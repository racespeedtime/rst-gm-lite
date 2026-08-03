import { Dialog, DialogStylesEnum, GameText, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { sessionManager } from "@/sessions/manager";
import { isInRace } from "@/race/room";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import type { MenuBack } from "@/core/panel";
import { setIntervalSafe, setTimeoutSafe, clearTimeoutSafe } from "@/core/timers";

import { COLOR_INFO, COLOR_WHITE, COLOR_ERROR } from "@/utils/colors";
const TP_TIMEOUT_MS = 18_000;
/** 传送后冻结时长（对齐原版 DynUpdateStart：等待 obj 流式加载，避免下坠穿模） */
const TELEPORT_FREEZE_MS = 2000;

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
  freezeAfterTeleport(player);
}

/** 传送冻结定时器句柄（playerId → timeout，防重复传送时旧解冻提前打断） */
const freezeTimers = new Map<number, NodeJS.Timeout>();

/**
 * 传送后短暂冻结玩家（车内不冻结——车有物理，冻结车辆反而不自然）。
 * 对齐原版 DynUpdateStart：TogglePlayerControllable(false) + "Objects Loading"
 * 提示 + 2 秒后解冻。GameText 不支持中文，保持原版英文文案。
 * 重复传送（2 秒内再传）：刷新定时器，保证解冻以最后一次传送为准。
 */
function freezeAfterTeleport(player: Player): void {
  if (player.isNpc() || !player.isConnected()) return;
  if (player.isInAnyVehicle()) return;
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
    player.sendClientMessage(COLOR_WHITE, "[TP] 你已有未处理的传送请求");
    return false;
  }
  if (targetId === player.id) {
    player.sendClientMessage(COLOR_WHITE, "[TP] 不能向自己发送传送请求");
    return false;
  }
  const target = Player.getInstance(targetId);
  if (!target) {
    player.sendClientMessage(COLOR_WHITE, "[TP] 错误的玩家ID");
    return false;
  }
  if (target.isNpc()) {
    player.sendClientMessage(COLOR_WHITE, "[TP] 不能向NPC发送传送请求");
    return false;
  }
  if (!getAuthState(target.id)) {
    player.sendClientMessage(COLOR_WHITE, "[TP] 对方尚未登录");
    return false;
  }
  // 比赛中禁止传送（请求方与目标方均检查）
  if (isInRace(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "[TP] 比赛中不能传送");
    return false;
  }
  if (isInRace(target.id)) {
    player.sendClientMessage(COLOR_WHITE, "[TP] 对方正在比赛中，无法传送");
    return false;
  }
  // 同战局限制
  const mySession = sessionManager.getPlayerSession(player);
  const targetSession = sessionManager.getPlayerSession(target);
  if (mySession.id !== targetSession.id) {
    player.sendClientMessage(COLOR_ERROR, "[TP] 对方与你不在同一战局，无法传送");
    return false;
  }
  if (!(await acceptsTeleport(target))) {
    player.sendClientMessage(COLOR_WHITE, "[TP] 对方关闭了接受传送");
    return false;
  }
  if (tpFromId.has(target.id) || tpGotoId.has(target.id)) {
    player.sendClientMessage(COLOR_WHITE, "[TP] 对方正在处理其他请求");
    return false;
  }
  const timeout = Date.now() + TP_TIMEOUT_MS;
  tpGotoId.set(player.id, target.id);
  tpFromId.set(target.id, player.id);
  tpTimeoutAt.set(player.id, timeout);
  tpTimeoutAt.set(target.id, timeout);
  target.sendClientMessage(
    COLOR_INFO,
    `[TP] ${player.getName().name}(${player.id}) 请求传送到你身边，/ta 同意 /td 拒绝`,
  );
  player.sendClientMessage(COLOR_INFO, `[TP] 请求已发至 ${target.getName().name}(${target.id})`);
  new GameText("~n~~n~~n~~n~~n~~n~~n~~n~~w~Player want to move ~r~you~w~.", 3000, 3).forPlayer(
    target,
  );
  return true;
}

/**
 * / 与 // 传送点兜底（挂在 onCommandError code 4）：
 * - /名称 → 系统传送点（isSystem=true），全服/战局公告
 * - //名称 → 用户传送点（isSystem=false），仅本人提示
 * rawCommand 传 cmdText（保留原始斜杠，如 "/ls" 或 "//ls"），
 * 因 command 参数已被命令解析器剥离前导斜杠（"//ls" 会变成 "ls"）。
 */
