import {
  Dialog,
  DialogStylesEnum,
  Dynamic3DTextLabel,
  GameMode,
  isPressed,
  KeysEnum,
  Npc,
  NpcEvent,
  Player,
  PlayerEvent,
  PlayerStateEnum,
  Vehicle,
  VehicleEvent,
} from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { addNitro } from "@/vehicles";
import { isPlayerLocked, lockPlayer, unlockPlayer } from "@/core/interaction";
import { isInRace } from "@/race/room";
import { setIntervalSafe, clearTimeoutSafe, setTimeoutSafe } from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { sysMsg } from "@/utils/msg";
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
  /** npcmodes/recordings/ 下的 .rec 文件名（不含扩展名） */
  readonly rec: string;
  /** 路线说明（中文，随 rec 文件对照） */
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

/** 8 个 NPC：车型/颜色/初始位对齐原版 npc.inc，路线名对齐 /selectnpc 对话框；
 *  展示名统一用 .rec 文件名（LXD/Drift/…），不用中文名 */
const DRIFTERS: readonly DrifterDef[] = [
  {
    id: "DrifterLDZ",
    rec: "LXD",
    route: "雷达站往返",
    model: 541,
    color: [6, 1],
    pos: [-342.7927, 1540.4495, 75.1911],
    rot: 178.9945,
    skin: 115,
  },
  {
    id: "DrifterSF",
    rec: "Drift",
    route: "SF 双环线",
    model: 562,
    color: [7, 1],
    pos: [1, 1, 5],
    rot: 0,
    skin: 115,
  },
  {
    id: "DrifterMadd",
    rec: "RunInMadd",
    route: "LS 山区",
    model: 411,
    color: [6, 1],
    pos: [3, 3, 5],
    rot: 0,
    skin: 115,
  },
  {
    id: "DrifterLS",
    rec: "LSEyeOut",
    route: "LS 市区",
    model: 411,
    color: [118, 1],
    pos: [5, 5, 5],
    rot: 0,
    skin: 115,
  },
  {
    id: "DrifterTD",
    rec: "TestDrive",
    route: "SF 市区",
    model: 411,
    color: [66, 1],
    pos: [7, 7, 5],
    rot: 0,
    skin: 115,
  },
  {
    id: "DrifterOff",
    rec: "OffControl",
    route: "城市交界越野",
    model: 411,
    color: [65, 1],
    pos: [9, 9, 5],
    rot: 0,
    skin: 115,
  },
  {
    id: "DrifterFM",
    rec: "FollowMe",
    route: "综合线 1",
    model: 411,
    color: [68, 1],
    pos: [15, 9, 5],
    rot: 0,
    skin: 115,
  },
  {
    id: "DrifterFM2",
    rec: "FollowMe2",
    route: "综合线 2",
    model: 411,
    color: [70, 1],
    pos: [18, 9, 5],
    rot: 0,
    skin: 115,
  },
];

/** 单个 NPC 的运行态 */
interface DrifterEntity {
  readonly def: DrifterDef;
  npc: Npc | null;
  vehicle: Vehicle | null;
  label: Dynamic3DTextLabel | null;
  /** 乘客位（null=空；0 号司机位被 NPC 占用，乘客从 1 号座位起） */
  passengerSlots: (Player | null)[];
  /** 上次自动补氮时间戳（每 15 秒一管，对齐原版 PlayerInfo[i][nitro]） */
  lastNitroAt: number;
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
    lastNitroAt: 0, // 创建即补（首轮 tick 立即补一管，对齐原版开局带氮气）
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
    addNitro(vehicle); // 氮气（对齐原版 NPC 漂移车带氮气）
    // 锁门防玩家抢司机位把 NPC 挤下车（对齐回放系统 ghost 车处理；
    // 乘客用 putPlayerIn 强塞座位，F 键仍可正常下车）
    vehicle.setParamsEx(true, false, false, true, false, false, false);

    npc.putInVehicle(vehicle, 0); // 司机位
    npc.setInvulnerable(true); // 防伤害

