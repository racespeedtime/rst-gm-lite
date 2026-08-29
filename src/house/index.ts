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
import { sysMsg } from "@/utils/msg";
import {
  registerObjectCollision,
  unregisterObjectCollision,
  clearObjectCollisions,
} from "@/core/collision";
import { teleportTo } from "@/teleport";
import { setTimeoutSafe } from "@/core/timers";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { PUBLIC_WORLD_ID } from "@/sessions/session";
import { RACE_WORLD_BASE } from "@/race/room";
import { REPLAY_WORLD_BASE } from "@/replay/playback";
import { isPlayerLocked } from "@/core/interaction";
/**
 * 房屋物件可见世界区间（按数组传，streamer 支持）：
 * - 普通房屋（不关联赛车）：公共大世界 0 + 战局 1..1000——赛道/回放世界看不到
 * - 关联赛道的房屋（House.race，含 5F 导入的赛道场景对象）：赛道世界
 *   1001..2000 + 回放/挑战世界 2001..2100 可见（赛道场景只在比赛/回放/挑战时
 *   出现），公共大世界与战局不可见——避免赛道物件堆在地图上
 * - 关联传送点的房屋：传送点都在战局世界使用（/house goto、//名称），战局区间
 *   已覆盖，与普通房屋一致
 */
const SESSION_WORLD_IDS: number[] = [
  PUBLIC_WORLD_ID,
  ...Array.from({ length: 1000 }, (_, i) => i + 1),
];
/** 战局 + 比赛区间（关联赛道的房屋可见） */
/** 战局 + 比赛区间（关联赛道的房屋可见） */
/** 赛道 + 回放/挑战区间（关联赛道的房屋：赛道场景对象，赛道房间与回放/挑战
 *  播放时可见；公共大世界/战局不可见——避免赛道物件堆在地图上）。
 *  回放世界从 REPLAY_WORLD_BASE(2001) 起，MAX_REPLAY_NPC=100 限制并发 → 取 2001..2100 */
const RACE_REPLAY_WORLD_IDS: number[] = [
  ...Array.from({ length: 1000 }, (_, i) => i + RACE_WORLD_BASE),
  ...Array.from({ length: 100 }, (_, i) => i + REPLAY_WORLD_BASE),
];

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

/**
 * 解码文本字段（对齐 rst-backend/frontend 的 URL 编码约定）：
 * 3dtext 的 text、materialtext 的 text/fontFace 因 args 是空格分隔单字段，
 * 含空格/中文的文本在导入文件中用 encodeURIComponent 编码。这里解码：
 * - 普通文本（无 %）原样返回（幂等，OP 手动输入中文不受影响）
 * - 非法 % 序列（如文本恰含 "100%"）try/catch 原样返回
 */
