import { Dialog, DialogStylesEnum, GameText, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { isPlayerLocked } from "@/core/interaction";
import { sessionManager } from "@/sessions/manager";
import { isInRace } from "@/race/room";
import { isObserving } from "@/core/observe";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import type { MenuBack } from "@/core/panel";
import { setIntervalSafe, setTimeoutSafe, clearTimeoutSafe } from "@/core/timers";

import { sysMsg, PREFIX } from "@/utils/msg";
import { containsSensitiveWord } from "@/utils/sensitive";
const TP_TIMEOUT_MS = 18_000;
/** 传送后冻结时长（对齐原版 DynUpdateStart：等待 obj 流式加载，避免下坠穿模） */
const TELEPORT_FREEZE_MS = 2000;
/** 高空冻结阈值：目标 Z 超过 SA 地图最高点（Mt Chiliad ≈ 810）即视为高空/地图外——
 *  传送到这类坐标物体加载距离极远，不冻结会持续下坠/穿模 */
const TP_HIGH_Z = 800;
/** 地图边界：SA 地图 XY 边界约 ±3000，超出即地图外（隐形墙之外/加载不到地面） */
const TP_MAP_RADIUS = 3000;

/** 目标坐标是否属于"极端传送"（高空/地图外）：必须强制冻结等加载，不论车内车外 */
function isExtremeTeleport(x: number, y: number, z: number): boolean {
  return z > TP_HIGH_Z || Math.abs(x) > TP_MAP_RADIUS || Math.abs(y) > TP_MAP_RADIUS;
}

/** 临时位置（/s 保存 /l 传送） */
interface TempPos {
  x: number;
  y: number;
  z: number;
  interior: number;
  facingAngle: number;
  zAngle: number;
}

const tempPos = new Map<number, TempPos>();

/** tpa 状态 */
const tpGotoId = new Map<number, number>(); // 我请求传送到谁
const tpFromId = new Map<number, number>(); // 谁请求传送到我这
const tpTimeoutAt = new Map<number, number>();

function initTp(playerId: number): void {
  tpGotoId.delete(playerId);
  tpFromId.delete(playerId);
  tpTimeoutAt.delete(playerId);
}

/** 玩家断线清理 */
export function cleanupTeleport(playerId: number): void {
  tempPos.delete(playerId);
  // 清理传送冻结定时器（防句柄残留）
  cleanupTeleportFreeze(playerId);
  // 清理双方请求
  const from = tpFromId.get(playerId);
  if (from != null) {
    tpGotoId.delete(from);
    tpTimeoutAt.delete(from);
  }
  const to = tpGotoId.get(playerId);
  if (to != null) {
    tpFromId.delete(to);
    tpTimeoutAt.delete(to);
  }
  initTp(playerId);
}

/** 传送到指定位置（区分车内/步行，保留朝向） */
export function teleportTo(
  player: Player,
  x: number,
  y: number,
  z: number,
  angle: number,
  interiorId: number,
): void {
  // 观战/回放观战禁止传送：传送会打断 spectating 视角（setPos 后客户端镜头错乱、
  // 观战目标失真）。所有传送入口（/名称 //名称 /tpa /面板 传送点 /house goto）
  // 都经 teleportTo，在此统一拦截——调用方无需各自判断
  if (isObserving(player.id)) {
    sysMsg(player, "tp", "观战中不能传送（/tv off 后可传送）", "warn");
    return;
  }
  player.setInterior(interiorId);
  if (player.isInAnyVehicle()) {
    const veh = player.getVehicle()!;
    veh.setPos(x, y, z);
    veh.setZAngle(angle);
    veh.linkToInterior(interiorId);
  } else {
    player.setPos(x, y, z);
    player.setFacingAngle(angle);
  }
  // 传送后短暂冻结（对齐原版 DynUpdateStart）：服务端立即传送，但客户端要
  // 几百 ms 才流式加载周边物体（房屋 obj 等）——不冻结会先下坠/穿模。
  // 冻结期间暂停物理（不会掉落），恢复时物体已加载。
  freezeAfterTeleport(player, x, y, z);
}

/** 传送冻结定时器句柄（playerId → timeout，防重复传送时旧解冻提前打断） */
const freezeTimers = new Map<number, NodeJS.Timeout>();

/**
 * 传送后短暂冻结玩家（等待流式加载）。
 * 对齐原版 DynUpdateStart：TogglePlayerControllable(false) + "Objects Loading"
 * 提示 + 2 秒后解冻。GameText 不支持中文，保持原版英文文案。
 * 重复传送（2 秒内再传）：刷新定时器，保证解冻以最后一次传送为准。
 * 车内普通坐标不冻结（车有物理，冻结车辆反而不自然）；**极端坐标（高空/地图外，
 * 见 isExtremeTeleport）车内也冻结**——车辆在物体未加载的高空/边界会持续下坠
 * 穿模，必须先等物体流式加载。
 */
function freezeAfterTeleport(player: Player, x: number, y: number, z: number): void {
  if (player.isNpc() || !player.isConnected()) return;
  if (player.isInAnyVehicle() && !isExtremeTeleport(x, y, z)) return;
  try {
    player.toggleControllable(false);
  } catch {
    return; // 冻结失败（玩家已失效等）直接跳过
  }
  // 刷新：取消上一次解冻定时器，防旧定时器在二次冻结期间提前解冻
  const prev = freezeTimers.get(player.id);
  if (prev) clearTimeoutSafe(prev);
  new GameText("~g~Objects~n~~r~Loading", TELEPORT_FREEZE_MS, 6).forPlayer(player);
  const timer = setTimeoutSafe(() => {
    freezeTimers.delete(player.id);
    if (player.isConnected()) {
      try {
        player.toggleControllable(true);
      } catch {
        // 玩家已断开/失效，忽略
      }
    }
  }, TELEPORT_FREEZE_MS);
  freezeTimers.set(player.id, timer);
}

/** 断线清理：解冻定时器随连接销毁，句柄从登记表移除 */
export function cleanupTeleportFreeze(playerId: number): void {
  const t = freezeTimers.get(playerId);
  if (t) clearTimeoutSafe(t);
  freezeTimers.delete(playerId);
}

/** 玩家是否接受传送（设置校验） */
export async function acceptsTeleport(player: Player): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) return false;
  const setting = await prisma.sysUserSetting.findUnique({ where: { userId: auth.userId } });
  return setting?.acceptTeleport ?? true;
}

