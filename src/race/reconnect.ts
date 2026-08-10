import { Player } from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle, spawnVehicle } from "@/vehicles";
import { applyWorldEnv } from "@/core/worldenv";
import { applyRaceNoCollision, getDefaultRaceModel } from "./vehicle";
import { createRaceTd, updateBestTd, setRaceTdText, destroyRaceTds } from "./raceTd";
import {
  showNextCheckpoint,
  syncCpToObservers,
  clearSpectatorCpForMember,
  cleanupSpectatorCpForRoom,
} from "./cpArrow";
import { sessionManager } from "@/sessions/manager";
import { formatRaceTimeCs } from "@/utils/format";
import { sysMsg } from "@/utils/msg";
import { reapplyCurrentPlayerPreset } from "@/attire";
import { raceRecordingStart, discardRaceReplay } from "@/replay";
import {
  suspendRecording,
  resumeRecording,
  isRecording,
  getRecording,
  stopRecording,
  dropRecording,
  rebindRecording,
} from "@/replay/recorder";
import { cleanupScriptVehicle } from "./scripts";
import { cleanupObserve } from "@/core/observe";
import { cancelCountdownFx } from "@/interface/countdownFx";
import { clearTimeoutSafe } from "@/core/timers";
import { rooms, playerRaces, broadcastToRoom, freeRaceWorld } from "./state";
import type { RaceRoom } from "./types";

/**
 * 房间成员生命周期：断线重连（进入/清理重连窗口、恢复比赛进度）+ 房间销毁判定
 * （全员离开/窗口过期 → checkRoomState 回收）。与比赛状态机（room.ts）双向无关：
 * room.ts 在成员离开/掉线路径调用本模块，本模块不反向依赖 room.ts。
 */

/** 重连窗口参数：预计时长 × 20%，上限 5 分钟、下限 30 秒；<2.5 分钟不支持 */
const RECONNECT_RATIO = 0.2;
const RECONNECT_MAX_MS = 5 * 60_000;
const RECONNECT_MIN_MS = 30_000;
const RECONNECT_SUPPORT_MIN_MS = 2.5 * 60_000;

/**
 * 玩家断线：进入重连窗口（不立即清成员/转移房主）。
 * - 短比赛（<2.5 分钟）不支持重连 → 走原断线逻辑
 * - 支持重连的比赛：记录进度快照 + 重连截止时间
 */
