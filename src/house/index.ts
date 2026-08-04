import {
  Dialog,
  DialogStylesEnum,
  Dynamic3DTextLabel,
  DynamicArea,
  DynamicObject,
  Player,
  PlayerEvent,
  Vehicle,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { showDialog } from "@/utils/dialog";
import { registerObjectCollision, clearObjectCollisions } from "@/core/collision";
import { teleportTo } from "@/teleport";
import { DEFAULT_CHARSET } from "@/utils/constants";

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
/** 已加载的房屋 3D 文本标签 */
const loadedLabels: Dynamic3DTextLabel[] = [];
/** 已加载的静态车辆（CreateVehicle） */
const loadedVehicles: Vehicle[] = [];
/** 已加载的流式区域（area） */
const loadedAreas: DynamicArea[] = [];

/**
 * 房屋建筑移除列表（removeobj）：玩家认证后对其应用（removeBuilding 是 per-player）。
 * 全局收集一次，登录时逐个玩家执行。
 */
const removedBuildings: { modelId: number; x: number; y: number; z: number; radius: number }[] = [];

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
 * 房屋模型类型（对齐 rst-backend house-model.dto VALID_TYPE_ARGS）。
 * gm-lite 静态加载支持：obj / material / materialtext / removeobj / 3dtext / CreateVehicle / area；
 * 依赖经济/动画/状态机的类型（sell/move/moveobj/changeobj）跳过并记录日志。
 */
const SKIPPED_TYPES = new Set(["sell", "move", "moveobj", "changeobj"]);

/** 解析颜色参数（支持 0x 前缀十六进制 / 十进制 / 数字字符串） */
function parseColor(raw: string): string | number | null {
  const s = raw.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) {
    const n = Number.parseInt(s, 16);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 解析数字 */
function num(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 房屋级加载统计（用于日志） */
interface HouseLoadStats {
  obj: number;
  material: number;
  materialtext: number;
  removeobj: number;
  labels: number;
  vehicles: number;
  areas: number;
  skipped: number;
  errors: number;
}

/**
 * 加载所有启用房屋的模型（多类型）。
 * 行顺序（按 houseId, index）：先建 obj 实体 → material/materialtext 绑定同屋 obj 材质
 * → removeobj 收集（登录时应用）→ 3dtext/CreateVehicle/area 直接创建。
 * 支持重载：开头清掉上一轮注册的 colandreas 碰撞，防止同批物体重复注册。
 */
export async function loadAllHouseObjects(): Promise<void> {
  // 防重复注册：若本函数被再次调用（重载），先销毁上一轮的碰撞注册
  clearObjectCollisions();
  const stats: HouseLoadStats = {
    obj: 0,
    material: 0,
    materialtext: 0,
    removeobj: 0,
    labels: 0,
    vehicles: 0,
    areas: 0,
    skipped: 0,
    errors: 0,
  };
  try {
    const models = await prisma.houseModel.findMany({
      // 只加载未软删且启用的房屋：软删房（deletedAt != null）若 isEnabled 仍为
      // true 会残留模型/标签/车辆实体
      where: { house: { isEnabled: true, deletedAt: null } },
      orderBy: [{ houseId: "asc" }, { index: "asc" }],
      include: { house: true },
    });

    const objs: DynamicObject[] = [];
    const labels: Dynamic3DTextLabel[] = [];
    const vehicles: Vehicle[] = [];
    const areas: DynamicArea[] = [];
    const buildings: typeof removedBuildings = [];
    // 材质绑定目标：houseId -> (objIndex -> DynamicObject)，供 material/materialtext 查找
    const objByHouse = new Map<string, Map<number, DynamicObject>>();
    const skippedTypes = new Set<string>();
    const houseName = (id: string | null, fallback: string): string =>
      id ? fallback : "(未关联房屋)";

    for (const m of models) {
      const hname = houseName(m.houseId, m.house?.name ?? "?");
      try {
        if (SKIPPED_TYPES.has(m.type)) {
          skippedTypes.add(m.type);
          stats.skipped++;
          continue;
        }
        switch (m.type) {
          case "obj": {
            const args = parseObjArgs(m.args);
            if (!args) {
              logger.warn(`[house] obj 参数无效 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
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
            objs.push(obj);
            // 注册进 colandreas 碰撞网格：传送/出生定位可命中它（落在屋顶而非卡进屋里）
            registerObjectCollision(
              args.modelId,
              args.x,
              args.y,
              args.z,
              args.rx,
              args.ry,
              args.rz,
            );
            // 登记到该房屋的 obj 索引表（材质绑定目标）
            if (m.houseId) {
              let map = objByHouse.get(m.houseId);
              if (!map) {
                map = new Map();
                objByHouse.set(m.houseId, map);
              }
              map.set(m.index, obj);
            }
            stats.obj++;
            break;
          }
          case "material": {
            // 格式：{index} {modelId} {txdName} {textureName} {color}
            const parts = m.args.trim().split(/\s+/);
            if (parts.length < 5) {
              logger.warn(`[house] material 参数不足 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
            const objIndex = num(parts[0]);
            const modelId = num(parts[1]);
            const color = parseColor(parts.slice(4).join(" "));
            const target = m.houseId ? objByHouse.get(m.houseId)?.get(objIndex ?? -1) : undefined;
            if (objIndex == null || modelId == null || !target) {
              logger.warn(`[house] material 未找到目标 obj house=${hname} objIndex=${parts[0]}`);
              stats.errors++;
              break;
            }
            target.setMaterial(0, modelId, parts[2], parts[3], color ?? undefined);
            stats.material++;
            break;
          }
          case "materialtext": {
            // 格式：{index} {text} {textSize} {fontFace} {fontSize} {textBold} {fontColor} {bgColor} {alignment}
            // text 为单字段（空格分隔格式下含空格无法区分，与后端校验规则一致）
            const parts = m.args.trim().split(/\s+/);
            if (parts.length < 9) {
              logger.warn(`[house] materialtext 参数不足 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
            const objIndex = num(parts[0]);
            const target = m.houseId ? objByHouse.get(m.houseId)?.get(objIndex ?? -1) : undefined;
            if (objIndex == null || !target) {
              logger.warn(
                `[house] materialtext 未找到目标 obj house=${hname} objIndex=${parts[0]}`,
              );
              stats.errors++;
              break;
            }
            const textSize = num(parts[2]);
            const fontSize = num(parts[4]);
            const bold = parts[5] === "1" || parts[5] === "true";
            const fontColor = parseColor(parts[6]);
            const bgColor = parseColor(parts[7]);
            const alignment = num(parts[8]);
            const text = parts[1];
            if (textSize == null || fontSize == null || alignment == null) {
              logger.warn(`[house] materialtext 数值无效 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
            // charset 用默认字符集（材质文字支持中文，对齐其他中文文本入口）
            // DynamicObject.setMaterialText 参数顺序：charset, materialIndex, text, ...
            target.setMaterialText(
              DEFAULT_CHARSET,
              0,
              text,
              textSize,
              parts[3],
              fontSize,
              bold ? 1 : 0,
              fontColor ?? 0xffffffff,
              bgColor ?? 0x00000000,
              alignment,
            );
            stats.materialtext++;
            break;
          }
          case "removeobj": {
            // 格式：{modelId} {x} {y} {z} {radius}
            const parts = m.args.trim().split(/\s+/).map(Number);
            if (parts.length < 5 || parts.some((n) => !Number.isFinite(n))) {
              logger.warn(`[house] removeobj 参数无效 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
            buildings.push({
              modelId: parts[0],
              x: parts[1],
              y: parts[2],
              z: parts[3],
              radius: parts[4],
            });
            stats.removeobj++;
            break;
          }
          case "3dtext": {
            // 格式：{text} {x} {y} {z}（text 可含空格，后三位为坐标）
            const parts = m.args.trim().split(/\s+/);
            if (parts.length < 4) {
              logger.warn(`[house] 3dtext 参数不足 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
            const x = num(parts[parts.length - 3]);
            const y = num(parts[parts.length - 2]);
            const z = num(parts[parts.length - 1]);
            if (x == null || y == null || z == null) {
              logger.warn(`[house] 3dtext 坐标无效 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
            const label = new Dynamic3DTextLabel({
              text: parts.slice(0, parts.length - 3).join(" "),
              color: "#ffd700",
              x,
              y,
              z,
              drawDistance: 30,
              testLOS: false,
              charset: DEFAULT_CHARSET, // 房屋文字可能含中文
            });
            label.create();
            labels.push(label);
            stats.labels++;
            break;
          }
          case "CreateVehicle": {
            // 格式：{modelId} {x} {y} {z} {angle} {color1} {color2}
            const parts = m.args.trim().split(/\s+/).map(Number);
            if (parts.length < 7 || parts.some((n) => !Number.isFinite(n))) {
              logger.warn(`[house] CreateVehicle 参数无效 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
            const veh = new Vehicle({
              modelId: parts[0],
              x: parts[1],
              y: parts[2],
              z: parts[3],
              zAngle: parts[4],
              color: [parts[5], parts[6]],
              respawnDelay: -1, // 静态车不重生
            });
            veh.create();
            vehicles.push(veh);
            stats.vehicles++;
            break;
          }
          case "area": {
            // 格式：{x} {y} {radius}
            const parts = m.args.trim().split(/\s+/).map(Number);
            if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
              logger.warn(`[house] area 参数无效 house=${hname} args=${m.args}`);
              stats.errors++;
              break;
            }
            const area = new DynamicArea({
              type: "circle",
              x: parts[0],
              y: parts[1],
              size: parts[2],
            });
            area.create();
            areas.push(area);
            stats.areas++;
            break;
          }
          default:
            logger.warn(`[house] 未知模型类型 house=${hname} type=${m.type}`);
            stats.errors++;
        }
      } catch (e) {
        logger.error(`[house] 加载模型失败 house=${hname} type=${m.type} args=${m.args}`, e);
        stats.errors++;
      }
    }

    // 提交新集合（替换旧引用，卸载函数据此清理）
    loadedObjects.length = 0;
    loadedObjects.push(...objs);
    loadedLabels.length = 0;
    loadedLabels.push(...labels);
    loadedVehicles.length = 0;
    loadedVehicles.push(...vehicles);
    loadedAreas.length = 0;
    loadedAreas.push(...areas);
    removedBuildings.length = 0;
    removedBuildings.push(...buildings);

    logger.info(
      `[house] 房屋模型加载完成 obj=${stats.obj} material=${stats.material} materialtext=${stats.materialtext} ` +
        `removeobj=${stats.removeobj} 3dtext=${stats.labels} vehicle=${stats.vehicles} area=${stats.areas} ` +
        `跳过=${stats.skipped} 失败=${stats.errors}` +
        (skippedTypes.size > 0 ? `（不支持的动态类型：${[...skippedTypes].join(",")}）` : ""),
    );
  } catch (e) {
    logger.error("[house] 加载房屋模型失败", e);
  }
}

/**
 * 对玩家应用房屋建筑移除（removeobj）。
 * removeBuilding 是 per-player，需在玩家认证后逐个执行；连接断开后随连接消失，无需清理。
 */
export function applyHouseRemovedBuildings(player: Player): void {
  for (const b of removedBuildings) {
    try {
      player.removeBuilding(b.modelId, b.x, b.y, b.z, b.radius);
    } catch (e) {
      logger.warn(`[house] removeobj 应用失败 ${player.getName().name} model=${b.modelId}`, e);
    }
  }
}

/** 卸载全部房屋实体（GameMode 退出时） */
export function unloadAllHouseObjects(): void {
  for (const obj of loadedObjects) {
    if (obj.isValid()) obj.destroy();
  }
  loadedObjects.length = 0;
  for (const label of loadedLabels) {
    if (label.isValid()) label.destroy();
  }
  loadedLabels.length = 0;
  for (const veh of loadedVehicles) {
    if (veh.isValid()) veh.destroy();
  }
  loadedVehicles.length = 0;
  for (const area of loadedAreas) {
    if (area.isValid()) area.destroy();
  }
  loadedAreas.length = 0;
  removedBuildings.length = 0;
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
      player.sendClientMessage(COLOR_WHITE, "房屋命令: /house list 列表 · /house goto 名称 传送");
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
  const info = houses
    .map((h, i) => `${i + 1}. ${h.name}${h.description ? `（${h.description}）` : ""}`)
    .join("\n");
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
  // await 后复查断线（查询期间玩家可能已掉线）
  if (!player.isConnected()) return;
  // 用 teleportTo 统一处理：车内 linkToInterior（防人车分离）+ 传送后冻结
  // （房屋 interior 物件流式加载，不冻结会下坠/穿模）
  teleportTo(player, Number(tp.x), Number(tp.y), Number(tp.z), Number(tp.angle), tp.interiorId);
  player.sendClientMessage(COLOR_WHITE, `[房屋] 已传送到 ${tp.house?.name ?? houseName}`);
}