/**
 * 发起传送到目标玩家的请求（/tpa 命令与点击玩家菜单共用）。
 * 含全部校验（未处理请求/自己/在线/NPC/登录/比赛/同战局/接受传送），
 * 任一校验失败给出提示并返回 false；成功发出请求返回 true。
 */
export async function requestTpa(player: Player, targetId: number): Promise<boolean> {
  if (tpGotoId.has(player.id) || tpFromId.has(player.id)) {
    sysMsg(player, "tp", "你已有未处理的传送请求", "warn");
    return false;
  }
  if (targetId === player.id) {
    sysMsg(player, "tp", "不能向自己发送传送请求", "warn");
    return false;
  }
  const target = Player.getInstance(targetId);
  if (!target) {
    sysMsg(player, "tp", "错误的玩家ID", "error");
    return false;
  }
  if (target.isNpc()) {
    sysMsg(player, "tp", "不能向NPC发送传送请求", "warn");
    return false;
  }
  if (!getAuthState(target.id)) {
    sysMsg(player, "tp", "对方尚未登录", "warn");
    return false;
  }
  // 比赛中禁止传送（请求方与目标方均检查）
  if (isInRace(player.id)) {
    sysMsg(player, "tp", "比赛中不能传送", "warn");
    return false;
  }
  if (isInRace(target.id)) {
    sysMsg(player, "tp", "对方正在比赛中，无法传送", "warn");
    return false;
  }
  // 同战局限制
  const mySession = sessionManager.getPlayerSession(player);
  const targetSession = sessionManager.getPlayerSession(target);
  if (mySession.id !== targetSession.id) {
    sysMsg(player, "tp", "对方与你不在同一战局，无法传送", "warn");
    return false;
  }
  if (!(await acceptsTeleport(target))) {
    sysMsg(player, "tp", "对方关闭了接受传送", "warn");
    return false;
  }
  if (tpFromId.has(target.id) || tpGotoId.has(target.id)) {
    sysMsg(player, "tp", "对方正在处理其他请求", "warn");
    return false;
  }
  const timeout = Date.now() + TP_TIMEOUT_MS;
  tpGotoId.set(player.id, target.id);
  tpFromId.set(target.id, player.id);
  tpTimeoutAt.set(player.id, timeout);
  tpTimeoutAt.set(target.id, timeout);
  sysMsg(
    target,
    "tp",
    `${player.getName().name}(${player.id}) 请求传送到你身边，/ta 同意 /td 拒绝`,
    "info",
  );
  sysMsg(player, "tp", `请求已发至 ${target.getName().name}(${target.id})`, "info");
  new GameText("~n~~n~~n~~n~~n~~n~~n~~n~~w~Player want to move ~r~you~w~.", 3000, 3).forPlayer(
    target,
  );
  return true;
}

