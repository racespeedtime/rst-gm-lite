import { Dialog, DialogStylesEnum, GameText, Player, PlayerEvent, Vehicle, WeaponEnum } from "@infernus/core";
import { pickOption, notifySaved, COLOR_ERROR } from "./settings";
import { setTimeoutSafe } from "@/core/timers";
import { startObservePlayer, stopObserve, isObserving } from "@/core/observe";
import { isInRace, getRacePlayerState, getRaceRoom, respawnToLastCp } from "@/race/room";
import { flipVehicle } from "@/core/vehicleAuto";
import { getSafeGroundZ } from "@/core/colandreas";
import { isPlayerInWater } from "@infernus/colandreas";
import type { MenuBack } from "@/core/panel";
import { showDialog } from "@/utils/dialog";

/** 海平面参考高度（SA 海水水面 z≈0；陆地判定取明显高于海平面） */
const SEA_LEVEL = 0;

/**
 * 找最近的陆地：从 (x,y) 向四周方向逐步外扩扫描（24 方向 × 每 30 单位一圈，
 * 最大半径 500）。每个采样点用 colandreas 找地面高度——水域点返回海底（远低于
 * 海平面），陆地点的地面明显高于海平面。返回最近陆地坐标（地面 + 0.8 防半身
 * 埋地）；扫描范围内无陆地返回 null（colandreas 不可用/无数据时所有点回退
 * fallback，同样判非陆地）。
 */
function findNearestLand(x: number, y: number): { x: number; y: number; z: number } | null {
  const STEP = 30; // 每步外扩距离
  const MAX_DIST = 500; // 最大搜索半径
  const ANGLES = 24; // 每圈方向数（15° 步进）
  const FALLBACK_Z = -100; // getSafeGroundZ fallback（地图内最低值，保证无数据点不判陆地）
  for (let dist = STEP; dist <= MAX_DIST; dist += STEP) {
    for (let i = 0; i < ANGLES; i++) {
      const ang = (i / ANGLES) * Math.PI * 2;
      const sx = x + Math.cos(ang) * dist;
      const sy = y + Math.sin(ang) * dist;
      const ground = getSafeGroundZ(sx, sy, FALLBACK_Z);
      if (ground > SEA_LEVEL + 1.5) {
        return { x: sx, y: sy, z: ground + 0.8 };
      }
    }
  }
  return null;
}

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
 *
 * 用 (label, run) 行驱动，比赛中按需删减行——避免旧实现的 index+2
 * 重映射在删掉中间项（降落伞/喷气背包）后错位（比赛中"车辆翻正"误触发"降落伞"）。
 */