function decodeText(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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
 * attempt（内部重试计数）：onInit 时机 DB 连接池可能尚未就绪，一次查询失败会让
 * 整批房屋实体（obj/标签/车辆）缺失且永不补建——失败后 30s 重试（上限
 * HOUSE_LOAD_RETRY 次），DB 就绪后自动补加载；成功或达到上限停止。
 */
const HOUSE_LOAD_RETRY = 5;
const HOUSE_LOAD_RETRY_MS = 30_000;

export async function loadAllHouseObjects(attempt = 1): Promise<void> {
  // 防重复注册：若本函数被再次调用（重载/重试成功后的再次加载），先销毁上一轮的碰撞注册
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
  // 声明提到 try 外：中途失败（DB 断开/创建异常）时 catch 需清理已创建的部分
  // 实体，防残留 + 防重试重复创建
  const objs: DynamicObject[] = [];
  const labels: Dynamic3DTextLabel[] = [];
  const vehicles: Vehicle[] = [];
  const areas: DynamicArea[] = [];
  const buildings: typeof removedBuildings = [];
  // 材质绑定目标：houseId -> (objIndex -> DynamicObject)，供 material/materialtext 查找
  const objByHouse = new Map<string, Map<number, DynamicObject>>();
  try {
    const models = await prisma.houseModel.findMany({
      // 只加载未软删且启用的房屋：软删房（deletedAt != null）若 isEnabled 仍为
      // true 会残留模型/标签/车辆实体
      where: { house: { isEnabled: true, deletedAt: null } },
      orderBy: [{ houseId: "asc" }, { index: "asc" }],
      include: { house: { include: { race: { select: { id: true } } } } },
    });

    const skippedTypes = new Set<string>();
    const houseName = (id: string | null, fallback: string): string =>
      id ? fallback : "(未关联房屋)";

    for (const m of models) {
      const hname = houseName(m.houseId, m.house?.name ?? "?");
      // 赛道专属对象（raceOnly=true，如 5F 空中赛道/护栏）：静态加载跳过——
      // 由比赛/挑战/回放动态加载到对应世界（玩该赛道才显示，见 loadRaceOnlyObjects）
      if (m.house?.raceOnly) {
        stats.skipped++;
        continue;
      }
      // 世界区间按"是否关联赛道"判定：
      // - 关联赛道的普通房屋（非 raceOnly）：赛道世界（1001..2000）+ 回放/挑战
      //   世界（2001..2100）可见，公共大世界/战局不可见
      // - 普通房屋（不关联赛道）：公共大世界 + 战局（0 + 1..1000）
      const worldIds = m.house?.race ? RACE_REPLAY_WORLD_IDS : SESSION_WORLD_IDS;
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
              worldId: worldIds, // 关联赛道→含比赛世界；否则仅战局区间
              extended: true,
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
            // text / fontFace：导入文件里可能是 URL 编码的（对齐 frontend 约定）→ 解码
            const text = decodeText(parts[1]);
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
              decodeText(parts[3]), // fontFace 同约定：可能是 URL 编码
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
              // text：导入文件里可能是 URL 编码的（对齐 frontend 约定）→ 解码
              text: decodeText(parts.slice(0, parts.length - 3).join(" ")),
              color: "#ffd700",
              x,
              y,
              z,
              drawDistance: 30,
              testLOS: false,
              charset: DEFAULT_CHARSET, // 房屋文字可能含中文
              worldId: worldIds, // 关联赛道→含比赛世界；否则仅战局区间
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
            // 静态车固定公共战局世界：Vehicle 是单世界实体（setVirtualWorld 是
            // 单值，循环铺多个世界既只有最后值生效、又让人误以为每个世界都占一辆
            // 车槽）——干脆只放公共战局（房屋静态车只在战局区间可见）
            veh.setVirtualWorld(PUBLIC_WORLD_ID);
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
              worldId: worldIds, // 关联赛道→含比赛世界；否则仅战局区间
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

    // 提交新集合：先销毁上一批已加载的实体（卸载函数据此清理；幂等，首次为空）。
    // 失败重试的定时器与 OP 手动重载可能并发：若不销毁旧批，重试回调成功后再
    // 提交会留下上一批的 obj/标签/车/area 双份实体，且新数组使旧批无法再被清理
    unloadAllHouseObjects();
    loadedObjects.push(...objs);
    loadedLabels.push(...labels);
    loadedVehicles.push(...vehicles);
    loadedAreas.push(...areas);
    removedBuildings.push(...buildings);

    logger.info(
      `[house] 房屋模型加载完成 obj=${stats.obj} material=${stats.material} materialtext=${stats.materialtext} ` +
        `removeobj=${stats.removeobj} 3dtext=${stats.labels} vehicle=${stats.vehicles} area=${stats.areas} ` +
        `跳过=${stats.skipped} 失败=${stats.errors}` +
        (skippedTypes.size > 0 ? `（不支持的动态类型：${[...skippedTypes].join(",")}）` : ""),
    );
  } catch (e) {
    logger.error(`[house] 加载房屋模型失败（第 ${attempt} 次）`, e);
    // 清理本次已创建的部分实体（中途失败残留），防重试时重复创建同批实体
    for (const obj of objs) {
      try {
        if (obj.isValid()) obj.destroy();
      } catch {
        /* 已失效 */
      }
    }
    for (const label of labels) {
      try {
        if (label.isValid()) label.destroy();
      } catch {
        /* 已失效 */
      }
    }
    for (const veh of vehicles) {
      try {
        if (veh.isValid()) veh.destroy();
      } catch {
        /* 已失效 */
      }
    }
    for (const area of areas) {
      try {
        if (area.isValid()) area.destroy();
      } catch {
        /* 已失效 */
      }
    }
    // onInit 时机 DB 未就绪等一次性失败：延迟重试补加载（上限内），防整批房屋
    // 实体缺失且无人发现（obj 不建 = 赛道/房屋场景消失）。上限达后放弃——
    // 持续连不上说明 DB 真有问题，不再空转重试
    if (attempt < HOUSE_LOAD_RETRY) {
      setTimeoutSafe(() => void loadAllHouseObjects(attempt + 1), HOUSE_LOAD_RETRY_MS);
    }
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
  // 动态赛道对象一并卸载（防退出残留）
  unloadAllRaceOnlyObjects();
}

// ---------------------------------------------------------------------------
// 赛道专属对象动态加载（raceOnly=true 的 house：只在游玩对应赛道/挑战/回放时
// 加载到该次分配的世界，其他时间不显示——避免不同赛道的对象在别的赛道重叠出现）
//
// 按 worldId 键控而非 raceId：同一赛道可被多个房间/战局同时游玩（每个房间分配
// 独立 worldId 1001..2000），各房间的对象实体互相独立——A 房间销毁不影响 B
// 房间；同赛道在两个房间各自加载一份到各自世界。worldId 由 allocRaceWorld/
// allocReplayWorld 分配且唯一（房间/回放销毁后回收），一个 worldId 至多一份。
// ---------------------------------------------------------------------------

interface RaceOnlyLoaded {
  raceId: string;
  items: { obj: DynamicObject; collision: unknown }[];
}

/** worldId -> 该世界已加载的动态赛道对象（含碰撞注册引用，销毁时一并注销） */
const loadedRaceOnly = new Map<number, RaceOnlyLoaded>();
/** 加载中的 worldId（防 async 加载期间重复进入；unload 时会清除） */
const loadingRaceOnly = new Set<number>();

/** 卸载指定世界的动态赛道对象（房间销毁/挑战退出/回放停止/换赛道时调用） */
export function unloadRaceOnlyObjects(worldId: number): void {
  loadingRaceOnly.delete(worldId); // 取消可能进行中的加载（load 续体会自查并销毁）
  const entry = loadedRaceOnly.get(worldId);
  if (!entry) return;
  for (const it of entry.items) {
    if (it.obj.isValid()) it.obj.destroy();
    if (it.collision) unregisterObjectCollision(it.collision as never);
  }
  loadedRaceOnly.delete(worldId);
}

/** 卸载全部动态赛道对象（GameMode 退出） */
export function unloadAllRaceOnlyObjects(): void {
  for (const worldId of [...loadedRaceOnly.keys()]) {
    unloadRaceOnlyObjects(worldId);
  }
}

/**
 * 加载指定赛道的专属对象到指定世界（比赛房间 worldId / 挑战回放世界）。
 * 按 worldId 幂等：该世界已加载则不重复创建（换赛道先 unload 再 load）。
 * 只处理该赛道关联的 house（race.houseId）且 raceOnly=true 的 obj 行；
 * 返回是否加载了任何对象（调用方据此决定是否需要在销毁时卸载）。
 */
export async function loadRaceOnlyObjects(raceId: string, worldId: number): Promise<boolean> {
  if (loadedRaceOnly.has(worldId)) return true; // 该世界已加载
  if (loadingRaceOnly.has(worldId)) return false; // 该世界加载进行中（防并发重复）
  loadingRaceOnly.add(worldId);
  try {
    // 查该赛道关联的 raceOnly house（race.houseId 唯一关联）
    const race = await prisma.race.findUnique({
      where: { id: raceId },
      select: { houseId: true },
    });
    if (!race?.houseId) return false;
    const house = await prisma.house.findUnique({
      where: { id: race.houseId },
      select: { id: true, raceOnly: true, isEnabled: true, deletedAt: true },
    });
    if (!house || !house.raceOnly || !house.isEnabled || house.deletedAt) return false;
    const models = await prisma.houseModel.findMany({
      where: { houseId: house.id },
      orderBy: { index: "asc" },
    });
    const items: { obj: DynamicObject; collision: unknown }[] = [];
    for (const m of models) {
      if (m.type !== "obj") continue; // 5F 导入只有 obj；material 等动态场景暂不支持
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
          worldId, // 单世界：只在该赛道这次分配的世界可见
        });
        obj.create();
        obj.setNoCameraCollision();
        const collision = registerObjectCollision(
          args.modelId,
          args.x,
          args.y,
          args.z,
          args.rx,
          args.ry,
          args.rz,
        );
        items.push({ obj, collision });
      } catch (e) {
        logger.warn(`[house] 动态赛道对象创建失败 race=${raceId} model=${args.modelId}`, e);
      }
    }
    // 加载期间该世界可能已被销毁（房间解散/挑战退出/回放停止触发 unload 清了
    // loading 标记）：若已不在 loading 集合，说明上下文已消失，销毁刚创建的对象
    // 防孤儿实体残留（世界 id 可能已被回收复用给别的房间）
    if (!loadingRaceOnly.has(worldId)) {
      for (const it of items) {
        if (it.obj.isValid()) it.obj.destroy();
        if (it.collision) unregisterObjectCollision(it.collision as never);
      }
      return false;
    }
    if (items.length) {
      loadedRaceOnly.set(worldId, { raceId, items });
      return true;
    }
    return false;
  } finally {
    loadingRaceOnly.delete(worldId);
  }
}

