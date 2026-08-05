import {
  Dialog,
  DialogStylesEnum,
  Player,
  PlayerEvent,
  Vehicle,
  VehicleParamsEnum,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { isPlayerLocked } from "@/core/interaction";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import type { MenuBack } from "@/core/panel";
import {
  spawnVehicle,
  getOwnedVehicle,
  destroyPlayerVehicle,
  summonMyVehicle,
  toggleMyVehicleLock,
  changeMyVehicleColor,
  setMyVehiclePlate,
  kickMyVehiclePassengers,
} from "./index";
import { getSetting, updateSetting, notifySaved } from "@/personalize/settings";
import { openVehiclePresetMenu } from "@/attire";
import { parseIntInRange } from "@/utils/parse";

import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";

/**
 * 爱车面板入口：
 * 1. 刷车（输入模型ID）
 * 2. 爱车列表（选择已拥有的车刷出）
 * 3. 当前爱车管理（锁车/车牌/改色/踢乘客）
 * 4. 收起当前车辆
 */
export async function openMyVehicleMenu(player: Player, back?: MenuBack): Promise<void> {
  const hasVeh = getOwnedVehicle(player.id) != null;
  const toThis = () => openMyVehicleMenu(player, back); // 子菜单取消时回本菜单
  // 无车时不显示"当前爱车管理/收起当前车辆"（点了也是"还没有刷出车辆"的无效项）
  const rows: { label: string; run: () => void | Promise<void> }[] = [
    { label: "刷车", run: () => spawnVehicleFlow(player, toThis) },
    { label: "爱车列表", run: () => listVehiclesFlow(player, toThis) },
  ];
  if (hasVeh) {
    rows.push(
      { label: "当前爱车管理", run: () => manageCurrentVehicle(player, toThis) },
      {
        label: "收起当前车辆",
        run: () => {
          destroyPlayerVehicle(player.id);
          player.sendClientMessage(COLOR_SUCCESS, "已收起当前车辆");
        },
      },
    );
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "爱车",
      info: rows.map((r, i) => `${i + 1}. ${r.label}`).join("\n"),
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return; // 断线
  if (res.response !== 1) return back?.(); // 取消 → 返回上一层
  await rows[res.listItem].run();
}

/** 刷车：输入模型ID */
async function spawnVehicleFlow(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "刷车",
      info: "输入车辆模型ID（400-611）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const modelId = parseIntInRange(res.inputText, 400, 611);
  if (modelId == null) {
    player.sendClientMessage(COLOR_ERROR, "请输入 400-611 的整数车辆ID");
    return back?.();
  }
  await spawnVehicle(player, modelId);
  return back?.();
}

/** 爱车列表：列出该玩家的所有爱车（分页），选择刷出（/llac /cars list 命令入口也调它） */
export async function listVehiclesFlow(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const vehicles = await prisma.userVehicle.findMany({
    where: { userId: auth.userId, deletedAt: null },
    orderBy: { modelId: "asc" },
  });
  if (vehicles.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "你还没有爱车，先刷一辆吧（/c 车辆ID）");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: `我的爱车（${vehicles.length} 辆）`,
    data: vehicles,
    // 多列：模型 | 车牌 | 锁定状态
    headers: ["模型", "车牌", "状态"],
    format: (v) => [
      String(v.modelId),
      v.plateNumber || "—",
      v.isLocked ? "{FF0000}锁定" : "{00FF00}未锁",
    ],
    button1: "刷出",
    button2: "取消",
  });
  if (!r) return back?.();
  const uv = r.item;
  await spawnVehicle(player, uv.modelId);
  return back?.();
}

