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

import { setIntervalSafe } from "@/core/timers";
import { sysMsg } from "@/utils/msg";

/** 观察状态 */
interface ObserveState {
  targetId: number;
  kind: "player" | "vehicle";
  /** 观战前的 world/interior（停止时恢复） */
  prevWorld: number;
  prevInterior: number;
  /**
   * 最初跟踪的玩家 id（目标上车切到车辆后仍保留来源）：
   * 目标下车/换车时按此重跟踪回玩家——否则 observeStates.kind 被覆盖成
   * "vehicle" 后 onStateChange 的 kind=player 匹配永远不中，观察者卡在空车上
   */
  originPlayerId?: number;
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
 *  open.mp 无现成的"观战目标切换"事件。触发源：
 *  - 左键（FIRE）→ 下一个；LOOK_RIGHT/A → 下一个
 *  - LOOK_LEFT/A → 上一个；键盘 ←/→ 由 getKeys() 轮询（pollObserveKeys）
 *  鼠标右键（SECONDARY_ATTACK/瞄准）在观战模式下客户端不发送，不可用。 */
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
        sysMsg(observer, "observe", `已切换到 ${target.getName().name}(${target.id})`, "info");
        return;
      }
    } else {
      const target = Vehicle.getInstance(-k);
      if (target && target.isValid()) {
        startObserveVehicle(observer, target);
        sysMsg(observer, "observe", `已切换到车辆 #${target.id}`, "info");
        return;
      }
    }
  }
}

/** 键盘方向键切换检测（getKeys 轮询）：方向键不触发 onKeyStateChange（SA-MP
 *  文档明确），需服务器主动读 getKeys().leftRight。只响应观战者，
 *  按下瞬间（与上次读数变化）触发。leftRight 的位值即
 *  KeysEnum.KEY_LEFT(-128) / KEY_RIGHT(128)。 */
const observePrevLeftRight = new Map<number, number>();
function pollObserveKeys(): void {
  for (const pid of observeStates.keys()) {
    const p = Player.getInstance(pid);
    if (!p || !p.isConnected()) continue;
    const lr = p.getKeys().leftRight;
    const prev = observePrevLeftRight.get(pid) ?? 0;
    if (lr === KeysEnum.KEY_LEFT && prev !== KeysEnum.KEY_LEFT) {
      cycleObserveTarget(p, false); // ← 上一个
    } else if (lr === KeysEnum.KEY_RIGHT && prev !== KeysEnum.KEY_RIGHT) {
      cycleObserveTarget(p, true); // → 下一个
    }
    observePrevLeftRight.set(pid, lr);
  }
}

export function isObserving(playerId: number): boolean {
  return observeStates.has(playerId);
}

export function getObserveTarget(playerId: number): ObserveState | undefined {
  return observeStates.get(playerId);
}

/** 当前正在观战指定玩家的观察者 id 列表（供比赛信息同步：观察者看到被观战者的
 *  CP/计时/排名——对齐原版 RaceRunTime/RaceRunRank 对观战者的 TD 同步）。
 *  同时按 originPlayerId 匹配：竞速中被观战者几乎总在车里，startObservePlayer
 *  会转发成 startObserveVehicle（kind="vehicle"），仅 kind=player 匹配会漏掉
 *  观战车内目标的观察者（现有比赛 TD 同步曾因此失效）。 */
export function getObserverIdsOf(targetId: number): number[] {
  const ids: number[] = [];
  for (const [pid, st] of observeStates) {
    if (st.originPlayerId === targetId || (st.kind === "player" && st.targetId === targetId)) {
      ids.push(pid);
    }
  }
  return ids;
}

/**
 * 观战状态变更钩子（观察者开始/停止观战时触发，参数为观察者 playerId）。
 * 供比赛/回放模块同步"观战者视角的检查点箭头"等 per-observer 实体：
 * start 时用 getObserveTarget 查当前目标，stop 时清理（无循环依赖——
 * observe 不 import room/replay，只提供注册口）。
 */