export function cleanupRacePlayer(playerId: number, opts?: { sessionId?: number }): void {
  const pr = playerRaces.get(playerId);
  if (pr) {
    const room = rooms.get(pr.roomId);
    if (room) {
      const tds = room.raceTextTds.get(playerId);
      if (tds) {
        // infernus 在玩家 onDisconnect 时已自动销毁其全部 PlayerTextDraw
        //（_id 回到 65535），此处必须 isValid 守卫——裸 destroy 会抛
        // TextDrawException 中断清理，TD 条目残留，tickRooms/syncRaceTds
        // 继续对已销毁 TD setString 无限刷屏
        for (const td of Object.values(tds)) {
          if (td.isValid()) td.destroy();
        }
        room.raceTextTds.delete(playerId);
      }
      room.tdTextCache.delete(playerId);
      // 掉线成员下线：清理指向该成员的观察者 CP 箭头（车停原地无人可跟）
      clearSpectatorCpForMember(playerId);
      // 比赛中且比赛支持重连 → 进入重连窗口（已完成玩家不开窗口：成绩已纪录，防重连后重复完成）
      const estMs = estimateRaceDurationMs(room);
      if (room.state === "RACING" && !pr.finished && estMs >= RECONNECT_SUPPORT_MIN_MS) {
        // 窗口 key 用 userId（防 playerId 复用劫持）；auth 在断线时仍可用
        //（closePlayerSession 清 auth 在其后执行），取不到则回退 playerId 字符串
        const uid = getAuthState(playerId)?.userId ?? String(playerId);
        const window = Math.min(
          RECONNECT_MAX_MS,
          Math.max(RECONNECT_MIN_MS, estMs * RECONNECT_RATIO),
        );
        room.reconnectUntil.set(uid, Date.now() + window);
        // 快照含"距下一 CP 距离"：掉线玩家按掉线瞬间位置/CP 继续参与排名。
        // onDisconnect 时 getPos 可能已失效（返回 undefined）→ 退化为 0,0,0，重连
        // 后玩家会出生在默认出生点、与"继续第 N 圈"脱节——用 tickRooms 最近一次
        // 采样位置兜底（200ms 内的最后已知位置，比 0,0,0 精确得多）
        const discPlayer = Player.getInstance(playerId);
        const dpos = discPlayer?.getPos() ?? room.lastPositions.get(playerId);
        const nextCp = room.cps[pr.cpIndex + 1];
        let dist = 0;
        if (nextCp && dpos) {
          dist = Math.hypot(dpos.x - nextCp.x, dpos.y - nextCp.y, dpos.z - nextCp.z);
        }
        room.reconnectSlots.set(uid, {
          playerId,
          cpIndex: pr.cpIndex,
          lap: pr.lap,
          startTime: pr.startTime,
          prevWorld: pr.prevWorld,
          dist,
          name: discPlayer?.getName().name ?? `玩家${playerId}`,
          // 掉线瞬间位置：重连是全新连接，恢复时 setPos 回此处（防出现在默认出生点）
          x: dpos?.x ?? 0,
          y: dpos?.y ?? 0,
          z: dpos?.z ?? 0,
          // 掉线瞬间原战局 id 快照（由 callbacks 在 handlePlayerDisconnect 删
          // playerSessions 之前传入——onDisconnect 阶段再取 getPlayerSession 只会
          // 命中公共大世界、恒为 0）
          sessionId: opts?.sessionId,
        });
        room.members.delete(playerId);
        room.lastPositions.delete(playerId); // 掉线快照缓存随成员移出清理
        room.afk.delete(playerId); // 挂机累计随断线清理（重连是新上下文，从零累计）
        playerRaces.delete(playerId);
        // 录制挂起：会话保持、掉线期间 fallbackSample 生成静止帧（车停在掉线
        // 位置、时间流逝），重连成功后 resume 续录——回放完整不中断，能看到
        // 掉线后车原地不动那段的帧。不落盘（forceStopRecording 会跳过挂起）。
        suspendRecording(playerId);
        // 断线期间脚本车辆销毁（重连后玩家自己重新刷车/用脚本）
        cleanupScriptVehicle(playerId);
        // 房主断线：窗口内不转移房主（重连恢复），但保留窗口
        broadcastToRoom(
          room,
          `${Player.getInstance(playerId)?.getName().name ?? "玩家"} 掉线，${Math.round(window / 1000)} 秒内可重连`,
        );
        cleanupObserve(playerId);
        return;
      }
      // 不支持重连或非比赛状态 → 原断线逻辑
      room.members.delete(playerId);
      room.lastPositions.delete(playerId); // 掉线快照缓存随成员移出清理
      room.afk.delete(playerId); // 挂机累计随断线清理（防 Map 残留到房间销毁）
      // 房主掉线 → 转移房主
      if (room.ownerId === playerId) {
        const next = [...room.members.keys()][0];
        if (next != null) {
          room.ownerId = next;
          room.ownerUserId = getAuthState(next)?.userId ?? "";
          const np = Player.getInstance(next);
          broadcastToRoom(room, `房主已掉线，${np?.getName().name ?? next} 成为新房主`);
        }
      }
      if (room.state === "WAITING") {
        broadcastToRoom(room, `一名玩家离开了比赛`);
      }
      checkRoomState(room);
    }
    playerRaces.delete(playerId);
  }
  // 脚本车辆（cveh）随玩家断线清理
  cleanupScriptVehicle(playerId);
  // 清理观战状态（被观战者/观战者掉线）
  cleanupObserve(playerId);
}

