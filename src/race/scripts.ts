import { Player, PlayerStateEnum, Vehicle } from "@infernus/core";
import { logger } from "@/logger";

import { COLOR_RACE, COLOR_ERROR } from "@/utils/colors";

/** 脚本运算模式 */
type Op = "|" | "+" | "-" | "*" | "/";
const OPS: Record<string, Op> = { "|": "|", "+": "+", "-": "-", "*": "*", "/": "/" };

/** 距离换算：getSpeed() 返回 km/h（magic=180） */
const KMH_UNIT = 180;

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

/** 清理玩家脚本创建的车辆（断线/离开比赛时调用） */
export function cleanupScriptVehicle(playerId: number): void {
  const v = scriptVehicles.get(playerId);
  if (v && v.isValid()) {
    v.destroy();
  }
  scriptVehicles.delete(playerId);
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
      return veh ? String(veh.getZAngle().angle) : String(player.getFacingAngle().angle);
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
      // #ncpa：当前点与下一个点的角度（归一化 0-360）
      const cur = ctx.cps[idx];
      const ang = Math.atan2(cur.y - next.y, cur.x - next.x);
      const deg = (ang * 180) / Math.PI;
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
    case "+": return current + value;
    case "-": return current - value;
    case "*": return current * value;
    case "/": return value === 0 ? current : current / value;
    default: return value;
  }
}

function normOp(s: string): Op {
  return OPS[s] ?? "|";
}

/** 设置车辆速度：km/h → velocity 分量（角度 0 = 正北） */
function setVehicleSpeed(veh: Vehicle, kmh: number, angleDeg: number): void {
  const units = kmh / KMH_UNIT;
  const rad = (angleDeg * Math.PI) / 180;
  veh.setVelocity(units * Math.sin(rad), units * Math.cos(rad), veh.getVelocity().z);
}

