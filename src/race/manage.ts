import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { showDialog } from "@/utils/dialog";
import { formatTime } from "@/utils/format";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE, COLOR_RACE } from "@/utils/colors";
import { swapSortIndex, nextSortIndex, compactSortIndex } from "@/utils/sort";
import { createRaceRoom } from "./room";
import { enterRaceEdit, canEditRace } from "./editor";

/** 面板入口：赛道管理 */
export async function openRaceMenu(player: Player): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "赛车",
      info: "1. 创建赛道\n2. 赛道列表\n3. 我的赛道\n4. 赛道分组\n5. 管理赛道（OP）",
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res || res.response !== 1) return;
  switch (res.listItem) {
    case 0:
      await createRaceFlow(player);
      break;
    case 1:
      await raceListFlow(player, "ALL");
      break;
    case 2:
      await raceListFlow(player, "MINE");
      break;
    case 3:
      await raceGroupFlow(player);
      break;
    case 4:
      if (isSuperAdmin(player)) {
        await adminRaceFlow(player);
      } else {
        player.sendClientMessage(COLOR_ERROR, "仅管理员可管理赛道");
      }
      break;
  }
}

/** 创建赛道 */
async function createRaceFlow(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const nameRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "创建赛道",
      info: "输入赛道名称：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!nameRes || nameRes.response !== 1) return;
  const name = nameRes.inputText.trim();
  if (!name) {
    player.sendClientMessage(COLOR_ERROR, "赛道名称不能为空");
    return;
  }
  const descRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "创建赛道",
      info: "输入赛道描述（可空）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!descRes || descRes.response !== 1) return;
  try {
    const race = await prisma.race.create({
      data: {
        name,
        description: descRes.inputText.trim() || null,
        isEnabled: true,
        userId: auth.userId,
      },
    });
    player.sendClientMessage(COLOR_SUCCESS, `赛道「${name}」创建成功，进入编辑模式放置检查点`);
    await enterRaceEdit(player, race.id);
  } catch (e) {
    logger.error(`[race] 创建赛道失败`, e);
    player.sendClientMessage(COLOR_ERROR, "创建失败（名称可能已存在）");
  }
}

/** 赛道列表（全部/我的） */
async function raceListFlow(player: Player, mode: "ALL" | "MINE"): Promise<void> {
  const auth = getAuthState(player.id);
  const where = {
    isEnabled: true,
    deletedAt: null,
    ...(mode === "MINE" && auth ? { userId: auth.userId } : {}),
  } as const;
  const races = await prisma.race.findMany({ where, orderBy: { createdAt: "desc" } });
  if (races.length === 0) {
    player.sendClientMessage(COLOR_WHITE, mode === "MINE" ? "你还没有创建赛道" : "暂无赛道");
    return;
  }
  const options = races.map((r) => `${r.name}${r.description ? `（${r.description}）` : ""} ${Math.round(Number(r.totalLength))}m`);
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: mode === "MINE" ? "我的赛道" : "赛道列表",
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "选择",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const race = races[res.listItem];
  if (!race) return;
  await raceDetailFlow(player, race.id);
}

/** 赛道详情：开始比赛/编辑/纪录/删除 */
async function raceDetailFlow(player: Player, raceId: string): Promise<void> {
  const race = await prisma.race.findUnique({ where: { id: raceId } });
  if (!race) return;
  const mine = await canEditRace(player, raceId);
  const recs = await prisma.raceRecord.count({ where: { raceId, deletedAt: null } });
  const options = ["开始比赛", "查看排行榜", ...(mine ? ["编辑赛道", "删除赛道（二次验证）"] : [])];
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `赛道「${race.name}」（${recs} 条纪录）`,
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const idx = res.listItem;
  if (idx === 0) {
    await createRaceRoom(player, raceId);
    // 建好房间后提示下一步（对齐 /r s 流程，避免首次使用者不知道要开始）
    player.sendClientMessage(COLOR_RACE, "输入 /r s 开始比赛（倒计时 5 秒后开跑）");
  } else if (idx === 1) {
    await leaderboardFlow(player, raceId);
  } else if (mine && idx === 2) {
    await enterRaceEdit(player, raceId);
  } else if (mine && idx === 3) {
    await deleteRaceFlow(player, raceId);
  }
}

