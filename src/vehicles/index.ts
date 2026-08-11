import {
  Dialog,
  DialogStylesEnum,
  Dynamic3DTextLabel,
  Player,
  PlayerEvent,
  Vehicle,
  VehicleEvent,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { cleanupAttire, applyVehiclePreset } from "@/attire";
import { isInRace } from "@/race/room";
import { isInChallenge } from "@/replay/challenge";
import { REPLAY_WORLD_BASE } from "@/replay/playback";
import { sysMsg } from "@/utils/msg";
import { containsSensitiveWord, filterSensitiveWords } from "@/utils/sensitive";
import { isPlayerLocked } from "@/core/interaction";
import { getSetting, updateSetting, notifySaved } from "@/personalize/settings";
import { syncVehicleAutoState } from "@/core/vehicleAuto";
import { setIntervalSafe } from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import { showModelSelectionMenu } from "@/utils/eSelection";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { VEHICLE_CATEGORIES, vehicleName, isValidVehicleModel } from "./catalog";
import type { UserVehicleModel } from "@/prisma/generated/prisma/models/UserVehicle";
import { Prisma } from "@/prisma/generated/prisma/client";

import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";
/** 车辆位置保存间隔（毫秒） */
const SAVE_INTERVAL_MS = 30_000;

/** 一人一车：playerId -> 当前刷出的 Vehicle */
const playerVehs = new Map<number, Vehicle>();
/** 爱车 3D 标签：playerId -> 绑定的 description 标签（车辆销毁/断线时清理） */
const playerVehLabels = new Map<number, Dynamic3DTextLabel>();

export function getOwnedVehicle(playerId: number): Vehicle | undefined {
  return playerVehs.get(playerId);
}

/** 把车辆实体登记为玩家当前爱车（cveh 换车后新车成为玩家车，对齐原版 BuyID = 新车） */
export function registerOwnedVehicle(playerId: number, vehicle: Vehicle): void {
  playerVehs.set(playerId, vehicle);
}

/** 销毁玩家的当前车辆（同时清理挂载其上的装扮挂件与 3D 标签） */
export function destroyPlayerVehicle(playerId: number): void {
  const veh = playerVehs.get(playerId);
  if (veh && veh.isValid()) {
    veh.destroy();
  }
  playerVehs.delete(playerId);
  // 清理爱车 3D 标签（防空中残留文字）
  const label = playerVehLabels.get(playerId);
  if (label && label.isValid()) {
    label.destroy();
  }
  playerVehLabels.delete(playerId);
  // 清理挂在该车上的装扮 DynamicObject（防空中残留）
  cleanupAttire(playerId);
}

/** 安全加车辆组件：先校验车型能否装该组件（VehicleCanHaveComponent），能装才装。
 * 氮气(1010)/预设改装件统一走这里——避免对不能装的车型（飞机/船等）发无效
 * AddVehicleComponent（SA native 对无效组件返回 false 静默忽略，但先查更明确且
 * 避免无效 native 调用）。 */
export function addVehicleComponentIfPossible(vehicle: Vehicle, componentId: number): void {
  try {
    if (vehicle.isValid() && vehicle.canHaveComponent(componentId)) {
      vehicle.addComponent(componentId);
    }
  } catch {
    // 实体已失效等，忽略
  }
}

/** 氮气组件 ID（散落 14 处的魔法数字收敛；刷车/比赛车/回放车/NPC 车统一用） */
export const NITRO_COMPONENT = 1010;

/** 给车辆加氮气组件（能装才装；对齐 addVehicleComponentIfPossible 的校验） */
export function addNitro(vehicle: Vehicle): void {
  addVehicleComponentIfPossible(vehicle, NITRO_COMPONENT);
}

/**
 * 懒创建 user_vehicle 行：
 * 刷车时按 (user, modelId) 查库，有则复用（含默认预设/外观），无则新建默认行。
 * 返回行 + 该爱车当前外观预设的颜色（默认预设已存颜色则用之——/cc 换色持久化到
 * 默认预设后重刷车保持所选色；未存则 [-1,-1] 用游戏默认色，防预设默认值 0,0
 * 覆盖成黑车）。
 */
export async function getOrCreateUserVehicle(
  player: Player,
  modelId: number,
): Promise<{ uv: UserVehicleModel; colors: [number, number] }> {
  const auth = getAuthState(player.id);
  const pos = player.getPos();
  const angle = player.isInAnyVehicle()
    ? player.getVehicle()!.getZAngle().angle
    : player.getFacingAngle().angle;
  const data = {
    userId: auth!.userId,
    modelId,
    x: pos.x,
    y: pos.y,
    z: pos.z,
    angle,
    isLocked: false,
    allowGoto: true,
    isDefault: false,
  };
  const uv = await prisma.userVehicle.upsert({
    where: { userId_modelId: { userId: auth!.userId, modelId } },
    update: {},
    create: data,
  });
  let colors: [number, number] = [-1, -1];
  if (uv.defaultPresetId) {
    const preset = await prisma.vehiclePreset.findUnique({
      where: { id: uv.defaultPresetId },
      select: { color1: true, color2: true },
    });
    if (preset) {
      // 懒创建预设 color1/color2 默认 0（未设色），必须 >0 才视为用户选色——
      // 与 applyVehiclePreset 的守卫同口径，否则 0 号色（纯黑）会覆盖刷车初始色
      colors = [preset.color1 > 0 ? preset.color1 : -1, preset.color2 > 0 ? preset.color2 : -1];
    }
  }
  return { uv, colors };
}

/**
 * 刷车（懒创建爱车 + 一人一车 + 完整预设外观 + 氮气）。
 * 比赛默认发车/无车兜底也走这里（silent=true）：玩家有该模型爱车则复用其外观，
 * 没有则自动创建成爱车——玩家始终在用自己的爱车比赛（对齐原版玩家车语义）。
 */
export async function spawnVehicle(
  player: Player,
  modelId: number,
  silent = false,
): Promise<boolean> {
  if (!isValidVehicleModel(modelId)) {
    player.sendClientMessage(COLOR_ERROR, "车辆ID需在 400-611 之间");
    return false;
  }
  try {
    const { uv, colors } = await getOrCreateUserVehicle(player, modelId);
    // 刷车位置/朝向必须在销毁旧车**之前**读取：旧车一销毁玩家即被弹下车，
    // isInAnyVehicle() 变 false 会落进 getFacingAngle()（actor 朝向——车内不随
    // 车头实时更新，取到陈旧值），新刷的车朝向就和开车时的朝向对不上。
    const pos = player.getPos();
    const angle = player.isInAnyVehicle()
      ? player.getVehicle()!.getZAngle().angle
      : player.getFacingAngle().angle;
    // 一人一车：先销毁旧车
    destroyPlayerVehicle(player.id);
    const veh = new Vehicle({
      modelId,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      zAngle: angle,
      color: colors, // 爱车已存颜色（/cc 换色已持久化到默认预设）；未存则 [-1,-1] 游戏默认色
      respawnDelay: 0,
    });
    veh.create();
    playerVehs.set(player.id, veh);
    veh.setVirtualWorld(player.getVirtualWorld());
    veh.linkToInterior(player.getInterior());
    addNitro(veh); // 氮气
    // 应用完整预设外观（颜色/paintjob/改装件 + 挂件），默认预设挂件也自动生效
    // （改装店装的 mod 已存进默认预设 mod_components，重刷车随预设一起应用）
    await applyVehiclePreset(veh, uv.defaultPresetId, player.id);
    // 爱车 description 绑定 3D 文本（有描述才挂，跟随车辆移动）
    // 注意：附着车辆时 x/y/z 是相对车辆的偏移（对齐原版 CreateDynamic3DTextLabel
    // 附车时传 0,0,0），传绝对坐标会导致标签出现在世界原点/错位
    // 敏感词兜底：description 数据由 backend 写入（gm-lite 无改描述入口），展示层
    // 掩码敏感词防裸奔（词库未部署时检测放行，展示原文）
    if (uv.description) {
      const label = new Dynamic3DTextLabel({
        text: filterSensitiveWords(uv.description),
        color: "#ffd700",
        x: 0,
        y: 0,
        z: 0,
        drawDistance: 30,
        testLOS: false,
        attachedVehicle: veh.id,
        charset: DEFAULT_CHARSET,
      });
      label.create();
      playerVehLabels.set(player.id, label);
    }
    veh.putPlayerIn(player, 0);
    if (!silent) {
      player.sendClientMessage(
        COLOR_SUCCESS,
        `刷车成功！爱车模型 [${modelId}]，/cc 换色，/c wode 召唤`,
      );
    }
    return true;
  } catch (e) {
    logger.error(`[veh] ${player.getName().name} 刷车失败 ${modelId}`, e);
    player.sendClientMessage(COLOR_ERROR, "刷车失败，请稍后重试");
    return false;
  }
}

/** 保存单个玩家车辆位置到 user_vehicle（懒创建已保证有行） */
export async function savePlayerVehiclePosition(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  const veh = playerVehs.get(player.id);
  if (!auth || !veh || !veh.isValid()) return;
  // 比赛中：爱车被切到比赛独立世界，保存会污染位置数据（重启后坐标错位），跳过
  // 挑战/回放：爱车被挪到挑战/回放世界起点，同样跳过（否则重启后爱车刷在赛道起点）
  if (isInRace(player.id) || veh.getVirtualWorld() >= REPLAY_WORLD_BASE) return;
  const modelId = veh.getModel();
  const pos = veh.getPos();
  const angle = veh.getZAngle().angle;
  await prisma.userVehicle.updateMany({
    where: { userId: auth.userId, modelId },
    data: { x: pos.x, y: pos.y, z: pos.z, angle },
  });
}

/** 保存所有在线玩家的车辆位置 */
export async function saveAllVehiclePositions(): Promise<void> {
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    if (!getAuthState(player.id)) continue;
    try {
      await savePlayerVehiclePosition(player);
    } catch (e) {
      logger.error(`[veh] 保存车辆位置失败 ${player.getName().name}`, e);
    }
  }
}

