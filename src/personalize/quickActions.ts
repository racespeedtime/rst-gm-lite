import { Dialog, DialogStylesEnum, GameText, Player, Vehicle, WeaponEnum } from "@infernus/core";
import { sessionManager } from "@/sessions/manager";
import { pickOption, notifySaved, COLOR_ERROR } from "./settings";
import { setTimeoutSafe } from "@/core/timers";
import { startObservePlayer, stopObserve } from "@/core/observe";
import { isInRace, getRacePlayerState, getRaceRoom, respawnToLastCp } from "@/race/room";
import { flipVehicle } from "@/core/vehicleAuto";
import { showDialog } from "@/utils/dialog";

/**
 * 快捷操作菜单（面板按钮触发）
 * 1. 脱离卡死（随机左右）
 * 2. 脱离卡死（垂直方向）
 * 3. 重生
 * 4. 获取当前位置空间信息
 * 5. 获取降落伞
 * 6. 获取喷气背包
 * 7. 车辆翻正（车内时）
 * 8. 范围倒计时（当前战局 10 秒）
 */
export async function openQuickActionsMenu(player: Player): Promise<void> {
  const inRace = isInRace(player.id);
  // 比赛中禁用的选项：脱离卡死（瞬移作弊）、降落伞/喷气背包（装备作弊）
  const options = inRace
    ? [
        "重生",
        "当前位置信息",
        "车辆翻正",
        "范围倒计时",
        "观战玩家",
        "停止观战",
      ]
    : [
        "脱离卡死（随机左右）",
        "脱离卡死（垂直方向）",
        "重生",
        "当前位置信息",
        "获取降落伞",
        "获取喷气背包",
        "车辆翻正",
        "范围倒计时",
        "观战玩家",
        "停止观战",
      ];
  const index = await pickOption(player, "快捷操作", options);
  if (index < 0) return;

  // 比赛中的选项重新映射到 switch case
  const idx = inRace ? index + 2 : index;

  switch (idx) {
    case 0: {
      // 随机左右位移一段距离，脱离卡死
      const pos = player.getPos();
      const dir = Math.random() < 0.5 ? -1 : 1;
      player.setPos(pos.x + dir * 3, pos.y, pos.z + 1);
      player.sendClientMessage("#ffffff", "已尝试脱离卡死（随机左右）");
      break;
    }
    case 1: {
      // 垂直方向抬升
      const pos = player.getPos();
      player.setPos(pos.x, pos.y, pos.z + 5);
      player.sendClientMessage("#ffffff", "已尝试脱离卡死（垂直方向）");
      break;
    }
    case 2: {
      // 比赛中：重生回上一 CP（与 /kill 一致）；非比赛：正常重生
      const racePr = isInRace(player.id) ? getRacePlayerState(player.id) : undefined;
      const room = racePr ? getRaceRoom(racePr.roomId) : undefined;
      if (racePr && room && room.state === "RACING") {
        respawnToLastCp(player, racePr, room);
      } else {
        player.spawn();
      }
      break;
    }
    case 3: {
      // 当前位置空间信息
      const pos = player.getPos();
      const angle = player.getFacingAngle().angle;
      const world = player.getVirtualWorld();
      const interior = player.getInterior();
      player.sendClientMessage(
        "#ffffff",
        `位置 X:${pos.x.toFixed(2)} Y:${pos.y.toFixed(2)} Z:${pos.z.toFixed(2)} 朝向:${angle.toFixed(2)} 世界:${world} 室内:${interior}`,
      );
      break;
    }
    case 4: {
      player.giveWeapon(WeaponEnum.PARACHUTE, 1);
      notifySaved(player, "已获取降落伞（按 F 使用）");
      break;
    }
    case 5: {
      player.setSpecialAction(2); // USEJETPACK
      notifySaved(player, "已获取喷气背包");
      break;
    }
    case 6: {
      // 车辆翻正：对齐原版 /f（抬升 2 让物理重新落正）
      const vehicle = Vehicle.getInstances().find((v) => v.isPlayerIn(player));
      if (!vehicle) {
        player.sendClientMessage(COLOR_ERROR, "你不在车内，无法翻正车辆");
        break;
      }
      flipVehicle(vehicle, 2);
      notifySaved(player, "车辆已翻正并修复");
      break;
    }
    case 7: {
      // 范围倒计时：当前战局 10 秒倒计时
      await sessionCountdown(player, 10);
      break;
    }
    case 8: {
      // 观战玩家
      const res = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.INPUT,
          caption: "观战玩家",
          info: "输入要观看的玩家ID：",
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!res || res.response !== 1) break;
      const target = Player.getInstance(+res.inputText.trim());
      if (!target) {
        player.sendClientMessage(COLOR_ERROR, "对方未在线");
        break;
      }
      startObservePlayer(player, target);
      break;
    }
    case 9: {
      stopObserve(player);
      break;
    }
  }
}

/** 战局/区域倒计时：倒计时期间全战局显示，结束时广播 */
async function sessionCountdown(player: Player, seconds: number): Promise<void> {
  const session = sessionManager.getPlayerSession(player);
  for (let i = seconds; i >= 1; i--) {
    if (!player.isConnected()) return;
    const countdown = new GameText(`${i}`, 1000, 3);
    countdown.forPlayer(player);
    session.broadcast(`[倒计时] ${player.getName().name} 发起了 ${seconds} 秒倒计时：${i}`);
    await sleep(1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeoutSafe(resolve, ms));
}