/** 排行榜 */
async function leaderboardFlow(player: Player, raceId: string): Promise<void> {
  const records = await prisma.raceRecord.findMany({
    where: { raceId, deletedAt: null },
    orderBy: [{ record: "asc" }],
    take: 10,
    include: { sysUser: true },
  });
  if (records.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "该赛道还没有纪录");
    return;
  }
  const info = records
    .map((r, i) => `${i + 1}. ${r.sysUser?.username ?? "?"}  ${formatTime(r.record)}`)
    .join("\n");
  await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "排行榜 TOP10",
      info,
      button1: "关闭",
    }),
  );
}

/** 删除赛道（二次验证） */
async function deleteRaceFlow(player: Player, raceId: string): Promise<void> {
  if (!(await canEditRace(player, raceId))) {
    player.sendClientMessage(COLOR_ERROR, "你无权删除该赛道");
    return;
  }
  const confirm = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "删除赛道",
      info: "确定删除该赛道吗？\n赛道的检查点、脚本、纪录将一并删除，不可恢复！",
      button1: "确认删除",
      button2: "取消",
    }),
  );
  if (!confirm || confirm.response !== 1) return;
  const race = await prisma.race.findUnique({ where: { id: raceId } });
  if (!race) return;
  // 二次输入验证
  const verify = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "二次验证",
      info: `输入赛道名「${race.name}」确认删除：`,
      button1: "确认",
      button2: "取消",
    }),
  );
  if (!verify || verify.response !== 1) return;
  if (verify.inputText.trim() !== race.name) {
    player.sendClientMessage(COLOR_ERROR, "输入的名称不匹配，已取消删除");
    return;
  }
  try {
    const cps = await prisma.raceCp.findMany({ where: { raceId } });
    // 事务：脚本/CP/纪录/赛道软删 原子完成，中途失败整体回滚
    await prisma.$transaction(async (tx) => {
      await tx.raceCpScript.deleteMany({
        where: { checkpointId: { in: cps.map((c) => c.id) } },
      });
      await tx.raceCp.deleteMany({ where: { raceId } });
      await tx.raceRecord.deleteMany({ where: { raceId } });
      await tx.race.update({ where: { id: raceId }, data: { deletedAt: new Date() } });
    });
    player.sendClientMessage(COLOR_SUCCESS, `赛道「${race.name}」已删除`);
  } catch (e) {
    logger.error(`[race] 删除赛道失败`, e);
    player.sendClientMessage(COLOR_ERROR, "删除失败");
  }
}

/** 赛道分组（OP 管理） */
async function raceGroupFlow(player: Player): Promise<void> {
  const groups = await prisma.raceGroup.findMany({
    where: { deletedAt: null },
    orderBy: { index: "asc" },
    include: { races: { include: { race: true }, orderBy: { index: "asc" } } },
  });
  if (groups.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "暂无赛道分组");
    if (isSuperAdmin(player)) {
      await createGroupFlow(player);
    }
    return;
  }
  const options = groups.map((g) => `${g.name}（${g.races.length} 条赛道）`);
  if (isSuperAdmin(player)) {
    options.push("↕ 重排分组顺序", "创建分组");
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "赛道分组",
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "查看",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  if (res.listItem < groups.length) {
    const group = groups[res.listItem];
    if (group) await groupDetailFlow(player, group.id);
    return;
  }
  // OP 扩展项
  if (!isSuperAdmin(player)) return;
  if (res.listItem === groups.length) {
    await reorderGroups(player);
  } else if (res.listItem === groups.length + 1) {
    await createGroupFlow(player);
  }
}

/** 重排分组顺序：列出分组 → 选择上移/下移（与相邻分组交换 index） */
async function reorderGroups(player: Player): Promise<void> {
  const groups = await prisma.raceGroup.findMany({
    where: { deletedAt: null },
    orderBy: { index: "asc" },
  });
  if (groups.length < 2) {
    player.sendClientMessage(COLOR_WHITE, "分组数量不足，无法重排");
    return;
  }
  const options = groups.map((g) => `${g.name}（第 ${g.index + 1} 位）`);
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "重排分组",
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "选择",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const idx = res.listItem;
  const group = groups[idx];
  if (!group) return;
  const dir = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `重排「${group.name}」`,
      info: `1. 上移（与${groups[idx - 1] ? `「${groups[idx - 1].name}」` : "无"}交换）\n2. 下移（与${groups[idx + 1] ? `「${groups[idx + 1].name}」` : "无"}交换）`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!dir || dir.response !== 1) return;
  const target = dir.listItem === 0 ? groups[idx - 1] : groups[idx + 1];
  if (!target) {
    player.sendClientMessage(COLOR_ERROR, dir.listItem === 0 ? "已是第一个分组" : "已是最后一个分组");
    return;
  }
  await swapSortIndex(group, target, (id, index) =>
    prisma.raceGroup.update({ where: { id }, data: { index } }),
  );
  player.sendClientMessage(COLOR_SUCCESS, `分组「${group.name}」已${dir.listItem === 0 ? "上移" : "下移"}`);
  await raceGroupFlow(player);
}