/** 车辆位置自动保存定时器（timer 由 GameMode.onExit 统一清理） */
export function startVehicleSaveTimer(): void {
  setIntervalSafe(() => {
    void saveAllVehiclePositions();
  }, SAVE_INTERVAL_MS);
}

/** 玩家断线：销毁车辆 + 保存最后位置 */
export function onPlayerDisconnectVehicle(player: Player): void {
  const id = player.id;
  void savePlayerVehiclePosition(player).catch(() => {});
  destroyPlayerVehicle(id);
}

/**
 * 命令入口（命令为辅）：
 * /c <modelId> 刷车 · /c wode 召唤 · /cc c1 c2 换色
 * /c lock 锁车 · /c chepai 文字 · /c kick 踢乘客
 */
/** 召唤当前爱车到身边并上车（/c wode · /cars wode 共用）。
 * 实体已损毁/被清（大世界炸车 onDeath 会销毁实体）时，回数据库重建**最近用过**
 * 的爱车——"已损毁 /c wode 重新刷出"的提示必须真的能刷出，否则提示自相矛盾。
 * 重建走 spawnVehicle（懒复用该模型外观预设 + 一人一车 + 放入车内）。 */
export async function summonMyVehicle(player: Player): Promise<void> {
  let veh = playerVehs.get(player.id);
  if (!veh || !veh.isValid()) {
    // 实体没了但 DB 爱车仍在（损毁只清了实体，user_vehicle 行未删）：重建
    const auth = getAuthState(player.id);
    if (!auth) {
      player.sendClientMessage(COLOR_ERROR, "请先登录");
      return;
    }
    const last = await prisma.userVehicle.findFirst({
      where: { userId: auth.userId, deletedAt: null },
      orderBy: { updatedAt: "desc" }, // 最近用过的爱车（损毁前开的那辆）
    });
    if (!last) {
      player.sendClientMessage(COLOR_ERROR, "你还没有爱车，先 /c 车辆ID 刷车");
      return;
    }
    const ok = await spawnVehicle(player, last.modelId, true);
    if (!ok) return;
    veh = playerVehs.get(player.id);
    if (!veh || !veh.isValid()) return;
  }
  const pos = player.getPos();
  const angle = player.isInAnyVehicle()
    ? player.getVehicle()!.getZAngle().angle
    : player.getFacingAngle().angle;
  veh.setPos(pos.x, pos.y, pos.z);
  veh.setZAngle(angle);
  veh.setVirtualWorld(player.getVirtualWorld());
  veh.linkToInterior(player.getInterior());
  addNitro(veh);
  veh.putPlayerIn(player, 0);
  player.sendClientMessage(COLOR_SUCCESS, "爱车已召唤到身边");
}

