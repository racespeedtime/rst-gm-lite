import {
  Dialog,
  DialogStylesEnum,
  Dynamic3DTextLabel,
  DynamicObject,
  DynamicObjectEvent,
  GameMode,
  InvalidEnum,
  isHolding,
  isPressed,
  KeysEnum,
  Player,
  PlayerEvent,
} from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { isPlayerLocked, lockPlayer, unlockPlayer } from "@/core/interaction";
import { clearTimeoutSafe, setTimeoutSafe } from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { COLOR_ERROR } from "@/utils/colors";
import { logger } from "@/logger";
import {
  DOORS_SPEED,
  DOOR_SOUND_ID,
  ELEVATOR_BOOST_DELAY,
  ELEVATOR_CONFIGS,
  ELEVATOR_SPEED,
  ELEVATOR_STATE_IDLE,
  ELEVATOR_STATE_MOVING,
  ELEVATOR_STATE_WAITING,
  ELEVATOR_WAIT_TIME,
  ELEVATOR_WORLD_ID,
  INVALID_FLOOR,
  type ElevatorConfig,
} from "./config";

/**
 * 电梯系统（通用引擎，移植自 infernus filterscript 的 4 个电梯脚本，
 * 见 config.ts 的 4 份配置）。直接集成进本 GameMode（不走 GameMode.use），
 * 全部交互 UI 为中文；计时用登记式 setIntervalSafe 体系，GameMode.onExit 统一清理。
 *
 * 玩法对齐原版：电梯在楼层间移动，玩家站在轿厢上可被带走；
 * 楼层按钮（按 Y 呼叫）→ 到层开门 → 轿厢内按钮（按 Y 选层）。
 * 状态机：IDLE(空闲) → [队列有单] 关门 → 慢速起步 2s → 提速 → 到层开门 → WAITING(停留)
 * → 到时 → IDLE → 继续队列。楼层门关到位事件（onMoved）驱动下一段行程。
 */

/** 轿厢内按钮标签（电梯移动时销毁，到层后按新高度重建）与各层标签 */
interface ElevatorLabels {
  elevator: Dynamic3DTextLabel | null;
  floors: Dynamic3DTextLabel[];
}

/** 单部电梯的运行态（一个配置 = 一个实例） */
interface ElevatorInstance {
  readonly config: ElevatorConfig;
  readonly car: DynamicObject;
  readonly carDoors: [DynamicObject, DynamicObject];
  readonly floorDoors: [DynamicObject, DynamicObject][];
  readonly labels: ElevatorLabels;
  readonly extraObjects: DynamicObject[];
  /** IDLE / WAITING / MOVING */
  state: number;
  /** 当前所在层（IDLE/WAITING）或正前往的层（MOVING） */
  floor: number;
  /** 楼层队列（INVALID_FLOOR 为空位，容量 = 层数） */
  queue: number[];
  /** 各楼层由谁呼叫（Player 或 InvalidEnum.PLAYER_ID） */
  requestedBy: (Player | number)[];
  boostTimer: NodeJS.Timeout | undefined;
  turnTimer: NodeJS.Timeout | undefined;
}

const instances = new Map<string, ElevatorInstance>();
let handlersReady = false;

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

/** 楼层门/轿厢门所在 z（门随轿厢升降，基于目标层） */
function doorsZ(el: ElevatorInstance, floorId: number): number {
  return el.config.groundZ + el.config.floorZOffsets[floorId] + el.config.doorZBaseOffset;
}

/** 轿厢所在 z（比楼层门多一个轿厢模型抬升） */
function carZ(el: ElevatorInstance, floorId: number): number {
  return el.config.groundZ + el.config.floorZOffsets[floorId] + el.config.elevatorZOffset;
}

/** 门的关到位判定（onMoved 后检查）：沿轴坐标 <= closedPos + margin */
function isDoorClosed(el: ElevatorInstance, pos: { x: number; y: number }): boolean {
  const check = el.config.doorClosedCheck;
  const axisPos = check.axis === "x" ? pos.x : pos.y;
  return axisPos <= check.closedPos + check.margin;
}

function playSoundInRange(soundId: number, range: number, x: number, y: number, z: number): void {
  for (const p of Player.getInstances()) {
    if (!p.isConnected() || p.isNpc()) continue;
    if (p.isInRangeOfPoint(range, x, y, z)) p.playSound(soundId, x, y, z);
  }
}