/** 执行一条 CP 脚本 */
export function execCpScript(player: Player, ctx: CpScriptContext, script: string): void {
  const [fn, ...rawArgs] = script.trim().split(/\s+/);
  const args = resolveArgs(player, ctx, rawArgs);
  const veh = player.getVehicle();

  const err = (msg: string): void => {
    player.sendClientMessage(COLOR_ERROR, `[赛车] ${ctx.raceName} 第${ctx.cpid + 1}个检查点脚本错误: ${msg}`);
  };

  switch (fn) {
    case "spawnpos": {
      // 赛道重生位置：spawnpos x y z a（驾驶员/乘客都移动车辆）
      if (args.length < 4) return err("spawnpos 参数不足");
      const [x, y, z, a] = args.map(Number);
      if ([x, y, z, a].some((n) => !Number.isFinite(n))) return err("spawnpos 坐标无效");
      if (veh) {
        veh.setPos(x, y, z);
        veh.setZAngle(a);
      } else {
        player.setPos(x, y, z);
        player.setFacingAngle(a);
      }
      break;
    }
    case "time": {
      const [hour, minute] = args.map(Number);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return err("time 需要 时(0-23) 分(0-59)");
      }
      player.setTime(hour, minute);
      break;
    }
    case "weather": {
      const w = Number(args[0]);
      if (!Number.isInteger(w) || w < 0 || w > 255) return err("weather ID 需 0-255");
      player.setWeather(w);
      break;
    }
    case "cveh": {
      const model = Number(args[0]);
      if (!Number.isInteger(model) || model < 400 || model > 611) return err("cveh 车辆ID需 400-611");
      const pos = player.getPos();
      // 销毁旧脚本车辆（防累积）；新车辆登记到生命周期表，断线/离场时统一清理
      cleanupScriptVehicle(player.id);
      const v = new Vehicle({ modelId: model, x: pos.x, y: pos.y, z: pos.z, zAngle: 0, color: [-1, -1], respawnDelay: 0 });
      v.create();
      scriptVehicles.set(player.id, v);
      v.setVirtualWorld(player.getVirtualWorld());
      v.linkToInterior(player.getInterior());
      v.putPlayerIn(player, 0);
      if (veh && player.getState() === PlayerStateEnum.DRIVER) {
        const vv = veh.getVelocity();
        v.setVelocity(vv.x, vv.y, vv.z);
        veh.destroy();
      }
      break;
    }
    case "msg": {
      player.sendClientMessage(COLOR_RACE, `[赛车] ${args.join(" ")}`);
      break;
    }
    case "speed": {
      // speed 角度模式 角度 速度模式 速度(KM/H)
      if (!veh) return err("speed 需要车辆");
      if (args.length < 4) return err("speed 参数不足");
      const angleOp = normOp(args[0]);
      const angle = Number(args[1]);
      const speedOp = normOp(args[2]);
      const speed = Number(args[3]);
      if ([angle, speed].some((n) => !Number.isFinite(n))) return err("speed 数值无效");
      const curAngle = veh.getZAngle().angle;
      const newAngle = applyOp(curAngle, angleOp, angle);
      const newSpeed = applyOp(veh.getSpeed(), speedOp, speed);
      setVehicleSpeed(veh, Math.max(0, newSpeed), newAngle);
      veh.setZAngle(newAngle);
      break;
    }
    case "angle": {
      // angle 角度模式 角度
      if (!veh) return err("angle 需要车辆");
      if (args.length < 2) return err("angle 参数不足");
      const angleOp = normOp(args[0]);
      const angle = Number(args[1]);
      if (!Number.isFinite(angle)) return err("angle 数值无效");
      const newAngle = applyOp(veh.getZAngle().angle, angleOp, angle);
      veh.setZAngle(newAngle);
      break;
    }
    case "zspeed": {
      // zspeed 速度模式 速度
      if (!veh) return err("zspeed 需要车辆");
      if (args.length < 2) return err("zspeed 参数不足");
      const speedOp = normOp(args[0]);
      const speed = Number(args[1]);
      if (!Number.isFinite(speed)) return err("zspeed 数值无效");
      const vv = veh.getVelocity();
      veh.setVelocity(vv.x, vv.y, applyOp(vv.z, speedOp, speed));
      break;
    }
    case "speedex": {
      // speedex 角度模式 角度 速度模式 速度 Z模式 Z速度
      if (!veh) return err("speedex 需要车辆");
      if (args.length < 6) return err("speedex 参数不足");
      const angleOp = normOp(args[0]);
      const angle = Number(args[1]);
      const speedOp = normOp(args[2]);
      const speed = Number(args[3]);
      const zOp = normOp(args[4]);
      const zspeed = Number(args[5]);
      if ([angle, speed, zspeed].some((n) => !Number.isFinite(n))) return err("speedex 数值无效");
      const newAngle = applyOp(veh.getZAngle().angle, angleOp, angle);
      const newSpeed = applyOp(veh.getSpeed(), speedOp, speed);
      const vv = veh.getVelocity();
      const newZ = applyOp(vv.z, zOp, zspeed);
      const units = Math.max(0, newSpeed) / KMH_UNIT;
      const rad = (newAngle * Math.PI) / 180;
      veh.setVelocity(units * Math.sin(rad), units * Math.cos(rad), newZ);
      veh.setZAngle(newAngle);
      break;
    }
    case "vgoto": {
      // vgoto 执行模式 x y z（s=不保留速度 v=保留速度）
      if (!veh) return err("vgoto 需要车辆");
      if (args.length < 4) return err("vgoto 参数不足");
      const mode = args[0] === "s" ? "s" : "v";
      const [x, y, z] = args.slice(1).map(Number);
      if ([x, y, z].some((n) => !Number.isFinite(n))) return err("vgoto 坐标无效");
      const vv = veh.getVelocity();
      veh.setPos(x, y, z);
      if (mode === "v") {
        veh.setVelocity(vv.x, vv.y, vv.z);
      }
      break;
    }
    case "fix": {
      // fix 执行模式（f=仅HP r=HP+外观）
      if (!veh) return err("fix 需要车辆");
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
      if (!veh) return err("damage 需要车辆");
      const mode = Number(args[0]);
      if (!Number.isInteger(mode) || mode < 0 || mode > 15) return err("damage 模式需 0-15");
      const ds = veh.getDamageStatus();
      veh.updateDamageStatus(ds.panels, ds.doors, ds.lights, mode);
      break;
    }
    default:
      logger.warn(`[race] 未知脚本函数: ${fn}`);
  }
}