/** 锁/解锁当前爱车（/c lock · /cars lock 共用；状态落库） */
export async function toggleMyVehicleLock(player: Player): Promise<void> {
  const veh = playerVehs.get(player.id);
  if (!veh || !veh.isValid()) {
    player.sendClientMessage(COLOR_ERROR, "你还没有车（或已损毁）");
    return;
  }
  const { doors } = veh.getParamsEx();
  const isLocked = doors < 1;
  veh.toggleDoors(isLocked);
  const auth = getAuthState(player.id);
  if (auth) {
    await prisma.userVehicle.updateMany({
      where: { userId: auth.userId, modelId: veh.getModel() },
      data: { isLocked },
    });
  }
  player.sendClientMessage(COLOR_WHITE, isLocked ? "爱车已上锁" : "爱车已解锁");
}

/**
 * 事务内取该爱车默认预设（无则懒创建并设为默认）——与 onMod/onPaintjob 的存储
 * 共用同一套路：并发写入不会重复创建预设触发 @@unique([userId,modelId,index])。
 */
async function ensureDefaultPresetTx(
  tx: Prisma.TransactionClient,
  userId: string,
  modelId: number,
): Promise<string> {
  const uv = await tx.userVehicle.findUnique({
    where: { userId_modelId: { userId, modelId } },
  });
  let presetId = uv?.defaultPresetId ?? null;
  if (!presetId) {
    const maxIdx = await tx.vehiclePreset.findFirst({
      where: { userId, modelId, deletedAt: null },
      orderBy: { index: "desc" },
      select: { index: true },
    });
    const created = await tx.vehiclePreset.create({
      data: { userId, modelId, index: (maxIdx?.index ?? -1) + 1, name: null },
    });
    presetId = created.id;
    await tx.userVehicle.update({
      where: { userId_modelId: { userId, modelId } },
      data: { defaultPresetId: created.id },
    });
  }
  return presetId;
}

