import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { invalidateSettingCache, getSetting } from "@/personalize/settings";
import { showDialog } from "@/utils/dialog";
import { setIntervalSafe } from "@/core/timers";
import { getSafeGroundZ } from "@/core/colandreas";
import { isInRace } from "@/race/room";
import { isEditing } from "@/race/editor";
import { isInsideMap } from "@/utils/map";
import { COLOR_SUCCESS } from "@/utils/colors";

/** 位置自动保存间隔（毫秒） */
const SAVE_INTERVAL_MS = 30_000;

let spawnPoints: { x: number; y: number; z: number; angle: number }[] | null = null;

async function loadSpawnPoints(): Promise<{ x: number; y: number; z: number; angle: number }[]> {
  if (!spawnPoints) {
    const rows = await prisma.spawnPoint.findMany({ orderBy: { index: "asc" } });
    spawnPoints = rows.map((r) => ({
      x: Number(r.x),
      y: Number(r.y),
      z: Number(r.z),
      angle: Number(r.angle),
    }));
  }
  return spawnPoints;
}

/** 获取一个随机出生点 */
export async function getRandomSpawnPoint(): Promise<{
  x: number;
  y: number;
  z: number;
  angle: number;
} | null> {
  const points = await loadSpawnPoints();
  if (points.length === 0) return null;
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
    // 上次位置也用 colandreas 修正 Z（防卡建筑/悬空）
    z = getSafeGroundZ(x, y, Number(setting.lastZ));
    angle = setting.lastAngle != null ? Number(setting.lastAngle) : 0;
  } else {
    const point = await getRandomSpawnPoint();
    if (!point) return; // 无出生点配置，跳过（保持默认状态）
    x = point.x;
    y = point.y;
    // 随机出生点用 colandreas 测实际地面高度（防出生卡进建筑）
    z = getSafeGroundZ(x, y, point.z);
    angle = point.angle;
  }
  const skin = setting?.skinId ?? 0;
  // SA-MP 风格签名：team, skin, x, y, z, rotation, 三把武器（0=无）
  player.setSpawnInfo(0, skin, x, y, z, angle, 0, 0, 0, 0, 0, 0);
  player.spawn();
  // 标记登录首次出生：onSpawn 跳过 respawnBySetting（避免 RANDOM 二次随机定位）
  loginSpawned.add(player.id);
  // 解除连接时进入的观战模式（认证/大厅期间隐藏），正式出生后恢复可见
  player.toggleSpectating(false);
}

/** 保存玩家当前在线位置（超出地图范围不保存；比赛中在独立世界，跳过防污染） */
export async function savePlayerPosition(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  // 比赛中：玩家在比赛独立世界（world≥5000），保存会污染 LAST_POSITION 出生点，跳过
  if (isInRace(player.id)) return;
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

/** 断线清理登录出生标记（防 playerId 复用残留跳过重生定位） */
export function cleanupLoginSpawned(playerId: number): void {
  loginSpawned.delete(playerId);
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
  const hasLast =
    setting?.spawnMode === "LAST_POSITION" &&
    setting.lastX != null &&
    setting.lastY != null &&
    setting.lastZ != null &&
    isInsideMap(Number(setting.lastX), Number(setting.lastY), Number(setting.lastZ));
  if (!player.isConnected()) return;
  if (hasLast) {
    const x = Number(setting.lastX);
    const y = Number(setting.lastY);
    // 最后位置也用 colandreas 修正 Z（防卡建筑/悬空）
    player.setPos(x, y, getSafeGroundZ(x, y, Number(setting.lastZ)));
    if (setting.lastAngle != null) player.setFacingAngle(Number(setting.lastAngle));
    return;
  }
  const point = await getRandomSpawnPoint();
  if (!point || !player.isConnected()) return; // 无出生点配置，保持默认
  player.setPos(point.x, point.y, getSafeGroundZ(point.x, point.y, point.z));
  player.setFacingAngle(point.angle);
}

/** 初始化出生系统：定时保存在线位置 + 大世界重生按设置自动定位（timer 由 GameMode.onExit 统一清理） */
export function initSpawnSystem(): void {
  setIntervalSafe(() => {
    void saveAllOnlinePositions();
  }, SAVE_INTERVAL_MS);

  // 每次出生/重生（含死亡重生、/kill）按 spawnMode 自动定位。
  // 登录首次出生由 spawnPlayer 的 setSpawnInfo 定位——跳过本逻辑，
  // 否则 RANDOM 会再随机一次，出现两个不同出生点。
  PlayerEvent.onSpawn(({ player, next }) => {
    if (player.isNpc()) return next();
    // 登录首次出生已定位
    if (loginSpawned.delete(player.id)) return next();
    // 兜底：已认证但仍处于 spect（出生方式/进入世界对话框未完成）却触发了
    // 出生（open.mp 默认出生/时序竞态）→ 维持 spect 隐藏（拉回不可见无实体），
    // 等 spawnPlayer 正式出生时一并 toggleSpectating(false)
    if (getAuthState(player.id) && player.isSpectating()) {
      player.toggleSpectating(true);
      return next();
    }
    // 正常死亡重生：按 spawnMode 自动定位（随机/上次位置）
    void respawnBySetting(player);
    return next();
  });
}

/** 万能面板入口：配置出生方式（随机 / 上次位置） */
export async function openSpawnSettingsFlow(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await prisma.sysUserSetting.findUnique({
    where: { userId: auth.userId },
  });
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
