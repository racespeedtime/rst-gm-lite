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
import { isPlayerLocked } from "@/core/interaction";
import { setIntervalSafe } from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { VEHICLE_CATEGORIES, vehicleName, isValidVehicleModel } from "./catalog";
import type { UserVehicleModel } from "@/prisma/generated/prisma/models/UserVehicle";

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

/**
 * 懒创建 user_vehicle 行：
 * 刷车时按 (user, modelId) 查库，有则复用（含默认预设/外观），无则新建默认行。
 */
export async function getOrCreateUserVehicle(
  player: Player,
  modelId: number,
): Promise<UserVehicleModel> {
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
  return uv;
}

/** 应用车辆外观（默认预设的 颜色/paintjob/改装件） */
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
    const uv = await getOrCreateUserVehicle(player, modelId);
    // 一人一车：先销毁旧车
    destroyPlayerVehicle(player.id);
    const pos = player.getPos();
    const angle = player.isInAnyVehicle()
      ? player.getVehicle()!.getZAngle().angle
      : player.getFacingAngle().angle;
    const veh = new Vehicle({
      modelId,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      zAngle: angle,
      color: [-1, -1],
      respawnDelay: 0,
    });
    veh.create();
    playerVehs.set(player.id, veh);
    veh.setVirtualWorld(player.getVirtualWorld());
    veh.linkToInterior(player.getInterior());
    veh.addComponent(1010); // 氮气
    // 应用完整预设外观（颜色/paintjob/改装件 + 挂件），默认预设挂件也自动生效
    // （改装店装的 mod 已存进默认预设 mod_components，重刷车随预设一起应用）
    await applyVehiclePreset(veh, uv.defaultPresetId, player.id);
    // 爱车 description 绑定 3D 文本（有描述才挂，跟随车辆移动）
    // 注意：附着车辆时 x/y/z 是相对车辆的偏移（对齐原版 CreateDynamic3DTextLabel
    // 附车时传 0,0,0），传绝对坐标会导致标签出现在世界原点/错位
    if (uv.description) {
      const label = new Dynamic3DTextLabel({
        text: uv.description,
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
  if (isInRace(player.id)) return;
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
export function initVehicleCommands(): void {
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
          const uv = await tx.userVehicle.findUnique({
            where: { userId_modelId: { userId: auth.userId, modelId } },
          });
          // 目标预设：爱车默认预设；无则懒创建并设为默认（index = 组内 max+1）
          let presetId = uv?.defaultPresetId ?? null;
          if (!presetId) {
            const maxIdx = await tx.vehiclePreset.findFirst({
              where: { userId: auth.userId, modelId, deletedAt: null },
              orderBy: { index: "desc" },
              select: { index: true },
            });
            const created = await tx.vehiclePreset.create({
              data: {
                userId: auth.userId,
                modelId,
                index: (maxIdx?.index ?? -1) + 1,
                name: null,
              },
            });
            presetId = created.id;
            await tx.userVehicle.update({
              where: { userId_modelId: { userId: auth.userId, modelId } },
              data: { defaultPresetId: created.id },
            });
          }
          const preset = await tx.vehiclePreset.findUnique({ where: { id: presetId } });
          const list = (preset?.modComponents ? preset.modComponents.split(" ") : []).filter(Boolean);
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

  PlayerEvent.onCommandText(["c", "veh"], ({ player, subcommand, next }) => {
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
        "刷车: /c [车辆ID400-611] · /c list 图片选车 · /c wode 召唤 · /cc 色1 色2 · /c lock · /c chepai 文字 · /c kick",
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
    const veh = playerVehs.get(player.id);
    if (!veh) {
      player.sendClientMessage(COLOR_ERROR, "你还没有刷过车，先 /c 车辆ID 刷车");
      return next();
    }
    const pos = player.getPos();
    const angle = player.isInAnyVehicle()
      ? player.getVehicle()!.getZAngle().angle
      : player.getFacingAngle().angle;
    veh.setPos(pos.x, pos.y, pos.z);
    veh.setZAngle(angle);
    veh.setVirtualWorld(player.getVirtualWorld());
    veh.linkToInterior(player.getInterior());
    veh.addComponent(1010);
    veh.putPlayerIn(player, 0);
    player.sendClientMessage(COLOR_SUCCESS, "爱车已召唤到身边");
    return next();
  });

  PlayerEvent.onCommandText(["c lock", "veh lock"], async ({ player, next }) => {
    const veh = playerVehs.get(player.id);
    if (!veh) {
      player.sendClientMessage(COLOR_ERROR, "你还没有车");
      return next();
    }
    const { doors } = veh.getParamsEx();
    const isLocked = doors < 1;
    veh.toggleDoors(isLocked);
    // 锁车状态落库（与面板菜单一致，重刷车保持锁定）
    const auth = getAuthState(player.id);
    if (auth) {
      await prisma.userVehicle.updateMany({
        where: { userId: auth.userId, modelId: veh.getModel() },
        data: { isLocked },
      });
    }
    player.sendClientMessage(COLOR_WHITE, isLocked ? "爱车已上锁" : "爱车已解锁");
    return next();
  });

  // /cc 色1 色2 换色（对齐原版 /cc，提示文案已多处引用）
  PlayerEvent.onCommandText(["cc", "c color", "veh color"], ({ player, subcommand, next }) => {
    const veh = playerVehs.get(player.id);
    if (!veh) {
      player.sendClientMessage(COLOR_ERROR, "你还没有刷过车，先 /c 车辆ID 刷车");
      return next();
    }
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
    veh.changeColors(c1, c2);
    player.sendClientMessage(COLOR_SUCCESS, `颜色已更换为 ${c1} / ${c2}`);
    return next();
  });

  PlayerEvent.onCommandText(["c chepai", "veh chepai"], async ({ player, subcommand, next }) => {
    const veh = playerVehs.get(player.id);
    if (!veh) {
      player.sendClientMessage(COLOR_ERROR, "你还没有车");
      return next();
    }
    const plate = subcommand.join(" ").trim();
    if (!plate) {
      player.sendClientMessage(COLOR_ERROR, "用法: /c chepai 车牌文字（≤10字符）");
      return next();
    }
    if (plate.length > 10) {
      player.sendClientMessage(COLOR_ERROR, "车牌文字最多 10 个字符");
      return next();
    }
    veh.setNumberPlate(plate);
    // 车牌落库（爱车列表从 user_vehicle 读取，不落库重刷车后车牌即丢失）
    const auth = getAuthState(player.id);
    if (auth) {
      await prisma.userVehicle.updateMany({
        where: { userId: auth.userId, modelId: veh.getModel() },
        data: { plateNumber: plate },
      });
    }
    player.sendClientMessage(COLOR_SUCCESS, "车牌已更换");
    return next();
  });

  PlayerEvent.onCommandText(["c kick", "veh kick"], ({ player, next }) => {
    const veh = playerVehs.get(player.id);
    if (!veh) {
      player.sendClientMessage(COLOR_ERROR, "你还没有车");
      return next();
    }
    let kicked = 0;
    for (const p of Player.getInstances()) {
      if (p.isNpc() || !p.isConnected() || p.id === player.id) continue;
      if (!p.isInAnyVehicle()) continue;
      if (p.getVehicle() !== veh) continue;
      const pos = p.getPos();
      p.setPos(pos.x, pos.y, pos.z + 5);
      // U2：实际是车主主动踢人（车没锁），文案与动作一致
      p.sendClientMessage(COLOR_ERROR, "你被车主移出了车辆");
      kicked++;
    }
    player.sendClientMessage(
      COLOR_SUCCESS,
      kicked > 0 ? `已踢出 ${kicked} 名乘客` : "车内没有其他乘客",
    );
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

/** e-selection 图片选车（3D 预览车辆模型），选中后刷车 */
async function showVehicleSelection(
  player: Player,
  cat: { label: string; menuTitle: string; models: number[] },
): Promise<void> {
  const { ModelSelectionMenu } = await import("@infernus/e-selection");
  const menu = new ModelSelectionMenu({
    player,
    models: cat.models.map((modelId) => ({
      modelId,
      modelText: `${vehicleName(modelId)} [${modelId}]`,
    })),
    headerText: cat.menuTitle,
    // 一页 14 个（e-selection 布局：第一行 6 + 第二行 8，两行铺满）
    maxItemPerPage: 14,
    bannerColor: "#333",
    menuBgColor: "#222",
    menuTextColor: "#fff",
    itemBgColor: "#444",
    itemTextColor: "#0f0",
  });
  const model = await menu.show();
  if (model) {
    await spawnVehicle(player, model.modelId);
  }
}