/** 分组详情 */
async function groupDetailFlow(player: Player, groupId: string): Promise<void> {
  const group = await prisma.raceGroup.findUnique({
    where: { id: groupId },
    include: { races: { include: { race: true }, orderBy: { index: "asc" } } },
  });
  if (!group) return;
  const options = [...group.races.map((gr) => `比赛: ${gr.race.name}`)];
  if (isSuperAdmin(player)) {
    options.push("添加赛道", "移除赛道", "↕ 重排组内赛道", "修改分组名", "删除分组（二次验证）");
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `分组「${group.name}」`,
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const idx = res.listItem;
  if (idx < group.races.length) {
    const gr = group.races[idx];
    await createRaceRoom(player, gr.raceId);
    return;
  }
  if (!isSuperAdmin(player)) return;
  const adminIdx = idx - group.races.length;
  if (adminIdx === 0) await addRaceToGroup(player, groupId);
  else if (adminIdx === 1) await removeRaceFromGroup(player, groupId);
  else if (adminIdx === 2) await reorderGroupRaces(player, groupId);
  else if (adminIdx === 3) await renameGroup(player, groupId);
  else if (adminIdx === 4) await deleteGroup(player, groupId);
}

/** 重排组内赛道顺序：列出赛道 → 选择上移/下移（交换 index） */
async function reorderGroupRaces(player: Player, groupId: string): Promise<void> {
  const entries = await prisma.raceGroupRace.findMany({
    where: { raceGroupId: groupId },
    include: { race: true },
    orderBy: { index: "asc" },
  });
  if (entries.length < 2) {
    player.sendClientMessage(COLOR_WHITE, "组内赛道不足，无法重排");
    return;
  }
  const options = entries.map((e) => `${e.race.name}（第 ${e.index + 1} 位）`);
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "重排组内赛道",
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "选择",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const idx = res.listItem;
  const entry = entries[idx];
  if (!entry) return;
  const dir = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `重排「${entry.race.name}」`,
      info: `1. 上移（与${entries[idx - 1] ? `「${entries[idx - 1].race.name}」` : "无"}交换）\n2. 下移（与${entries[idx + 1] ? `「${entries[idx + 1].race.name}」` : "无"}交换）`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!dir || dir.response !== 1) return;
  const target = dir.listItem === 0 ? entries[idx - 1] : entries[idx + 1];
  if (!target) {
    player.sendClientMessage(COLOR_ERROR, dir.listItem === 0 ? "已是第一条赛道" : "已是最后一条赛道");
    return;
  }
  await swapSortIndex(
    { id: entry.raceId, index: entry.index },
    { id: target.raceId, index: target.index },
    (id, index) =>
      prisma.raceGroupRace.update({
        where: { raceGroupId_raceId: { raceGroupId: groupId, raceId: id } },
        data: { index },
      }),
  );
  player.sendClientMessage(COLOR_SUCCESS, `「${entry.race.name}」已${dir.listItem === 0 ? "上移" : "下移"}`);
  await groupDetailFlow(player, groupId);
}

async function createGroupFlow(player: Player): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "创建分组",
      info: "输入分组名称：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const name = res.inputText.trim();
  if (!name) return;
  const groups = await prisma.raceGroup.findMany({
    where: { deletedAt: null },
    select: { index: true },
  });
  await prisma.raceGroup.create({ data: { name, index: nextSortIndex(groups) } });
  player.sendClientMessage(COLOR_SUCCESS, `分组「${name}」已创建`);
}

