import { Dialog, DialogStylesEnum, DynamicObject, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { showDialog } from "@/utils/dialog";

import { COLOR_WHITE, COLOR_ERROR } from "@/utils/colors";

/** 房屋 obj 行格式：modelId x y z rX rY rZ（可选 drawDistance） */
interface ObjArgs {
  modelId: number;
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  drawDistance?: number;
}

export function parseObjArgs(args: string): ObjArgs | null {
  const parts = args.trim().split(/\s+/).map(Number);
  if (parts.length < 7 || parts.some((n) => !Number.isFinite(n))) return null;
  const [modelId, x, y, z, rx, ry, rz] = parts;
  return { modelId, x, y, z, rx, ry, rz, drawDistance: parts[7] };
}

/** 已加载的房屋 obj（global，公共大世界 world 0） */
const loadedObjects: DynamicObject[] = [];

/** 设置某玩家对全部房屋物件的可见性（世界个性化→显示物件开关） */
export function setHouseObjectsVisibleForPlayer(player: Player, visible: boolean): void {
  // 全局 streamer 流式对象显隐（对齐原版"显示物件"开关：隐藏场景物件降低干扰）
  if (visible) {
    DynamicObject.showForPlayer(player);
  } else {
    DynamicObject.hideForPlayer(player);
  }
}

/**
 * 加载所有启用房屋的 obj（纯模型加载，无购买）。
 * 每行 house_model.type='obj' → 一个 DynamicObject（公共大世界）。
 */
export async function loadAllHouseObjects(): Promise<void> {
  try {
    const models = await prisma.houseModel.findMany({
      where: { house: { isEnabled: true } },
      orderBy: [{ houseId: "asc" }, { index: "asc" }],
      include: { house: true },
    });
    const objs = new Set<DynamicObject>();
    for (const m of models) {
      if (m.type !== "obj") continue;
      const args = parseObjArgs(m.args);
      if (!args) continue;
      try {
        const obj = new DynamicObject({
          modelId: args.modelId,
          x: args.x,
          y: args.y,
          z: args.z,
          rx: args.rx,
          ry: args.ry,
          rz: args.rz,
          drawDistance: args.drawDistance ?? 400,
        });
        obj.create();
        // 相机无碰撞：镜头可穿透物体（避免被房屋模型遮挡视野）
        obj.setNoCameraCollision();
        objs.add(obj);
      } catch (e) {
        logger.error(`[house] 加载 obj 失败 house=${m.house?.name} args=${m.args}`, e);
      }
    }
    loadedObjects.length = 0;
    loadedObjects.push(...objs);
    logger.info(`[house] 已加载 ${objs.size} 个房屋模型`);
  } catch (e) {
    logger.error("[house] 加载房屋模型失败", e);
  }
}

/** 卸载全部房屋 obj（GameMode 退出时） */
export function unloadAllHouseObjects(): void {
  for (const obj of loadedObjects) {
    if (obj.isValid()) obj.destroy();
  }
  loadedObjects.length = 0;
}

/** 初始化房屋命令 */
export function initHouseCommands(): void {
  PlayerEvent.onCommandText("house", async ({ player, subcommand, next }) => {
    const cmd = subcommand[0];
    if (cmd === "list") {
      await houseList(player);
    } else if (cmd === "goto") {
      await houseGoto(player, subcommand.slice(1).join(" "));
    } else {
      player.sendClientMessage(
        COLOR_WHITE,
        "房屋命令: /house list 列表 · /house goto 名称 传送",
      );
    }
    return next();
  });
}

async function houseList(player: Player): Promise<void> {
  const houses = await prisma.house.findMany({
    where: { isEnabled: true, deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (houses.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "暂无可用房屋");
    return;
  }
  const info = houses.map((h, i) => `${i + 1}. ${h.name}${h.description ? `（${h.description}）` : ""}`).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "房屋列表",
      info,
      button1: "传送",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const house = houses[res.listItem];
  if (!house) return;
  await teleportToHouse(player, house.name);
}

async function houseGoto(player: Player, name: string): Promise<void> {
  if (!name) {
    player.sendClientMessage(COLOR_ERROR, "用法: /house goto 房屋名称");
    return;
  }
  await teleportToHouse(player, name);
}

/** 通过 teleport.houseId 找到房屋传送点并传送 */
async function teleportToHouse(player: Player, houseName: string): Promise<void> {
  const tp = await prisma.teleport.findFirst({
    where: { house: { name: houseName }, deletedAt: null },
    include: { house: true },
  });
  if (!tp) {
    player.sendClientMessage(COLOR_ERROR, `未找到房屋「${houseName}」的传送点`);
    return;
  }
  player.setInterior(tp.interiorId);
  if (player.isInAnyVehicle()) {
    const veh = player.getVehicle()!;
    veh.setPos(Number(tp.x), Number(tp.y), Number(tp.z));
    veh.setZAngle(Number(tp.angle));
  } else {
    player.setPos(Number(tp.x), Number(tp.y), Number(tp.z));
    player.setFacingAngle(Number(tp.angle));
  }
  player.sendClientMessage(COLOR_WHITE, `[房屋] 已传送到 ${tp.house?.name ?? houseName}`);
}
