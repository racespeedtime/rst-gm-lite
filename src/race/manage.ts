import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { pickOption } from "@/personalize/settings";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import { formatTime, formatDuration, formatShortDate } from "@/utils/format";
import { sysMsg } from "@/utils/msg";
import { swapSortIndex, nextSortIndex, compactSortIndex } from "@/utils/sort";
import type { MenuBack } from "@/core/panel";
import { createRaceRoom } from "./room";
import { enterRaceEdit, canEditRace } from "./editor";
import { startChallengeFromRace } from "@/replay/challenge";
import { openReplayActions } from "@/replay/menu";

/** 面板入口：赛道管理（管理赛道为 OP 专属，非 OP 不显示该行） */
export async function openRaceMenu(player: Player, back?: MenuBack): Promise<void> {
  const isOp = isSuperAdmin(player);
  const toThis = () => openRaceMenu(player, back);
  const rows: { label: string; run: () => Promise<void> }[] = [
    { label: "创建赛道", run: () => createRaceFlow(player, toThis) },
    { label: "赛道列表", run: () => raceListFlow(player, "ALL", toThis) },
    { label: "我的赛道", run: () => raceListFlow(player, "MINE", toThis) },
    { label: "赛道分组", run: () => raceGroupFlow(player, toThis) },
  ];
  if (isOp) {
    rows.push({ label: "管理赛道（OP）", run: () => adminRaceFlow(player, toThis) });
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "赛车",
      info: rows.map((r, i) => `${i + 1}. ${r.label}`).join("\n"),
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return; // 断线
  if (res.response !== 1) return back?.(); // 取消 → 返回上一层
  await rows[res.listItem].run();
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
    sysMsg(player, "race", "赛道名称不能为空", "error");
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
    sysMsg(player, "race", `赛道「${name}」创建成功，进入编辑模式放置检查点`, "success");
    await enterRaceEdit(player, race.id);
  } catch (e) {
    logger.error(`[race] 创建赛道失败`, e);
    sysMsg(player, "race", "创建失败（名称可能已存在）", "error");
  }
}

/** 时长格式化（mm:ss 或 ss，回放列表用）与短日期（MM-DD HH:MM）收敛至 utils/format */

/** 赛道列表（全部/我的）：排序选择 + 多列展示，选择进入详情 */
async function raceListFlow(player: Player, mode: "ALL" | "MINE", back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  const where = {
    isEnabled: true,
    deletedAt: null,
    ...(mode === "MINE" && auth ? { userId: auth.userId } : {}),
  } as const;
  // 排序：先选字段（创建时间/名称/总长度），再选方向（升序/降序）
  const fieldIndex = await pickOption(
    player,
    mode === "MINE" ? "我的赛道 · 排序" : "赛道列表 · 排序",
    ["按创建时间", "按名称", "按总长度"],
  );
  if (fieldIndex < 0) return back?.();
  const dirIndex = await pickOption(player, "排序方向", ["升序", "降序"]);
  if (dirIndex < 0) return back?.();
  const dir = dirIndex === 0 ? ("asc" as const) : ("desc" as const);
  // 各字段明确字面量 as const，避免联合类型导致 Prisma 泛型推断失败
  const orderBy =
    fieldIndex === 0
      ? ({ createdAt: dir } as const)
      : fieldIndex === 1
        ? ({ name: dir } as const)
        : ({ totalLength: dir } as const);
  const races = await prisma.race.findMany({
    where,
    orderBy: "name" in orderBy ? undefined : orderBy, // 名称排序改 JS 端做（见下）
    include: { sysUser: true },
  });
  // 名称排序：大小写不敏感（DB 默认按字节序区分大小写，A 整块排在 a 前）——
  // 与 /r 列表（roomUi.fetchEnabledRaces）保持一致：toLowerCase 后按码点比较
  if ("name" in orderBy) {
    races.sort((a, b) => {
      const la = a.name.toLowerCase();
      const lb = b.name.toLowerCase();
      const cmp = la < lb ? -1 : la > lb ? 1 : 0;
      return orderBy.name === "asc" ? cmp : -cmp;
    });
  }
  if (races.length === 0) {
    sysMsg(player, "race", mode === "MINE" ? "你还没有创建赛道" : "暂无赛道", "plain");
    return back?.();
  }
  const isAll = mode === "ALL";
  const r = await showPagedDialog(player, {
    caption: mode === "MINE" ? "我的赛道" : "赛道列表",
    data: races,
    cacheKey: `race:list:${mode}`, // 赛道列表常翻页找赛道，记住上次位置
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
            formatShortDate(race.createdAt),
          ]
        : [
            String(index + 1),
            race.name,
            `${Math.round(Number(race.totalLength))}m`,
            `${race.laps ?? 1}`,
            formatShortDate(race.createdAt),
          ],
    button1: "选择",
    button2: "取消",
  });
  if (!r) return back?.();
  await openRaceDetailPanel(player, r.item.id, back);
}

