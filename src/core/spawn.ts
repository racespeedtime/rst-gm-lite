import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { invalidateSettingCache, getSetting } from "@/personalize/settings";
import { showDialog } from "@/utils/dialog";
import { setIntervalSafe } from "@/core/timers";
import { getSpawnGroundZ } from "@/core/colandreas";
import { isInRace } from "@/race/room";
import { REPLAY_WORLD_BASE } from "@/replay/playback";
import { isEditing } from "@/race/editor";
import { reapplyCurrentPlayerPreset } from "@/attire";
import { isInsideMap } from "@/utils/map";
import { COLOR_SUCCESS } from "@/utils/colors";

/** 位置自动保存间隔（毫秒） */
const SAVE_INTERVAL_MS = 30_000;

let spawnPoints: { x: number; y: number; z: number; angle: number }[] | null = null;

/** 默认出生点（LV 机场跑道，安全平地；出生点表无配置/查询失败时兜底，
 *  保证玩家总能正常出生——否则 RANDOM 模式出生直接卡死（无 spawnInfo）） */
const DEFAULT_SPAWN_POINT = { x: 1857.58, y: -1430.13, z: 13.58, angle: 0 };

async function loadSpawnPoints(): Promise<{ x: number; y: number; z: number; angle: number }[]> {
  if (!spawnPoints) {
    try {
      const rows = await prisma.spawnPoint.findMany({ orderBy: { index: "asc" } });
      spawnPoints = rows.map((r) => ({
        x: Number(r.x),
        y: Number(r.y),
        z: Number(r.z),
        angle: Number(r.angle),
      }));
    } catch (e) {
      // DB 故障时缓存空数组并记录（避免每次出生重复查库失败），出生走兜底点
      spawnPoints = [];
      logger.error("[spawn] 加载出生点失败，使用默认出生点", e);
    }
  }
  return spawnPoints;
}

/** 获取一个随机出生点（无配置/查询失败返回默认兜底点） */
export async function getRandomSpawnPoint(): Promise<{
  x: number;
  y: number;
  z: number;
  angle: number;
}> {
  const points = await loadSpawnPoints();
  if (points.length === 0) return DEFAULT_SPAWN_POINT;
  return points[Math.floor(Math.random() * points.length)];
}

/**
 * 玩家认证成功后出生：
 * - 设置 LAST_POSITION 且最后位置在地图范围内 → 使用最后位置
 * - 否则（RANDOM 或上次位置超范围被忽略）→ 随机出生点
 */
export async function spawnPlayer(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await prisma.sysUserSetting.findUnique({
    where: { userId: auth.userId },
  });
  let x: number;
  let y: number;
  let z: number;
  let angle: number;
  const hasLast =
    setting?.spawnMode === "LAST_POSITION" &&
    setting.lastX != null &&
    setting.lastY != null &&
    setting.lastZ != null &&
    isInsideMap(Number(setting.lastX), Number(setting.lastY), Number(setting.lastZ));
  if (hasLast) {
    x = Number(setting.lastX);
    y = Number(setting.lastY);
    // 上次位置也用 colandreas 修正 Z（防卡建筑/悬空/半身入地/被抬到遮挡物顶）
    z = getSpawnGroundZ(x, y, Number(setting.lastZ));
    angle = setting.lastAngle != null ? Number(setting.lastAngle) : 0;
  } else {
    const point = await getRandomSpawnPoint();
    x = point.x;
    y = point.y;
    // 随机出生点用 colandreas 测实际地面高度（防出生卡进建筑/抬到屋檐顶）
    z = getSpawnGroundZ(x, y, point.z);
    angle = point.angle;
  }
  const skin = setting?.skinId ?? 0;
  // SA-MP 风格签名：team, skin, x, y, z, rotation, 三把武器（0=无）
  player.setSpawnInfo(0, skin, x, y, z, angle, 0, 0, 0, 0, 0, 0);
  // 解除连接时进入的观战模式（认证/大厅期间隐藏），正式出生后恢复可见
  player.toggleSpectating(false);
  // player.spawn();
  // 标记登录首次出生：onSpawn 跳过 respawnBySetting（避免 RANDOM 二次随机定位）
  loginSpawned.add(player.id);
}

