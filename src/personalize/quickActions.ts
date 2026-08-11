import {
  Dialog,
  DialogStylesEnum,
  GameText,
  Player,
  PlayerEvent,
  Vehicle,
  WeaponEnum,
} from "@infernus/core";
import { pickOption, notifySaved } from "./settings";
import { sysMsg } from "@/utils/msg";
import { setTimeoutSafe } from "@/core/timers";
import { startObservePlayer, stopObserve, isObserving } from "@/core/observe";
import { isInRace, getRacePlayerState, getRaceRoom, respawnToLastCp } from "@/race/room";
import { isEditing } from "@/race/editor";
import { flipVehicle } from "@/core/vehicleAuto";
import { isPlayerLocked } from "@/core/interaction";
import { getAuthState } from "@/auth/auth";
import { getSafeGroundZ } from "@/core/colandreas";
import { isPlayerInWater } from "@infernus/colandreas";
import type { MenuBack } from "@/core/panel";
import { showDialog } from "@/utils/dialog";

/** 海平面参考高度（SA 海水水面 z≈0；陆地判定取明显高于海平面） */
const SEA_LEVEL = 0;

/** /djs 范围倒计时：20 单位半径 + 同世界（对齐原版 IsPlayerInRangeOfPoint 20 单位） */
const DJS_RADIUS = 20;
/** 倒计时从 N 开始倒数到 GO */
const DJS_COUNT = 5;
/** 发起冷却（防连发刷屏；每轮 5 秒 + 发起瞬间） */
const DJS_COOLDOWN_MS = 5000;
/** playerId -> 下一轮可发起时刻 */
const djsCooldownUntil = new Map<number, number>();

/** 执行一轮 20 单位范围倒计时（对齐原版 CountDown：数字 + 音效 1056，GO + 音效 1057）。
 * 计时器登记制（setTimeoutSafe 链）；发起人掉线即停（不残留刷屏）。 */
function runDjsCountdown(host: Player): void {
  let count = DJS_COUNT;
  const tick = (): void => {
    if (!host.isConnected()) return; // 发起人掉线 → 停（对齐原版 KillTimer 语义）
    const pos = host.getPos();
    const world = host.getVirtualWorld();
    const targets = Player.getInstances().filter(
      (p) =>
        !p.isNpc() &&
        p.isConnected() &&
        p.getVirtualWorld() === world &&
        p.getDistanceFromPoint(pos.x, pos.y, pos.z) <= DJS_RADIUS,
    );
    if (count <= 0) {
      const go = new GameText("~g~GO~r~!~n~~g~GO~r~!~n~~g~GO~r~!", 3000, 3);
      for (const p of targets) {
        go.forPlayer(p);
        p.playSound(1057);
      }
      djsCooldownUntil.delete(host.id); // 本轮结束，允许下一轮（冷却独立计时）
      return;
    }
    const gt = new GameText(`~w~${count}`, 3000, 3);
    for (const p of targets) {
      gt.forPlayer(p);
      p.playSound(1056);
    }
    count--;
    setTimeoutSafe(tick, 1000);
  };
  tick();
}

/**
 * 找最近的陆地：从 (x,y) 向四周方向逐步外扩扫描（24 方向 × 每 30 单位一圈，
 * 最大半径 500）。每个采样点用 colandreas 找地面高度——水域点返回海底（远低于
 * 海平面），陆地点的地面明显高于海平面。返回最近陆地坐标（地面 + 0.8 防半身
 * 埋地）；扫描范围内无陆地返回 null（colandreas 不可用/无数据时所有点回退
 * fallback，同样判非陆地）。
 */
function findNearestLand(x: number, y: number): { x: number; y: number; z: number } | null {
  const STEP = 30; // 每步外扩距离
  const MAX_DIST = 500; // 最大搜索半径
  const ANGLES = 24; // 每圈方向数（15° 步进）
  const FALLBACK_Z = -100; // getSafeGroundZ fallback（地图内最低值，保证无数据点不判陆地）
  for (let dist = STEP; dist <= MAX_DIST; dist += STEP) {
    for (let i = 0; i < ANGLES; i++) {
      const ang = (i / ANGLES) * Math.PI * 2;
      const sx = x + Math.cos(ang) * dist;
      const sy = y + Math.sin(ang) * dist;
      const ground = getSafeGroundZ(sx, sy, FALLBACK_Z);
      if (ground > SEA_LEVEL + 1.5) {
        return { x: sx, y: sy, z: ground + 0.8 };
      }
    }
  }
  return null;
}

