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
import { setIntervalSafe } from "@/core/timers";

import { COLOR_INFO, COLOR_WHITE, COLOR_ERROR } from "@/utils/colors";
const TP_TIMEOUT_MS = 18_000;

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
export function teleportTo(player: Player, x: number, y: number, z: number, angle: number, interiorId: number): void {
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
}

/** 玩家是否接受传送（设置校验） */
async function acceptsTeleport(player: Player): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) return false;
  const setting = await prisma.sysUserSetting.findUnique({ where: { userId: auth.userId } });
  return setting?.acceptTeleport ?? true;
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
    teleportTo(player, Number(point.x), Number(point.y), Number(point.z), Number(point.angle), point.interiorId);
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
      player.sendClientMessage(COLOR_WHITE, "[TP] 当前精简版通过面板的『世界个性化→接受传送』控制是否接收请求");
      return next();
    }
    if (tpGotoId.has(player.id) || tpFromId.has(player.id)) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 你已有未处理的传送请求");
      return next();
    }
    if (!arg || Number.isNaN(+arg)) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 用法: /tpa 玩家ID");
      return next();
    }
    const targetId = +arg;
    if (targetId === player.id) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 不能向自己发送传送请求");
      return next();
    }
    const target = Player.getInstance(targetId);
    if (!target) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 错误的玩家ID");
      return next();
    }
    if (target.isNpc()) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 不能向NPC发送传送请求");
      return next();
    }
    if (!getAuthState(target.id)) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 对方尚未登录");
      return next();
    }
    // 比赛中禁止传送（请求方与目标方均检查）
    if (isInRace(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "[TP] 比赛中不能传送");
      return next();
    }
    if (isInRace(target.id)) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 对方正在比赛中，无法传送");
      return next();
    }
    // 同战局限制
    const mySession = sessionManager.getPlayerSession(player);
    const targetSession = sessionManager.getPlayerSession(target);
    if (mySession.id !== targetSession.id) {
      player.sendClientMessage(COLOR_ERROR, "[TP] 对方与你不在同一战局，无法传送");
      return next();
    }
    if (!(await acceptsTeleport(target))) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 对方关闭了接受传送");
      return next();
    }
    if (tpFromId.has(target.id) || tpGotoId.has(target.id)) {
      player.sendClientMessage(COLOR_WHITE, "[TP] 对方正在处理其他请求");
      return next();
    }
    const timeout = Date.now() + TP_TIMEOUT_MS;
    tpGotoId.set(player.id, target.id);
    tpFromId.set(target.id, player.id);
    tpTimeoutAt.set(player.id, timeout);
    tpTimeoutAt.set(target.id, timeout);
    target.sendClientMessage(COLOR_INFO, `[TP] ${player.getName().name}(${player.id}) 请求传送到你身边，/ta 同意 /td 拒绝`);
    player.sendClientMessage(COLOR_INFO, `[TP] 请求已发至 ${target.getName().name}(${target.id})`);
    new GameText("~n~~n~~n~~n~~n~~n~~n~~n~~w~Player want to move ~r~you~w~.", 3000, 3).forPlayer(target);
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
    // 用 teleportTo 统一处理人车分离（车内/步行分别移动），避免 setPos 后玩家与车分离
    teleportTo(from, pos.x + Math.random() * 3, pos.y, pos.z + Math.random() * 3, player.getFacingAngle().angle, player.getInterior());
    from.sendClientMessage(COLOR_INFO, `[TP] ${player.getName().name}(${player.id}) 同意了你的传送请求`);
    player.sendClientMessage(COLOR_INFO, `[TP] 你同意了 ${from.getName().name}(${from.id}) 的传送请求`);
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
      from.sendClientMessage(COLOR_INFO, `[TP] ${player.getName().name}(${player.id}) 拒绝了你的传送请求`);
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

/** 面板入口：传送菜单（系统/我的传送点列表 / 创建传送点 / OP 管理） */
export async function openTeleportMenu(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "传送",
      info: "1. 系统传送点\n2. 我的传送点\n3. 创建传送点\n4. 管理传送点（OP）",
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return; // 断线
  if (res.response !== 1) return back?.(); // 取消 → 返回上一层
  const toThis = () => openTeleportMenu(player, back);
  if (res.listItem === 0) {
    await listSystemTeleports(player, toThis);
  } else if (res.listItem === 1) {
    await listMyTeleports(player, toThis);
  } else if (res.listItem === 2) {
    await createTeleportFlow(player, toThis);
  } else if (res.listItem === 3) {
    if (isSuperAdmin(player)) {
      await manageTeleports(player, toThis);
    } else {
      player.sendClientMessage(COLOR_ERROR, "仅管理员可管理传送点");
      return back?.();
    }
  }
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
  teleportTo(player, Number(point.x), Number(point.y), Number(point.z), Number(point.angle), point.interiorId);
  player.sendClientMessage(COLOR_WHITE, `[传送] 你传送到了 ${point.name}`);
  return back?.();
}

/** 我的传送点列表（// 用户点，分页选择传送） */
async function listMyTeleports(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const points = await prisma.teleport.findMany({
    where: { isSystem: false, isEnabled: true, deletedAt: null, userId: auth.userId },
    orderBy: { name: "asc" },
  });
  if (points.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "你还没有个人传送点，创建后输入 //名称 或在此选择使用");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "我的传送点",
    data: points,
    format: (p) => `//${p.name}${p.description ? `（${p.description}）` : ""}`,
    button1: "传送",
    button2: "取消",
  });
  if (!r) return back?.();
  const point = r.item;
  teleportTo(player, Number(point.x), Number(point.y), Number(point.z), Number(point.angle), point.interiorId);
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
    format: (p) => `${p.isSystem ? "/" : "//"}${p.name}${p.description ? `（${p.description}）` : ""}`,
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