/** 清理过期的重连窗口（tickRooms 调用）：窗口到期的玩家彻底移出房间 */
export function cleanupExpiredReconnects(room: RaceRoom): void {
  const now = Date.now();
  for (const [uid, until] of room.reconnectUntil) {
    if (now >= until) {
      const slot = room.reconnectSlots.get(uid);
      room.reconnectUntil.delete(uid);
      room.reconnectSlots.delete(uid);
      // 重连超时：挂起中的录制落盘保留（未完成段，含掉线静止帧——玩家没回来，
      // 录像停在原地；无人完成则由房间销毁路径作废）。用 slot.playerId（掉线时
      // 的 id）找挂起会话——挂起会话键控在 playerId 上。归属校验：断线期间该
      // playerId 可能被新连接复用开了录制（同一房间也可能被同房新成员复用——
      // raceRoomId 会相同），必须再比 userId 才能确认是掉线者自己的会话，防误停
      // 别人的活跃录制（与 endRoom/checkRoomState 的归属校验一致）
      if (slot && isRecording(slot.playerId)) {
        const rec = getRecording(slot.playerId);
        if (rec && rec.userId === uid && (!rec.raceRoomId || rec.raceRoomId === room.id)) {
          void stopRecording(slot.playerId, { quiet: true });
        }
      }
      // 房主重连窗口过期 → 转移房主
      if (slot && room.ownerUserId === uid) {
        const next = [...room.members.keys()][0];
        if (next != null) {
          room.ownerId = next;
          room.ownerUserId = getAuthState(next)?.userId ?? "";
          const np = Player.getInstance(next);
          broadcastToRoom(room, `房主重连超时，${np?.getName().name ?? next} 成为新房主`);
        }
      }
    }
  }
  checkRoomState(room);
}

/**
 * 估算比赛预计时长（毫秒）：总距离 / 平均速度（约 90 km/h = 25 m/s），再 ×圈数。
 * 用于重连窗口计算。
 */
function estimateRaceDurationMs(room: RaceRoom): number {
  // cps 是完整路线（每圈），总长 = 相邻 CP 距离和 × 圈数
  let total = 0;
  for (let i = 0; i < room.cps.length - 1; i++) {
    const dx = room.cps[i].x - room.cps[i + 1].x;
    const dy = room.cps[i].y - room.cps[i + 1].y;
    const dz = room.cps[i].z - room.cps[i + 1].z;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const avgSpeed = 25; // m/s ≈ 90 km/h
  return (total / avgSpeed) * 1000 * room.laps;
}

/**
 * 玩家断线/比赛结束后的世界恢复：回到原世界 + 车世界同步 + 个人时间天气恢复
 * （CP 脚本改过的 time/weather 在此重置；防爱车遗留在比赛独立世界成为幽灵车，
 * 对齐原版 Race_Game_Quit 的车世界恢复）。导出供比赛状态机（room.ts 的结束/
 * 离开/解散路径）调用。
 */
export function restorePlayerAfterRace(player: Player, prevWorld: number): void {
  if (!player.isConnected()) return;
  player.setVirtualWorld(prevWorld);
  if (player.isInAnyVehicle()) {
    player.getVehicle()!.setVirtualWorld(prevWorld);
  }
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid() && owned !== player.getVehicle()) {
    owned.setVirtualWorld(prevWorld);
  }
  // 按个人设置恢复时间天气（CP 脚本改过的 time/weather 在此重置）
  void applyWorldEnv(player);
}

/**
 * 全员离开/窗口过期时的房间销毁判定（leaveRace / cleanupRacePlayer /
 * cleanupExpiredReconnects 共用）：
 * 全员离开但仍有重连窗口 → 不销毁：重连是"成员全掉线也靠窗口存活"的场景
 *（单人房掉线是重连功能最典型用法）。窗口全部到期后 cleanupExpiredReconnects
 * 会再调本函数，此时窗口空、members 仍空 → 正常销毁。
 */