    // NPC 无 nametag：车顶绑 3D 标签显示"车手（rec 文件名）+ 路线"（随车移动）。
    // attachedVehicle 的 x/y/z 为相对车辆原点（车底中心）的偏移：跑车车顶约
    // z+1.3~1.5，z=1.5 贴近车顶上方；之前 2.2 悬在车顶近 1 米显得脱离车身
    label = new Dynamic3DTextLabel({
      text: `{33FF33}漂移车手 ${def.rec}\n{FFFFFF}路线：${def.route}`,
      color: 0x33aa33aa,
      x: 0,
      y: 0,
      z: 1.5,
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
    logger.info(`[npcs] ${def.id} 已加载（${def.rec}.rec / ${def.rec}）`);
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

/** 车辆被毁（玩家火箭/C4 可炸毁漂移车——setInvulnerable 只保护 NPC 本体）：
 *  重建车辆 + NPC 归位 + 重播路线。否则 NPC 原地站桩、车毁后 /drift 永久
 *  未就绪、3D 标签悬空，直到服务器重启 */
function rebuildDrifterVehicle(ent: DrifterEntity): void {
  const def = ent.def;
  try {
    // 清旧实体：标签/旧车（玩家车上乘客已被爆炸弹出，座位释放由 onStateChange 处理）
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
    const vehicle = new Vehicle({
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
    addNitro(vehicle); // 氮气
    vehicle.setParamsEx(true, false, false, true, false, false, false); // 锁门防抢司机位
    ent.vehicle = vehicle;
    if (ent.npc?.isValid()) {
      ent.npc.putInVehicle(vehicle, 0); // 司机位
      // 归位后重新沿路线播放（放乘客回原座位由玩家自行 /drift 上车）
      if (!ent.npc.startPlayback(def.rec)) {
        logger.warn(`[npcs] ${def.id} 重建后播放 ${def.rec}.rec 失败`);
      }
    }
    // 重建 3D 标签（原标签随旧车销毁）
    const label = new Dynamic3DTextLabel({
      text: `{33FF33}漂移车手 ${def.rec}\n{FFFFFF}路线：${def.route}`,
      color: 0x33aa33aa,
      x: 0,
      y: 0,
      z: 1.5,
      drawDistance: 15,
      testLOS: false,
      attachedVehicle: vehicle.id,
      worldId: PUBLIC_WORLD_ID,
      charset: DEFAULT_CHARSET,
    });
    label.create();
    ent.label = label;
    logger.info(`[npcs] ${def.id} 车辆被毁，已重建并重播`);
  } catch (e) {
    logger.error(`[npcs] 重建 ${def.id} 车辆失败`, e);
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

/** 上车（已校验玩家在公共大世界；支持从其它 NPC 车直接切换：先释放旧座位） */
function rideDrifter(player: Player, def: DrifterDef): void {
  // 基础条件优先校验（世界不对时先提示，不落到满员/切换逻辑）
  if (player.getVirtualWorld() !== PUBLIC_WORLD_ID) {
    sysMsg(player, "drift", "请先回到公共大世界再上车", "error");
    return;
  }
  const ent = entities.get(def.id);
  if (!ent || !ent.npc?.isValid() || !ent.vehicle?.isValid()) {
    sysMsg(player, "drift", `${def.rec} 尚未就绪，请稍后再试`, "error");
    return;
  }
  // 已在目标车上 → 提示（避免重复上车/反复切换抖动）
  if (ent.passengerSlots.includes(player)) {
    sysMsg(player, "drift", `你已在 ${def.rec} 的车上`, "error");
    return;
  }
  // 切换：先释放玩家在其它 NPC 车上的座位（坐在旧车上直接换到新车，
  // 旧车座位立即空出——否则旧车会一直显示"满员"）
  removePassenger(player);
  const slot = ent.passengerSlots.indexOf(null);
  if (slot === -1) {
    sysMsg(player, "drift", `${def.rec} 的车已满员`, "error");
    return;
  }
  // 座位号 = 槽位 + 1（0 号司机位被 NPC 占用）
  ent.vehicle.putPlayerIn(player, slot + 1);
  ent.passengerSlots[slot] = player;
  sysMsg(
    player,
    "drift",
    `已上车：${def.rec}（路线：${def.route}），NPC 开车，按 F 下车`,
    "success",
  );
}

/** /drift 选车面板（中文） */
async function openDrifterMenu(player: Player): Promise<void> {
  // TABLIST_HEADERS 多列：名称 / 路线 / 状态（表头不占行号，listItem 仍从数据行起算）
  const info = [
    "{FFD700}名称\t路线\t状态",
    ...DRIFTERS.map((d) => {
      const ent = entities.get(d.id);
      const free = ent ? ent.passengerSlots.filter((s) => s === null).length : 0;
      // 自己已乘坐的车显示"已乘坐"而非"满员"（座位被自己占着不算满员）
      const riding = ent?.passengerSlots.includes(player) ?? false;
      const state =
        !ent || !ent.npc?.isValid()
          ? "{808080}未就绪"
          : riding
            ? "{00FF00}已乘坐"
            : free > 0
              ? "{FFFFFF}可上车"
              : "{FF0000}满员";
      return `${d.rec}\t${d.route}\t${state}`;
    }),
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.TABLIST_HEADERS,
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
 * 启动漂移 NPC 持久 tick（1 秒轮询；onInit 注册、onExit 统一清理）：
 * 1. NPC 车每 15 秒自动补一管氮气（对齐原版 racespeedtime.pwn:2696-2700
 *    IsPlayerNPC 分支——NPC 无人驾驶、.rec 播放，创建时的一管喷完即无，
 *    必须周期自动补才有持续氮气效果）
 * 2. 乘客按住 FIRE/ACTION → 续氮气（对齐 vehicleAuto hold 点按逻辑）
 * 从 initDrifterNpcs 拆出：initDrifterNpcs 只注册事件（模块加载一次），interval
 * 必须 onInit 重注册——gmx 的 onExit 会 clearAllTimers，顶层注册的 tick 会死掉。
 */
export function startDrifterNpcTicks(): void {
  setIntervalSafe(() => {
    const now = Date.now();
    for (const ent of entities.values()) {
      if (!ent.vehicle?.isValid() || !ent.npc?.isValid()) continue;
      // NPC 自动补氮（每 15 秒一管）：对齐原版 PlayerInfo[i][nitro] 计时
      if (now - ent.lastNitroAt >= 15_000) {
        addNitro(ent.vehicle);
        ent.lastNitroAt = now;
      }
      // 乘客按住补氮：drift 车上有乘客按住 FIRE/ACTION → 续一管
      if (!ent.passengerSlots.some((p) => p && p.isConnected())) continue;
      let holding = false;
      for (const p of ent.passengerSlots) {
        if (!p || !p.isConnected()) continue;
        const k = p.getKeys().keys & 0xffff;
        if ((k & (KeysEnum.FIRE | KeysEnum.ACTION)) !== 0) {
          holding = true;
          break;
        }
      }
      if (holding) addNitro(ent.vehicle);
    }
  }, 1000);
}

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

  // 车辆被毁 → 重建（漂移车无 respawnDelay 兜底，炸了不重建会永久失效）
  VehicleEvent.onDeath(({ vehicle, next }) => {
    const ent = [...entities.values()].find((e) => e.vehicle === vehicle);
    if (ent) rebuildDrifterVehicle(ent);
    return next();
  });

  // 玩家离开乘客/司机状态 → 释放座位（否则座位被永久占用）。
  // 不能只看 newState===ONFOOT：玩家在 NPC 车里死亡（PASSENGER→WASTED）或
  // 直接换到另一辆车（PASSENGER→PASSENGER/DRIVER）都不会经过 ONFOOT——
  // 只要旧状态是乘客/司机就释放（removePassenger 幂等，未登记的玩家自动跳过）
  PlayerEvent.onStateChange(({ player, oldState, next }) => {
    if (player.isNpc()) return next();
    if (oldState === PlayerStateEnum.PASSENGER || oldState === PlayerStateEnum.DRIVER) {
      removePassenger(player);
    }
    return next();
  });

  // 漂移 NPC 车乘客按 KEY_FIRE（左键）/ KEY_ACTION（右键）→ 给 NPC 车补氮气
  //（点按模式：按住持续补，对齐 vehicleAuto hold）。NPC 车用 .rec 播放无人开，
  // 车上氮气喷完即消失、无自动补给——乘客按下瞬间补一管（即时反馈），每秒 tick
  // 检测仍按住继续补（SA 氮气一管约 3-4 秒，每秒补维持连续喷射，松开停补）。
  // 只响应真实玩家（NPC 无按键事件）。
  PlayerEvent.onKeyStateChange(({ player, newKeys, oldKeys, next }) => {
    if (player.isNpc()) return next();
    const pressed =
      isPressed(newKeys, oldKeys, KeysEnum.FIRE) || isPressed(newKeys, oldKeys, KeysEnum.ACTION);
    if (!pressed || !player.isInAnyVehicle()) return next();
    const veh = player.getVehicle();
    if (!veh) return next();
    // 是否在某个漂移 NPC 车上（乘客位）
    for (const ent of entities.values()) {
      if (ent.vehicle === veh && ent.npc?.isValid()) {
        addNitro(veh); // 按下瞬间补一管（即时反馈）
        break;
      }
    }
    return next();
  });

  // 按住持续补（每秒）：drift 车上有乘客按住 FIRE/ACTION → 续氮气。
  // 对齐 vehicleAuto hold 点按逻辑（每秒检测按住补一管）；setIntervalSafe 登记制
  // 由 GameMode.onExit 统一清理。
  // （interval 本体抽到 startDrifterNpcTicks，onInit 注册——本函数只管事件注册）

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
      sysMsg(player, "drift", "请先登录", "error");
      return next();
    }
    if (isPlayerLocked(player.id)) {
      sysMsg(player, "drift", "当前正在其他流程中，请稍后再试", "error");
      return next();
    }
    if (isInRace(player.id)) {
      sysMsg(player, "drift", "比赛中不能乘坐漂移 NPC", "error");
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