/** 赛道详情：基本信息 + 开始比赛/影子挑战/排行榜/编辑/删除。
 * /r info 与赛车管理菜单（openRaceMenu → 赛道列表 → 选择）共用。
 * LIST 前几行为详情信息头（不可操作），listItem 减去 INFO_LINES 才是操作下标 */
export async function openRaceDetailPanel(
  player: Player,
  raceId: string,
  back?: MenuBack,
): Promise<void> {
  const race = await prisma.race.findUnique({
    where: { id: raceId },
    include: { sysUser: true },
  });
  if (!race) return;
  const mine = await canEditRace(player, raceId);
  const recs = await prisma.raceRecord.count({ where: { raceId, deletedAt: null } });
  const actions = [
    "开始比赛",
    "查看回放",
    "影子挑战",
    "查看排行榜",
    ...(mine ? ["编辑赛道", "删除赛道（二次验证）"] : []),
  ];
  // 详情信息头（名称/长度/作者），其后紧跟操作项。
  // INFO_LINES = 信息头行数。两个坑（都踩过）：
  // 1) 信息头文本必须单行——SA LIST 对话框按渲染宽度自动折行，赛道名/作者
  //    过长折行后渲染行数 > 逻辑行数，listItem 偏移错位。名称截断 28 字符、
  //    作者截断 12 字符（中文双宽，安全宽度内不折行）。
  // 2) 不要用空行做信息头与操作项的分隔——SA 客户端折叠空行不占行号，多算的
  //    INFO_LINES 会让点击整体偏移（"选查看回放触发开始比赛"）。
  const name = race.name.length > 28 ? `${race.name.slice(0, 28)}…` : race.name;
  const author = race.sysUser?.username ?? "?";
  const authorSafe = author.length > 12 ? `${author.slice(0, 12)}…` : author;
  const headerLines = [
    `{FFD700}${name}`,
    `长度 ${Math.round(Number(race.totalLength))}m · ${race.laps ?? 1} 圈`,
    `作者 ${authorSafe} · 纪录 ${recs} 条`,
  ];
  const INFO_LINES = headerLines.length;
  const info = [...headerLines, ...actions.map((o, i) => `${i + 1}. ${o}`)].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "赛道详情",
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const idx = res.listItem - INFO_LINES;
  if (idx < 0) return;
  if (idx === 0) {
    await createRaceRoom(player, raceId);
    // 创建比赛后进入房间：不再弹回赛道/赛车菜单（玩家在房间内，
    // 按 Y 打开的是"比赛房间"面板）。提示下一步（对齐 /r s 流程）
    sysMsg(
      player,
      "race",
      "比赛房间已创建，按 Y 或输入 /r s 开始比赛（倒计时 5 秒后开跑）",
      "info",
    );
    return;
  } else if (idx === 1) {
    // 查看该赛道所有人的完赛比赛回放（分页）→ 可观看/分身/影子挑战
    await listRaceReplays(player, raceId, () => openRaceDetailPanel(player, raceId, back));
  } else if (idx === 2) {
    // 影子挑战：选该赛道的完赛比赛回放当影子，同步起跑对比
    const ok = await startChallengeFromRace(player, raceId);
    if (ok) return; // 进入挑战世界，不再回菜单
    await openRaceDetailPanel(player, raceId, back);
  } else if (idx === 3) {
    await leaderboardFlow(player, raceId, () => openRaceDetailPanel(player, raceId, back));
  } else if (mine && idx === 4) {
    await enterRaceEdit(player, raceId);
  } else if (mine && idx === 5) {
    await deleteRaceFlow(player, raceId, () => openRaceDetailPanel(player, raceId, back));
  }
}

/** 赛道详情 → 查看回放：该赛道所有玩家已完成的比赛回放（分页）→ 观看/分身/影子挑战 */
async function listRaceReplays(player: Player, raceId: string, back?: MenuBack): Promise<void> {
  const list = await prisma.replay.findMany({
    where: { raceId, type: "race", deletedAt: null, finished: true },
    orderBy: { createdAt: "desc" },
  });
  if (list.length === 0) {
    sysMsg(player, "race", "该赛道还没有完成的比赛回放", "plain");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: `该赛道回放（${list.length}）`,
    data: list,
    headers: ["录者", "名次", "时长", "时间"],
    format: (v) => [
      v.recorderName,
      v.rank != null ? `No.${v.rank}` : "—",
      formatDuration(v.durationMs),
      formatShortDate(v.createdAt),
    ],
    button1: "操作",
    button2: "返回",
  });
  if (!r) return back?.();
  await openReplayActions(player, r.item, { back, allowDelete: false });
}

/** 排行榜：多列分页展示前 100 条纪录（名次/玩家/用时/日期）。
 * 对齐 shadow 选择等列表的分页交互，热门赛道也能翻到靠后的名次 */