type ObserveHook = (observerId: number) => void;
const observeStartHooks: ObserveHook[] = [];
const observeStopHooks: ObserveHook[] = [];
export function onObserveStart(hook: ObserveHook): void {
  observeStartHooks.push(hook);
}
export function onObserveStop(hook: ObserveHook): void {
  observeStopHooks.push(hook);
}
function emitObserveStart(observerId: number): void {
  for (const h of observeStartHooks) {
    try {
      h(observerId);
    } catch {
      /* 钩子异常不影响观战主流程 */
    }
  }
}
function emitObserveStop(observerId: number): void {
  for (const h of observeStopHooks) {
    try {
      h(observerId);
    } catch {
      /* 钩子异常不影响观战主流程 */
    }
  }
}

/** 开始观战玩家（自动跟踪其车辆/步行状态） */
export function startObservePlayer(observer: Player, target: Player): void {
  if (observer.id === target.id) {
    sysMsg(observer, "observe", "不能观看自己", "warn");
    return;
  }
  if (
    !target.isConnected() ||
    [PlayerStateEnum.NONE, PlayerStateEnum.SPECTATING].includes(target.getState())
  ) {
    sysMsg(observer, "observe", "对方当前无法被观看", "warn");
    return;
  }
  if (target.isInAnyVehicle()) {
    // 换车/上车瞬间 isInAnyVehicle 与 getVehicle 之间有空窗：getVehicle 可能
    // 返回 undefined，非空断言会让 startObserveVehicle 在 isValid() 上抛 TypeError
    const veh = target.getVehicle();
    if (veh) startObserveVehicle(observer, veh, target.id);
  } else {
    // 保留已有 prevWorld/prevInterior（重跟踪时不覆盖最初值）
    const existing = observeStates.get(observer.id);
    observeStates.set(observer.id, {
      targetId: target.id,
      kind: "player",
      prevWorld: existing?.prevWorld ?? observer.getVirtualWorld(),
      prevInterior: existing?.prevInterior ?? observer.getInterior(),
      originPlayerId: target.id,
    });
    observer.setVirtualWorld(target.getVirtualWorld());
    observer.setInterior(target.getInterior());
    observer.toggleSpectating(true);
    observer.spectatePlayer(target, SpectateModesEnum.NORMAL);
    sysMsg(observer, "observe", `正在观看 ${target.getName().name}(${target.id})`, "info");
    emitObserveStart(observer.id);
  }
}

/** 开始观战车辆（originPlayerId：从观战玩家切入时保留来源玩家，下车后重跟踪用） */
export function startObserveVehicle(
  observer: Player,
  target: Vehicle,
  originPlayerId?: number,
): void {
  if (!target.isValid()) return;
  const existing = observeStates.get(observer.id);
  observeStates.set(observer.id, {
    targetId: target.id,
    kind: "vehicle",
    prevWorld: existing?.prevWorld ?? observer.getVirtualWorld(),
    prevInterior: existing?.prevInterior ?? observer.getInterior(),
    originPlayerId,
  });
  observer.setVirtualWorld(target.getVirtualWorld());
  observer.setInterior(target.getInterior());
  observer.toggleSpectating(true);
  observer.spectateVehicle(target, SpectateModesEnum.NORMAL);
  emitObserveStart(observer.id);
}

/** 停止观战（回到观战前的世界/室内）。quiet=true 时跳过"已关闭观战"提示
 *（换车重挂等瞬态场景，避免误导刷屏——重挂紧接着 startObserveVehicle） */
export function stopObserve(player: Player, opts?: { quiet?: boolean }): void {
  const state = observeStates.get(player.id);
  if (!state) {
    sysMsg(player, "observe", "你不在观战状态", "warn");
    return;
  }
  observeStates.delete(player.id);
  observePrevLeftRight.delete(player.id); // 清轮询残留（防 playerId 复用时吞掉首次按键切换）
  player.toggleSpectating(false);
  // 恢复观战前所在战局（世界）与室内
  player.setVirtualWorld(state.prevWorld);
  player.setInterior(state.prevInterior);
  if (!opts?.quiet) {
    sysMsg(player, "observe", "已关闭观战", "info");
  }
  emitObserveStop(player.id);
}

