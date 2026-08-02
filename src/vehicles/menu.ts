import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { showDialog } from "@/utils/dialog";
import { spawnVehicle, getOwnedVehicle, destroyPlayerVehicle } from "./index";
import { parseIntInRange } from "@/utils/parse";

import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";

/**
 * 爱车面板入口：
 * 1. 刷车（输入模型ID）
 * 2. 爱车列表（选择已拥有的车刷出）
 * 3. 当前爱车管理（锁车/车牌/改色/踢乘客）
 * 4. 收起当前车辆
 */
export async function openMyVehicleMenu(player: Player): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "爱车",
      info: "1. 刷车\n2. 爱车列表\n3. 当前爱车管理\n4. 收起当前车辆",
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res || res.response !== 1) return;

  if (res.listItem === 0) {
    await spawnVehicleFlow(player);
  } else if (res.listItem === 1) {
    await listVehiclesFlow(player);
  } else if (res.listItem === 2) {
    await manageCurrentVehicle(player);
  } else if (res.listItem === 3) {
    destroyPlayerVehicle(player.id);
    player.sendClientMessage(COLOR_SUCCESS, "已收起当前车辆");
  }
}

/** 刷车：输入模型ID */
async function spawnVehicleFlow(player: Player): Promise<void> {
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
  if (!res || res.response !== 1) return;
  const modelId = parseIntInRange(res.inputText, 400, 611);
  if (modelId == null) {
    player.sendClientMessage(COLOR_ERROR, "请输入 400-611 的整数车辆ID");
    return;
  }
  await spawnVehicle(player, modelId);
}

/** 爱车列表：列出该玩家的所有爱车，选择刷出 */
async function listVehiclesFlow(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const vehicles = await prisma.userVehicle.findMany({
    where: { userId: auth.userId, deletedAt: null },
    orderBy: { modelId: "asc" },
  });
  if (vehicles.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "你还没有爱车，先刷一辆吧（/c 车辆ID）");
    return;
  }
  const options = vehicles.map((v) => `模型 ${v.modelId}${v.plateNumber ? `（${v.plateNumber}）` : ""}`);
  const info = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `我的爱车（${vehicles.length} 辆）`,
      info,
      button1: "刷出",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const uv = vehicles[res.listItem];
  if (!uv) return;
  await spawnVehicle(player, uv.modelId);
}

/** 当前爱车管理：锁车/车牌/改色/踢乘客 */
async function manageCurrentVehicle(player: Player): Promise<void> {
  const veh = getOwnedVehicle(player.id);
  if (!veh) {
    player.sendClientMessage(COLOR_ERROR, "你还没有刷出车辆");
    return;
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "当前爱车管理",
      info: "1. 锁车/解锁\n2. 更换车牌\n3. 更换颜色\n4. 踢出乘客\n5. 回收车辆",
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res || res.response !== 1) return;

  if (res.listItem === 0) {
    const { doors } = veh.getParamsEx();
    const isLocked = doors < 1;
    veh.toggleDoors(isLocked);
    player.sendClientMessage(COLOR_SUCCESS, isLocked ? "爱车已上锁" : "爱车已解锁");
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
    if (!r || r.response !== 1) return;
    if (r.inputText.trim().length > 10) {
      player.sendClientMessage(COLOR_ERROR, "车牌文字最多 10 个字符");
      return;
    }
    veh.setNumberPlate(r.inputText.trim());
    player.sendClientMessage(COLOR_SUCCESS, "车牌已更换");
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
    if (!r || r.response !== 1) return;
    const [c1, c2] = r.inputText.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(c1) || c1 < 0 || c1 > 255 || !Number.isInteger(c2) || c2 < 0 || c2 > 255) {
      player.sendClientMessage(COLOR_ERROR, "颜色代码需为 0-255 的整数");
      return;
    }
    veh.changeColors(c1, c2);
    player.sendClientMessage(COLOR_SUCCESS, `颜色已更换为 ${c1} / ${c2}`);
  } else if (res.listItem === 3) {
    // 踢乘客
    let kicked = 0;
    for (const p of Player.getInstances()) {
      if (p.isNpc() || !p.isConnected() || p.id === player.id) continue;
      if (!p.isInAnyVehicle() || p.getVehicle() !== veh) continue;
      const pos = p.getPos();
      p.setPos(pos.x, pos.y, pos.z + 5);
      p.sendClientMessage(COLOR_ERROR, "该车已被锁，你被移出");
      kicked++;
    }
    player.sendClientMessage(COLOR_SUCCESS, kicked > 0 ? `已踢出 ${kicked} 名乘客` : "车内没有其他乘客");
  } else if (res.listItem === 4) {
    destroyPlayerVehicle(player.id);
    player.sendClientMessage(COLOR_SUCCESS, "已回收车辆");
  }
}