async function leaderboardFlow(player: Player, raceId: string, back?: MenuBack): Promise<void> {
  const records = await prisma.raceRecord.findMany({
    where: { raceId, deletedAt: null },
    orderBy: [{ record: "asc" }],
    take: 100,
    include: { sysUser: true },
  });
  if (records.length === 0) {
    sysMsg(player, "race", "该赛道还没有纪录", "plain");
    return back?.();
  }
  await showPagedDialog(player, {
    caption: "排行榜（前 100）",
    data: records,
    headers: ["#", "玩家", "用时", "日期"],
    format: (r, index) => [
      String(index + 1),
      r.sysUser?.username ?? "?",
      formatTime(r.record),
      formatShortDate(r.createdAt),
    ],
    // 纯浏览：点行无选中语义，仅翻页/确定返回（防"点了没反应"的困惑）
    selectable: false,
    button1: "确定",
    button2: "返回",
  });
  return back?.();
}

/** 删除赛道（二次验证） */
async function deleteRaceFlow(player: Player, raceId: string, back?: MenuBack): Promise<void> {
  if (!(await canEditRace(player, raceId))) {
    sysMsg(player, "race", "你无权删除该赛道", "error");
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
    sysMsg(player, "race", "输入的名称不匹配，已取消删除", "error");
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
    sysMsg(player, "race", `赛道「${race.name}」已删除`, "success");
  } catch (e) {
    logger.error(`[race] 删除赛道失败`, e);
    sysMsg(player, "race", "删除失败", "error");
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
    sysMsg(player, "race", "暂无赛道分组", "plain");
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
      { label: "↑↓ 重排分组顺序", run: () => reorderGroups(player, back) },
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
    sysMsg(player, "race", "分组数量不足，无法重排", "plain");
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
    sysMsg(player, "race", dir.listItem === 0 ? "已是第一个分组" : "已是最后一个分组", "error");
    return back?.();
  }
  await swapSortIndex(group, target, (id, index) =>
    prisma.raceGroup.update({ where: { id }, data: { index } }),
  );
  sysMsg(
    player,
    "race",
    `分组「${group.name}」已${dir.listItem === 0 ? "上移" : "下移"}`,
    "success",
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
    // 与赛道列表一致：双击进赛道详情（开始比赛/回放/挑战/排行榜自选），不再
    // 直接开赛。详情取消直接关闭、不弹回赛道分组面板——分组只是入口，
    // 详情就是目标面板（不再多弹一层"返回分组"的步骤）
    run: () => openRaceDetailPanel(player, gr.raceId),
  }));
  if (isOp) {
    const toThis = () => groupDetailFlow(player, groupId, back);
    rows.push(
      { label: "添加赛道", run: () => addRaceToGroup(player, groupId, toThis) },
      { label: "移除赛道", run: () => removeRaceFromGroup(player, groupId, toThis) },
      { label: "↑↓ 重排组内赛道", run: () => reorderGroupRaces(player, groupId, toThis) },
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
    sysMsg(player, "race", "组内赛道不足，无法重排", "plain");
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
    sysMsg(player, "race", dir.listItem === 0 ? "已是第一条赛道" : "已是最后一条赛道", "error");
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
  sysMsg(
    player,
    "race",
    `赛道「${entry.race.name}」已${dir.listItem === 0 ? "上移" : "下移"}`,
    "success",
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
  sysMsg(player, "race", `分组「${name}」已创建`, "success");
  return back?.();
}

async function addRaceToGroup(player: Player, groupId: string, back?: MenuBack): Promise<void> {
  const races = await prisma.race.findMany({
    where: { isEnabled: true, deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (races.length === 0) {
    sysMsg(player, "race", "暂无赛道可添加", "plain");
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
    sysMsg(player, "race", `赛道「${race.name}」已在分组中`, "error");
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
    sysMsg(player, "race", `已添加赛道「${race.name}」`, "success");
  } catch (e) {
    logger.error(`[race] 添加赛道到分组失败`, e);
    sysMsg(player, "race", "添加失败", "error");
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
    sysMsg(player, "race", "分组内没有赛道", "plain");
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
  sysMsg(player, "race", `已移除赛道「${entry.race.name}」`, "success");
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
  sysMsg(player, "race", "分组名已更新", "success");
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
  sysMsg(player, "race", "分组已删除", "success");
  return back?.();
}

/** OP 管理赛道（分页） */
async function adminRaceFlow(player: Player, back?: MenuBack): Promise<void> {
  // 纵深防御：面板 visible 过滤外，入口再复查一次（对齐 house-admin 先例）
  if (!isSuperAdmin(player)) {
    sysMsg(player, "race", "只有管理员能管理赛道", "warn");
    return back?.();
  }
  const races = await prisma.race.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (races.length === 0) {
    sysMsg(player, "race", "暂无赛道", "plain");
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