export function checkRoomState(room: RaceRoom): void {
  if (room.members.size === 0 && room.reconnectSlots.size === 0 && room.reconnectUntil.size === 0) {
    // 置 FINISHED：COUNTDOWN 中全员离开时，倒计时链每步都查 state，置位后
    // beginRace 不再被调用（防闭包链空转几秒无效执行）
    room.state = "FINISHED";
    // 全员离开：各自的倒计时动画链随断线自停（组件帧守卫），成员残留 TD 一并清
    for (const m of room.members.values()) cancelCountdownFx(m.id);
    if (room.endTimer) {
      clearTimeoutSafe(room.endTimer);
      room.endTimer = undefined;
    }
    destroyRaceTds(room);
    cleanupSpectatorCpForRoom(room); // 房间销毁：清理指向本房间成员的观察者 CP 箭头
    // 有人完成（room.results 非空）→ 比赛有成绩，录像保留：挂起会话落盘、
    // 已落盘段不作废。仅"无人完成"才作废删除（挂起丢弃 + 已落盘段删除）。
    const someoneFinished = room.results.length > 0;
    for (const pid of room.raceMembersLast.keys()) {
      // 当前 pid 上的会话归属：只处理本房间的挂起/活跃会话（玩家退赛后又加入
      // 别的房间时，其新会话 raceRoomId 是别的房间——防误停/误丢另一房间的录制）
      const rec = getRecording(pid);
      const mine = !rec || !rec.raceRoomId || rec.raceRoomId === room.id;
      if (isRecording(pid) && mine) {
        if (someoneFinished) {
          void stopRecording(pid, { quiet: true }); // 挂起会话落盘保留（含静止段）
        } else {
          dropRecording(pid); // 挂起会话：丢弃（静止段无成绩价值）
        }
      }
      // 已落盘未完成段作废：不依赖 isRecording 状态——pid 可能已被新连接复用
      // 开了别的房间录制（isRecording=true 且归属不符），旧用户本场的落盘段
      // 仍须作废。discardRaceReplay 按 userId+raceId+raceRoomId 精确匹配本场
      //（rank=null），只会命中旧段，碰不到新用户（不同 userId）的活跃会话
      if (!someoneFinished) {
        discardRaceReplay(pid, room.raceId, room.raceMembersLast.get(pid), room.id);
      }
    }
    room.raceMembersLast.clear();
    freeRaceWorld(room.worldId); // 房间销毁：回收独立世界 id
    rooms.delete(room.id);
  }
}

/**
 * 掉线重连：玩家重新进入游戏时，若其断线窗口未过期且房间仍存在，恢复比赛进度。
 * 返回 true 表示已恢复；false 表示无可重连房间。
 */