/** 初始化房屋命令 */
export function initHouseCommands(): void {
  PlayerEvent.onCommandText("house", async ({ player, subcommand, next }) => {
    const cmd = subcommand[0];
    // 弹窗锁定期禁止打开房屋列表（防替换面板对话框导致锁泄漏，对齐 /p 守卫）
    if (isPlayerLocked(player.id)) {
      sysMsg(player, "house", "当前正在其他流程中，请稍后再试", "info");
      return next();
    }
    if (cmd === "list") {
      await houseList(player);
    } else if (cmd === "goto") {
      await houseGoto(player, subcommand.slice(1).join(" "));
    } else {
      sysMsg(player, "house", "房屋命令: /house list 列表 · /house goto 名称 传送", "plain");
    }
    return next();
  });
}

async function houseList(player: Player): Promise<void> {
  const houses = await prisma.house.findMany({
    where: { isEnabled: true, deletedAt: null },
    orderBy: { name: "asc" },
    include: { sysUser: true }, // 房主名（无主房屋 userId 为空）
  });
  if (houses.length === 0) {
    sysMsg(player, "house", "暂无可用房屋", "plain");
    return;
  }
  // TABLIST_HEADERS 多列：名称 / 描述 / 房主（表头不占行号）
  const info = [
    "{FFD700}名称\t描述\t房主",
    ...houses.map((h) => `${h.name}\t${h.description ?? "—"}\t${h.sysUser?.username ?? "—"}`),
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.TABLIST_HEADERS,
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
    sysMsg(player, "house", "用法: /house goto 房屋名称", "error");
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
    sysMsg(player, "house", `未找到房屋「${houseName}」的传送点`, "error");
    return;
  }
  // await 后复查断线（查询期间玩家可能已掉线）
  if (!player.isConnected()) return;
  // 用 teleportTo 统一处理：车内 linkToInterior（防人车分离）+ 传送后冻结
  // （房屋 interior 物件流式加载，不冻结会下坠/穿模）
  teleportTo(player, Number(tp.x), Number(tp.y), Number(tp.z), Number(tp.angle), tp.interiorId);
  sysMsg(player, "house", `已传送到 ${tp.house?.name ?? houseName}`, "info");
}