export async function openQuickActionsMenu(player: Player, back?: MenuBack): Promise<void> {
  const inRace = isInRace(player.id);
  // 比赛中禁用的选项：脱离卡死（瞬移作弊）、降落伞/喷气背包（装备作弊）
  const rows: { label: string; run: () => void | Promise<void> }[] = [];

  if (!inRace) {
    rows.push({
      label: "脱离卡死（随机左右）",
      run: () => {
        // 随机左右位移一段距离，脱离卡死
        const pos = player.getPos();
        const dir = Math.random() < 0.5 ? -1 : 1;
        player.setPos(pos.x + dir * 3, pos.y, pos.z + 1);
        player.sendClientMessage("#ffffff", "已尝试脱离卡死（随机左右）");
      },
    });
    rows.push({
      label: "脱离卡死（垂直方向）",
      run: () => {
        // 垂直方向抬升（对齐原版 /xiufu 的 Z+2.8，对卡在墙缝/室内有效）
        const pos = player.getPos();
        player.setPos(pos.x, pos.y, pos.z + 5);
        player.sendClientMessage("#ffffff", "已尝试脱离卡死（垂直方向）");
      },
    });
    rows.push({
      label: "脱离卡死（传送到最近地面）",
      run: () => {
        // 用 colandreas 找当前 (x,y) 的实际地面高度落上去（最可靠）：
        // 卡在建筑里/悬空时直接回到该点的地面。室内没有碰撞数据 → 退化为抬升。
        const pos = player.getPos();
        if (player.getInterior() === 0) {
          // 水里：不是浮出水面，而是找最近的陆地传送过去
          // （colandreas 对水域返回的是海底地面，原地落下仍在水里）
          try {
            const water = isPlayerInWater(player);
            if (water && water.playerDepth > 0) {
              const land = findNearestLand(pos.x, pos.y);
              if (land) {
                player.setPos(land.x, land.y, land.z);
                player.sendClientMessage("#ffffff", "已脱离卡死（传送到最近陆地）");
                return;
              }
              // 附近找不到陆地（罕见/远离岸边）：退化为浮出水面兜底
              player.setPos(pos.x, pos.y, pos.z + water.playerDepth + 0.5);
              player.sendClientMessage("#ffffff", "附近未找到陆地，已浮出水面");
              return;
            }
          } catch {
            // colandreas 不可用，忽略
          }
          const ground = getSafeGroundZ(pos.x, pos.y, pos.z);
          if (Math.abs(ground - pos.z) > 0.5) {
            // 抬高 0.8 防半身埋地（colandreas 地面高度可能略低于实际地表/流式 obj）
            player.setPos(pos.x, pos.y, ground + 0.8);
            player.sendClientMessage("#ffffff", "已脱离卡死（传送到最近地面）");
            return;
          }
          player.sendClientMessage("#ffffff", "已在安全位置或无法检测地面，可尝试垂直抬升");
        } else {
          player.setPos(pos.x, pos.y, pos.z + 5);
          player.sendClientMessage("#ffffff", "室内无法检测地面，已尝试垂直抬升");
        }
      },
    });
  }

  rows.push({
    label: "重生",
    run: () => {
      // 比赛中：重生回上一 CP（与 /kill 一致）；非比赛：正常重生
      const racePr = isInRace(player.id) ? getRacePlayerState(player.id) : undefined;
      const room = racePr ? getRaceRoom(racePr.roomId) : undefined;
      if (racePr && room && room.state === "RACING") {
        respawnToLastCp(player, racePr, room);
      } else {
        player.spawn();
      }
    },
  });

  rows.push({
    label: "当前位置信息",
    run: () => {
      // 当前位置空间信息
      const pos = player.getPos();
      const angle = player.getFacingAngle().angle;
      const world = player.getVirtualWorld();
      const interior = player.getInterior();
      player.sendClientMessage(
        "#ffffff",
        `位置 X:${pos.x.toFixed(2)} Y:${pos.y.toFixed(2)} Z:${pos.z.toFixed(2)} 朝向:${angle.toFixed(2)} 世界:${world} 室内:${interior}`,
      );
    },
  });

  if (!inRace) {
    rows.push({
      label: "获取降落伞",
      run: () => {
        player.giveWeapon(WeaponEnum.PARACHUTE, 1);
        notifySaved(player, "已获取降落伞（按 F 使用）");
      },
    });
    rows.push({
      label: "获取喷气背包",
      run: () => {
        player.setSpecialAction(2); // USEJETPACK
        notifySaved(player, "已获取喷气背包");
      },
    });
  }

  rows.push({
    label: "车辆翻正",
    run: () => {
      // 车辆翻正：对齐原版 /f（抬升 2 让物理重新落正）
      const vehicle = Vehicle.getInstances().find((v) => v.isPlayerIn(player));
      if (!vehicle) {
        player.sendClientMessage(COLOR_ERROR, "你不在车内，无法翻正车辆");
        return;
      }
      flipVehicle(vehicle, 2);
      notifySaved(player, "车辆已翻正并修复");
    },
  });

  rows.push({
    label: "范围倒计时",
    run: () => sessionCountdown(player, 10),
  });

  // 观战相关：未观战显示"观战玩家"，已观战显示"停止观战"（互斥，避免无效项）
  if (!isObserving(player.id)) {
    rows.push({
      label: "观战玩家",
      run: async () => {
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
        if (!res || res.response !== 1) return;
        const target = Player.getInstance(+res.inputText.trim());
        if (!target) {
          player.sendClientMessage(COLOR_ERROR, "对方未在线");
          return;
        }
        startObservePlayer(player, target);
      },
    });
  } else {
    rows.push({
      label: "停止观战",
      run: () => stopObserve(player),
    });
  }

  const index = await pickOption(
    player,
    "快捷操作",
    rows.map((r) => r.label),
  );
  if (index < 0) return back?.(); // 取消 → 退出面板
  await rows[index].run();
  // 操作完成后回到快捷操作菜单（可连续做多个操作），点"取消"才退出
  return openQuickActionsMenu(player, back);
}