export async function tryReconnectRace(player: Player): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) return false;
  // 遍历房间找该玩家的重连窗口（key 是 userId：防 playerId 复用劫持旧窗口）
  for (const room of rooms.values()) {
    const until = room.reconnectUntil.get(auth.userId);
    if (until == null) continue;
    const slot = room.reconnectSlots.get(auth.userId);
    // 窗口过期或房间已结束/解散 → 清理窗口，无法重连；对齐 cleanupExpiredReconnects
    // 把挂起的录制落盘（不落盘则会话永久悬挂、静止帧无限累积内存）
    if (Date.now() >= until || room.state === "FINISHED") {
      room.reconnectUntil.delete(auth.userId);
      room.reconnectSlots.delete(auth.userId);
      // 归属校验（对齐 cleanupExpiredReconnects）：断线期间该 playerId 可能被新
      // 连接复用开了录制（含同一房间被同房新成员复用——raceRoomId 相同），须再
      // 比 userId 才是掉线者自己的挂起会话，防误停别人的活跃会话
      if (slot && isRecording(slot.playerId)) {
        const rec = getRecording(slot.playerId);
        if (rec && rec.userId === auth.userId && (!rec.raceRoomId || rec.raceRoomId === room.id)) {
          void stopRecording(slot.playerId, { quiet: true });
        }
      }
      // 玩家已在线（重连流程中）：明确提示窗口状态，避免"输入完密码直接走登录
      // 流程"的困惑（重连窗口只对进行中的比赛建立，短比赛/过期/房间结束都无
      // 法恢复，走正常登录是预期行为，但要说清楚）
      sysMsg(
        player,
        "race",
        room.state === "FINISHED"
          ? "原比赛房间已结束，无法重连（将正常登录）"
          : "重连窗口已过期，无法恢复比赛（将正常登录）",
        "warn",
      );
      continue;
    }
    // 恢复：重新加入房间 + 恢复进度
    room.reconnectUntil.delete(auth.userId);
    room.reconnectSlots.delete(auth.userId);
    // playerId 可能已被复用（新连接 id 与掉线时不同）：把挂起的录制会话从
    // 旧 id 迁移到新 id，否则 resumeRecording(player.id) 找不到会话（掉线静帧
    // 断在旧 id 上、回放缺段），且旧 id 残留挂起会话占内存。传 raceRoomId 归属
    // 校验：旧 id 可能已被新连接占用来开别的房间的挂起会话，不能劫持
    if (slot && slot.playerId !== player.id) {
      rebindRecording(slot.playerId, player.id, room.id, auth.userId);
    }
    room.members.set(player.id, player);
    room.raceMembersLast.set(player.id, auth.userId); // 重新登记本场录制成员（userId 快照供离线作废）
    // 恢复战局归属：按掉线时快照的原战局 id 精确匹配（sessionId 自增不复用，战局
    // 仍在则必然命中原战局——worldId 会被解散战局回收复用，按 worldId 可能塞进
    // 无关新战局）。战局已解散（查无此 id）→ 回公共大世界并修正 prevWorld=0
    //（避免比赛结束恢复到已解散战局的幽灵世界，与战局登记不一致）
    const prevWorld = slot?.prevWorld ?? player.getVirtualWorld();
    const joinedSession = sessionManager.rejoinPlayerSession(player, slot?.sessionId ?? 0);
    playerRaces.set(player.id, {
      roomId: room.id,
      cpIndex: slot?.cpIndex ?? -1,
      lap: slot?.lap ?? 0,
      startTime: slot?.startTime ?? Date.now(),
      finished: false,
      // 恢复断线前所在世界（重连时玩家必然在世界 0，不能用作 prevWorld）
      prevWorld: joinedSession ? prevWorld : 0,
      cpSnapshots: [], // 重连是新连接：回退重生快照从空重建（后续过 CP 重新记录）
    });
    // 切回比赛世界 + 恢复掉线瞬间位置（重连是全新连接，跳过出生定位，不恢复
    // 会出现在地图默认出生点，与"继续第 N 圈"提示严重不符）。
    // 只 setSpawnInfo 不设 pendingSpawnPos：比赛中 onSpawn 的 respawnBySetting 对
    // isInRace 玩家提前 return（不会随机定位），setSpawnInfo 即权威；而 pendingSpawnPos
    // 若残留会在**之后的死亡重生**被 onSpawn 误消费（把玩家 setPos 回掉线点并弹出车）。
    // 掉线位置恢复：三轴任一非零即认为有坐标快照。掉线瞬间 getPos 失效且
    // tickRooms 尚未采样过（RACING 前 200ms 内掉线）时 slot 为 0,0,0——此时
    // 跳过 setPos（落在房间世界默认点），避免"设到原点把玩家塞进海/地下"
    player.setVirtualWorld(room.worldId);
    if (slot && (slot.x !== 0 || slot.y !== 0 || slot.z !== 0)) {
      const angle = room.cps[Math.max(0, slot.cpIndex)]?.angle ?? 0;
      player.setSpawnInfo(0, player.getSkin(), slot.x, slot.y, slot.z, angle, 0, 0, 0, 0, 0, 0);
      player.setPos(slot.x, slot.y, slot.z);
    }
    // 清挂机采样：playerId 键可能继承掉线前的静止累计（重连后停在原地没立刻开
    // 车会误判"即将移出比赛"），且重连玩家是新上下文，从零开始累计
    room.afk.delete(player.id);
    if (room.state === "RACING") {
      // 回放：恢复挂起的录制（同一会话续录，掉线静止帧衔接无缝；若挂起会话
      // 已被其他路径处理——超时落盘/房间销毁/重开丢弃——resume 无会话可恢复，
      // 则新开一段录制兜底）
      resumeRecording(player.id);
      if (!isRecording(player.id)) {
        raceRecordingStart(player.id, {
          raceId: room.raceId,
          raceName: room.raceName,
          raceRoomId: room.id,
        });
      }
      const tds = createRaceTd(player, room);
      // 立即写入 TIME（含初始化 tdTextCache）：否则下一个 tickRooms（≤200ms）
      // 前 syncRaceTds 无 cache 跳过、TD 停在创建时的 "00:00:00 / 1 st"，显示
      // 从 0 跳变到掉线前累计时间。TIME 用 startTime 起算（slot 恢复的掉线前计时）。
      // RANK 不写死 "1 st"（重连玩家实际名次可能是第 5 名，显示错误名次闪烁）——
      // 留创建时的占位，≤200ms 后 tickRooms 写入真实名次
      const rstart = playerRaces.get(player.id)?.startTime ?? Date.now();
      setRaceTdText(
        room,
        player.id,
        `TIME / ${formatRaceTimeCs(Date.now() - rstart)}`,
        `RANK / 1 st`,
      );
      // 恢复 BEST TD（房间缓存已有，无则查询）
      void updateBestTd(player, room, tds);
      // 恢复 CP 进度 TD（按断线时进度）
      const cpDone = Math.min((slot?.cpIndex ?? -1) + 1, room.cps.length);
      tds.cp.setString(`C  P / ~p~${cpDone}~w~/~y~${room.cps.length}`);
      showNextCheckpoint(player, room.cps, slot?.cpIndex ?? -1);
      // 重连恢复同步观战者的 CP 箭头（观察者跟着看到重连后的当前目标）
      syncCpToObservers(room, player, slot?.cpIndex ?? -1);
      // 重新强制无碰撞（重连是全新连接，碰撞状态已重置）
      applyRaceNoCollision(player, true);
      // 恢复房间统一时间天气（重连是新连接，默认回服务器时间天气——不恢复会
      // 与同房其他成员不一致，直到碰到带 time/weather 脚本的 CP）
      player.setTime(room.roomTime.hour, room.roomTime.minute);
      player.setWeather(room.roomWeather);
      // 无车兜底（断线前坐默认比赛车，重连时已被清理）：用默认比赛车型刷爱车
      // （有该模型爱车则复用外观，没有则自动创建成爱车——与 joinRoom/beginRace 一致）。
      // 判 isValid：断线期间爱车可能被炸（实体失效但仍占 Map 条目）
      const ownedVeh = getOwnedVehicle(player.id);
      if (!player.isInAnyVehicle() && (!ownedVeh || !ownedVeh.isValid())) {
        void spawnVehicle(player, getDefaultRaceModel(room.cps), true);
      }
    }
    // 重连是全新连接：onDisconnect 已 cleanupAttire 清空挂件，且重连路径不触发
    // onSpawn（玩家被直接放回车里）——手动重挂默认人物装扮，否则整个重连比赛
    // 期间装扮缺失
    void reapplyCurrentPlayerPreset(player);
    broadcastToRoom(room, `${player.getName().name} 已重连比赛！`);
    sysMsg(
      player,
      "race",
      `已重连比赛「${room.raceName}」，继续第 ${(slot?.lap ?? 0) + 1} 圈`,
      "success",
    );
    // 房主重连 → 恢复房主身份
    if (room.ownerId === player.id || room.ownerUserId === auth.userId) {
      room.ownerId = player.id;
      room.ownerUserId = auth.userId;
      broadcastToRoom(room, `${player.getName().name} 恢复了房主身份`);
    }
    return true;
  }
  return false;
}
