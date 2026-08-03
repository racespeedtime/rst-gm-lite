import {
  Dialog,
  DialogStylesEnum,
  Player,
  PlayerEvent,
  PlayerStateEnum,
  SpectateModesEnum,
  Vehicle,
  VehicleEvent,
} from "@infernus/core";

import { COLOR_ORANGE, COLOR_WHITE, COLOR_ERROR } from "@/utils/colors";

/** 观察状态 */
interface ObserveState {
  targetId: number;
  kind: "player" | "vehicle";
  /** 观战前的 world/interior（停止时恢复） */
  prevWorld: number;
  prevInterior: number;
}

const observeStates = new Map<number, ObserveState>();

export function isObserving(playerId: number): boolean {
  return observeStates.has(playerId);
}

export function getObserveTarget(playerId: number): ObserveState | undefined {
  return observeStates.get(playerId);
}

/** 当前正在观战指定玩家的观察者 id 列表（供比赛信息同步：观察者看到被观战者的
 *  CP/计时/排名——对齐原版 RaceRunTime/RaceRunRank 对观战者的 TD 同步） */
export function getObserverIdsOf(targetId: number): number[] {
  const ids: number[] = [];
  for (const [pid, st] of observeStates) {
    if (st.kind === "player" && st.targetId === targetId) {
      ids.push(pid);
    }
  }
  return ids;
}

/** 开始观战玩家（自动跟踪其车辆/步行状态） */
export function startObservePlayer(observer: Player, target: Player): void {
  if (observer.id === target.id) {
    observer.sendClientMessage(COLOR_ORANGE, "[TV] 不能观看自己");
    return;
  }
  if (
    !target.isConnected() ||
    [PlayerStateEnum.NONE, PlayerStateEnum.SPECTATING].includes(target.getState())
  ) {
    observer.sendClientMessage(COLOR_ORANGE, "[TV] 对方当前无法被观看");
    return;
  }
  if (target.isInAnyVehicle()) {
    const veh = target.getVehicle()!;
    startObserveVehicle(observer, veh);
  } else {
    // 保留已有 prevWorld/prevInterior（重跟踪时不覆盖最初值）
    const existing = observeStates.get(observer.id);
    observeStates.set(observer.id, {
      targetId: target.id,
      kind: "player",
      prevWorld: existing?.prevWorld ?? observer.getVirtualWorld(),
      prevInterior: existing?.prevInterior ?? observer.getInterior(),
    });
    observer.setVirtualWorld(target.getVirtualWorld());
    observer.setInterior(target.getInterior());
    observer.toggleSpectating(true);
    observer.spectatePlayer(target, SpectateModesEnum.NORMAL);
    observer.sendClientMessage(COLOR_WHITE, `[TV] 正在观看 ${target.getName().name}(${target.id})`);
  }
}

/** 开始观战车辆 */
export function startObserveVehicle(observer: Player, target: Vehicle): void {
  if (!target.isValid()) return;
  const existing = observeStates.get(observer.id);
  observeStates.set(observer.id, {
    targetId: target.id,
    kind: "vehicle",
    prevWorld: existing?.prevWorld ?? observer.getVirtualWorld(),
    prevInterior: existing?.prevInterior ?? observer.getInterior(),
  });
  observer.setVirtualWorld(target.getVirtualWorld());
  observer.setInterior(target.getInterior());
  observer.toggleSpectating(true);
  observer.spectateVehicle(target, SpectateModesEnum.NORMAL);
}

/** 停止观战（回到观战前的世界/室内） */
export function stopObserve(player: Player): void {
  const state = observeStates.get(player.id);
  if (!state) {
    player.sendClientMessage(COLOR_ERROR, "[TV] 你不在观战状态");
    return;
  }
  observeStates.delete(player.id);
  player.toggleSpectating(false);
  // 恢复观战前所在战局（世界）与室内
  player.setVirtualWorld(state.prevWorld);
  player.setInterior(state.prevInterior);
  player.sendClientMessage(COLOR_ORANGE, "[TV] 已关闭观战");
}

/** 清理（断线时） */
export function cleanupObserve(playerId: number): void {
  observeStates.delete(playerId);
}

/**
 * 目标失去跟踪（掉线/换车/重生等）时重新跟踪或提示。
 */