// ---------------------------------------------------------------------------
// 门
// ---------------------------------------------------------------------------

function carDoorsOpen(el: ElevatorInstance): void {
  const z = doorsZ(el, el.floor);
  const t = el.config.carDoors;
  el.carDoors[0].move(t.leftOpen.x, t.leftOpen.y, z, DOORS_SPEED);
  el.carDoors[1].move(t.rightOpen.x, t.rightOpen.y, z, DOORS_SPEED);
}

function carDoorsClose(el: ElevatorInstance): boolean {
  if (el.state === ELEVATOR_STATE_MOVING) return false;
  const z = doorsZ(el, el.floor);
  const t = el.config.carDoors;
  el.carDoors[0].move(t.closed.x, t.closed.y, z, DOORS_SPEED);
  el.carDoors[1].move(t.closed.x, t.closed.y, z, DOORS_SPEED);
  return true;
}

function floorDoorsOpen(el: ElevatorInstance, floorId: number): void {
  const z = doorsZ(el, floorId) + el.config.floorDoorMoveZOffset;
  const t = el.config.floorDoors;
  el.floorDoors[floorId][0].move(t.leftOpen.x, t.leftOpen.y, z, DOORS_SPEED);
  el.floorDoors[floorId][1].move(t.rightOpen.x, t.rightOpen.y, z, DOORS_SPEED);
  playSoundInRange(DOOR_SOUND_ID, 50, el.config.x, el.config.y, z + 5);
}

function floorDoorsClose(el: ElevatorInstance, floorId: number): void {
  const z = doorsZ(el, floorId) + el.config.floorDoorMoveZOffset;
  const t = el.config.floorDoors;
  el.floorDoors[floorId][0].move(t.closed.x, t.closed.y, z, DOORS_SPEED);
  el.floorDoors[floorId][1].move(t.closed.x, t.closed.y, z, DOORS_SPEED);
  playSoundInRange(DOOR_SOUND_ID, 50, el.config.x, el.config.y, z + 5);
}

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

function resetQueue(el: ElevatorInstance): void {
  el.queue = [];
  el.requestedBy = [];
  for (let i = 0; i < el.config.floors.length; i++) {
    el.queue[i] = INVALID_FLOOR;
    el.requestedBy[i] = InvalidEnum.PLAYER_ID;
  }
}

function queueHas(el: ElevatorInstance, floorId: number): boolean {
  return el.queue.includes(floorId);
}

function didRequest(el: ElevatorInstance, player: Player): boolean {
  return el.requestedBy.includes(player);
}

/** 移除队首并补空位（容量固定 = 层数） */
function removeQueueHead(el: ElevatorInstance): void {
  el.queue.shift();
  el.queue.push(INVALID_FLOOR);
}

function addToQueue(el: ElevatorInstance, floorId: number): boolean {
  const slot = el.queue.indexOf(INVALID_FLOOR);
  if (slot === -1) return false;
  el.queue[slot] = floorId;
  // 空闲时直接出发（关门 → 门关到位事件 → 移动）
  if (el.state === ELEVATOR_STATE_IDLE) readNextFloorInQueue(el);
  return true;
}