/** 更换当前爱车颜色（/cc · /c color · /cars color 共用）。
 *  同步换色 + 异步持久化到默认预设 color1/color2（重刷车/重新登录后保持所选色——
 *  否则 applyVehiclePreset 用预设默认 0,0 覆盖，爱车变黑） */
export function changeMyVehicleColor(player: Player, c1: number, c2: number): void {
  const veh = playerVehs.get(player.id);
  if (!veh || !veh.isValid()) {
    player.sendClientMessage(COLOR_ERROR, "你还没有车（或已损毁），先 /c 车辆ID 刷车");
    return;
  }
  veh.changeColors(c1, c2);
  player.sendClientMessage(COLOR_SUCCESS, `颜色已更换为 ${c1} / ${c2}`);
  const auth = getAuthState(player.id);
  if (!auth) return;
  const modelId = veh.getModel();
  void (async () => {
    try {
      await prisma.$transaction(async (tx) => {
        const presetId = await ensureDefaultPresetTx(tx, auth.userId, modelId);
        await tx.vehiclePreset.update({
          where: { id: presetId },
          data: { color1: c1, color2: c2 },
        });
      });
    } catch (e) {
      logger.error(`[veh] ${player.getName().name} 存储换色失败 model=${modelId}`, e);
    }
  })();
}

/** 更换当前爱车车牌（/c chepai · /cars chepai 共用；落库）。
 *  车牌对所有玩家可见渲染——与昵称前后缀/传送点名同防线，含敏感词拒绝设置 */
export async function setMyVehiclePlate(player: Player, plate: string): Promise<void> {
  if (containsSensitiveWord(plate)) {
    player.sendClientMessage(COLOR_ERROR, "车牌包含敏感内容，请更换");
    return;
  }
  const veh = playerVehs.get(player.id);
  if (!veh || !veh.isValid()) {
    player.sendClientMessage(COLOR_ERROR, "你还没有车（或已损毁）");
    return;
  }
  veh.setNumberPlate(plate);
  const auth = getAuthState(player.id);
  if (auth) {
    await prisma.userVehicle.updateMany({
      where: { userId: auth.userId, modelId: veh.getModel() },
      data: { plateNumber: plate },
    });
  }
  player.sendClientMessage(COLOR_SUCCESS, "车牌已更换");
}

/** 踢出当前爱车内的乘客（/c kick · /cars kick 共用） */
export function kickMyVehiclePassengers(player: Player): void {
  const veh = playerVehs.get(player.id);
  if (!veh) {
    player.sendClientMessage(COLOR_ERROR, "你还没有车");
    return;
  }
  let kicked = 0;
  for (const p of Player.getInstances()) {
    if (p.isNpc() || !p.isConnected() || p.id === player.id) continue;
    if (!p.isInAnyVehicle() || p.getVehicle() !== veh) continue;
    const pos = p.getPos();
    p.setPos(pos.x, pos.y, pos.z + 5);
    p.sendClientMessage(COLOR_ERROR, "你被车主移出了车辆");
    kicked++;
  }
  player.sendClientMessage(
    COLOR_SUCCESS,
    kicked > 0 ? `已踢出 ${kicked} 名乘客` : "车内没有其他乘客",
  );
}