/** 保存玩家当前在线位置（超出地图范围不保存；比赛中在独立世界，跳过防污染） */
export async function savePlayerPosition(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  // 比赛中：玩家在比赛独立世界（world≥1001，RACE_WORLD_BASE），保存会污染
  // LAST_POSITION 出生点，跳过
  if (isInRace(player.id) || player.getVirtualWorld() >= REPLAY_WORLD_BASE) return;
  const pos = player.getPos();
  const angle = player.getFacingAngle().angle;
  if (!isInsideMap(pos.x, pos.y, pos.z)) return;
  await prisma.sysUserSetting.upsert({
    where: { userId: auth.userId },
    update: {
      lastX: pos.x,
      lastY: pos.y,
      lastZ: pos.z,
      lastAngle: angle,
    },
    create: {
      userId: auth.userId,
      lastX: pos.x,
      lastY: pos.y,
      lastZ: pos.z,
      lastAngle: angle,
    },
  });
  invalidateSettingCache(auth.userId); // 直接写库后使设置缓存失效（30s 一次，开销可忽略）
}

async function saveAllOnlinePositions(): Promise<void> {
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    if (!getAuthState(player.id)) continue;
    try {
      await savePlayerPosition(player);
    } catch (e) {
      logger.error(`[spawn] 保存位置失败 ${player.getName().name}`, e);
    }
  }
}

/** 登录首次出生标记：spawnPlayer 已用 setSpawnInfo 定位，onSpawn 不再二次定位 */
const loginSpawned = new Set<number>();

/** onDeath 预计算的重生位置（playerId → 位置）：onSpawn 直接使用，避免死亡重生
 *  双重随机——onDeath 预计算一个随机点写 spawnInfo，onSpawn 若再随机一次会先
 *  出现在 A 点再瞬移到 B 点（客户端可见闪烁传送） */
const pendingSpawnPos = new Map<number, { x: number; y: number; z: number; angle: number }>();

/** 预计算下一次 onSpawn 的落点（死亡重生/比赛掉线重连共用）：
 *  onSpawn 消费后自动清除；配合 setSpawnInfo 让 open.mp 的 spawn 落在指定位置，
 *  避免 respawnBySetting 再按 RANDOM/LAST_POSITION 随机定位（重连会把人拉离赛道） */
export function setPendingSpawnPos(
  playerId: number,
  pos: { x: number; y: number; z: number; angle: number },
): void {
  pendingSpawnPos.set(playerId, pos);
}

/** 断线清理登录出生标记（防 playerId 复用残留跳过重生定位） */
export function cleanupLoginSpawned(playerId: number): void {
  loginSpawned.delete(playerId);
  pendingSpawnPos.delete(playerId);
}

/**
 * 按设置计算重生位置（LAST_POSITION / RANDOM，含 colandreas Z 修正）。
 * 供死亡重生预计算 spawnInfo 与 onSpawn 兜底定位共用；无出生点配置返回 null。
 */
async function computeSpawnPos(
  setting:
    | {
        spawnMode?: string | null;
        lastX?: unknown;
        lastY?: unknown;
        lastZ?: unknown;
        lastAngle?: unknown;
      }
    | null
    | undefined,
): Promise<{ x: number; y: number; z: number; angle: number } | null> {
  const hasLast =
    setting?.spawnMode === "LAST_POSITION" &&
    setting.lastX != null &&
    setting.lastY != null &&
    setting.lastZ != null &&
    isInsideMap(Number(setting.lastX), Number(setting.lastY), Number(setting.lastZ));
  if (hasLast) {
    const x = Number(setting.lastX);
    const y = Number(setting.lastY);
    // 最后位置也用 colandreas 修正 Z（防卡建筑/悬空/半身入地/被抬到遮挡物顶）
    return {
      x,
      y,
      z: getSpawnGroundZ(x, y, Number(setting.lastZ)),
      angle: setting.lastAngle != null ? Number(setting.lastAngle) : 0,
    };
  }
  const point = await getRandomSpawnPoint();
  return {
    x: point.x,
    y: point.y,
    z: getSpawnGroundZ(point.x, point.y, point.z),
    angle: point.angle,
  };
}

/**
 * 大世界后续重生按设置自动定位（对齐原版 OnPlayerSpawn → SetPlayerPos_Birth）：
 * - spawnMode=LAST_POSITION 且最后位置有效 → 回到最后保存的位置
 * - 否则（RANDOM 或上次位置超范围被忽略）→ 随机出生点
 * 比赛中/编辑模式的重生由各自系统处理，不在此覆盖。
 * 用 setPos 直接定位（onSpawn 里不能再 spawn，避免递归触发）。
 */