/**
 * / 与 // 传送点兜底（挂在 onCommandError code 4）：
 * - /名称 → 系统传送点（isSystem=true），全服/战局公告
 * - //名称 → 用户传送点（isSystem=false），仅本人提示
 * 向下兼容：//名称 无同名用户点时回退查系统点（反之 /名称 无系统点也回退用户点）——
 * 玩家记错斜杠数量/历史习惯（如 //ldz 实际只有系统点 ldz）也能成功传送，
 * 且提示按实际命中类型区分系统/用户传送点（回退到系统点照常广播战局，与 /名称 一致）。
 * rawCommand 传 cmdText（保留原始斜杠，如 "/ls" 或 "//ls"），
 * 因 command 参数已被命令解析器剥离前导斜杠（"//ls" 会变成 "ls"）。
 */
export async function fallbackTeleport(player: Player, rawCommand: string): Promise<boolean> {
  const isUserTele = rawCommand.startsWith("//");
  const teleName = rawCommand.replace(/^\/+/, "");
  if (!teleName) return false;
  // 比赛中禁止传送
  if (isInRace(player.id)) {
    sysMsg(player, "tp", "比赛中不能传送", "warn");
    return true;
  }
  try {
    // 主查询按输入语法（/ → 系统点，// → 用户点）；无结果回退查同名的另一种类型
    //（双向对称——同名的系统/用户点都存在时优先输入语义，回退仅发生在主查询失败）
    const primarySystem = !isUserTele;
    let point = await prisma.teleport.findFirst({
      where: { name: teleName, isEnabled: true, deletedAt: null, isSystem: primarySystem },
    });
    if (!point) {
      point = await prisma.teleport.findFirst({
        where: { name: teleName, isEnabled: true, deletedAt: null, isSystem: !primarySystem },
      });
    }
    if (!point) return false;
    teleportTo(
      player,
      Number(point.x),
      Number(point.y),
      Number(point.z),
      Number(point.angle),
      point.interiorId,
    );
    // 提示按实际命中类型区分（回退也如实标注）：系统点广播战局 + 本人确认，
    // 用户点仅本人提示（不广播）
    if (point.isSystem) {
      const session = sessionManager.getPlayerSession(player);
      // 批量广播不走 sysMsg（无 Player 对象），前缀用 PREFIX 常量保证与单聊一致
      session.broadcast(
        `${PREFIX.tp} ${player.getName().name} 传送到了 ${point.description || point.name} (/${teleName})`,
      );
      sysMsg(player, "tp", `你传送到了 /${teleName}（系统传送点）`, "success");
    } else {
      sysMsg(player, "tp", `你传送到了 //${teleName}（用户传送点）`, "success");
    }
    return true;
  } catch (e) {
    logger.error(`[tp] fallbackTeleport 失败 ${rawCommand}`, e);
    return false;
  }
}

