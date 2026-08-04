import {
  Dialog,
  DialogStylesEnum,
  KeysEnum,
  Player,
  PlayerEvent,
  PlayerStateEnum,
  SpectateModesEnum,
  Vehicle,
  VehicleEvent,
  isPressed,
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

/**
 * 观战切换候选源（玩家/车辆，注册制的可切换目标列表）。
 * 每份观战会话对应一条：切走/停止时清掉；观战回放/影子时由 replay 模块
 * 注册 ghost 车。key 保证同源不重复注册（玩家用负号区分车辆）。
 */
const observeCandidates = new Map<number, { kind: "player" | "vehicle" }>();

/** 注册观战切换候选源（targetId：玩家 id 或车辆 id；kind 区分命名空间） */
export function registerObserveCandidate(targetId: number, kind: "player" | "vehicle"): void {
  const key = kind === "player" ? targetId : -targetId;
  observeCandidates.set(key, { kind });
}

/** 注销观战切换候选源（实体销毁/离开可切范围时调用） */
export function unregisterObserveCandidate(targetId: number, kind: "player" | "vehicle"): void {
  observeCandidates.delete(kind === "player" ? targetId : -targetId);
}

/** 观战左/右键切换：循环切换下一个/上一个可观战目标。
 *  左键（FIRE）→ 下一个；右键（SECONDARY_ATTACK/瞄准）→ 上一个。
 *  open.mp 无现成的"观战目标切换"事件，用按键同步（onKeyStateChange）检测
 *  ——观战中玩家仍发按键包（键盘 WASD 已证实可用，鼠标键同理依赖客户端）。
 *  AI 观战者/NPC 不参与（onKeyStateChange 对 NPC 不触发）。 */
function cycleObserveTarget(observer: Player, forward: boolean): void {
  const st = observeStates.get(observer.id);
  if (!st) return;
  if (observeCandidates.size === 0) return;
  // 当前目标在候选列表中的索引；不在则从头/尾开始
  const curKey = st.kind === "player" ? st.targetId : -st.targetId;
  const keys = [...observeCandidates.keys()];
  let idx = keys.indexOf(curKey);
  if (idx < 0) idx = forward ? -1 : keys.length;
  for (let step = 1; step <= keys.length; step++) {
    const k = keys[(idx + (forward ? step : -step) + keys.length * 2) % keys.length];
    const cand = observeCandidates.get(k)!;
    if (cand.kind === "player") {
      const target = Player.getInstance(k);
      if (target && target.isConnected() && target.id !== observer.id) {
        startObservePlayer(observer, target); // 会更新 observeStates + spectate
        return;
      }
    } else {
      const target = Vehicle.getInstance(-k);
      if (target && target.isValid()) {
        startObserveVehicle(observer, target);
        return;
      }
    }
  }
}

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
  // 在线玩家都登记为可切换观战候选（断线时注销；观战者自己在切换时排除）
  PlayerEvent.onConnect(({ player, next }) => {
    if (!player.isNpc()) registerObserveCandidate(player.id, "player");
    return next();
  });

  // 观战左/右键循环切换（左键=下一个，右键=上一个）。按下瞬间触发；
  // 观战模式中玩家仍发按键包（键盘方向键已验证可用）。只响应观战者。
  PlayerEvent.onKeyStateChange(({ player, newKeys, oldKeys, next }) => {
    if (player.isNpc()) return next();
    if (!observeStates.has(player.id)) return next(); // 非观战不处理
    if (isPressed(newKeys, oldKeys, KeysEnum.FIRE)) {
      cycleObserveTarget(player, true); // 左键 → 下一个
      return next();
    }
    if (isPressed(newKeys, oldKeys, KeysEnum.SECONDARY_ATTACK)) {
      cycleObserveTarget(player, false); // 右键 → 上一个
      return next();
    }
    return next();
  });

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
    // 遍历所有观察者重新跟踪。仅匹配 kind="player" 的观察者——targetId 可能是
    // 车辆 id（kind="vehicle"，车辆目标的重跟踪由 onStreamOut 处理），玩家 id 与
    // 车辆 id 是独立命名空间，数值上可能撞号，不做 kind 区分会误重跟踪
    for (const [pid, st] of observeStates) {
      if (st.kind === "player" && st.targetId === target.id) {
        const observer = Player.getInstance(pid);
        if (observer && observer.isConnected()) retracePlayer(observer, st);
      }
    }
    return next();
  });

  // 观察者自己死亡（/kill 自杀/被杀死）：退出观战。否则 onRequestSpawn 闸门
  // 会拦截 spect 中的出生请求，玩家卡在观战无法重生（重生请求被拒）。
  // 死亡即回到自己世界：恢复 prevWorld 后客户端重生请求放行，正常重生。
  PlayerEvent.onDeath(({ player, next }) => {
    if (observeStates.has(player.id)) {
      stopObserve(player);
    }
    return next();
  });

  PlayerEvent.onSpawn(({ player: target, next }) => {
    // 观察者自己重生（服务器 spawn 路径，如比赛强制重生，绕过 RequestSpawn
    // 闸门）：兜底退出观战——否则 observeStates 残留，速度表仍读被观战
    // 对象的速度而非自己的
    if (observeStates.has(target.id)) {
      stopObserve(target);
    }
    // 被观战者重生：通知观察者重跟踪
    for (const [pid, st] of observeStates) {
      if (st.kind === "player" && st.targetId === target.id) {
        const observer = Player.getInstance(pid);
        if (observer && observer.isConnected()) retracePlayer(observer, st);
      }
    }
    return next();
  });

  // 目标进室内/换世界：观察者跟着进（主动追踪内部空间）
  PlayerEvent.onInteriorChange(({ player: target, next }) => {
    for (const [pid, st] of observeStates) {
      if (st.kind === "player" && st.targetId === target.id) {
        const observer = Player.getInstance(pid);
        if (observer && observer.isConnected()) {
          observer.setInterior(target.getInterior());
        }
      }
    }
    return next();
  });

  PlayerEvent.onDisconnect(({ player: target, next }) => {
    // 从可切换候选移除
    unregisterObserveCandidate(target.id, "player");
    for (const [pid, st] of observeStates) {
      if (st.kind === "player" && st.targetId === target.id) {
        const observer = Player.getInstance(pid);
        if (observer && observer.isConnected()) retracePlayer(observer, st);
      }
    }
    return next();
  });
}