/** 摘除所有正在观战指定车辆实体的观察者（换车/实体销毁前调用，防 onStreamOut 触发
 *  suggestStop 弹窗打断观战）。返回被摘除的 (playerId, originPlayerId) 列表，供调用方
 *  建新车后重挂（startObserveVehicle 保留 originPlayerId 重跟踪语义）。
 *  覆盖全表而非调用方自己的集合：任何玩家都可能经左右键/cycleObserveTarget 切到
 *  该车（observeStates 有记录但不属于调用方的 watcher 集合）。 */
export function detachObservingVehicle(
  targetId: number,
): { playerId: number; originPlayerId?: number }[] {
  const detached: { playerId: number; originPlayerId?: number }[] = [];
  for (const [pid, st] of observeStates) {
    if (st.kind === "vehicle" && st.targetId === targetId) {
      const observer = Player.getInstance(pid);
      if (observer && observer.isConnected()) {
        stopObserve(observer, { quiet: true }); // 瞬态重挂：不弹"已关闭观战"
        detached.push({ playerId: pid, originPlayerId: st.originPlayerId });
      }
    }
  }
  return detached;
}

/** 清理（断线时） */
export function cleanupObserve(playerId: number): void {
  observeStates.delete(playerId);
  observePrevLeftRight.delete(playerId);
  emitObserveStop(playerId); // 断线：清理观察者专属实体（CP 箭头等）
}

/**
 * 目标失去跟踪（掉线/换车/重生等）时重新跟踪或提示。
 */
function retracePlayer(observer: Player, state: ObserveState): void {
  // 有最初跟踪玩家（目标上车切的车）→ 恢复为跟踪该玩家本人（下车/换车/重生后
  // 目标仍在，重跟踪回玩家而非继续盯车）
  if (state.originPlayerId != null) {
    const origin = Player.getInstance(state.originPlayerId);
    if (
      origin &&
      origin.isConnected() &&
      ![PlayerStateEnum.NONE, PlayerStateEnum.SPECTATING].includes(origin.getState())
    ) {
      startObservePlayer(observer, origin);
      return;
    }
    suggestStop(observer);
    return;
  }
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
  // 对话框期间断线：cleanupObserve 已删条目并 emitObserveStop，直接退出防重插
  //（否则 playerId 复用后新连接继承观战态）
  if (!observer.isConnected()) return;
  if (res && res.response) {
    // 期间可能已 /tv off（stopObserve 删条目 + 恢复世界）：重复恢复会重设
    // 世界/重复提示，且条目已删时按"已处理"跳过
    if (observeStates.has(observer.id)) {
      observeStates.delete(observer.id);
      emitObserveStop(observer.id); // 观察者专属实体清理（房间的 CP 箭头等）
      observer.toggleSpectating(false);
      observer.setVirtualWorld(prevWorld);
      observer.setInterior(prevInterior);
      sysMsg(observer, "observe", "已关闭观战", "info");
    }
  } else {
    // 保留观战状态（stopObserve 仍可正常关闭）。期间已 /tv off（stopObserve
    // 删条目）则不重插——观战态已结束，重插会残留不一致的条目
    if (state && !observeStates.has(observer.id)) {
      observeStates.set(observer.id, state);
    }
    sysMsg(observer, "observe", "可通过 /tv off 停止观战", "plain");
  }
}