/** 初始化传送命令与兜底 */
export function initTeleport(): void {
  // /s /l 临时位置
  PlayerEvent.onCommandText(["s", "sp"], ({ player, next }) => {
    const pos = player.getPos();
    const veh = player.getVehicle();
    tempPos.set(player.id, {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      interior: player.getInterior(),
      facingAngle: player.getFacingAngle().angle,
      zAngle: veh ? veh.getZAngle().angle : 0,
    });
    sysMsg(player, "tp", "当前位置已保存，输入 /l 返回", "success");
    return next();
  });

  PlayerEvent.onCommandText(["l", "lp"], ({ player, next }) => {
    const saved = tempPos.get(player.id);
    if (!saved) {
      sysMsg(player, "tp", "请先使用 /s 保存位置", "warn");
      return next();
    }
    player.setInterior(saved.interior);
    if (player.isInAnyVehicle()) {
      const veh = player.getVehicle()!;
      veh.setPos(saved.x, saved.y, saved.z);
      veh.setZAngle(saved.zAngle);
      // 车辆必须连到保存的 interior（否则人进室内、车留在旧 interior → 人车分离/车隐形）
      veh.linkToInterior(saved.interior);
    } else {
      player.setPos(saved.x, saved.y, saved.z);
      player.setFacingAngle(saved.facingAngle);
    }
    // /l 之前没走 freezeAfterTeleport——传回高空/地图外位置（如飞行赛道/边界点）
    // 同样需要等物体加载，否则下坠穿模
    freezeAfterTeleport(player, saved.x, saved.y, saved.z);
    sysMsg(player, "tp", "已传送回保存的位置", "success");
    return next();
  });

  // /tpa 同战局传送申请
  PlayerEvent.onCommandText(["tp", "tpa"], async ({ player, subcommand, next }) => {
    const arg = subcommand[0];
    if (arg === "ban") {
      sysMsg(player, "tp", "当前精简版通过面板的『世界个性化→接受传送』控制是否接收请求", "plain");
      return next();
    }
    if (!arg || Number.isNaN(+arg)) {
      sysMsg(player, "tp", "用法: /tpa 玩家ID", "plain");
      return next();
    }
    await requestTpa(player, +arg);
    return next();
  });

  // /ta 同意
  PlayerEvent.onCommandText(["ta", "yes"], async ({ player, next }) => {
    const fromId = tpFromId.get(player.id);
    if (fromId == null) {
      sysMsg(player, "tp", "没有待处理的请求", "warn");
      return next();
    }
    // 请求存在但超时条目缺失（防御性，正常 requestTpa 保证同写）：视为未超时
    if ((tpTimeoutAt.get(player.id) ?? Infinity) < Date.now()) {
      sysMsg(player, "tp", "请求已超时", "warn");
      initTp(player.id);
      return next();
    }
    const from = Player.getInstance(fromId);
    if (!from) {
      sysMsg(player, "tp", "对方已离线", "warn");
      initTp(player.id);
      return next();
    }
    // 接受时重新校验：期间可能进入比赛/切换战局（竞态防护）
    if (isInRace(player.id) || isInRace(from.id)) {
      sysMsg(player, "tp", "比赛中不能传送", "warn");
      initTp(player.id);
      initTp(from.id);
      return next();
    }
    if (!getAuthState(from.id)) {
      sysMsg(player, "tp", "对方已离线", "warn");
      initTp(player.id);
      initTp(from.id);
      return next();
    }
    const mySession = sessionManager.getPlayerSession(player);
    const fromSession = sessionManager.getPlayerSession(from);
    if (mySession.id !== fromSession.id) {
      sysMsg(player, "tp", "你们已不在同一战局，传送取消", "warn");
      initTp(player.id);
      initTp(from.id);
      return next();
    }
    const pos = player.getPos();
    // 落点 X/Y 横向随机（错开与对方重合），Z 保持原高度（之前 z+rand 会
    // 把被传送者抬高砸在对方头顶/卡进身体）
    teleportTo(
      from,
      pos.x + Math.random() * 3,
      pos.y + Math.random() * 3,
      pos.z,
      player.getFacingAngle().angle,
      player.getInterior(),
    );
    sysMsg(from, "tp", `${player.getName().name}(${player.id}) 同意了你的传送请求`, "info");
    sysMsg(player, "tp", `你同意了 ${from.getName().name}(${from.id}) 的传送请求`, "info");
    initTp(from.id);
    initTp(player.id);
    return next();
  });

  // /td 拒绝
  PlayerEvent.onCommandText(["td", "no"], ({ player, next }) => {
    const fromId = tpFromId.get(player.id);
    if (fromId == null) {
      sysMsg(player, "tp", "没有待处理的请求", "warn");
      return next();
    }
    const from = Player.getInstance(fromId);
    if (from) {
      sysMsg(from, "tp", `${player.getName().name}(${player.id}) 拒绝了你的传送请求`, "info");
    }
    sysMsg(player, "tp", "你拒绝了传送请求", "info");
    initTp(fromId);
    initTp(player.id);
    return next();
  });

  // /vmake [名字] 创建用户传送点（//名字 触发）——对齐原版命令（原版 /vmake）。
  // 无参 → 打开面板创建流程（对话框收集名字/描述，兼容老玩家习惯）
  PlayerEvent.onCommandText("vmake", ({ player, subcommand, next }) => {
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      sysMsg(player, "tp", "当前流程中不可操作", "warn");
      return next();
    }
    const name = subcommand[0];
    if (!name) {
      void createTeleportFlow(player);
      return next();
    }
    void createTeleport(player, name, null, false);
    return next();
  });

  // /vsmake [名字] [描述] 管理员创建系统传送点（/名字 触发，全服共享）——对齐
  // 原版 /vsmake（LV4+）。描述支持带空格（原版 sscanf 缺陷吞空格，这里修正）
  PlayerEvent.onCommandText("vsmake", ({ player, subcommand, next }) => {
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      sysMsg(player, "tp", "当前流程中不可操作", "warn");
      return next();
    }
    if (!isSuperAdmin(player)) {
      sysMsg(player, "tp", "只有管理员能创建系统传送点", "warn");
      return next();
    }
    const name = subcommand[0];
    if (!name) {
      sysMsg(
        player,
        "tp",
        "用法: /vsmake [名字] [描述] 例如 /vsmake sf SF机场（/名字 触发，全服共享）",
        "plain",
      );
      return next();
    }
    const description = subcommand.slice(1).join(" ");
    void createTeleport(player, name, description || null, true);
    return next();
  });

  // /telemenu 系统传送点列表（分页选择传送）——对齐原版 /telemenu
  PlayerEvent.onCommandText("telemenu", ({ player, next }) => {
    void listSystemTeleports(player);
    return next();
  });
}