/**
 * 快捷操作菜单（面板按钮触发）
 * 1. 脱离卡死（随机左右）
 * 2. 脱离卡死（垂直方向）
 * 3. 重生
 * 4. 获取当前位置空间信息
 * 5. 获取降落伞
 * 6. 获取喷气背包
 * 7. 车辆翻正（车内时）
 * 8. 范围倒计时（当前战局 10 秒）
 *
 * 用 (label, run) 行驱动，比赛中按需删减行——避免旧实现的 index+2
 * 重映射在删掉中间项（降落伞/喷气背包）后错位（比赛中"车辆翻正"误触发"降落伞"）。
 */
export async function openQuickActionsMenu(player: Player, back?: MenuBack): Promise<void> {
  const inRace = isInRace(player.id);
  // 比赛中禁用的选项：脱离卡死（瞬移作弊）、降落伞/喷气背包（装备作弊）
  const rows: { label: string; run: () => void | Promise<void> }[] = [];

  if (!inRace) {
    rows.push({
      label: "脱离卡死（随机左右）",
      run: () => {
        // 随机左右位移一段距离，脱离卡死
        const pos = player.getPos();
        const dir = Math.random() < 0.5 ? -1 : 1;
        player.setPos(pos.x + dir * 3, pos.y, pos.z + 1);
        sysMsg(player, "action", "已尝试脱离卡死（随机左右）", "plain");
      },
    });
    rows.push({
      label: "脱离卡死（垂直方向）",
      run: () => {
        // 垂直方向抬升（对齐原版 /xiufu 的 Z+2.8，对卡在墙缝/室内有效）
        const pos = player.getPos();
        player.setPos(pos.x, pos.y, pos.z + 5);
        sysMsg(player, "action", "已尝试脱离卡死（垂直方向）", "plain");
      },
    });
    rows.push({
      label: "脱离卡死（传送到最近地面）",
      run: () => {
        // 用 colandreas 找当前 (x,y) 的实际地面高度落上去（最可靠）：
        // 卡在建筑里/悬空时直接回到该点的地面。室内没有碰撞数据 → 退化为抬升。
        const pos = player.getPos();
        if (player.getInterior() === 0) {
          // 水里：不是浮出水面，而是找最近的陆地传送过去
          // （colandreas 对水域返回的是海底地面，原地落下仍在水里）
          try {
            const water = isPlayerInWater(player);
            if (water && water.playerDepth > 0) {
              const land = findNearestLand(pos.x, pos.y);
              if (land) {
                player.setPos(land.x, land.y, land.z);
                sysMsg(player, "action", "已脱离卡死（传送到最近陆地）", "plain");
                return;
              }
              // 附近找不到陆地（罕见/远离岸边）：退化为浮出水面兜底
              player.setPos(pos.x, pos.y, pos.z + water.playerDepth + 0.5);
              sysMsg(player, "action", "附近未找到陆地，已浮出水面", "plain");
              return;
            }
          } catch {
            // colandreas 不可用，忽略
          }
          const ground = getSafeGroundZ(pos.x, pos.y, pos.z);
          if (Math.abs(ground - pos.z) > 0.5) {
            // 抬高 0.8 防半身埋地（colandreas 地面高度可能略低于实际地表/流式 obj）
            player.setPos(pos.x, pos.y, ground + 0.8);
            sysMsg(player, "action", "已脱离卡死（传送到最近地面）", "plain");
            return;
          }
          sysMsg(player, "action", "已在安全位置或无法检测地面，可尝试垂直抬升", "plain");
        } else {
          player.setPos(pos.x, pos.y, pos.z + 5);
          sysMsg(player, "action", "室内无法检测地面，已尝试垂直抬升", "plain");
        }
      },
    });
  }

  // 重生：观战中隐藏（观战态重生会 spawn 出观战但 observeStates 残留，
  // 且 stopObserve 恢复的 prevWorld 语义错乱；观战有独立的"停止观战"项）
  if (!isObserving(player.id)) {
    rows.push({
      label: "重生",
      run: () => {
        // 比赛中：重生回上一 CP（与 /kill 一致）；非比赛：正常重生
        const racePr = isInRace(player.id) ? getRacePlayerState(player.id) : undefined;
        const room = racePr ? getRaceRoom(racePr.roomId) : undefined;
        if (racePr && room && room.state === "RACING") {
          respawnToLastCp(player, racePr, room);
        } else {
          player.spawn();
        }
      },
    });
  }

  rows.push({
    label: "当前位置信息",
    run: () => {
      // 当前位置空间信息
      const pos = player.getPos();
      const angle = player.getFacingAngle().angle;
      const world = player.getVirtualWorld();
      const interior = player.getInterior();
      sysMsg(
        player,
        "action",
        `位置 X:${pos.x.toFixed(2)} Y:${pos.y.toFixed(2)} Z:${pos.z.toFixed(2)} 朝向:${angle.toFixed(2)} 世界:${world} 室内:${interior}`,
        "plain",
      );
    },
  });

  if (!inRace) {
    rows.push({
      label: "获取降落伞",
      run: () => {
        player.giveWeapon(WeaponEnum.PARACHUTE, 1);
        notifySaved(player, "已获取降落伞（按 F 使用）");
      },
    });
    rows.push({
      label: "获取喷气背包",
      run: () => {
        player.setSpecialAction(2); // USEJETPACK
        notifySaved(player, "已获取喷气背包");
      },
    });
  }

  rows.push({
    label: "车辆翻正",
    run: () => {
      // 车辆翻正：对齐原版 /f（抬升 2 让物理重新落正）
      const vehicle = Vehicle.getInstances().find((v) => v.isPlayerIn(player));
      if (!vehicle) {
        sysMsg(player, "action", "你不在车内，无法翻正车辆", "error");
        return;
      }
      flipVehicle(vehicle, 2);
      // flipVehicle 只抬升+重置朝向（物理重新落正），不修车——文案如实，
      // 修车由车辆自动的 autoFix（个人设置开启时）负责
      notifySaved(player, "车辆已翻正");
    },
  });

  rows.push({
    label: "范围倒计时",
    // 复用 /djs 的统一实现（runDjsCountdown）：冷却检查 + 5 秒倒计时。
    // 面板直接调 sessionCountdown 会绕过冷却——可连点无限叠加多个并行
    // GameText/音效 1056 循环轰炸附近玩家（且 10 秒版与 /djs 行为不一致）
    run: () => {
      const now = Date.now();
      if ((djsCooldownUntil.get(player.id) ?? 0) > now) {
        sysMsg(player, "countdown", "请稍后再发起（每 5 秒一次）", "warn");
        return;
      }
      djsCooldownUntil.set(player.id, now + DJS_COOLDOWN_MS);
      runDjsCountdown(player);
    },
  });

  // 观战相关：未观战显示"观战玩家"，已观战显示"停止观战"（互斥，避免无效项）
  if (!isObserving(player.id)) {
    rows.push({
      label: "观战玩家",
      run: async () => {
        const res = await showDialog(
          player,
          new Dialog({
            style: DialogStylesEnum.INPUT,
            caption: "观战玩家",
            info: "输入要观看的玩家ID：",
            button1: "确定",
            button2: "取消",
          }),
        );
        if (!res || res.response !== 1) return;
        // B5：空输入/非数字会解析成 0/NaN → 误观战 0 号玩家，先校验
        const input = res.inputText.trim();
        if (!/^\d+$/.test(input)) {
          sysMsg(player, "action", "请输入有效的玩家ID", "error");
          return;
        }
        const target = Player.getInstance(+input);
        if (!target) {
          sysMsg(player, "action", "对方未在线", "error");
          return;
        }
        startObservePlayer(player, target);
      },
    });
  } else {
    rows.push({
      label: "停止观战",
      run: () => stopObserve(player),
    });
  }

  const index = await pickOption(
    player,
    "快捷操作",
    rows.map((r) => r.label),
  );
  if (index < 0) return back?.(); // 取消 → 退出面板
  await rows[index].run();
  // 操作完成后回到快捷操作菜单（可连续做多个操作），点"取消"才退出
  return openQuickActionsMenu(player, back);
}