export function initVehicleCommands(): void {
  // 大世界爱车被毁清理：非比赛场景下玩家爱车被炸（respawnDelay=0 不会自动重生，
  // 且不在比赛重生的兜底范围）→ 销毁 playerVehs 条目 + 3D 标签，防残留失效实体。
  // 否则 /c wode 会把报废残骸拖过来、开赛/挑战的"无车判定"（getOwnedVehicle 不判
  // isValid）全部错位。比赛中由 race 的 VehicleEvent.onDeath 处理重生补车（司机存活
  // 刷车/死亡重生兜底），这里跳过避免双重处理。
  VehicleEvent.onDeath(({ vehicle, next }) => {
    // getLastDriver 而非 getDriver：司机刚下车瞬间仍算该车
    const owner = [...playerVehs].find(([, v]) => v === vehicle)?.[0];
    if (owner == null || isInRace(owner)) return next();
    const player = Player.getInstance(owner);
    destroyPlayerVehicle(owner); // 清失效实体 + 3D 标签（isValid 内部防护）
    if (player && player.isConnected() && !player.isNpc()) {
      // 影子挑战中：ensureChallengeCar 会自动刷车（无感续跑），不提示手动补车
      if (isInChallenge(player.id)) {
        sysMsg(player, "challenge", "车辆已损毁，挑战已自动补车", "info");
      } else {
        sysMsg(player, "vehicle", "你的爱车已损毁，/c wode 或 /c 车型 重新刷出", "warn");
      }
    }
    return next();
  });

  // 改装店装件存储：OnVehicleMod 在改装店装上 mod 时触发 → 存到该爱车的
  // 当前默认预设（vehicle_preset.mod_components，仅自己的车）。
  // 无默认预设时懒创建一个并设为默认（重刷车 applyVehiclePreset 应用预设
  // 时自然带上改装件，无需额外存储）
  VehicleEvent.onMod(({ player, vehicle, componentId, next }) => {
    if (player.isNpc()) return next();
    // 仅自己的爱车：改装店能开进别人的车，但 mod 归属按车主存储
    if (getOwnedVehicle(player.id) !== vehicle) return next();
    const auth = getAuthState(player.id);
    if (!auth) return next();
    const modelId = vehicle.getModel();
    void (async () => {
      try {
        // 事务内"取默认预设（无则建）→ 追加改件"原子完成：并发 onMod
        // （同帧装多个件）不会重复创建预设触发 @@unique([userId,modelId,index]) 冲突
        await prisma.$transaction(async (tx) => {
          // 目标预设：爱车默认预设；无则懒创建并设为默认（ensureDefaultPresetTx）
          const presetId = await ensureDefaultPresetTx(tx, auth.userId, modelId);
          const preset = await tx.vehiclePreset.findUnique({ where: { id: presetId } });
          const list = (preset?.modComponents ? preset.modComponents.split(" ") : []).filter(
            Boolean,
          );
          if (!list.includes(String(componentId))) {
            list.push(String(componentId));
            await tx.vehiclePreset.update({
              where: { id: presetId },
              data: { modComponents: list.join(" ") },
            });
          }
        });
      } catch (e) {
        logger.error(`[veh] ${player.getName().name} 存储改装件失败 model=${modelId}`, e);
      }
    })();
    return next();
  });

  // 改装店喷漆存储：OnVehiclePaintjob 喷漆（paintjob 0-3）触发 → 存到该爱车的
  // 当前默认预设 vehiclePreset.paintjob（对齐 onMod 的存档模式；仅自己的车）。
  // 刷车/重刷车 applyVehiclePreset 会应用 paintjob（attire/index.ts:176）
  VehicleEvent.onPaintjob(({ player, vehicle, paintjobId, next }) => {
    if (player.isNpc()) return next();
    // 仅自己的爱车：改装店能开进别人的车，但喷漆归属按车主存储
    if (getOwnedVehicle(player.id) !== vehicle) return next();
    const auth = getAuthState(player.id);
    if (!auth) return next();
    const modelId = vehicle.getModel();
    void (async () => {
      try {
        // 事务内"取默认预设（无则懒创建并设为默认）→ 写 paintjob"原子完成
        await prisma.$transaction(async (tx) => {
          const presetId = await ensureDefaultPresetTx(tx, auth.userId, modelId);
          await tx.vehiclePreset.update({
            where: { id: presetId },
            data: { paintjob: paintjobId },
          });
        });
      } catch (e) {
        logger.error(`[veh] ${player.getName().name} 存储喷漆失败 model=${modelId}`, e);
      }
    })();
    return next();
  });

  PlayerEvent.onCommandText(["c", "veh"], ({ player, subcommand, next }) => {
    // 诊断（debug 级，防刷车测试刷屏）：定位"/c 无提示"——命令是否分发到本
    // handler、arg/认证/锁状态
    logger.debug(
      `[veh] /c dispatch player=${player.getName().name}(${player.id}) arg=${subcommand[0] ?? "(空)"} ` +
        `authed=${!!getAuthState(player.id)} locked=${isPlayerLocked(player.id)}`,
    );
    // B6：刷车需已认证且不在流程锁中（未登录/大厅对话框期间 /c 会触发
    // getOrCreateUserVehicle 的 auth! 空断言 → 报错被吞，只留"刷车失败"）
    if (!getAuthState(player.id) || isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "请先完成登录后再刷车");
      return next();
    }
    const arg = subcommand[0];
    if (arg === "list") {
      void showVehicleCategoryMenu(player);
      return next();
    }
    if (!arg || Number.isNaN(+arg)) {
      player.sendClientMessage(
        COLOR_WHITE,
        "刷车: /c [车辆ID400-611] · /c list 图片选车 · /c wode 召唤 · /cc 色1 色2 · /c lock · /c chepai 文字 · /c kick · /c 3d 3D速度表 · /c 2d 2D速度表",
      );
      return next();
    }
    void spawnVehicle(player, +arg);
    return next();
  });

  PlayerEvent.onCommandText(["c list", "veh list"], ({ player, next }) => {
    void showVehicleCategoryMenu(player);
    return next();
  });

  PlayerEvent.onCommandText(["c wode", "veh wode"], ({ player, next }) => {
    void summonMyVehicle(player);
    return next();
  });

  PlayerEvent.onCommandText(["c lock", "veh lock"], async ({ player, next }) => {
    await toggleMyVehicleLock(player);
    return next();
  });

  // /cc 色1 色2 换色（对齐原版 /cc，提示文案已多处引用）
  PlayerEvent.onCommandText(["cc", "c color", "veh color"], ({ player, subcommand, next }) => {
    const c1 = +subcommand[0];
    const c2 = +subcommand[1];
    if (
      !Number.isInteger(c1) ||
      c1 < 0 ||
      c1 > 255 ||
      !Number.isInteger(c2) ||
      c2 < 0 ||
      c2 > 255
    ) {
      player.sendClientMessage(COLOR_ERROR, "用法: /cc 颜色代码1 颜色代码2（0-255）");
      return next();
    }
    changeMyVehicleColor(player, c1, c2);
    return next();
  });

  PlayerEvent.onCommandText(["c chepai", "veh chepai"], async ({ player, subcommand, next }) => {
    const plate = subcommand.join(" ").trim();
    if (!plate) {
      player.sendClientMessage(COLOR_ERROR, "用法: /c chepai 车牌文字（≤10字符）");
      return next();
    }
    if (plate.length > 10) {
      player.sendClientMessage(COLOR_ERROR, "车牌文字最多 10 个字符");
      return next();
    }
    await setMyVehiclePlate(player, plate);
    return next();
  });

  PlayerEvent.onCommandText(["c kick", "veh kick"], ({ player, next }) => {
    kickMyVehiclePassengers(player);
    return next();
  });

  // /c 3d 3D速度表开关（对齐原版 /c 3d；2d/3d 互斥，与界面菜单一致）。
  // 开启时联动总开关 showSpeed（GUI 判定是 showSpeed && showSpeed3d，只写
  // showSpeed3d 而总开关关闭时提示"已开启"实际不显示）
  PlayerEvent.onCommandText(["c 3d", "veh 3d"], async ({ player, next }) => {
    const setting = await getSetting(player);
    if (!setting) return next();
    const nextOn = !setting.showSpeed3d;
    await updateSetting(player, {
      showSpeed3d: nextOn,
      showSpeed2d: false,
      showSpeed: nextOn ? true : setting.showSpeed,
    });
    notifySaved(player, `3D速度表已${nextOn ? "开启" : "关闭"}`);
    return next();
  });

  // /c 2d 2D速度表开关（对齐 /c 3d 的互斥语义：开 2d 关 3d，联动总开关）
  PlayerEvent.onCommandText(["c 2d", "veh 2d"], async ({ player, next }) => {
    const setting = await getSetting(player);
    if (!setting) return next();
    const nextOn = !setting.showSpeed2d;
    await updateSetting(player, {
      showSpeed2d: nextOn,
      showSpeed3d: false,
      showSpeed: nextOn ? true : setting.showSpeed,
    });
    notifySaved(player, `2D速度表已${nextOn ? "开启" : "关闭"}`);
    return next();
  });

  // /dcar /autofix：toggle 载具无敌（自动修复，对齐原版 AutoFix——载具被攻击/碰撞
  // 自动修复，设置与面板「车辆→自动修复」同一数据源；比赛中该设置被比赛系统
  // 强制覆盖为"无碰撞"，命令仅改个人设置，不碰比赛态）
  PlayerEvent.onCommandText(["dcar", "autofix"], async ({ player, next }) => {
    if (!getAuthState(player.id) || isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "请先完成登录后再操作");
      return next();
    }
    const setting = await getSetting(player);
    if (!setting) return next();
    const nextOn = !setting.vehicleAutoFix;
    await updateSetting(player, { vehicleAutoFix: nextOn });
    syncVehicleAutoState(player, { vehicleAutoFix: nextOn }); // 同步拦截名单（onWeaponShot 热路径）
    notifySaved(player, `载具无敌已${nextOn ? "开启" : "关闭"}（载具自动修复）`);
    return next();
  });

  // /hys：toggle 车辆变色龙（自动换色，对齐原版 hys——每秒随机换色，vehicleTick 驱动）
  PlayerEvent.onCommandText("hys", async ({ player, next }) => {
    if (!getAuthState(player.id) || isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "请先完成登录后再操作");
      return next();
    }
    const setting = await getSetting(player);
    if (!setting) return next();
    const nextOn = !setting.vehicleColorCycle;
    await updateSetting(player, { vehicleColorCycle: nextOn });
    // 开启瞬间立即换一次色（对齐原版开启即有视觉效果，不等下一秒 tick）。
    // 只换本人的爱车实体——玩家坐在别人车里（乘客）开 /hys 不能改别人车的颜色
    //（vehicleTick 的变色龙每 tick 也有 isOwnVehicle 守卫，此处同口径）
    if (nextOn) {
      const veh = getOwnedVehicle(player.id);
      if (veh && veh.isValid()) {
        veh.changeColors(Math.floor(Math.random() * 256), Math.floor(Math.random() * 256));
      }
    }
    notifySaved(player, `变色龙已${nextOn ? "开启" : "关闭"}（每秒随机换色）`);
    return next();
  });
}

