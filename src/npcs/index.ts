import {
  Dialog,
  DialogStylesEnum,
  Dynamic3DTextLabel,
  GameMode,
  Npc,
  NpcEvent,
  Player,
  PlayerEvent,
  PlayerStateEnum,
  Vehicle,
} from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { isPlayerLocked, lockPlayer, unlockPlayer } from "@/core/interaction";
import { isInRace } from "@/race/room";
import { clearTimeoutSafe, setTimeoutSafe } from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { COLOR_ERROR, COLOR_SUCCESS } from "@/utils/colors";
import { PUBLIC_WORLD_ID } from "@/sessions/session";
import { logger } from "@/logger";

/**
 * 漂移 NPC 系统（移植自 pawn-server 的 npcmodes/*.pwn + npc.inc）：
 * 8 个 Drifter NPC 各自沿一条 .rec 路线循环漂移，车顶挂 3D 标签显示身份与路线，
 * 玩家用 /drift 上车随行（NPC 开车，玩家当乘客）。
 *
 * - .rec 路线文件：npcmodes/recordings/（open.mp 的 NPC 播放目录，随仓库提交）
 * - NPC 池：8 个常驻 NPC 占 config.json max_bots=100 的 8 个槽位，与回放系统
 *   （allocReplayNpc 按 Npc.getInstances() 实时统计）自动共池，无需手动协调
 * - 加载：对齐原版 100ms 错峰串行 ConnectNPC（避免同时创建 NPC 卡顿/失败），
 *   用登记式 setTimeoutSafe 链，onExit 统一清理
 * - 循环：NpcEvent.onPlaybackEnd 触发重播（对应原版 OnRecordingPlaybackEnd 循环）
 * - 安全：NPC 不可被伤害（setInvulnerable）；车锁门防玩家抢司机位
 */

/** 单个漂移 NPC 定义（车型/颜色/初始位置对齐原版 npc.inc 的 npcCars） */
interface DrifterDef {
  /** NPC 名（open.mp 唯一，也是 .rec 播放名匹配依据） */
  readonly id: string;
  /** 中文显示名（3D 标签 / 选车面板） */
  readonly name: string;
  /** npcmodes/recordings/ 下的 .rec 文件名（不含扩展名） */
  readonly rec: string;
  /** 路线说明（中文） */
  readonly route: string;
  /** 车型 */
  readonly model: number;
  readonly color: [number, number];
  /** 车辆初始坐标（播放开始后自动移到 rec 路线起点） */
  readonly pos: [number, number, number];
  readonly rot: number;
  /** NPC 皮肤（对齐原版注释的 SetSpawnInfo skin 115） */
  readonly skin: number;
}

/** 8 个 NPC：车型/颜色/初始位对齐原版 npc.inc，路线名对齐 /selectnpc 对话框 */
const DRIFTERS: readonly DrifterDef[] = [
  { id: "DrifterLDZ",  name: "雷达站漂移",   rec: "LXD",        route: "雷达站往返",   model: 541, color: [6, 1],   pos: [-342.7927, 1540.4495, 75.1911], rot: 178.9945, skin: 115 },
  { id: "DrifterSF",   name: "SF 双环漂移",  rec: "Drift",      route: "SF 双环线",     model: 562, color: [7, 1],   pos: [1, 1, 5],  rot: 0, skin: 115 },
  { id: "DrifterMadd", name: "LS 山区漂移",  rec: "RunInMadd",  route: "LS 山区",       model: 411, color: [6, 1],   pos: [3, 3, 5],  rot: 0, skin: 115 },
  { id: "DrifterLS",   name: "LS 市区漂移",  rec: "LSEyeOut",   route: "LS 市区",       model: 411, color: [118, 1], pos: [5, 5, 5],  rot: 0, skin: 115 },
  { id: "DrifterTD",   name: "SF 试驾漂移",  rec: "TestDrive",  route: "SF 市区",       model: 411, color: [66, 1],  pos: [7, 7, 5],  rot: 0, skin: 115 },
  { id: "DrifterOff",  name: "城市交界越野", rec: "OffControl", route: "城市交界越野",  model: 411, color: [65, 1],  pos: [9, 9, 5],  rot: 0, skin: 115 },
  { id: "DrifterFM",   name: "综合漂移",     rec: "FollowMe",   route: "综合线 1",      model: 411, color: [68, 1],  pos: [15, 9, 5], rot: 0, skin: 115 },
  { id: "DrifterFM2",  name: "综合漂移 2",   rec: "FollowMe2",  route: "综合线 2",      model: 411, color: [70, 1],  pos: [18, 9, 5], rot: 0, skin: 115 },
];

/** 单个 NPC 的运行态 */
interface DrifterEntity {
  readonly def: DrifterDef;
  npc: Npc | null;
  vehicle: Vehicle | null;
  label: Dynamic3DTextLabel | null;
  /** 乘客位（null=空；0 号司机位被 NPC 占用，乘客从 1 号座位起） */
  passengerSlots: (Player | null)[];
}