/** 当前爱车管理：锁车/车牌/改色/踢乘客/车灯/引擎盖/行李箱（操作后停留本菜单，取消返回上一层；/wdac 入口） */
export async function manageCurrentVehicle(player: Player, back?: MenuBack): Promise<void> {
  const veh = getOwnedVehicle(player.id);
  if (!veh) {
    player.sendClientMessage(COLOR_ERROR, "你还没有刷出车辆");
    return back?.();
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "当前爱车管理",
      info: "1. 锁车/解锁\n2. 更换车牌\n3. 更换颜色\n4. 踢出乘客\n5. 回收车辆\n6. 车灯开关\n7. 引擎盖开关\n8. 行李箱开关",
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const toThis = () => manageCurrentVehicle(player, back);
  if (res.listItem === 0) {
    const { doors } = veh.getParamsEx();
    const isLocked = doors < 1;
    veh.toggleDoors(isLocked);
    // 锁车状态落库（与 user_vehicle.is_locked 字段对齐，重刷车保持锁定）
    const auth = getAuthState(player.id);
    if (auth) {
      await prisma.userVehicle.updateMany({
        where: { userId: auth.userId, modelId: veh.getModel() },
        data: { isLocked },
      });
    }
    player.sendClientMessage(COLOR_SUCCESS, isLocked ? "爱车已上锁" : "爱车已解锁");
    return toThis();
  } else if (res.listItem === 1) {
    const r = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "更换车牌",
        info: "输入车牌文字（≤10字符）：",
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!r) return;
    if (r.response !== 1) return toThis();
    if (r.inputText.trim().length > 10) {
      player.sendClientMessage(COLOR_ERROR, "车牌文字最多 10 个字符");
      return toThis();
    }
    const plate = r.inputText.trim();
    veh.setNumberPlate(plate);
    // 车牌落库（与 /c chepai 命令一致，重刷车不丢失）
    const auth = getAuthState(player.id);
    if (auth) {
      await prisma.userVehicle.updateMany({
        where: { userId: auth.userId, modelId: veh.getModel() },
        data: { plateNumber: plate },
      });
    }
    player.sendClientMessage(COLOR_SUCCESS, "车牌已更换");
    return toThis();
  } else if (res.listItem === 2) {
    const r = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "更换颜色",
        info: "输入两个颜色代码（0-255，空格分隔）：",
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!r) return;
    if (r.response !== 1) return toThis();
    const [c1, c2] = r.inputText.trim().split(/\s+/).map(Number);
    if (
      !Number.isInteger(c1) ||
      c1 < 0 ||
      c1 > 255 ||
      !Number.isInteger(c2) ||
      c2 < 0 ||
      c2 > 255
    ) {
      player.sendClientMessage(COLOR_ERROR, "颜色代码需为 0-255 的整数");
      return toThis();
    }
    veh.changeColors(c1, c2);
    player.sendClientMessage(COLOR_SUCCESS, `颜色已更换为 ${c1} / ${c2}`);
    return toThis();
  } else if (res.listItem === 3) {
    // 踢乘客
    let kicked = 0;
    for (const p of Player.getInstances()) {
      if (p.isNpc() || !p.isConnected() || p.id === player.id) continue;
      if (!p.isInAnyVehicle() || p.getVehicle() !== veh) continue;
      const pos = p.getPos();
      p.setPos(pos.x, pos.y, pos.z + 5);
      // 实际是车主主动踢人（车没锁），文案与动作一致（对齐 /c kick）
      p.sendClientMessage(COLOR_ERROR, "你被车主移出了车辆");
      kicked++;
    }
    player.sendClientMessage(
      COLOR_SUCCESS,
      kicked > 0 ? `已踢出 ${kicked} 名乘客` : "车内没有其他乘客",
    );
    return toThis();
  } else if (res.listItem === 4) {
    destroyPlayerVehicle(player.id);
    player.sendClientMessage(COLOR_SUCCESS, "已回收车辆");
    return back?.(); // 回收后车没了，回上一层
  } else if (res.listItem === 5) {
    toggleVehicleParam(player, veh, "lights", "车灯");
    return toThis();
  } else if (res.listItem === 6) {
    toggleVehicleParam(player, veh, "bonnet", "引擎盖");
    return toThis();
  } else if (res.listItem === 7) {
    toggleVehicleParam(player, veh, "boot", "行李箱");
    return toThis();
  }
}

/**
 * 翻转车辆开关参数（车灯/引擎盖/行李箱）：读当前参数 → 翻转目标项 → 写回，
 * 其余参数（引擎/车门/警报等）保持不变。纯临时操作，不落库（重刷车/换车即重置）。
 */
function toggleVehicleParam(
  player: Player,
  veh: Vehicle,
  key: "lights" | "bonnet" | "boot",
  label: string,
): void {
  const p = veh.getParamsEx();
  if (!p.ret) {
    player.sendClientMessage(COLOR_ERROR, "车辆参数读取失败，请重试");
    return;
  }
  const cur = p[key];
  const next = cur === VehicleParamsEnum.ON ? VehicleParamsEnum.OFF : VehicleParamsEnum.ON;
  veh.setParamsEx(
    p.engine,
    key === "lights" ? next : p.lights,
    p.alarm,
    p.doors,
    key === "bonnet" ? next : p.bonnet,
    key === "boot" ? next : p.boot,
    p.objective,
  );
  player.sendClientMessage(
    COLOR_SUCCESS,
    `${label}已${next === VehicleParamsEnum.ON ? "开启" : "关闭"}`,
  );
}

/**
 * 原版爱车命令兼容（对齐 pawn-server Cars.inc）：
 * /cars|/ac — 爱车入口（打开爱车面板）
 * /cars list — 爱车列表（= /llac）
 * /cars wode — 召唤爱车到身边
 * /cars lock — 锁/解锁爱车
 * /wdac — 我的爱车管理菜单
 * /llac — 爱车列表
 * 原版 /cars buy（购买爱车）/cars create（管理员造车）在 gm-lite 无对应概念：
 * 刷车即自动登记爱车（无需购买/造车），给出引导提示而非报错。
 */
