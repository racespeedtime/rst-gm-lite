import { Player, Vehicle } from "@infernus/core";
import { logger } from "@/logger";
import { isValidVehicleModel } from "@/vehicles/catalog";
import {
  destroyPlayerVehicle,
  getOwnedVehicle,
  registerOwnedVehicle,
  getOrCreateUserVehicle,
  addVehicleComponentIfPossible,
} from "@/vehicles";
import { applyVehiclePreset } from "@/attire";
import { getAuthState } from "@/auth/auth";

import { COLOR_RACE } from "@/utils/colors";
import { sysMsg } from "@/utils/msg";

/** 脚本运算模式 */
type Op = "|" | "+" | "-" | "*" | "/";
const OPS: Record<string, Op> = { "|": "|", "+": "+", "-": "-", "*": "*", "/": "/" };

/** 距离换算：getSpeed() 返回 km/h（magic=180）；velocity 分量 = kmh / 180 */
export const KMH_UNIT = 180;

/** CP 脚本执行上下文：由比赛房间在创建时构建一次，避免每条脚本重复查库 */
export interface CpScriptContext {
  raceId: string;
  cpid: number;
  raceName: string;
  authorName: string;
  /** 该赛道全部 CP（#ncpx 等变量解析用，按 index 升序） */
  cps: { index: number; x: number; y: number; z: number }[];
}

/** 脚本创建（cveh 函数）的车辆，按玩家跟踪以便离开比赛/断线时销毁 */
const scriptVehicles = new Map<number, Vehicle>();

/** 清理玩家脚本创建的车辆（断线/离开比赛时调用）。
 *  若该车辆已是玩家的爱车（cveh 换车后登记），跳过——爱车由
 *  onPlayerDisconnectVehicle / 玩家持有管理，避免对已销毁车辆调用 destroy
 *  抛 "Cannot destroy before create" */
export function cleanupScriptVehicle(playerId: number): void {
  const v = scriptVehicles.get(playerId);
  if (v && v.isValid()) {
    if (getOwnedVehicle(playerId) === v) {
      scriptVehicles.delete(playerId);
      return;
    }
    v.destroy();
  }
  scriptVehicles.delete(playerId);
}

/**
 * 登记玩家名下需随比赛生命周期清理的车辆（脚本车 + 比赛默认发车）。
 * 加入比赛/开赛时发的默认车也登记进来，离开/结束时统一销毁，防泄漏。
 */
export function registerScriptVehicle(playerId: number, vehicle: Vehicle): void {
  scriptVehicles.set(playerId, vehicle);
}

/**
 * 提取脚本数组中第一个 cveh 换车指令的车型 ID（无则 null）。
 * 用于开赛/测试前决定默认车辆（赛道第一个 CP 有换车则用它，否则默认 411）。
 */
export function getFirstCvehModel(scripts: string[]): number | null {
  for (const script of scripts) {
    const [fn, raw] = script.trim().split(/\s+/);
    if (fn === "cveh") {
      const model = Number(raw);
      if (isValidVehicleModel(model)) return model;
    }
  }
  return null;
}

/**
 * 返回变量解析（#pname/#rname/#aname/#vs/#va/#vzs/#ncpx/y/z/#ncpa）
 */