export async function fallbackTeleport(player: Player, rawCommand: string): Promise<boolean> {
  const isUserTele = rawCommand.startsWith("//");
  const teleName = rawCommand.replace(/^\/+/, "");
  if (!teleName) return false;
  // 比赛中禁止传送
  if (isInRace(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "[比赛] 比赛中不能传送");
    return true;
  }
  try {
    const point = await prisma.teleport.findFirst({
      where: { name: teleName, isEnabled: true, deletedAt: null, isSystem: !isUserTele },
    });
    if (!point) return false;
    teleportTo(
      player,
      Number(point.x),
      Number(point.y),
      Number(point.z),
      Number(point.angle),
      point.interiorId,
    );
    if (isUserTele) {
      player.sendClientMessage(COLOR_WHITE, `[传送] 你传送到了 //${teleName}`);
    } else {
      const session = sessionManager.getPlayerSession(player);
      const msg = `[传送] ${player.getName().name} 传送到了 ${point.description || point.name} (/${teleName})`;
      session.broadcast(msg);
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
    player.sendClientMessage(COLOR_WHITE, "[传送] 当前位置已保存，输入 /l 返回");
    return next();
  });

  PlayerEvent.onCommandText(["l", "lp"], ({ player, next }) => {
    const saved = tempPos.get(player.id);
    if (!saved) {
      player.sendClientMessage(COLOR_ERROR, "[传送] 请先使用 /s 保存位置");
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
    player.sendClientMessage(COLOR_WHITE, "[传送] 已传送回保存的位置");
    return next();
  });

  // /tpa 同战局传送申请
  PlayerEvent.onCommandText(["tp", "tpa"], async ({ player, subcommand, next }) => {
    const arg = subcommand[0];
    if (arg === "ban") {
      player.sendClientMessage(
        COLOR_WHITE,
        "[TP] 当前精简版通过面板的『世界个性化→接受传送』控制是否接收请求",
      );
      return next();
    }
    if (!arg || Number.isNaN(+arg)) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 用法: /tpa 玩家ID");
      return next();
    }
    await requestTpa(player, +arg);
    return next();
  });

  // /ta 同意
  PlayerEvent.onCommandText(["ta", "yes"], async ({ player, next }) => {
    const fromId = tpFromId.get(player.id);
    if (fromId == null) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 没有待处理的请求");
      return next();
    }
    if (tpTimeoutAt.get(player.id)! < Date.now()) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 请求已超时");
      initTp(player.id);
      return next();
    }
    const from = Player.getInstance(fromId);
    if (!from) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 对方已离线");
      initTp(player.id);
      return next();
    }
    // 接受时重新校验：期间可能进入比赛/切换战局（竞态防护）
    if (isInRace(player.id) || isInRace(from.id)) {
      player.sendClientMessage(COLOR_ERROR, "[TP] 比赛中不能传送");
      initTp(player.id);
      initTp(from.id);
      return next();
    }
    if (!getAuthState(from.id)) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 对方已离线");
      initTp(player.id);
      initTp(from.id);
      return next();
    }
    const mySession = sessionManager.getPlayerSession(player);
    const fromSession = sessionManager.getPlayerSession(from);
    if (mySession.id !== fromSession.id) {
      player.sendClientMessage(COLOR_ERROR, "[TP] 你们已不在同一战局，传送取消");
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
    from.sendClientMessage(
      COLOR_INFO,
      `[TP] ${player.getName().name}(${player.id}) 同意了你的传送请求`,
    );
    player.sendClientMessage(
      COLOR_INFO,
      `[TP] 你同意了 ${from.getName().name}(${from.id}) 的传送请求`,
    );
    initTp(from.id);
    initTp(player.id);
    return next();
  });

  // /td 拒绝
  PlayerEvent.onCommandText(["td", "no"], ({ player, next }) => {
    const fromId = tpFromId.get(player.id);
    if (fromId == null) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 没有待处理的请求");
      return next();
    }
    const from = Player.getInstance(fromId);
    if (from) {
      from.sendClientMessage(
        COLOR_INFO,
        `[TP] ${player.getName().name}(${player.id}) 拒绝了你的传送请求`,
      );
    }
    player.sendClientMessage(COLOR_INFO, `[TP] 你拒绝了传送请求`);
    initTp(fromId);
    initTp(player.id);
    return next();
  });
}

/** tpa 超时清理（定时器调用） */
export function updateTpTimeouts(): void {
  const now = Date.now();
  for (const [pid, timeout] of tpTimeoutAt) {
    if (now >= timeout) {
      const targetId = tpGotoId.get(pid) ?? tpFromId.get(pid);
      if (targetId != null) {
        const target = Player.getInstance(targetId);
        if (target) {
          target.sendClientMessage(COLOR_WHITE, "[TP] 传送请求已超时");
        }
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
    player.sendClientMessage(COLOR_WHITE, "暂无系统传送点");
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
  player.sendClientMessage(COLOR_WHITE, `[传送] 你传送到了 ${point.name}`);
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
    player.sendClientMessage(COLOR_WHITE, "暂无用户传送点，创建后输入 //名称 或在此选择使用");
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
  player.sendClientMessage(COLOR_WHITE, `[传送] 你传送到了 //${point.name}`);
  return back?.();
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
    player.sendClientMessage(COLOR_ERROR, "传送点名称不能为空");
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
  const pos = player.getPos();
  const auth = getAuthState(player.id);
  try {
    await prisma.teleport.create({
      data: {
        name,
        description: descRes.inputText.trim() || null,
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
    player.sendClientMessage(COLOR_WHITE, `[传送] 传送点 ${isSystem ? "/" : "//"}${name} 创建成功`);
  } catch (e) {
    logger.error(`[tp] 创建传送点失败 ${name}`, e);
    player.sendClientMessage(COLOR_ERROR, "创建失败，名称可能已存在");
  }
  return back?.();
}

/** OP 管理传送点：分页列表 → 删除（二次验证） */
async function manageTeleports(player: Player, back?: MenuBack): Promise<void> {
  const points = await prisma.teleport.findMany({
    where: { deletedAt: null },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  if (points.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "暂无传送点");
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
  player.sendClientMessage(COLOR_WHITE, `[传送] 传送点已删除`);
  return back?.();
}