export function initMyVehicleCommands(): void {
  const cmdGuard = (player: Player, next: () => unknown): boolean => {
    if (!getAuthState(player.id) || isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "请先完成登录后再操作");
      next();
      return false;
    }
    return true;
  };

  PlayerEvent.onCommandText(["cars", "ac"], async ({ player, subcommand, next }) => {
    if (!cmdGuard(player, next)) return;
    const arg = subcommand[0];
    if (arg === "list") {
      void listVehiclesFlow(player);
    } else if (arg === "wode") {
      summonMyVehicle(player);
    } else if (arg === "lock") {
      await toggleMyVehicleLock(player);
    } else if (arg === "chepai") {
      const plate = subcommand.slice(1).join(" ").trim();
      if (!plate) {
        player.sendClientMessage(COLOR_ERROR, "用法: /cars chepai 车牌文字（≤10字符）");
        return next();
      }
      if (plate.length > 10) {
        player.sendClientMessage(COLOR_ERROR, "车牌文字最多 10 个字符");
        return next();
      }
      await setMyVehiclePlate(player, plate);
    } else if (arg === "kick") {
      kickMyVehiclePassengers(player);
    } else if (arg === "color") {
      const c1 = +subcommand[1];
      const c2 = +subcommand[2];
      if (
        !Number.isInteger(c1) ||
        c1 < 0 ||
        c1 > 255 ||
        !Number.isInteger(c2) ||
        c2 < 0 ||
        c2 > 255
      ) {
        player.sendClientMessage(COLOR_ERROR, "用法: /cars color 颜色代码1 颜色代码2（0-255）");
        return next();
      }
      changeMyVehicleColor(player, c1, c2);
    } else if (arg === "3d") {
      // 联动总开关（与 /c 3d、界面菜单一致）：只写 showSpeed3d 而总开关关闭时
      // 提示"已开启"实际不显示
      const setting = await getSetting(player);
      if (setting) {
        const n3d = !setting.showSpeed3d;
        await updateSetting(player, {
          showSpeed3d: n3d,
          showSpeed2d: false,
          showSpeed: n3d ? true : setting.showSpeed,
        });
        notifySaved(player, `3D速度表已${n3d ? "开启" : "关闭"}`);
      }
    } else if (arg === "buy" || arg === "create") {
      player.sendClientMessage(
        COLOR_WHITE,
        arg === "buy"
          ? "[爱车] gm-lite 无需购买爱车，/c 车辆ID 刷车即自动登记为爱车"
          : "[爱车] gm-lite 无需管理员造车，刷车即自动登记爱车",
      );
    } else if (arg === "buyobj") {
      // 原版 /cars buyobj 是"购买爱车装扮"（商店）——gm-lite 装扮由模型+预设驱动，
      // 无需购买：直接打开车辆装扮预设（挂件自由添加，警灯/尾翼等同源）
      void openVehiclePresetMenu(player);
    } else {
      void openMyVehicleMenu(player);
    }
    return next();
  });

  // /aczb 爱车装扮（对齐原版 /aczb 进入爱车装扮）——直接打开车辆装扮预设
  PlayerEvent.onCommandText("aczb", ({ player, next }) => {
    if (!cmdGuard(player, next)) return;
    void openVehiclePresetMenu(player);
    return next();
  });

  // /infobj 警灯尾翼（对齐原版 /infobj 给车辆加警灯+尾翼）：gm-lite 无一次性警灯
  // 挂件命令——装扮由模型+预设驱动，警灯/尾翼就是车辆装扮预设里的挂件，引导玩家去加
  PlayerEvent.onCommandText("infobj", ({ player, next }) => {
    if (!cmdGuard(player, next)) return;
    player.sendClientMessage(
      COLOR_WHITE,
      "[装扮] 警灯/尾翼请在「车辆装扮预设」中添加（装扮由模型+预设驱动，可自由组合）",
    );
    void openVehiclePresetMenu(player);
    return next();
  });

  // /wdac 我的爱车管理（对齐原版 pViewMyCar）
  PlayerEvent.onCommandText("wdac", ({ player, next }) => {
    if (!cmdGuard(player, next)) return;
    void manageCurrentVehicle(player);
    return next();
  });

  // /llac 爱车列表（对齐原版 pViewACList）
  PlayerEvent.onCommandText("llac", ({ player, next }) => {
    if (!cmdGuard(player, next)) return;
    void listVehiclesFlow(player);
    return next();
  });
}