/** tpa 超时清理（定时器调用） */
export function updateTpTimeouts(): void {
  const now = Date.now();
  for (const [pid, timeout] of tpTimeoutAt) {
    if (now >= timeout) {
      const targetId = tpGotoId.get(pid) ?? tpFromId.get(pid);
      // 双方都通知：发起方（pid）要知道自己请求超时（可重新发起），
      // 接收方（targetId）也知道请求已过期
      const requester = Player.getInstance(pid);
      if (requester && requester.isConnected()) {
        sysMsg(requester, "tp", "传送请求已超时", "info");
      }
      if (targetId != null) {
        const target = Player.getInstance(targetId);
        if (target && target.isConnected()) {
          sysMsg(target, "tp", "传送请求已超时", "info");
        }
        // 双向清理：对方侧可能残留配对条目（tpFromId[tp] = pid）——只清 pid
        // 会让对方之后 /tpa 被"你已有未处理的传送请求"卡住（initTp 只清自身）
        initTp(targetId);
      }
      initTp(pid);
    }
  }
}

/** tpa 超时轮询（timer 由 GameMode.onExit 统一清理） */
export function initTpTimeoutLoop(): void {
  setIntervalSafe(() => updateTpTimeouts(), 1000);
}

/** 面板入口：传送菜单（系统/用户传送点列表 / 创建传送点 / OP 管理，OP 项仅管理员显示） */
export async function openTeleportMenu(player: Player, back?: MenuBack): Promise<void> {
  const toThis = () => openTeleportMenu(player, back);
  const rows: { label: string; run: () => Promise<void> }[] = [
    { label: "系统传送点", run: () => listSystemTeleports(player, toThis) },
    { label: "用户传送点（//）", run: () => listUserTeleports(player, toThis) },
    { label: "创建传送点", run: () => createTeleportFlow(player, toThis) },
  ];
  if (isSuperAdmin(player)) {
    rows.push({ label: "管理传送点（OP）", run: () => manageTeleports(player, toThis) });
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "传送",
      info: rows.map((r, i) => `${i + 1}. ${r.label}`).join("\n"),
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return; // 断线
  if (res.response !== 1) return back?.(); // 取消 → 返回上一层
  await rows[res.listItem].run();
}

/** 系统传送点列表（分页选择传送） */
async function listSystemTeleports(player: Player, back?: MenuBack): Promise<void> {
  const points = await prisma.teleport.findMany({
    where: { isSystem: true, isEnabled: true, deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (points.length === 0) {
    sysMsg(player, "tp", "暂无系统传送点", "plain");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "系统传送点",
    data: points,
    format: (p) => `/${p.name}${p.description ? `（${p.description}）` : ""}`,
    button1: "传送",
    button2: "取消",
  });
  if (!r) return back?.();
  const point = r.item;
  teleportTo(
    player,
    Number(point.x),
    Number(point.y),
    Number(point.z),
    Number(point.angle),
    point.interiorId,
  );
  sysMsg(player, "tp", `你传送到了 ${point.name}`, "success");
  return back?.();
}

/**
 * 用户传送点列表（// 用户点，分页选择传送）。
 * 与 fallbackTeleport 的查询一致（isSystem:false 即可，不按 userId 过滤）——
 * 历史 // 点（原版迁移，owner 为特殊账号）对所有玩家可见可用，
 * 否则列表为空但 //名称 输入又能传，行为不一致。
 */
async function listUserTeleports(player: Player, back?: MenuBack): Promise<void> {
  const points = await prisma.teleport.findMany({
    where: { isSystem: false, isEnabled: true, deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (points.length === 0) {
    sysMsg(player, "tp", "暂无用户传送点，创建后输入 //名称 或在此选择使用", "plain");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "用户传送点",
    data: points,
    format: (p) => `//${p.name}${p.description ? `（${p.description}）` : ""}`,
    button1: "传送",
    button2: "取消",
  });
  if (!r) return back?.();
  const point = r.item;
  teleportTo(
    player,
    Number(point.x),
    Number(point.y),
    Number(point.z),
    Number(point.angle),
    point.interiorId,
  );
  sysMsg(player, "tp", `你传送到了 //${point.name}`, "success");
  return back?.();
}

/** 创建传送点（面板流程与 /vmake /vsmake 命令共用）：
 * 名字去斜杠前缀 + 去空格 + 长度 ≤48（对齐原版 vmake/vsmake 的 48 位限制）；
 * 重名（含软删，name 全局唯一约束）拒绝。成功返回 true，失败已发提示返回 false。 */
async function createTeleport(
  player: Player,
  name: string,
  description: string | null,
  isSystem: boolean,
): Promise<boolean> {
  const clean = name.replace(/^\/+/, "").trim();
  if (!clean) {
    sysMsg(player, "tp", "传送点名称不能为空", "error");
    return false;
  }
  if (clean.length > 48) {
    sysMsg(player, "tp", "名字过长，最多 48 个字符", "error");
    return false;
  }
  if (description && description.length > 48) {
    sysMsg(player, "tp", "描述过长，最多 48 个字符", "error");
    return false;
  }
  // 传送点名称/描述展示在聊天/列表（所有人可见），含敏感词拒绝创建
  if (containsSensitiveWord(clean) || (description && containsSensitiveWord(description))) {
    sysMsg(player, "tp", "传送点名称或描述包含敏感内容", "error");
    return false;
  }
  const exist = await prisma.teleport.findFirst({ where: { name: clean } });
  if (exist) {
    sysMsg(player, "tp", `该传送点 ${clean} 已存在`, "error");
    return false;
  }
  const auth = getAuthState(player.id);
  const pos = player.getPos();
  try {
    await prisma.teleport.create({
      data: {
        name: clean,
        description: description?.trim() || null,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        angle: player.getFacingAngle().angle,
        interiorId: player.getInterior(),
        isSystem,
        isEnabled: true,
        userId: isSystem ? null : auth?.userId,
      },
    });
    sysMsg(player, "tp", `传送点 ${isSystem ? "/" : "//"}${clean} 创建成功`, "success");
    return true;
  } catch (e) {
    logger.error(`[tp] 创建传送点失败 ${clean}`, e);
    sysMsg(player, "tp", "创建失败，名称可能已存在", "error");
    return false;
  }
}

/** 创建传送点：非 OP 只能建 //（用户点），OP 可选 / 或 // */
async function createTeleportFlow(player: Player, back?: MenuBack): Promise<void> {
  const isOp = isSuperAdmin(player);
  const nameRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "创建传送点",
      info: `输入传送点名称（${isOp ? "OP 可创建 /系统 或 //用户 传送点" : "创建的是 // 用户传送点"}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!nameRes) return;
  if (nameRes.response !== 1) return back?.();
  let name = nameRes.inputText.trim();
  if (!name) {
    sysMsg(player, "tp", "传送点名称不能为空", "error");
    return back?.();
  }
  // 去斜杠前缀
  if (name.startsWith("/")) name = name.slice(name.startsWith("//") ? 2 : 1);
  let isSystem = false;
  if (isOp) {
    const typeRes = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.LIST,
        caption: "传送点类型",
        info: "1. 系统传送点（/名称，所有人可见）\n2. 用户传送点（//名称，仅自己）",
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!typeRes) return;
    if (typeRes.response !== 1) return back?.();
    isSystem = typeRes.listItem === 0;
  }
  const descRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "传送点描述",
      info: "输入描述（可空）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!descRes) return;
  if (descRes.response !== 1) return back?.();
  await createTeleport(player, name, descRes.inputText.trim() || null, isSystem);
  return back?.();
}

/** OP 管理传送点：分页列表 → 删除（二次验证） */
async function manageTeleports(player: Player, back?: MenuBack): Promise<void> {
  // 纵深防御：面板 visible 过滤外，入口再复查一次（对齐 house-admin 先例）
  if (!isSuperAdmin(player)) {
    sysMsg(player, "tp", "只有管理员能管理传送点", "warn");
    return back?.();
  }
  const points = await prisma.teleport.findMany({
    where: { deletedAt: null },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  if (points.length === 0) {
    sysMsg(player, "tp", "暂无传送点", "plain");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "管理传送点",
    data: points,
    format: (p) =>
      `${p.isSystem ? "/" : "//"}${p.name}${p.description ? `（${p.description}）` : ""}`,
    button1: "删除",
    button2: "取消",
  });
  if (!r) return back?.();
  const point = r.item;
  // 二次验证删除
  const confirm = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "删除传送点",
      info: `确定删除传送点 ${point.isSystem ? "/" : "//"}${point.name} 吗？\n此操作不可撤销！`,
      button1: "确认删除",
      button2: "取消",
    }),
  );
  if (!confirm) return;
  if (confirm.response !== 1) return back?.();
  await prisma.teleport.update({
    where: { id: point.id },
    data: { deletedAt: new Date() },
  });
  sysMsg(player, "tp", "传送点已删除", "success");
  return back?.();
}