/** 初始化观察系统 */
export function initObserve(): void {
  // 在线玩家都登记为可切换观战候选（断线时注销；观战者自己在切换时排除）
  PlayerEvent.onConnect(({ player, next }) => {
    if (!player.isNpc()) registerObserveCandidate(player.id, "player");
    return next();
  });

  // 观战切换（按下瞬间触发；只响应观战者）：
  // 左键（FIRE）→ 下一个；Q（LOOK_LEFT）/E（LOOK_RIGHT）→ 上一个/下一个。
  // SA-MP 键位：Q=LOOK_LEFT(256)、E=LOOK_RIGHT(64)，两者都触发
  // onKeyStateChange；鼠标右键（瞄准）观战中客户端不发送不可用；←/→ 方向键
  // 不触发 onKeyStateChange（文档明确），由 pollObserveKeys 的 getKeys 轮询。
  PlayerEvent.onKeyStateChange(({ player, newKeys, oldKeys, next }) => {
    if (player.isNpc()) return next();
    if (!observeStates.has(player.id)) return next(); // 非观战不处理
    if (isPressed(newKeys, oldKeys, KeysEnum.FIRE)) {
      cycleObserveTarget(player, true); // 左键 → 下一个
      return next();
    }
    if (isPressed(newKeys, oldKeys, KeysEnum.LOOK_RIGHT)) {
      cycleObserveTarget(player, true); // E 键 → 下一个
      return next();
    }
    if (isPressed(newKeys, oldKeys, KeysEnum.LOOK_LEFT)) {
      cycleObserveTarget(player, false); // Q 键 → 上一个
      return next();
    }
    return next();
  });

  // 键盘 ←/→ 方向键切换（getKeys 轮询 100ms；onKeyStateChange 收不到方向键）。
  // 注意：观战中玩家不发 sync 包，服务器按键缓存可能为空，轮询未必可靠——
  // 主切换路径是聊天命令（/tv next|prev，观战中命令明确可用）
  setIntervalSafe(() => pollObserveKeys(), 100);

  // /tv <ID> 观战玩家 · /tv off 关闭 · /tv next|prev 切换上一个/下一个观战目标。
  // 聊天命令在观战中不受限制（对齐 /p 面板原理），是切换的可靠入口——
  // 观战模式下客户端只同步左键（FIRE），Q/E（LOOK_LEFT/RIGHT）与右键（瞄准）
  // 均为本地镜头键不发送，按键切换依赖客户端同步不可靠。
  PlayerEvent.onCommandText(["tv", "ob", "spec"], ({ player, subcommand, next }) => {
    const arg = subcommand[0];
    if (!arg) {
      sysMsg(
        player,
        "observe",
        "用法: /tv 玩家ID 观战 · /tv off 关闭 · /tv next 下一个 · /tv prev 上一个",
        "info",
      );
      return next();
    }
    if (arg === "off") {
      stopObserve(player);
      return next();
    }
    if (arg === "next" || arg === "prev") {
      if (!observeStates.has(player.id)) {
        sysMsg(player, "observe", "你不在观战中，先 /tv 玩家ID 开始观战", "warn");
        return next();
      }
      cycleObserveTarget(player, arg === "next");
      return next();
    }
    const target = Player.getInstance(+arg);
    if (!target) {
      sysMsg(player, "observe", "对方未在线", "warn");
      return next();
    }
    if (getObserveTarget(target.id)) {
      sysMsg(player, "observe", "对方正处于观战状态", "warn");
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
    // 遍历所有观察者重新跟踪。匹配"最初跟踪的玩家"（originPlayerId）——含目标
    // 上车后 kind 已是 vehicle 的情况（否则目标下车时 kind=vehicle 匹配不中，
    // 观察者卡在被弃车辆上）。targetId 可能是车辆 id（kind="vehicle" 且无
    // originPlayerId 的纯车辆目标由 onStreamOut 重跟踪），玩家 id 与车辆 id 是
    // 独立命名空间，数值上可能撞号，须同时校验 originPlayerId 指向该玩家。
    for (const [pid, st] of observeStates) {
      if (st.originPlayerId === target.id) {
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

  // 目标进室内/换世界：观察者跟着进（主动追踪内部空间）。
  // 用 originPlayerId 匹配（与 onStateChange 对齐）：目标上车后 kind 已是
  // vehicle，仅按 kind=player 匹配会漏——目标从车里进室内时观察者 interior 不跟随
  PlayerEvent.onInteriorChange(({ player: target, next }) => {
    for (const [pid, st] of observeStates) {
      if (st.originPlayerId === target.id) {
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