/**
 * /c list：分类选择 → e-selection 图片选车 → 懒创建爱车刷车。
 * 对齐原版 Dialog_SpawnVehicle 11 类 + mSelection 图片菜单。
 */
async function showVehicleCategoryMenu(player: Player): Promise<void> {
  const info = VEHICLE_CATEGORIES.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "刷车列表",
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const cat = VEHICLE_CATEGORIES[res.listItem];
  if (!cat) return;
  await showVehicleSelection(player, cat);
}

/** e-selection 图片选车（3D 预览车辆模型），选中后刷车。
 *  每页 18 个（6 列 × 3 行铺满）+ 分页页码记忆（per 分类：刷完/关闭再开回到上次页） */
async function showVehicleSelection(
  player: Player,
  cat: { label: string; menuTitle: string; models: number[] },
): Promise<void> {
  const model = await showModelSelectionMenu(player, `veh:${cat.label}`, {
    models: cat.models.map((modelId) => ({
      modelId,
      modelText: `${vehicleName(modelId)} [${modelId}]`,
    })),
    headerText: cat.menuTitle,
    bannerColor: "#333",
    menuBgColor: "#222",
    menuTextColor: "#fff",
    itemBgColor: "#444",
    itemTextColor: "#0f0",
  });
  if (model) {
    await spawnVehicle(player, model.modelId);
  }
}