function retracePlayer(observer: Player, state: ObserveState): void {
  if (state.kind === "player") {
    const target = Player.getInstance(state.targetId);
    if (
      target &&
      target.isConnected() &&
      ![PlayerStateEnum.NONE, PlayerStateEnum.SPECTATING].includes(target.getState())
    ) {
      startObservePlayer(observer, target);
      return;
    }
    suggestStop(observer);
  } else {
    // kind === "vehicle"：targetId 是车辆 id（不能用 Player.getInstance 取）
    const veh = Vehicle.getInstance(state.targetId);
    if (veh && veh.isValid()) {
      startObserveVehicle(observer, veh);
      return;
    }
    suggestStop(observer);
  }
}

/** 弹提示：观察对象已无法跟踪 */
async function suggestStop(observer: Player): Promise<void> {
  const state = observeStates.get(observer.id);
  const prevWorld = state?.prevWorld ?? observer.getVirtualWorld();
  const prevInterior = state?.prevInterior ?? observer.getInterior();
  // 选"否"时状态保留（恢复 Map，避免 /tv off 报"不在观战状态"且无法退出）
  observer.toggleSpectating(true);
  const res = await new Dialog({
    style: DialogStylesEnum.MSGBOX,
    caption: "提示",
    info: "你观察的对象已无法继续跟踪，是否停止观战？",
    button1: "是",
    button2: "否",
  })
    .show(observer)
    .catch(() => null);
  if (res && res.response) {
    observeStates.delete(observer.id);
    observer.toggleSpectating(false);
    observer.setVirtualWorld(prevWorld);
    observer.setInterior(prevInterior);
    observer.sendClientMessage(COLOR_ORANGE, "[TV] 已关闭观战");
  } else {
    // 保留观战状态（stopObserve 仍可正常关闭）
    if (state && !observeStates.has(observer.id)) {
      observeStates.set(observer.id, state);
    }
    observer.sendClientMessage(COLOR_ORANGE, "可通过 /tv off 停止观战");
  }
}

/** 初始化观察系统 */
export function initObserve(): void {
  // /tv <ID> 观战玩家，/tv off 关闭
  PlayerEvent.onCommandText(["tv", "ob", "spec"], ({ player, subcommand, next }) => {
    const arg = subcommand[0];
    if (!arg) {
      player.sendClientMessage(COLOR_ORANGE, "[TV] 用法: /tv 玩家ID 观战 · /tv off 关闭");
      return next();
    }
    if (arg === "off") {
      stopObserve(player);
      return next();
    }
    const target = Player.getInstance(+arg);
    if (!target) {
      player.sendClientMessage(COLOR_ORANGE, "[TV] 对方未在线");
      return next();
    }
    if (getObserveTarget(target.id)) {
      player.sendClientMessage(COLOR_ORANGE, "[TV] 对方正处于观战状态");
      return next();
    }
    startObservePlayer(player, target);
    return next();
  });

  // 自动重跟踪：目标换车/换状态/重生
  VehicleEvent.onStreamOut(({ vehicle: target, forPlayer, next }) => {
    if (forPlayer) {
      const st = observeStates.get(forPlayer.id);
      if (st && st.kind === "vehicle" && st.targetId === target.id) {
        retracePlayer(forPlayer, st);
      }
    }
    return next();
  });

  PlayerEvent.onStateChange(({ player: target, next }) => {
    // 遍历所有观察者重新跟踪
    for (const [pid, st] of observeStates) {
      if (st.targetId === target.id) {
        const observer = Player.getInstance(pid);
        if (observer && observer.isConnected()) retracePlayer(observer, st);
      }
    }
    return next();
  });

  PlayerEvent.onSpawn(({ player: target, next }) => {
    for (const [pid, st] of observeStates) {
      if (st.targetId === target.id) {
        const observer = Player.getInstance(pid);
        if (observer && observer.isConnected()) retracePlayer(observer, st);
      }
    }
    return next();
  });

  // 目标进室内/换世界：观察者跟着进（主动追踪内部空间）
  PlayerEvent.onInteriorChange(({ player: target, next }) => {
    for (const [pid, st] of observeStates) {
      if (st.targetId === target.id) {
        const observer = Player.getInstance(pid);
        if (observer && observer.isConnected()) {
          observer.setInterior(target.getInterior());
        }
      }
    }
    return next();
  });

  PlayerEvent.onDisconnect(({ player: target, next }) => {
    for (const [pid, st] of observeStates) {
      if (st.targetId === target.id) {
        const observer = Player.getInstance(pid);
        if (observer && observer.isConnected()) retracePlayer(observer, st);
      }
    }
    return next();
  });
}
