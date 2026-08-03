import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { pickOption } from "@/personalize/settings";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import { formatTime } from "@/utils/format";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE, COLOR_RACE } from "@/utils/colors";
import { swapSortIndex, nextSortIndex, compactSortIndex } from "@/utils/sort";
import type { MenuBack } from "@/core/panel";
import { createRaceRoom } from "./room";
import { enterRaceEdit, canEditRace } from "./editor";

/** 面板入口：赛道管理 */
export async function openRaceMenu(player: Player, back?: MenuBack): Promise<void> {
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
  if (!res) return; // 断线
  if (res.response !== 1) return back?.(); // 取消 → 返回上一层
  const toThis = () => openRaceMenu(player, back);
  switch (res.listItem) {
    case 0:
      await createRaceFlow(player, toThis);
      break;
    case 1:
      await raceListFlow(player, "ALL", toThis);
      break;
    case 2:
      await raceListFlow(player, "MINE", toThis);
      break;
    case 3:
      await raceGroupFlow(player, toThis);
      break;
    case 4:
      if (isSuperAdmin(player)) {
        await adminRaceFlow(player, toThis);
      } else {
        player.sendClientMessage(COLOR_ERROR, "仅管理员可管理赛道");
      }
      break;
  }
}

/** 创建赛道 */
async function createRaceFlow(player: Player, back?: MenuBack): Promise<void> {
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
  if (!nameRes) return;
  if (nameRes.response !== 1) return back?.();
  const name = nameRes.inputText.trim();
  if (!name) {
    player.sendClientMessage(COLOR_ERROR, "赛道名称不能为空");
    return back?.();
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
  if (!descRes) return;
  if (descRes.response !== 1) return back?.();
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

/** 短日期（MM-DD HH:MM），用于列表多列展示 */
function fmtShortDate(d: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 赛道列表（全部/我的）：排序选择 + 多列展示，选择进入详情 */
async function raceListFlow(player: Player, mode: "ALL" | "MINE", back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  const where = {
    isEnabled: true,
    deletedAt: null,
    ...(mode === "MINE" && auth ? { userId: auth.userId } : {}),
  } as const;
  // 排序方式：按创建时间（默认，最新在前）/ 按名称（A-Z）
  const sortIndex = await pickOption(player, mode === "MINE" ? "我的赛道 · 排序" : "赛道列表 · 排序", [
    "按创建时间（最新在前）",
    "按名称（A-Z）",
  ]);
  if (sortIndex < 0) return back?.();
  // as const 固定字面量类型，否则联合类型导致 Prisma 泛型推断失败（orderBy 报错）
  const orderBy = sortIndex === 1 ? ({ name: "asc" } as const) : ({ createdAt: "desc" } as const);
  const races = await prisma.race.findMany({
    where,
    orderBy,
    include: { sysUser: true },
  });
  if (races.length === 0) {
    player.sendClientMessage(COLOR_WHITE, mode === "MINE" ? "你还没有创建赛道" : "暂无赛道");
    return back?.();
  }
  const isAll = mode === "ALL";
  const r = await showPagedDialog(player, {
    caption: mode === "MINE" ? "我的赛道" : "赛道列表",
    data: races,
    headers: isAll
      ? ["#", "名称", "长度", "圈数", "作者", "创建"]
      : ["#", "名称", "长度", "圈数", "创建"],
    format: (race, index) =>
      isAll
        ? [
            String(index + 1),
            race.name,
            `${Math.round(Number(race.totalLength))}m`,
            `${race.laps ?? 1}`,
            race.sysUser?.username ?? "?",
            fmtShortDate(race.createdAt),
          ]
        : [
            String(index + 1),
            race.name,
            `${Math.round(Number(race.totalLength))}m`,
            `${race.laps ?? 1}`,
            fmtShortDate(race.createdAt),
          ],
    button1: "选择",
    button2: "取消",
  });
  if (!r) return back?.();
  await raceDetailFlow(player, r.item.id, back);
}

/** 赛道详情：开始比赛/编辑/纪录/删除 */
async function raceDetailFlow(player: Player, raceId: string, back?: MenuBack): Promise<void> {
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
  if (!res) return;
  if (res.response !== 1) return back?.();
  const idx = res.listItem;
  if (idx === 0) {
    await createRaceRoom(player, raceId);
    // 建好房间后提示下一步（对齐 /r s 流程，避免首次使用者不知道要开始）
    player.sendClientMessage(COLOR_RACE, "输入 /r s 开始比赛（倒计时 5 秒后开跑）");
    return back?.();
  } else if (idx === 1) {
    await leaderboardFlow(player, raceId, () => raceDetailFlow(player, raceId, back));
  } else if (mine && idx === 2) {
    await enterRaceEdit(player, raceId);
  } else if (mine && idx === 3) {
    await deleteRaceFlow(player, raceId, () => raceDetailFlow(player, raceId, back));
  }
}

/** 排行榜 */
async function leaderboardFlow(player: Player, raceId: string, back?: MenuBack): Promise<void> {
  const records = await prisma.raceRecord.findMany({
    where: { raceId, deletedAt: null },
    orderBy: [{ record: "asc" }],
    take: 10,
    include: { sysUser: true },
  });
  if (records.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "该赛道还没有纪录");
    return back?.();
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
  return back?.();
}

/** 删除赛道（二次验证） */
async function deleteRaceFlow(player: Player, raceId: string, back?: MenuBack): Promise<void> {
  if (!(await canEditRace(player, raceId))) {
    player.sendClientMessage(COLOR_ERROR, "你无权删除该赛道");
    return back?.();
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
  if (!confirm) return;
  if (confirm.response !== 1) return back?.();
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
  if (!verify) return;
  if (verify.response !== 1) return back?.();
  if (verify.inputText.trim() !== race.name) {
    player.sendClientMessage(COLOR_ERROR, "输入的名称不匹配，已取消删除");
    return back?.();
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

/** 赛道分组（OP 管理，分页） */
async function raceGroupFlow(player: Player, back?: MenuBack): Promise<void> {
  const groups = await prisma.raceGroup.findMany({
    where: { deletedAt: null },
    orderBy: { index: "asc" },
    include: { races: { include: { race: true }, orderBy: { index: "asc" } } },
  });
  if (groups.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "暂无赛道分组");
    if (isSuperAdmin(player)) {
      await createGroupFlow(player, back);
    }
    return back?.();
  }
  const isOp = isSuperAdmin(player);
  const rows: { label: string; run: () => Promise<void> }[] = groups.map((g) => ({
    label: `${g.name}（${g.races.length} 条赛道）`,
    run: () => groupDetailFlow(player, g.id, () => raceGroupFlow(player, back)),
  }));
  if (isOp) {
    rows.push(
      { label: "↕ 重排分组顺序", run: () => reorderGroups(player, back) },
      { label: "创建分组", run: () => createGroupFlow(player, back) },
    );
  }
  const r = await showPagedDialog(player, {
    caption: "赛道分组",
    data: rows,
    format: (row) => row.label,
    button1: "查看",
    button2: "取消",
  });
  if (!r) return back?.();
  await r.item.run();
}

/** 重排分组顺序：分页列出分组 → 选择上移/下移（与相邻分组交换 index） */
async function reorderGroups(player: Player, back?: MenuBack): Promise<void> {
  const groups = await prisma.raceGroup.findMany({
    where: { deletedAt: null },
    orderBy: { index: "asc" },
  });
  if (groups.length < 2) {
    player.sendClientMessage(COLOR_WHITE, "分组数量不足，无法重排");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "重排分组",
    data: groups.map((g, i) => ({ group: g, i })),
    format: ({ group }) => `${group.name}（第 ${group.index + 1} 位）`,
    button1: "选择",
    button2: "取消",
  });
  if (!r) return back?.();
  const idx = r.item.i;
  const group = r.item.group;
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
  if (!dir) return;
  if (dir.response !== 1) return back?.();
  const target = dir.listItem === 0 ? groups[idx - 1] : groups[idx + 1];
  if (!target) {
    player.sendClientMessage(
      COLOR_ERROR,
      dir.listItem === 0 ? "已是第一个分组" : "已是最后一个分组",
    );
    return back?.();
  }
  await swapSortIndex(group, target, (id, index) =>
    prisma.raceGroup.update({ where: { id }, data: { index } }),
  );
  player.sendClientMessage(
    COLOR_SUCCESS,
    `分组「${group.name}」已${dir.listItem === 0 ? "上移" : "下移"}`,
  );
  await raceGroupFlow(player, back);
}

/** 分组详情（分页：组内赛道 + OP 管理项） */
async function groupDetailFlow(player: Player, groupId: string, back?: MenuBack): Promise<void> {
  const group = await prisma.raceGroup.findUnique({
    where: { id: groupId },
    include: { races: { include: { race: true }, orderBy: { index: "asc" } } },
  });
  if (!group) return;
  const isOp = isSuperAdmin(player);
  const rows: { label: string; run: () => Promise<void> }[] = group.races.map((gr) => ({
    label: `比赛: ${gr.race.name}`,
    run: async () => {
      await createRaceRoom(player, gr.raceId);
      // 开赛后回到上一层（分组列表），与原来"返回 back"行为一致
      await back?.();
    },
  }));
  if (isOp) {
    const toThis = () => groupDetailFlow(player, groupId, back);
    rows.push(
      { label: "添加赛道", run: () => addRaceToGroup(player, groupId, toThis) },
      { label: "移除赛道", run: () => removeRaceFromGroup(player, groupId, toThis) },
      { label: "↕ 重排组内赛道", run: () => reorderGroupRaces(player, groupId, toThis) },
      { label: "修改分组名", run: () => renameGroup(player, groupId, toThis) },
      { label: "删除分组（二次验证）", run: () => deleteGroup(player, groupId, toThis) },
    );
  }
  const r = await showPagedDialog(player, {
    caption: `分组「${group.name}」`,
    data: rows,
    format: (row) => row.label,
    button1: "确定",
    button2: "取消",
  });
  if (!r) return back?.();
  await r.item.run();
}

/** 重排组内赛道顺序：分页列出赛道 → 选择上移/下移（交换 index） */
async function reorderGroupRaces(player: Player, groupId: string, back?: MenuBack): Promise<void> {
  const entries = await prisma.raceGroupRace.findMany({
    where: { raceGroupId: groupId },
    include: { race: true },
    orderBy: { index: "asc" },
  });
  if (entries.length < 2) {
    player.sendClientMessage(COLOR_WHITE, "组内赛道不足，无法重排");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "重排组内赛道",
    data: entries.map((e, i) => ({ entry: e, i })),
    format: ({ entry }) => `${entry.race.name}（第 ${entry.index + 1} 位）`,
    button1: "选择",
    button2: "取消",
  });
  if (!r) return back?.();
  const idx = r.item.i;
  const entry = r.item.entry;
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
  if (!dir) return;
  if (dir.response !== 1) return back?.();
  const target = dir.listItem === 0 ? entries[idx - 1] : entries[idx + 1];
  if (!target) {
    player.sendClientMessage(
      COLOR_ERROR,
      dir.listItem === 0 ? "已是第一条赛道" : "已是最后一条赛道",
    );
    return back?.();
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
  player.sendClientMessage(
    COLOR_SUCCESS,
    `赛道「${entry.race.name}」已${dir.listItem === 0 ? "上移" : "下移"}`,
  );
  await groupDetailFlow(player, groupId, back);
}

async function createGroupFlow(player: Player, back?: MenuBack): Promise<void> {
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
  if (!res) return;
  if (res.response !== 1) return back?.();
  const name = res.inputText.trim();
  if (!name) return back?.();
  const groups = await prisma.raceGroup.findMany({
    where: { deletedAt: null },
    select: { index: true },
  });
  await prisma.raceGroup.create({ data: { name, index: nextSortIndex(groups) } });
  player.sendClientMessage(COLOR_SUCCESS, `分组「${name}」已创建`);
  return back?.();
}

async function addRaceToGroup(player: Player, groupId: string, back?: MenuBack): Promise<void> {
  const races = await prisma.race.findMany({
    where: { isEnabled: true, deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (races.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "暂无赛道可添加");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "添加赛道",
    data: races,
    format: (race) => race.name,
    button1: "添加",
    button2: "取消",
  });
  if (!r) return back?.();
  const race = r.item;
  // 判重：该赛道已在分组中则拒绝（race_group_race 有复合主键，重复会抛异常）
  const dup = await prisma.raceGroupRace.findUnique({
    where: { raceGroupId_raceId: { raceGroupId: groupId, raceId: race.id } },
  });
  if (dup) {
    player.sendClientMessage(COLOR_ERROR, `赛道「${race.name}」已在分组中`);
    return back?.();
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
  return back?.();
}

async function removeRaceFromGroup(
  player: Player,
  groupId: string,
  back?: MenuBack,
): Promise<void> {
  const entries = await prisma.raceGroupRace.findMany({
    where: { raceGroupId: groupId },
    include: { race: true },
    orderBy: { index: "asc" },
  });
  if (entries.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "分组内没有赛道");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "移除赛道",
    data: entries,
    format: (e) => e.race.name,
    button1: "移除",
    button2: "取消",
  });
  if (!r) return back?.();
  const entry = r.item;
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
  return back?.();
}

async function renameGroup(player: Player, groupId: string, back?: MenuBack): Promise<void> {
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
  if (!res) return;
  if (res.response !== 1) return back?.();
  const name = res.inputText.trim();
  if (!name) return back?.();
  await prisma.raceGroup.update({ where: { id: groupId }, data: { name } });
  player.sendClientMessage(COLOR_SUCCESS, "分组名已更新");
  return back?.();
}

async function deleteGroup(player: Player, groupId: string, back?: MenuBack): Promise<void> {
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
  if (!confirm) return;
  if (confirm.response !== 1) return back?.();
  // 事务：先删组内关联再删分组，中途失败整体回滚
  await prisma.$transaction(async (tx) => {
    await tx.raceGroupRace.deleteMany({ where: { raceGroupId: groupId } });
    await tx.raceGroup.delete({ where: { id: groupId } });
  });
  player.sendClientMessage(COLOR_SUCCESS, "分组已删除");
  return back?.();
}

/** OP 管理赛道（分页） */
async function adminRaceFlow(player: Player, back?: MenuBack): Promise<void> {
  const races = await prisma.race.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (races.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "暂无赛道");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "管理赛道（OP）",
    data: races,
    format: (race) => race.name,
    button1: "管理",
    button2: "取消",
  });
  if (!r) return back?.();
  const race = r.item;
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
  if (!r2) return;
  if (r2.response !== 1) return back?.();
  const toThis = () => adminRaceFlow(player, back);
  if (r2.listItem === 0) await enterRaceEdit(player, race.id);
  else if (r2.listItem === 1) await deleteRaceFlow(player, race.id, toThis);
  else if (r2.listItem === 2) await createGroupFlow(player, toThis);
}

/** 初始化命令（命令为辅）：/r 相关已由 room 注册，这里补充 /race 别名已在 room */
export function initRaceCommands(): void {
  PlayerEvent.onCommandText("races", ({ player, next }) => {
    void openRaceMenu(player);
    return next();
  });
}