function resolveVar(player: Player, ctx: CpScriptContext, varName: string): string {
  const veh = player.getVehicle();
  switch (varName) {
    case "#pname":
      return player.getName().name;
    case "#rname":
      return ctx.raceName;
    case "#aname":
      return ctx.authorName;
    case "#vs":
      return veh ? String(veh.getSpeed()) : "0";
    case "#va":
      // 对齐原版 Race_Cp_Script_Return：#va = 玩家朝向（GetPlayerFacingAngleEx）。
      // 车内时 open.mp 玩家朝向与车辆角度一致；下车后取玩家朝向更贴近原版语义
      return String(player.getFacingAngle().angle);
    case "#vzs":
      return veh ? String(veh.getVelocity().z) : "0";
    case "#ncpx":
    case "#ncpy":
    case "#ncpz":
    case "#ncpa": {
      // 下一个检查点信息（当前是最后则返回 0）
      const idx = ctx.cps.findIndex((c) => c.index === ctx.cpid);
      if (idx === -1 || idx === ctx.cps.length - 1) return "0";
      const next = ctx.cps[idx + 1];
      if (varName === "#ncpx") return String(next.x);
      if (varName === "#ncpy") return String(next.y);
      if (varName === "#ncpz") return String(next.z);
      // #ncpa：当前点与下一个点的角度，+90 偏移后归一化 0-360（对齐原版 atan2 + a=90+a）
      const cur = ctx.cps[idx];
      const ang = Math.atan2(cur.y - next.y, cur.x - next.x);
      const deg = (ang * 180) / Math.PI + 90;
      return String(((deg % 360) + 360) % 360);
    }
    default:
      return varName;
  }
}

/** 解析参数中的返回变量（同步：上下文已预载赛道数据，无需查库） */
function resolveArgs(player: Player, ctx: CpScriptContext, args: string[]): string[] {
  return args.map((arg) => (arg.startsWith("#") ? resolveVar(player, ctx, arg) : arg));
}

/** 运算模式应用 */
function applyOp(current: number, op: Op, value: number): number {
  switch (op) {
    case "+":
      return current + value;
    case "-":
      return current - value;
    case "*":
      return current * value;
    case "/":
      return value === 0 ? current : current / value;
    default:
      return value;
  }
}

function normOp(s: string): Op {
  return OPS[s] ?? "|";
}

/** 设置车辆速度：km/h → velocity 分量。
 * 坐标系对齐原版 speed/speedex：x = 速度·cos(na)、y = 速度·sin(na)，角度 0 = 正东
 * （SA-MP 方位角基准）。na 由调用方按"玩家朝向 + 90"（| 模式 = 角度 + 90）算好。 */
export function setVehicleSpeed(veh: Vehicle, kmh: number, angleDeg: number, z?: number): void {
  const units = kmh / KMH_UNIT;
  const rad = (angleDeg * Math.PI) / 180;
  veh.setVelocity(units * Math.cos(rad), units * Math.sin(rad), z ?? veh.getVelocity().z);
}

/**
 * 超级起步（superstart）：开局 GO 瞬间沿车头方向给全车一个向前初速（对齐 speed 脚本
 * 坐标系：角度 = 车头朝向 + 90）。只认第一 CP 的配置，写其他地方无效；不写默认生效
 * （默认 SUPERSTART_DEFAULT_KMH=221）。参数：superstart 速度(KM/H)，无参数/非法 → 默认，
 * 写 superstart 0 可关闭该赛道起步加速。全局仅开局一次（beginRace 触发），
 * 重生不激活——过 CP 时 execCpScript 静默跳过（见 case "superstart"）。
 */
export const SUPERSTART_DEFAULT_KMH = 221;

export function getSuperStartKmh(cps: { scripts: string[] }[]): number {
  for (const script of cps[0]?.scripts ?? []) {
    const [fn, raw] = script.trim().split(/\s+/);
    if (fn === "superstart") {
      const kmh = Number(raw);
      if (Number.isFinite(kmh) && kmh >= 0) return kmh;
      break;
    }
  }
  return SUPERSTART_DEFAULT_KMH;
}

/** 执行一条 CP 脚本。返回 false 表示终止整条脚本链（对齐原版 Race_Cp_Script_Start：
 * 碰到 spawnpos 直接 return 1，其后的脚本全部不再执行）。其余情况返回 true 继续。
 * opts.skipCveh：跳过 cveh 换车（第一 CP 的 cveh = 进赛道默认车型，到达时不再换车）。 */