const entities = new Map<string, DrifterEntity>();
const loadTimers: NodeJS.Timeout[] = [];
let initialized = false;

// ---------------------------------------------------------------------------
// 创建 / 销毁
// ---------------------------------------------------------------------------

/** 串行加载链的下一环（100ms 错峰，对齐原版 ConnectNPC 间隔） */
function scheduleNext(index: number): void {
  if (index >= DRIFTERS.length) {
    logger.info(`[npcs] ${DRIFTERS.length} 个漂移 NPC 全部加载完成`);
    return;
  }
  const def = DRIFTERS[index];
  loadTimers.push(
    setTimeoutSafe(() => {
      createDrifter(def);
      scheduleNext(index + 1);
    }, 100),
  );
}

function createDrifter(def: DrifterDef): void {
  const ent: DrifterEntity = {
    def,
    npc: null,
    vehicle: null,
    label: null,
    // 全部为 2 座车（NPC 司机 + 1 个乘客位）
    passengerSlots: [null],
  };
  let npc: Npc | null = null;
  let vehicle: Vehicle | null = null;
  let label: Dynamic3DTextLabel | null = null;
  try {
    // 创建 NPC（open.mp 失败不抛，需显式 isValid 校验）
    npc = new Npc(def.id).create();
    if (!npc.isValid()) {
      logger.warn(`[npcs] ${def.id} NPC 创建失败（槽位/名称冲突）`);
      return;
    }
    npc.getPlayer(); // 触发校验：invalid NPC 的 getPlayer 会抛
    npc.setVirtualWorld(PUBLIC_WORLD_ID);
    npc.setSkin(def.skin);

    // 创建车辆（respawnDelay -1 = 静态车，对齐原版 AddStaticVehicleEx）
    vehicle = new Vehicle({
      modelId: def.model,
      x: def.pos[0],
      y: def.pos[1],
      z: def.pos[2],
      zAngle: def.rot,
      color: [def.color[0], def.color[1]],
      respawnDelay: -1,
    });
    vehicle.create();
    vehicle.setVirtualWorld(PUBLIC_WORLD_ID);
    vehicle.linkToInterior(0);
    // 锁门防玩家抢司机位把 NPC 挤下车（对齐回放系统 ghost 车处理；
    // 乘客用 putPlayerIn 强塞座位，F 键仍可正常下车）
    vehicle.setParamsEx(true, false, false, true, false, false, false);

    npc.putInVehicle(vehicle, 0); // 司机位
    npc.setInvulnerable(true); // 防伤害

    // NPC 无 nametag：车顶绑 3D 标签显示"身份 + 路线"（随车移动）。
    // attachedVehicle 的 x/y/z 为相对车辆原点（车底）的偏移，车高约 1.5，抬到车顶上方
    label = new Dynamic3DTextLabel({
      text: `{33FF33}漂移车手 ${def.name}\n{FFFFFF}路线：${def.route}`,
      color: 0x33aa33aa,
      x: 0,
      y: 0,
      z: 2.2,
      drawDistance: 15,
      testLOS: false,
      attachedVehicle: vehicle.id,
      worldId: PUBLIC_WORLD_ID,
      charset: DEFAULT_CHARSET, // 3D 标签中文必须与玩家默认字符集一致否则乱码
    });
    label.create();

    // 开始沿路线播放（open.mp 自动从 npcmodes/recordings/{rec}.rec 加载，
    // 并把车移到 rec 起点；循环由 onPlaybackEnd 事件负责）
    if (!npc.startPlayback(def.rec)) {
      logger.warn(`[npcs] ${def.id} 播放 ${def.rec}.rec 失败（文件缺失？）`);
    }

    ent.npc = npc;
    ent.vehicle = vehicle;
    ent.label = label;
    entities.set(def.id, ent);
    logger.info(`[npcs] ${def.id} 已加载（${def.rec}.rec / ${def.name}）`);
  } catch (e) {
    // 半成品清理（NPC 创建成功但后续失败时防止泄漏）
    try {
      label?.destroy();
    } catch {
      /* 忽略 */
    }
    try {
      vehicle?.destroy();
    } catch {
      /* 忽略 */
    }
    try {
      npc?.destroy();
    } catch {
      /* 忽略 */
    }
    logger.error(`[npcs] 创建 ${def.id} 失败`, e);
  }
}

function destroyAll(): void {
  for (const t of loadTimers) clearTimeoutSafe(t);
  loadTimers.length = 0;
  for (const ent of entities.values()) {
    try {
      ent.label?.destroy();
    } catch {
      /* 忽略 */
    }
    try {
      ent.vehicle?.destroy();
    } catch {
      /* 忽略 */
    }
    try {
      ent.npc?.destroy();
    } catch {
      /* 忽略 */
    }
  }
  entities.clear();
}