/** 玩家呼叫某层（已在队列/已被呼叫则拒绝） */
function callElevator(el: ElevatorInstance, player: Player, floorId: number): boolean {
  if (el.requestedBy[floorId] !== InvalidEnum.PLAYER_ID || queueHas(el, floorId)) return false;
  el.requestedBy[floorId] = player;
  if (!addToQueue(el, floorId)) {
    // 队列满：回滚占坑，避免该楼层被永久占用（原版遗留问题）
    el.requestedBy[floorId] = InvalidEnum.PLAYER_ID;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 行程
// ---------------------------------------------------------------------------

/** 空闲且有队首 → 关电梯门 + 关当前层门（门关到位事件触发移动） */
function readNextFloorInQueue(el: ElevatorInstance): boolean {
  if (el.state !== ELEVATOR_STATE_IDLE || el.queue[0] === INVALID_FLOOR) return false;
  carDoorsClose(el);
  floorDoorsClose(el, el.floor);
  return true;
}

/** 慢速起步（给客户端同步踩轿厢的时间），2 秒后提速 */
function moveToFloor(el: ElevatorInstance, floorId: number): void {
  el.state = ELEVATOR_STATE_MOVING;
  el.floor = floorId;
  const z = carZ(el, floorId);
  const doorZ = doorsZ(el, floorId);
  el.car.move(el.config.x, el.config.y, z, 0.25);
  el.carDoors[0].move(el.config.carDoors.closed.x, el.config.carDoors.closed.y, doorZ, 0.25);
  el.carDoors[1].move(el.config.carDoors.closed.x, el.config.carDoors.closed.y, doorZ, 0.25);
  // 轿厢移动期间标签销毁，到层后按新高度重建
  destroyElevatorLabel(el);
  clearTimeoutSafe(el.boostTimer);
  el.boostTimer = setTimeoutSafe(() => boost(el, floorId), ELEVATOR_BOOST_DELAY);
}

function boost(el: ElevatorInstance, floorId: number): void {
  el.car.stop();
  el.carDoors[0].stop();
  el.carDoors[1].stop();
  el.car.move(el.config.x, el.config.y, carZ(el, floorId), ELEVATOR_SPEED);
  el.carDoors[0].move(
    el.config.carDoors.closed.x,
    el.config.carDoors.closed.y,
    doorsZ(el, floorId),
    ELEVATOR_SPEED,
  );
  el.carDoors[1].move(
    el.config.carDoors.closed.x,
    el.config.carDoors.closed.y,
    doorsZ(el, floorId),
    ELEVATOR_SPEED,
  );
}

/** 停留结束：回到空闲并继续处理队列 */
function turnToIdle(el: ElevatorInstance): void {
  el.state = ELEVATOR_STATE_IDLE;
  readNextFloorInQueue(el);
}

/** 轿厢到达目标层：开门、清呼叫、重建轿厢内标签、进入停留 */
function onElevatorArrive(el: ElevatorInstance): void {
  clearTimeoutSafe(el.boostTimer);
  el.requestedBy[el.floor] = InvalidEnum.PLAYER_ID;
  carDoorsOpen(el);
  floorDoorsOpen(el, el.floor);
  createElevatorLabel(el, carZ(el, el.floor) + el.config.elevatorLabelOffset.z);
  clearTimeoutSafe(el.turnTimer);
  el.state = ELEVATOR_STATE_WAITING;
  el.turnTimer = setTimeoutSafe(() => turnToIdle(el), ELEVATOR_WAIT_TIME);
}

/** 楼层门关到位 → 前往队列下一层 */
function onFloorDoorClosed(el: ElevatorInstance): void {
  const next = el.queue[0];
  if (next === INVALID_FLOOR) return; // 防御：队列已空（正常流程不会发生）
  moveToFloor(el, next);
  removeQueueHead(el);
}

// ---------------------------------------------------------------------------
// 对象/标签创建与销毁
// ---------------------------------------------------------------------------

function createElevatorLabel(el: ElevatorInstance, z: number): void {
  destroyElevatorLabel(el);
  const cfg = el.config;
  const label = new Dynamic3DTextLabel({
    text: "{CCCCCC}按 ~k~~CONVERSATION_YES~ 键使用电梯",
    color: 0xccccccaa,
    x: cfg.x + cfg.elevatorLabelOffset.x,
    y: cfg.y + cfg.elevatorLabelOffset.y,
    z,
    drawDistance: 4.0,
    worldId: ELEVATOR_WORLD_ID,
    testLOS: true,
    charset: DEFAULT_CHARSET, // 3D 标签中文必须与玩家默认字符集一致否则乱码
  });
  label.create();
  el.labels.elevator = label;
}

function destroyElevatorLabel(el: ElevatorInstance): void {
  if (el.labels.elevator) {
    try {
      el.labels.elevator.destroy();
    } catch {
      /* 已失效等，忽略 */
    }
    el.labels.elevator = null;
  }
}

function createInstance(config: ElevatorConfig): ElevatorInstance {
  const el: ElevatorInstance = {
    config,
    car: new DynamicObject({
      modelId: 18755, // 电梯轿厢
      x: config.x,
      y: config.y,
      z: config.groundZ + config.elevatorZOffset,
      rx: 0,
      ry: 0,
      rz: config.elevatorRotation,
      worldId: ELEVATOR_WORLD_ID,
    }),
    carDoors: [
      new DynamicObject({
        modelId: 18757, // 左门
        x: config.carDoors.closed.x,
        y: config.carDoors.closed.y,
        z: config.groundZ + config.doorZBaseOffset,
        rx: 0,
        ry: 0,
        rz: config.elevatorRotation,
        worldId: ELEVATOR_WORLD_ID,
      }),
      new DynamicObject({
        modelId: 18756, // 右门
        x: config.carDoors.closed.x,
        y: config.carDoors.closed.y,
        z: config.groundZ + config.doorZBaseOffset,
        rx: 0,
        ry: 0,
        rz: config.elevatorRotation,
        worldId: ELEVATOR_WORLD_ID,
      }),
    ],
    floorDoors: [],
    labels: { elevator: null, floors: [] },
    extraObjects: [],
    state: ELEVATOR_STATE_IDLE,
    floor: 0,
    queue: [],
    requestedBy: [],
    boostTimer: undefined,
    turnTimer: undefined,
  };
  el.car.create();
  el.carDoors[0].create();
  el.carDoors[1].create();

  for (let i = 0; i < config.floors.length; i++) {
    const doorZ = doorsZ(el, i) + config.floorDoorCreateZOffset;
    el.floorDoors[i] = [
      new DynamicObject({
        modelId: 18757,
        x: config.floorDoors.closed.x,
        y: config.floorDoors.closed.y,
        z: doorZ,
        rx: 0,
        ry: 0,
        rz: config.elevatorRotation,
        worldId: ELEVATOR_WORLD_ID,
      }),
      new DynamicObject({
        modelId: 18756,
        x: config.floorDoors.closed.x,
        y: config.floorDoors.closed.y,
        z: doorZ,
        rx: 0,
        ry: 0,
        rz: config.elevatorRotation,
        worldId: ELEVATOR_WORLD_ID,
      }),
    ];
    el.floorDoors[i][0].create();
    el.floorDoors[i][1].create();

    const label = new Dynamic3DTextLabel({
      text: `{CCCCCC}[${config.floors[i]}]\n{CCCCCC}按 ~k~~CONVERSATION_YES~ 键呼叫电梯`,
      color: 0xccccccaa,
      x: config.x + config.floorLabelOffset.x,
      y: config.y + config.floorLabelOffset.y,
      z: config.floorLabelZ[i],
      drawDistance: 10.5,
      worldId: ELEVATOR_WORLD_ID,
      testLOS: true,
      charset: DEFAULT_CHARSET,
    });
    label.create();
    el.labels.floors[i] = label;
  }

  for (const o of config.extraObjects) {
    const obj = new DynamicObject({
      modelId: o.modelId,
      x: o.x,
      y: o.y,
      z: o.z,
      rx: o.rx,
      ry: o.ry,
      rz: o.rz,
      worldId: ELEVATOR_WORLD_ID,
    });
    obj.create();
    el.extraObjects.push(obj);
  }

  resetQueue(el);
  // 初始：底层门与轿厢门打开
  floorDoorsOpen(el, 0);
  carDoorsOpen(el);
  // 轿厢内按钮标签初始在底层
  createElevatorLabel(el, config.groundZ + config.elevatorLabelOffset.z);

  return el;
}

function destroyInstance(el: ElevatorInstance): void {
  clearTimeoutSafe(el.boostTimer);
  clearTimeoutSafe(el.turnTimer);
  destroyElevatorLabel(el);
  try {
    el.car.destroy();
    el.carDoors[0].destroy();
    el.carDoors[1].destroy();
    for (let i = 0; i < el.floorDoors.length; i++) {
      el.floorDoors[i][0].destroy();
      el.floorDoors[i][1].destroy();
      el.labels.floors[i]?.destroy();
    }
    for (const o of el.extraObjects) o.destroy();
  } catch (e) {
    logger.warn(`[elevator] 销毁 ${el.config.id} 失败`, e);
  }
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

/** 轿厢内选层对话框（中文） */
async function showFloorDialog(el: ElevatorInstance, player: Player): Promise<void> {
  let info = "";
  for (let i = 0; i < el.config.floors.length; i++) {
    // 已被其他人呼叫的楼层标红提示（自己已呼叫的楼层同样标红，原版语义）
    if (el.requestedBy[i] !== InvalidEnum.PLAYER_ID) info += "{FF0000}";
    info += el.config.floors[i] + "\n";
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `${el.config.buildingName} - 电梯`,
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return; // 取消/断线
  const floorId = res.listItem;
  if (el.requestedBy[floorId] !== InvalidEnum.PLAYER_ID || queueHas(el, floorId)) {
    player.sendClientMessage(COLOR_ERROR, "[电梯] 该楼层已在队列中");
  } else if (didRequest(el, player)) {
    player.sendClientMessage(COLOR_ERROR, "[电梯] 您已呼叫过电梯");
  } else {
    callElevator(el, player, floorId);
  }
}

/** 楼层判定：z-scan 逐层扫（按所在高度确定楼层）或 zombo 按高度二选一 */
function findFloorByZ(el: ElevatorInstance, z: number): number {
  const cfg = el.config;
  if (cfg.floorMode === "zombo") {
    return z > cfg.groundZ - 2 && z < cfg.groundZ + 2 ? 0 : 1;
  }
  let i = cfg.floorCheckStart;
  while (z < doorsZ(el, i) + 3.5 && i > 0) i--;
  if (i === 0 && z < doorsZ(el, 0) + 2.0) i = -1;
  if (i > cfg.floorCheckStart - 1) return -1; // 楼层按钮区但高度异常
  return i + 1; // i=-1 → 最底层（停车场/地面层）
}

/** 处理一次按键状态变更；返回 true 表示玩家处于该电梯的检测区内（消费了 Y 键） */
function handleKeyState(
  el: ElevatorInstance,
  player: Player,
  newKeys: number,
  oldKeys: number,
): boolean {
  const cfg = el.config;
  const pos = player.getPos();
  const dx = pos.x - cfg.x;
  const dy = pos.y - cfg.y;
  const ir = cfg.insideRange;
  // 轿厢内按钮：按 Y 弹出选层对话框
  if (dx >= ir.xMin && dx <= ir.xMax && dy >= ir.yMin && dy <= ir.yMax) {
    // 只在按下瞬间且不在其他流程中时弹窗（按住不放不重复弹）
    if (isPressed(newKeys, oldKeys, KeysEnum.YES) && !isPlayerLocked(player.id)) {
      lockPlayer(player.id);
      void showFloorDialog(el, player).finally(() => unlockPlayer(player.id));
    }
    return true;
  }
  // 楼层按钮：按 Y 呼叫当前层。面板流程中放行 Y 键给万能面板（否则站在按钮
  // 区旁永远打不开面板）
  const fr = cfg.floorButtonRange;
  if (dx >= fr.xMin && dx <= fr.xMax && dy >= fr.yMin && dy <= fr.yMax) {
    if (isPlayerLocked(player.id)) return false;
    if (!isPressed(newKeys, oldKeys, KeysEnum.YES)) return true;
    const target = findFloorByZ(el, pos.z);
    if (target >= 0) {
      if (cfg.alreadyOnFloorNotify && el.state !== ELEVATOR_STATE_MOVING && el.floor === target) {
        player.sendClientMessage(
          0xffdd00aa,
          `* ${cfg.buildingName} 的电梯已在此楼层，请进入电梯内按 Y 键选择楼层`,
        );
      } else if (callElevator(el, player, target)) {
        player.sendClientMessage(0xffdd00aa, `[电梯] 已呼叫「${cfg.floors[target]}」，请稍候`);
        if (cfg.callChatMessage) {
          const name = cfg.floors[el.floor];
          const msg =
            el.state === ELEVATOR_STATE_MOVING
              ? `* 电梯已呼叫，正在前往「${name}」…`
              : `* 电梯已呼叫，当前在「${name}」…`;
          player.sendClientMessage(0xffdd00aa, msg);
        }
      } else {
        // callElevator 失败（目标层已在队列/已在响应中）：给出反馈，防重复按键无感
        player.sendClientMessage(0xffdd00aa, `[电梯] 「${cfg.floors[target]}」已在响应中，请稍候`);
      }
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 事件与生命周期
// ---------------------------------------------------------------------------

/** 对象移动完成：楼层门关到位 → 去下一层；轿厢到层 → 开门/清呼叫/重建标签 */
function onObjectMoved(el: ElevatorInstance, object: DynamicObject): void {
  for (let i = 0; i < el.floorDoors.length; i++) {
    if (object === el.floorDoors[i][0] && isDoorClosed(el, object.getPos())) {
      onFloorDoorClosed(el);
      return;
    }
  }
  if (object === el.car) onElevatorArrive(el);
}

function applyRemoveBuildings(player: Player): void {
  for (const cfg of ELEVATOR_CONFIGS) {
    for (const rb of cfg.removeBuildings) {
      try {
        player.removeBuilding(rb.modelId, rb.x, rb.y, rb.z, rb.radius);
      } catch {
        /* 玩家已失效等，忽略 */
      }
    }
  }
}

export function destroyElevators(): void {
  for (const el of instances.values()) destroyInstance(el);
  instances.clear();
}

/**
 * 初始化全部电梯（在 callbacks 的 init 序列中调用，须在 initPanel 之前——
 * 电梯与万能面板共用 Y 键，电梯优先消费其检测区内的按键，其余位置交给面板）。
 */
export function initElevators(): void {
  if (handlersReady) return;
  handlersReady = true;

  PlayerEvent.onConnect(({ player, next }) => {
    if (player.isNpc()) return next();
    // 替换建筑：per-player 移除原版模型（随连接消失，无需清理）
    applyRemoveBuildings(player);
    return next();
  });

  // 玩家断线：释放其占用的电梯楼层（requestedBy 持有 Player 引用不清理的话，
  // 楼层永久显示"已被呼叫"且同 id 重连的新 Player 无法再次呼叫该层，直到电梯
  // 到层才清）。队列项保留——电梯仍会到该层，到层后自然清空。
  PlayerEvent.onDisconnect(({ player, next }) => {
    if (player.isNpc()) return next();
    for (const el of instances.values()) {
      for (let i = 0; i < el.requestedBy.length; i++) {
        if (el.requestedBy[i] === player) {
          el.requestedBy[i] = InvalidEnum.PLAYER_ID;
        }
      }
    }
    return next();
  });

  PlayerEvent.onKeyStateChange(({ player, newKeys, oldKeys, next }) => {
    // NPC/未认证玩家不响应；未按 Y 直接放行（面板等后续 handler 继续）
    if (player.isNpc() || !getAuthState(player.id)) return next();
    if (!isHolding(newKeys, KeysEnum.YES)) return next();
    // 只处理玩家当前所在世界的电梯（战局/比赛世界看不到这些建筑）
    const world = player.getVirtualWorld();
    if (world !== ELEVATOR_WORLD_ID) return next();
    for (const el of instances.values()) {
      if (handleKeyState(el, player, newKeys, oldKeys)) {
        // 电梯消费了 Y 键（楼层呼叫/轿厢内选层）：同步 return false 终止事件链，
        // 避免同时触发万能面板（面板同样监听 Y 键，注册在电梯之后）
        return false;
      }
    }
    return next();
  });

  DynamicObjectEvent.onMoved(({ object, next }) => {
    for (const el of instances.values()) {
      onObjectMoved(el, object);
    }
    return next();
  });

  GameMode.onExit(({ next }) => {
    destroyElevators();
    return next();
  });

  // 电梯实体创建必须延后到 GameMode.onInit：CreateDynamicObject/CreateDynamic3DTextLabel/
  // MoveDynamicObject 等 streamer 原生在服务器加载地图（Loaded Map）后才注册，
  // 模块导入期直接创建会抛 "native function: CreateDynamicObject not found"——
  // 房屋 obj 在 onInit 里创建即零失败，电梯若在模块作用域创建则刷屏报错。
  // 事件注册（onKeyStateChange/onMoved/onExit 等）不调原生，留在模块导入期无碍。
  GameMode.onInit(({ next }) => {
    for (const cfg of ELEVATOR_CONFIGS) {
      try {
        instances.set(cfg.id, createInstance(cfg));
      } catch (e) {
        // 单部失败不阻断其余电梯（记录日志，onExit 兜底清理已创建的实例）
        logger.error(`[elevator] 初始化 ${cfg.id} 失败`, e);
      }
    }
    // 热重载兜底：给已在线玩家补 removeBuilding
    for (const p of Player.getInstances()) {
      if (!p.isNpc()) applyRemoveBuildings(p);
    }
    logger.info(`[elevator] 已初始化 ${instances.size} 部电梯`);
    return next();
  });
}