/**
 * 范围倒计时（对齐原版 /djs）：
 * - 倒计时开始时给 20 米内同世界玩家发一条 sendClientMessage 提示
 * - 每秒给范围内玩家 GameText 显示数字（~w~N）+ 音效 1056
 * - 结束时 GameText "GO!" + 音效 1057
 */
async function sessionCountdown(player: Player, seconds: number): Promise<void> {
  const pos = player.getPos();
  const world = player.getVirtualWorld();
  // 倒计时开始时：范围内玩家收到一条提示
  const near = Player.getInstances().filter(
    (p) =>
      !p.isNpc() &&
      p.isConnected() &&
      p.getVirtualWorld() === world &&
      Math.hypot(p.getPos().x - pos.x, p.getPos().y - pos.y, p.getPos().z - pos.z) <= 20,
  );
  for (const p of near) {
    p.sendClientMessage("#ffffff", `[倒计时] ${player.getName().name} 发起了 ${seconds} 秒倒计时`);
  }
  for (let i = seconds; i >= 1; i--) {
    if (!player.isConnected()) return;
    const countdown = new GameText(`~w~${i}`, 1000, 3);
    for (const p of near) {
      if (!p.isConnected()) continue;
      countdown.forPlayer(p);
      p.playSound(1056);
    }
    await sleep(1000);
  }
  // 结束：GO!
  if (!player.isConnected()) return;
  const go = new GameText("~g~GO~r~!~n~~g~GO~r~!~n~~g~GO~r~!", 3000, 3);
  for (const p of near) {
    if (!p.isConnected()) continue;
    go.forPlayer(p);
    p.playSound(1057);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeoutSafe(resolve, ms));
}

/**
 * 初始化快捷命令：
 * /fxq 获取喷气背包 · /jls 获取降落伞（对齐原版命令：喷气背包/降落伞装备）。
 * 比赛/编辑中禁用（与快捷操作菜单一致，避免装备作弊）。
 */
export function initQuickCommands(): void {
  PlayerEvent.onCommandText("fxq", ({ player, next }) => {
    if (isInRace(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "[比赛] 比赛中不能获取喷气背包");
      return next();
    }
    player.setSpecialAction(2); // USEJETPACK
    notifySaved(player, "已获取喷气背包");
    return next();
  });

  PlayerEvent.onCommandText("jls", ({ player, next }) => {
    if (isInRace(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "[比赛] 比赛中不能获取降落伞");
      return next();
    }
    player.giveWeapon(WeaponEnum.PARACHUTE, 1);
    notifySaved(player, "已获取降落伞（按 F 使用）");
    return next();
  });

  // /f 车辆翻正（对齐原版 /f）：抬升 2 让物理重新落正 + 修复。与快捷操作菜单
  // "车辆翻正"同一实现；车内任意模式可用（比赛内翻车自救也支持）。
  PlayerEvent.onCommandText("f", ({ player, next }) => {
    const vehicle = Vehicle.getInstances().find((v) => v.isPlayerIn(player));
    if (!vehicle) {
      player.sendClientMessage(COLOR_ERROR, "你不在车内，无法翻正车辆");
      return next();
    }
    flipVehicle(vehicle, 2);
    notifySaved(player, "车辆已翻正并修复");
    return next();
  });
}