async function respawnBySetting(player: Player): Promise<void> {
  if (isInRace(player.id) || isEditing(player.id)) return;
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await getSetting(player); // 设置缓存，避免每次重生查库
  // 按当前设置应用皮肤（对齐原版 OnPlayerSpawn → SetPlayerSkin）：
  // 死亡重生会用 setSpawnInfo 的旧皮肤重置，中途改的皮肤会丢，这里强制设回
  if (setting?.skinId != null && player.getSkin() !== setting.skinId) {
    player.setSkin(setting.skinId);
  }
  if (!player.isConnected()) return;
  const pos = await computeSpawnPos(setting);
  if (!pos || !player.isConnected()) return; // 无出生点配置，保持默认
  player.setPos(pos.x, pos.y, pos.z);
  player.setFacingAngle(pos.angle);
}

/** 初始化出生系统：定时保存在线位置 + 大世界重生按设置自动定位（timer 由 GameMode.onExit 统一清理） */
export function initSpawnSystem(): void {
  setIntervalSafe(() => {
    void saveAllOnlinePositions();
  }, SAVE_INTERVAL_MS);

  // 出生请求闸门：open.mp 的 RequestSpawn 处理对观战状态不做任何检查，观战
  // （spect）中的玩家仍会被客户端的自动出生请求直接放行（toSpawn_=true）强制
  // 出生。而服务器侧 spectateData.spectating 只有 Player::spawn() 会清除——
  // 客户端已经出生可见，服务器却仍认为在观战，导致旧 onSpawn 兜底里的
  // toggleSpectating(true) 因状态相同直接 return（no-op），玩家以"服务器认为
  // 隐身、客户端实际可见"的错乱态出现在世界（认证/出生方式对话框期间出生）。
  // 因此在 spect 未解除期间同步拦截出生请求：认证流程、大厅对话框、观战中一律
  // 禁止客户端自发出生，只有正式出生（spawnPlayer）解除 spect 后才放行。
  // 注意：spawnPlayer/比赛重生等走服务器端 Player::spawn()，不经过该请求，不受影响。
  PlayerEvent.onRequestSpawn(({ player, next }) => {
    if (player.isNpc()) {
      return next();
    }
    // 观战模式下拒绝出生请求（必须同步 return false——async 返回值会被忽略，
    // 放行请求导致上述错乱态）
    if (player.isSpectating()) {
      return false;
    }
    // 非观战（正式出生后 / 死亡重生 / 退出观战 / 重连恢复）：放行
    return true;
  });

  // 死亡重生预计算 spawn info：玩家死亡 → 提前按设置算好重生位置 + 皮肤并
  // setSpawnInfo。死亡重生时客户端用 setSpawnInfo 的 class 数据重生——若数据
  // 还是登录时的旧位置/旧皮肤，open.mp 可能 fallback 到 class 选择界面，
  // 提前更新可避免，且重生位置/皮肤直接正确（onSpawn 的 respawnBySetting
  // 仍兜底 setPos，防预计算失败/中途改设置）。
  // 比赛中/编辑模式的重生由各自系统处理（比赛 onDeath 已 setSpawnInfo + spawn）。
  PlayerEvent.onDeath(({ player, next }) => {
    if (player.isNpc()) return next();
    if (isInRace(player.id) || isEditing(player.id)) return next();
    void (async () => {
      const auth = getAuthState(player.id);
      if (!auth) return;
      const setting = await getSetting(player); // 设置缓存，避免每次死亡查库
      if (!player.isConnected()) return;
      const pos = await computeSpawnPos(setting);
      if (!pos || !player.isConnected()) return; // 无出生点配置，保持默认
      // 记录预计算位置：onSpawn 直接用（防双重随机闪烁）
      pendingSpawnPos.set(player.id, pos);
      player.setSpawnInfo(
        0,
        setting?.skinId ?? player.getSkin(),
        pos.x,
        pos.y,
        pos.z,
        pos.angle,
        0,
        0,
        0,
        0,
        0,
        0,
      );
    })();
    return next();
  });

  // 阻止进入 class 选择界面：服务器未 AddPlayerClass（无 class 系统）。
  // 部分客户端在死亡后会先进 class 选择（按 F4 / 客户端默认行为），若只
  // return false 抑制界面，玩家会卡在死亡状态无响应（不会自动 RequestSpawn）
  // ——直接强制重生（玩家此刻必然是想起死），死亡后即用即走，不再弹提示。
  PlayerEvent.onRequestClass(({ player, next }) => {
    if (player.isNpc()) return next();
    // 观战中：保持观战态，不强制重生（否则观察者被拽出观战出生；onRequestSpawn
    // 闸门只拦 RequestSpawn，拦不住服务器侧 player.spawn()）
    if (player.isSpectating()) return false;
    // 比赛/编辑中的重生由各自系统处理（比赛回上一 CP / 编辑器状态），不干预
    if (isInRace(player.id) || isEditing(player.id)) return next();
    player.spawn();
    return false;
  });

  // 每次出生/重生（含死亡重生、/kill）按 spawnMode 自动定位。
  // 登录首次出生由 spawnPlayer 的 setSpawnInfo 定位——跳过本逻辑，
  // 否则 RANDOM 会再随机一次，出现两个不同出生点。
  PlayerEvent.onSpawn(({ player, next }) => {
    if (player.isNpc()) return next();
    // 登录首次出生已定位
    if (loginSpawned.delete(player.id)) return next();
    // 兜底：已认证但仍处于 spect（出生方式/进入世界对话框未完成）却触发了
    // 出生（open.mp 默认出生/时序竞态）→ 维持 spect 隐藏（拉回不可见无实体），
    // 等 spawnPlayer 正式出生时一并 toggleSpectating(false)。
    // （onRequestSpawn 闸门已拦截 spect 期间的出生请求，此兜底仅防客户端绕过
    // 请求直接发 Spawn RPC 的极端情况。）
    if (getAuthState(player.id) && player.isSpectating()) {
      return next();
    }
    // 死亡重生：onDeath 预计算的位置直接用（防双重随机闪烁）——apply 皮肤 +
    // setPos 后不再走 respawnBySetting（否则又随机一次）。未预计算（onDeath
    // 中断/竞态）才回退 respawnBySetting 的独立计算。
    const pre = pendingSpawnPos.get(player.id);
    if (pre) {
      // 预计算续体可能慢于这次 onSpawn（DB 缓存 miss/随机点首查库）：陈旧条目
      // 会被**之后的**任意 onSpawn 误消费——含比赛中 /kill 重生（比赛 onDeath 已
      // setSpawnInfo + spawn）和编辑模式重生，会把玩家拽回上一次死亡点。比赛/
      // 编辑的重生由各自系统处理，这里不消费（与 respawnBySetting 门禁同口径）
      if (isInRace(player.id) || isEditing(player.id)) {
        // 比赛/编辑重生由各自系统定位，消费并清除防赛后残留误消费
        pendingSpawnPos.delete(player.id);
        return next();
      }
      pendingSpawnPos.delete(player.id);
      void (async () => {
        const auth = getAuthState(player.id);
        if (!auth) return;
        const setting = await getSetting(player);
        if (setting?.skinId != null && player.getSkin() !== setting.skinId) {
          player.setSkin(setting.skinId);
        }
        if (!player.isConnected()) return;
        player.setPos(pre.x, pre.y, pre.z);
        player.setFacingAngle(pre.angle);
      })();
    } else {
      // 正常死亡重生：按 spawnMode 自动定位（随机/上次位置）
      void respawnBySetting(player);
    }
    // 死亡重生后挂件会被 open.mp 清除：重新应用当前人物预设（对齐原版
    // OnPlayerSpawn → SpawnAttire）。编辑模式除外（编辑时是对象编辑/挂件操作，
    // 重应用会打断）。
    if (!isEditing(player.id)) {
      void reapplyCurrentPlayerPreset(player);
    }
    return next();
  });
}

/** 万能面板入口：配置出生方式（随机 / 上次位置） */
export async function openSpawnSettingsFlow(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  // 走设置缓存（与各个性化菜单同一数据源）
  const setting = await getSetting(player);
  const current = setting?.spawnMode === "LAST_POSITION" ? "LAST_POSITION" : "RANDOM";
  const info = [
    `1. 随机出生点${current === "RANDOM" ? "（当前）" : ""}`,
    `2. 上次位置出生${current === "LAST_POSITION" ? "（当前）" : ""}（超地图范围自动忽略）`,
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "出生设置",
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const mode = res.listItem === 1 ? "LAST_POSITION" : "RANDOM";
  await prisma.sysUserSetting.upsert({
    where: { userId: auth.userId },
    update: { spawnMode: mode },
    create: { userId: auth.userId, spawnMode: mode },
  });
  invalidateSettingCache(auth.userId); // 直接写库后使设置缓存失效，防脏读
  player.sendClientMessage(
    COLOR_SUCCESS,
    mode === "RANDOM" ? "出生方式已设为：随机出生点" : "出生方式已设为：上次位置出生",
  );
}