/**
 * 初始化快捷命令：
 * /fxq 获取喷气背包 · /jls 获取降落伞 · /jetpack（= /fxq 别名）· /stuck 脱卡 · /djs 范围倒计时
 * （对齐原版命令：喷气背包/降落伞装备、卡住修复、附近倒计时）。
 * 比赛/编辑中禁用（与快捷操作菜单一致，避免装备作弊；/f 翻正除外——车内自救保留）。
 */
export function initQuickCommands(): void {
  PlayerEvent.onCommandText("fxq", ({ player, next }) => {
    // U3：命令入口统一拦截（未认证/流程锁中不可执行，对齐 /skin 无参路径）
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      sysMsg(player, "action", "当前流程中不可操作", "error");
      return next();
    }
    if (isInRace(player.id)) {
      sysMsg(player, "match", "比赛中不能获取喷气背包", "error");
      return next();
    }
    player.setSpecialAction(2); // USEJETPACK
    notifySaved(player, "已获取喷气背包");
    return next();
  });

  // /jetpack 原版别名（= /fxq，原版 CMD:jetpack 同样调 SetPlayerSpecialAction(2)）
  PlayerEvent.onCommandText("jetpack", ({ player, next }) => {
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      sysMsg(player, "action", "当前流程中不可操作", "error");
      return next();
    }
    if (isInRace(player.id)) {
      sysMsg(player, "match", "比赛中不能获取喷气背包", "error");
      return next();
    }
    player.setSpecialAction(2); // USEJETPACK
    notifySaved(player, "已获取喷气背包");
    return next();
  });

  // /stuck 脱离卡死（对齐原版 /xiufu：位置原地抬升 2.8 让物理脱卡）。
  // 卡在地形里时抬升脱离；比赛/编辑中禁用（比赛中脱卡请用 /kill 回上一 CP，
  // 编辑中会干扰摆位）
  PlayerEvent.onCommandText(["stuck", "xiufu"], ({ player, next }) => {
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      sysMsg(player, "action", "当前流程中不可操作", "error");
      return next();
    }
    if (isInRace(player.id)) {
      sysMsg(player, "match", "比赛中请用 /kill 重生回检查点脱卡", "warn");
      return next();
    }
    if (isEditing(player.id)) {
      sysMsg(player, "race", "编辑模式中不可脱卡，请移动位置", "error");
      return next();
    }
    const pos = player.getPos();
    player.setPos(pos.x, pos.y, pos.z + 2.8);
    notifySaved(player, "已脱离卡住状态");
    return next();
  });

  // /djs 范围倒计时（对齐原版 CountDown：20 单位内同世界玩家 5→4→3→2→1→GO +
  // 音效 1056/1057，用于拍视频/飙车配合）。发起人每 5 秒冷却，防连发刷屏
  PlayerEvent.onCommandText(["djs", "count", "daojishi"], ({ player, next }) => {
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      sysMsg(player, "action", "当前流程中不可操作", "error");
      return next();
    }
    if (isInRace(player.id)) {
      sysMsg(player, "match", "比赛中不能发起倒计时", "error");
      return next();
    }
    const now = Date.now();
    if ((djsCooldownUntil.get(player.id) ?? 0) > now) {
      sysMsg(player, "countdown", "请稍后再发起（每 5 秒一次）", "warn");
      return next();
    }
    djsCooldownUntil.set(player.id, now + DJS_COOLDOWN_MS);
    void runDjsCountdown(player);
    return next();
  });

  PlayerEvent.onCommandText("jls", ({ player, next }) => {
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      sysMsg(player, "action", "当前流程中不可操作", "error");
      return next();
    }
    if (isInRace(player.id)) {
      sysMsg(player, "match", "比赛中不能获取降落伞", "error");
      return next();
    }
    player.giveWeapon(WeaponEnum.PARACHUTE, 1);
    notifySaved(player, "已获取降落伞（按 F 使用）");
    return next();
  });

  // /f 车辆翻正（对齐原版 /f）：抬升 2 让物理重新落正 + 修复。与快捷操作菜单
  // "车辆翻正"同一实现；车内任意模式可用（比赛内翻车自救也支持）。
  PlayerEvent.onCommandText("f", ({ player, next }) => {
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      sysMsg(player, "action", "当前流程中不可操作", "error");
      return next();
    }
    const vehicle = Vehicle.getInstances().find((v) => v.isPlayerIn(player));
    if (!vehicle) {
      sysMsg(player, "action", "你不在车内，无法翻正车辆", "error");
      return next();
    }
    flipVehicle(vehicle, 2);
    // 同上：只翻正不修车，文案如实
    notifySaved(player, "车辆已翻正");
    return next();
  });

  // 断线清理 /djs 冷却记录（playerId 键，防复用后被误拒；对齐其他模块的 onDisconnect 清理）
  PlayerEvent.onDisconnect(({ player, next }) => {
    djsCooldownUntil.delete(player.id);
    return next();
  });
}