export function execCpScript(
  player: Player,
  ctx: CpScriptContext,
  script: string,
  opts?: { skipCveh?: boolean },
): boolean {
  const [fn, ...rawArgs] = script.trim().split(/\s+/);
  const args = resolveArgs(player, ctx, rawArgs);
  const veh = player.getVehicle();

  const err = (msg: string): void => {
    sysMsg(player, "race", `${ctx.raceName} 第${ctx.cpid + 1}个检查点脚本错误: ${msg}`, "error");
  };

  switch (fn) {
    case "spawnpos": {
      // 赛道重生坐标提取用，不触发（对齐原版 Race_Cp_Script_Start：
      // 碰到 spawnpos 直接 return 1 终止整条脚本链——该点后续脚本全部不执行）。
      // 过 CP 时不执行——否则玩家会被瞬移到重生点；重生坐标由 room 的重生逻辑处理。
      return false;
    }
    case "superstart": {
      // 超级起步：开局 GO 时由 beginRace 统一触发（见 getSuperStartKmh），
      // 过 CP / 重生不激活——这里静默跳过，防误报"不存在函数[superstart]"。
      // 且 superstart 只认第一 CP 的配置，写在别处无效（也不报错）。
      return true;
    }
    case "time": {
      // 对齐原版 time：时 0-24、分 0-59
      const [hour, minute] = args.map(Number);
      if (
        !Number.isInteger(hour) ||
        hour < 0 ||
        hour > 24 ||
        !Number.isInteger(minute) ||
        minute < 0 ||
        minute > 59
      ) {
        return (err("time 需要 时(0-24) 分(0-59)"), true);
      }
      player.setTime(hour, minute);
      break;
    }
    case "weather": {
      const w = Number(args[0]);
      if (!Number.isInteger(w) || w < 0 || w > 255) return (err("weather ID 需 0-255"), true);
      player.setWeather(w);
      break;
    }
    case "cveh": {
      // 第一 CP 的 cveh = 赛道标准车型，进赛道时（joinRoom）已按它刷车/匹配爱车，
      // 到达第一 CP 不再换车——防"临时换车"销毁玩家爱车（对齐"进赛道即以该车为标准"）
      if (opts?.skipCveh) return true;
      const model = Number(args[0]);
      if (!isValidVehicleModel(model)) {
        err("cveh 车辆ID需 400-611");
        return true;
      }
      const pos = player.getPos();
      // 对齐原版 cveh（HRace.inc:561 → SpawnVehicle，gamemode:2065）：换车后
      // 新车成为玩家自己的车（原版 BuyID = CreateVehicle(新车)）。因此：
      // 1. 换车前取当前车速度，换车后无条件恢复（原版 GetVehicleVelocity/SetVehicleVelocity）
      // 2. 旧脚本车（比赛默认车等）销毁清登记，防残留
      // 3. 旧爱车实体销毁（原版 DestroyVehicle(旧BuyID)，玩家换车即弃旧车）
      // 4. 新车登记为玩家爱车（registerOwnedVehicle）——离开/结束比赛时保留，
      //    不再作为"脚本车"被统一清理
      const oldScriptVeh = scriptVehicles.get(player.id);
      const oldVelo = veh
        ? { x: veh.getVelocity().x, y: veh.getVelocity().y, z: veh.getVelocity().z }
        : null;
      if (oldScriptVeh) {
        cleanupScriptVehicle(player.id);
      }
      if (getOwnedVehicle(player.id)) {
        destroyPlayerVehicle(player.id);
      }
      const v = new Vehicle({
        modelId: model,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        zAngle: 0,
        color: [-1, -1],
        respawnDelay: 0,
      });
      v.create();
      v.setVirtualWorld(player.getVirtualWorld());
      v.linkToInterior(player.getInterior());
      addVehicleComponentIfPossible(v, 1010); // 氮气（对齐比赛默认车/编辑器车，cveh 换出的新车同样带）
      v.putPlayerIn(player, 0);
      // 恢复原速（司机/乘客一律恢复，对齐原版 SetVehicleVelocity 无条件执行）
      if (oldVelo) {
        v.setVelocity(oldVelo.x, oldVelo.y, oldVelo.z);
      }
      // 新车成为玩家爱车（对齐原版 BuyID = 新车）；离开/结束比赛时随玩家保留
      registerOwnedVehicle(player.id, v);
      // 懒建 user_vehicle 行（cveh 换车不销毁旧行、也从不建新模型行——不补的话
      // 后续 /cc 换色、改装店存件（ensureDefaultPresetTx 的 update 找不到行）会
      // 静默失败、断线位置保存 updateMany 零命中）。异步不阻塞 CP 热路径；
      // 若有默认预设一并应用外观（颜色/挂件，对齐 spawnVehicle）
      const auth = getAuthState(player.id);
      if (auth) {
        void (async () => {
          try {
            const { uv } = await getOrCreateUserVehicle(player, model);
            // 换车后玩家可能已再次换车/离开（车实体销毁）：守卫防对失效车应用外观
            if (uv.defaultPresetId && v.isValid()) {
              await applyVehiclePreset(v, uv.defaultPresetId, player.id);
            }
          } catch (e) {
            logger.error(`[race] cveh 换车懒建爱车行失败 player=${player.id} model=${model}`, e);
          }
        })();
      }
      break;
    }
    case "msg": {
      // msg 是赛道作者写的自定义文本（原版直接 SendClientMessage，无前缀——
      // 前缀会污染作者文案；内容安全由敏感词系统在写入时把关，这里原样输出）
      player.sendClientMessage(COLOR_RACE, args.join(" "));
      break;
    }
    case "speed": {
      // speed 角度模式 角度 速度模式 速度(KM/H)
      // 对齐原版 speed（HRace.inc:805）：基准角度 = 玩家朝向 + 90（车内 = 车辆角度 + 90），
      // | 模式 = 角度 + 90；x = 速度·cos(na)、y = 速度·sin(na)（角度 0 = 正东）。
      // 原版不设车辆朝向，只 SetVehicleVelocity。
      if (!veh) {
        err("speed 需要车辆");
        return true;
      }
      if (args.length < 4) {
        err("speed 参数不足");
        return true;
      }
      const angleOp = normOp(args[0]);
      const angle = Number(args[1]);
      const speedOp = normOp(args[2]);
      const speed = Number(args[3]);
      if ([angle, speed].some((n) => !Number.isFinite(n))) {
        err("speed 数值无效");
        return true;
      }
      const base = veh.getZAngle().angle + 90;
      const newAngle = angleOp === "|" ? angle + 90 : applyOp(base, angleOp, angle);
      const newSpeed = applyOp(veh.getSpeed(), speedOp, speed);
      setVehicleSpeed(veh, Math.max(0, newSpeed), newAngle);
      break;
    }
    case "angle": {
      // angle 角度模式 角度（对齐原版 angle：| 模式直接设为指定角度，
      // +/- 等以玩家朝向为基准运算；车内玩家朝向 = 车辆角度，等效 veh.getZAngle）
      if (!veh) {
        err("angle 需要车辆");
        return true;
      }
      if (args.length < 2) {
        err("angle 参数不足");
        return true;
      }
      const angleOp = normOp(args[0]);
      const angle = Number(args[1]);
      if (!Number.isFinite(angle)) {
        err("angle 数值无效");
        return true;
      }
      const newAngle = applyOp(veh.getZAngle().angle, angleOp, angle);
      veh.setZAngle(newAngle);
      break;
    }
    case "zspeed": {
      // zspeed 速度模式 速度（对齐原版 zspeed：| 模式直接设 Z 速度，其余在当前 Z 上运算）
      if (!veh) {
        err("zspeed 需要车辆");
        return true;
      }
      if (args.length < 2) {
        err("zspeed 参数不足");
        return true;
      }
      const speedOp = normOp(args[0]);
      const speed = Number(args[1]);
      if (!Number.isFinite(speed)) {
        err("zspeed 数值无效");
        return true;
      }
      const vv = veh.getVelocity();
      veh.setVelocity(vv.x, vv.y, applyOp(vv.z, speedOp, speed));
      break;
    }
    case "speedex": {
      // speedex 角度模式 角度 速度模式 速度 Z模式 Z速度
      // 对齐原版 speedex（HRace.inc:728）：角度基准 = 玩家朝向 + 90（车内 = 车辆角度 + 90），
      // | 模式 = 角度 + 90；x = 速度·cos(na)、y = 速度·sin(na)（角度 0 = 正东）；Z 轴独立。
      // 原版不设车辆朝向，只 SetVehicleVelocity。
      if (!veh) {
        err("speedex 需要车辆");
        return true;
      }
      if (args.length < 6) {
        err("speedex 参数不足");
        return true;
      }
      const angleOp = normOp(args[0]);
      const angle = Number(args[1]);
      const speedOp = normOp(args[2]);
      const speed = Number(args[3]);
      const zOp = normOp(args[4]);
      const zspeed = Number(args[5]);
      if ([angle, speed, zspeed].some((n) => !Number.isFinite(n))) {
        err("speedex 数值无效");
        return true;
      }
      const base = veh.getZAngle().angle + 90;
      const newAngle = angleOp === "|" ? angle + 90 : applyOp(base, angleOp, angle);
      const newSpeed = applyOp(veh.getSpeed(), speedOp, speed);
      const vv = veh.getVelocity();
      const newZ = applyOp(vv.z, zOp, zspeed);
      setVehicleSpeed(veh, Math.max(0, newSpeed), newAngle, newZ);
      break;
    }
    case "vgoto": {
      // vgoto 执行模式 x y z（s=不保留速度 v=保留速度）
      if (!veh) {
        err("vgoto 需要车辆");
        return true;
      }
      if (args.length < 4) {
        err("vgoto 参数不足");
        return true;
      }
      const mode = args[0] === "s" ? "s" : "v";
      const [x, y, z] = args.slice(1).map(Number);
      if ([x, y, z].some((n) => !Number.isFinite(n))) {
        err("vgoto 坐标无效");
        return true;
      }
      const vv = veh.getVelocity();
      veh.setPos(x, y, z);
      if (mode === "v") {
        veh.setVelocity(vv.x, vv.y, vv.z);
      }
      break;
    }
    case "fix": {
      // fix 执行模式（f=仅HP r=HP+外观，对齐原版 fix：r 修复，否则血量 1000）
      if (!veh) {
        err("fix 需要车辆");
        return true;
      }
      const mode = args[0] === "r" ? "r" : "f";
      if (mode === "r") {
        veh.repair();
      } else {
        veh.setHealth(1000);
      }
      break;
    }
    case "damage": {
      // damage 破坏模式（0-15 轮胎位）
      if (!veh) {
        err("damage 需要车辆");
        return true;
      }
      const mode = Number(args[0]);
      if (!Number.isInteger(mode) || mode < 0 || mode > 15) {
        err("damage 模式需 0-15");
        return true;
      }
      const ds = veh.getDamageStatus();
      veh.updateDamageStatus(ds.panels, ds.doors, ds.lights, mode);
      break;
    }
    default:
      // 对齐原版 Race_Cp_Script_Start：未知函数给玩家提示，且不中断后续脚本
      logger.warn(`[race] 未知脚本函数: ${fn}`);
      sysMsg(
        player,
        "race",
        `${ctx.raceName} 第${ctx.cpid + 1}个检查点脚本错误: 不存在函数[${fn}]`,
        "error",
      );
      return true;
  }
  return true;
}