async function addRaceToGroup(player: Player, groupId: string): Promise<void> {
  const races = await prisma.race.findMany({
    where: { isEnabled: true, deletedAt: null },
    orderBy: { name: "asc" },
    take: 50,
  });
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "添加赛道",
      info: races.map((r, i) => `${i + 1}. ${r.name}`).join("\n"),
      button1: "添加",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const race = races[res.listItem];
  if (!race) return;
  // 判重：该赛道已在分组中则拒绝（race_group_race 有复合主键，重复会抛异常）
  const dup = await prisma.raceGroupRace.findUnique({
    where: { raceGroupId_raceId: { raceGroupId: groupId, raceId: race.id } },
  });
  if (dup) {
    player.sendClientMessage(COLOR_ERROR, `赛道「${race.name}」已在分组中`);
    return;
  }
  try {
    const existing = await prisma.raceGroupRace.findMany({
      where: { raceGroupId: groupId },
      select: { index: true },
    });
    await prisma.raceGroupRace.create({
      data: { raceGroupId: groupId, raceId: race.id, index: nextSortIndex(existing) },
    });
    player.sendClientMessage(COLOR_SUCCESS, `已添加赛道「${race.name}」`);
  } catch (e) {
    logger.error(`[race] 添加赛道到分组失败`, e);
    player.sendClientMessage(COLOR_ERROR, "添加失败");
  }
}

async function removeRaceFromGroup(player: Player, groupId: string): Promise<void> {
  const entries = await prisma.raceGroupRace.findMany({
    where: { raceGroupId: groupId },
    include: { race: true },
    orderBy: { index: "asc" },
  });
  if (entries.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "分组内没有赛道");
    return;
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "移除赛道",
      info: entries.map((e, i) => `${i + 1}. ${e.race.name}`).join("\n"),
      button1: "移除",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const entry = entries[res.listItem];
  if (!entry) return;
  // 事务：删除 + 组内后续赛道 index 前移（防空洞）原子完成
  const rest = entries
    .filter((e) => e.raceId !== entry.raceId)
    .map((e) => ({ id: e.raceId, index: e.index }));
  await prisma.$transaction(async (tx) => {
    await tx.raceGroupRace.delete({
      where: { raceGroupId_raceId: { raceGroupId: groupId, raceId: entry.raceId } },
    });
    await compactSortIndex(rest, entry.index, (id, index) =>
      tx.raceGroupRace.update({
        where: { raceGroupId_raceId: { raceGroupId: groupId, raceId: id } },
        data: { index },
      }),
    );
  });
  player.sendClientMessage(COLOR_SUCCESS, `已移除赛道「${entry.race.name}」`);
}

async function renameGroup(player: Player, groupId: string): Promise<void> {
  const group = await prisma.raceGroup.findUnique({ where: { id: groupId } });
  if (!group) return;
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "修改分组名",
      info: `输入新名称（当前：${group.name}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const name = res.inputText.trim();
  if (!name) return;
  await prisma.raceGroup.update({ where: { id: groupId }, data: { name } });
  player.sendClientMessage(COLOR_SUCCESS, "分组名已更新");
}

async function deleteGroup(player: Player, groupId: string): Promise<void> {
  const confirm = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "删除分组",
      info: "确定删除该分组吗？（组内赛道不会被删除）",
      button1: "确认删除",
      button2: "取消",
    }),
  );
  if (!confirm || confirm.response !== 1) return;
  // 事务：先删组内关联再删分组，中途失败整体回滚
  await prisma.$transaction(async (tx) => {
    await tx.raceGroupRace.deleteMany({ where: { raceGroupId: groupId } });
    await tx.raceGroup.delete({ where: { id: groupId } });
  });
  player.sendClientMessage(COLOR_SUCCESS, "分组已删除");
}

/** OP 管理赛道 */
async function adminRaceFlow(player: Player): Promise<void> {
  const races = await prisma.race.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "管理赛道（OP）",
      info: races.map((r, i) => `${i + 1}. ${r.name}`).join("\n"),
      button1: "管理",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const race = races[res.listItem];
  if (!race) return;
  const opts = ["编辑赛道", "删除赛道（二次验证）", "创建分组"];
  const r2 = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `赛道「${race.name}」`,
      info: opts.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!r2 || r2.response !== 1) return;
  if (r2.listItem === 0) await enterRaceEdit(player, race.id);
  else if (r2.listItem === 1) await deleteRaceFlow(player, race.id);
  else if (r2.listItem === 2) await createGroupFlow(player);
}

/** 初始化命令（命令为辅）：/r 相关已由 room 注册，这里补充 /race 别名已在 room */
export function initRaceCommands(): void {
  PlayerEvent.onCommandText("races", ({ player, next }) => {
    void openRaceMenu(player);
    return next();
  });
}