// ---------------------------------------------------------------------------
// 乘坐（/drift）
// ---------------------------------------------------------------------------

/** 释放玩家在该 NPC 车上的乘客位（下车/断线时调用） */
function removePassenger(player: Player): void {
  for (const ent of entities.values()) {
    const i = ent.passengerSlots.indexOf(player);
    if (i >= 0) ent.passengerSlots[i] = null;
  }
}

/** 上车（已校验玩家在公共大世界） */
function rideDrifter(player: Player, def: DrifterDef): void {
  const ent = entities.get(def.id);
  if (!ent || !ent.npc?.isValid() || !ent.vehicle?.isValid()) {
    player.sendClientMessage(COLOR_ERROR, `[漂移] ${def.name} 尚未就绪，请稍后再试`);
    return;
  }
  const slot = ent.passengerSlots.indexOf(null);
  if (slot === -1) {
    player.sendClientMessage(COLOR_ERROR, `[漂移] ${def.name} 的车已满员`);
    return;
  }
  if (player.getVirtualWorld() !== PUBLIC_WORLD_ID) {
    player.sendClientMessage(COLOR_ERROR, "[漂移] 请先回到公共大世界再上车");
    return;
  }
  // 座位号 = 槽位 + 1（0 号司机位被 NPC 占用）
  ent.vehicle.putPlayerIn(player, slot + 1);
  ent.passengerSlots[slot] = player;
  player.sendClientMessage(
    COLOR_SUCCESS,
    `[漂移] 已上车：${def.name}（路线：${def.route}），NPC 开车，按 F 下车`,
  );
}

/** /drift 选车面板（中文） */
async function openDrifterMenu(player: Player): Promise<void> {
  const info = DRIFTERS.map((d, i) => {
    const ent = entities.get(d.id);
    const free = ent ? ent.passengerSlots.filter((s) => s === null).length : 0;
    const state = !ent || !ent.npc?.isValid() ? " {808080}未就绪" : free > 0 ? "" : " {FF0000}满员";
    return `{FFD700}${i + 1}. ${d.name}{FFFFFF}（${d.route}）${state}`;
  }).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "漂移 NPC 随行（NPC 开车，您当乘客）",
      info,
      button1: "上车",
      button2: "关闭",
    }),
  );
  if (!res || res.response !== 1) return; // 取消/断线
  const def = DRIFTERS[res.listItem];
  if (def) rideDrifter(player, def);
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/**
 * 初始化漂移 NPC 系统（callbacks init 序列中调用）：
 * 注册循环播放/下车清理/命令，并在 GameMode.onInit 后启动错峰加载链。
 */
export function initDrifterNpcs(): void {
  if (initialized) return;
  initialized = true;

  // 路线播完 → 重播（对应原版 OnRecordingPlaybackEnd 循环）
  NpcEvent.onPlaybackEnd(({ npc, next }) => {
    try {
      const ent = [...entities.values()].find((e) => e.def.id === npc.getName());
      if (ent && !npc.startPlayback(ent.def.rec)) {
        logger.warn(`[npcs] ${ent.def.id} 重播 ${ent.def.rec}.rec 失败`);
      }
    } catch (e) {
      logger.warn(`[npcs] 播放结束处理异常`, e);
    }
    return next();
  });

  // 玩家从乘客/司机状态下车 → 释放座位（否则座位被永久占用）
  PlayerEvent.onStateChange(({ player, newState, oldState, next }) => {
    if (player.isNpc()) return next();
    if (
      newState === PlayerStateEnum.ONFOOT &&
      (oldState === PlayerStateEnum.PASSENGER || oldState === PlayerStateEnum.DRIVER)
    ) {
      removePassenger(player);
    }
    return next();
  });

  // 断线 → 释放座位（含在 NPC 车里断线的情况）
  PlayerEvent.onDisconnect(({ player, next }) => {
    if (player.isNpc()) return next();
    removePassenger(player);
    return next();
  });

  // /drift：打开选车面板
  PlayerEvent.onCommandText("drift", ({ player, next }) => {
    if (player.isNpc()) return next();
    if (!getAuthState(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "请先登录");
      return next();
    }
    if (isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "当前正在其他流程中，请稍后再试");
      return next();
    }
    if (isInRace(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "[比赛] 比赛中不能乘坐漂移 NPC");
      return next();
    }
    lockPlayer(player.id);
    void openDrifterMenu(player).finally(() => unlockPlayer(player.id));
    return next();
  });

  GameMode.onExit(({ next }) => {
    destroyAll();
    return next();
  });

  // 启动错峰加载链（服务器初始化完成后创建 NPC）
  GameMode.onInit(({ next }) => {
    scheduleNext(0);
    return next();
  });
}
