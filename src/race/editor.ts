import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { swapSortIndex, compactSortIndex, nextSortIndex } from "@/utils/sort";
import { showDialog } from "@/utils/dialog";
import { spawnRaceVehicleAt, getDefaultRaceModel, getFirstCpStartAngle } from "./vehicle";
import { cleanupScriptVehicle } from "./scripts";
import { isInRace } from "./state";
import { UUID_RE } from "./state";
import { sysMsg } from "@/utils/msg";
import {
  parseLevelData,
  formatLevelData,
  formatLevelSummary,
  isTierSet,
  validateTierOrder,
  TIER_LABELS,
} from "./level";

/** 编辑中的赛道（raceId + 玩家当前查看的 CP） */
interface EditState {
  raceId: string;
  cpIndex: number; // 当前聚焦的 CP 下标
  cpSize: number; // 新放置 CP 的默认尺寸（/r edit cpsize 设置，对齐原版 EditRace rcpsize）
}

const editStates = new Map<number, EditState>();

export function isEditing(playerId: number): boolean {
  return editStates.has(playerId);
}

/** 当前编辑中的 CP 放置尺寸（/r edit cpsize 读写） */
export function getEditCpSize(playerId: number): number {
  return editStates.get(playerId)?.cpSize ?? 8;
}

/** 设置新放置 CP 的默认尺寸（/r edit cpsize [值]） */
export function setEditCpSize(playerId: number, size: number): void {
  const st = editStates.get(playerId);
  if (st) st.cpSize = size;
}

export function exitEdit(playerId: number): void {
  editStates.delete(playerId);
  // 清理编辑/测试用车（scriptVehicles）：防测试车留在世界成为幽灵车。
  // 进编辑时 destroyPlayerVehicle 已销毁玩家爱车，退出后玩家需重新刷车
  cleanupScriptVehicle(playerId);
}

/** 计算赛道总长度（相邻 CP 欧氏距离累加）；支持传入事务客户端 */
export async function recalcRaceLength(
  raceId: string,
  client: {
    raceCp: { findMany: typeof prisma.raceCp.findMany };
    race: { update: typeof prisma.race.update };
  } = prisma,
): Promise<void> {
  const cps = await client.raceCp.findMany({
    where: { raceId },
    orderBy: { index: "asc" },
  });
  let total = 0;
  for (let i = 0; i < cps.length - 1; i++) {
    const dx = Number(cps[i].x) - Number(cps[i + 1].x);
    const dy = Number(cps[i].y) - Number(cps[i + 1].y);
    const dz = Number(cps[i].z) - Number(cps[i + 1].z);
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  await client.race.update({ where: { id: raceId }, data: { totalLength: total } });
}

/** 校验玩家可编辑赛道（作者本人或 OP） */
export async function canEditRace(player: Player, raceId: string): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) return false;
  if (isSuperAdmin(player)) return true;
  const race = await prisma.race.findUnique({ where: { id: raceId } });
  return race?.userId === auth.userId;
}

/** 进入赛道编辑模式 */
export async function enterRaceEdit(player: Player, raceId: string): Promise<void> {
  if (!(await canEditRace(player, raceId))) {
    sysMsg(player, "race", "你无权编辑该赛道", "error");
    return;
  }
  // 比赛中禁止进编辑：编辑会销毁比赛车（destroyPlayerVehicle）并置 isEditing，
  // 比赛 CP 计数随即失效、成员被拖离比赛——/r info 详情面板的编辑入口可达此路径
  if (isInRace(player.id)) {
    sysMsg(player, "race", "比赛中不能进入赛道编辑，先 /r l 离开", "warn");
    return;
  }
  // 防重复进入泄漏测试车：连续 /r edit A /r edit B 时上一辆测试车不销毁会成
  // 世界幽灵车（进编辑时 destroyPlayerVehicle 已销毁爱车，旧车无主）
  cleanupScriptVehicle(player.id);
  try {
    const cps = await prisma.raceCp.findMany({
      where: { raceId },
      orderBy: { index: "asc" },
      include: { raceCpScripts: { orderBy: { index: "asc" } } },
    });
    // 先查库成功再登记状态，避免 DB 异常后残留编辑态；cpSize 默认 8（对齐原版
    // EditRace rcpsize 初始 8，放置的 CP 用此尺寸）
    editStates.set(player.id, { raceId, cpIndex: cps.length > 0 ? 0 : -1, cpSize: 8 });
    // 编辑/测试用车：刷出默认比赛车（首个 CP 有 cveh 换车用其车型，否则 411）并放入车内
    const model = getDefaultRaceModel(
      cps.map((c) => ({ scripts: c.raceCpScripts.map((s) => s.script) })),
    );
    if (cps.length > 0) {
      // 已有 CP：车放到第一个 CP（起点），玩家上车。起点朝向用 CP1→CP2 走向校正
      //（作者放置时 getFacingAngle 可能滞后/放歪，见 getFirstCpStartAngle）
      const startAngle = getFirstCpStartAngle(
        cps.map((c) => ({ x: Number(c.x), y: Number(c.y), angle: Number(c.angle) })),
      );
      spawnRaceVehicleAt(
        player,
        model,
        Number(cps[0].x),
        Number(cps[0].y),
        Number(cps[0].z),
        startAngle.angle,
      );
      if (startAngle.corrected) {
        sysMsg(
          player,
          "race",
          `起点朝向与赛道走向不符，已按走向校正车头（${Number(cps[0].angle).toFixed(0)}° → ${startAngle.angle.toFixed(0)}°）`,
          "warn",
        );
      }
      sysMsg(player, "race", "已刷出测试车辆并传送到赛道起点", "info");
    } else {
      // 新赛道还没有 CP：在当前位置发车，放置第一个 CP 后可从起点测试
      const pos = player.getPos();
      spawnRaceVehicleAt(player, model, pos.x, pos.y, pos.z, player.getFacingAngle().angle);
      sysMsg(player, "race", "已刷出测试车辆，放置第一个 CP 后可测试赛道", "info");
    }
  } catch (e) {
    logger.error(`[race] 进入编辑模式失败 ${raceId}`, e);
    sysMsg(player, "race", "进入编辑模式失败，请稍后重试", "error");
    return;
  }
  sysMsg(player, "race", "已进入赛道编辑模式，打开对话框操作", "info");
  await showEditMenu(player);
}

/** 编辑主菜单（/r edit d 命令入口也调它） */
export async function showEditMenu(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const cps = await prisma.raceCp.findMany({
    where: { raceId: state.raceId },
    orderBy: { index: "asc" },
  });
  const info = [
    "1. 在当前位置放置CP",
    "2. 查看/管理CP",
    "3. 修改赛道名称/描述",
    "4. 设置圈数",
    "5. 设置挑战等级",
    "6. 测试赛道（从第一个CP开始）",
    "7. 保存并退出编辑",
    "8. 退出编辑（不保存修改）",
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `编辑赛道（${cps.length} 个CP）`,
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) {
    // 取消：保留编辑态（对齐全局 MenuBack 惯例——取消返回上一层，
    // 不退出编辑；误触取消不丢编辑进度）。提示如何主动退出
    sysMsg(player, "race", "编辑模式保持，选「退出编辑」或 /redit quit 退出", "info");
    await showEditMenu(player);
    return;
  }
  switch (res.listItem) {
    case 0:
      await addCp(player);
      await showEditMenu(player);
      break;
    case 1:
      await cpListMenu(player);
      break;
    case 2:
      await editRaceInfo(player);
      await showEditMenu(player);
      break;
    case 3:
      await editRaceLaps(player);
      await showEditMenu(player);
      break;
    case 4:
      await editRaceLevels(player);
      await showEditMenu(player);
      break;
    case 5:
      await testRace(player);
      break;
    case 6:
      sysMsg(player, "race", "赛道已保存，退出编辑模式", "success");
      exitEdit(player.id);
      break;
    case 7:
      exitEdit(player.id);
      sysMsg(player, "race", "已退出编辑模式", "info");
      break;
  }
}

/** 设置赛道圈数（1-99，默认 1） */
async function editRaceLaps(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const race = await prisma.race.findUnique({ where: { id: state.raceId } });
  if (!race) return;
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "设置圈数",
      info: `输入圈数（1-99，当前：${race.laps ?? 1}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const laps = Number(res.inputText.trim());
  if (!Number.isInteger(laps) || laps < 1 || laps > 99) {
    sysMsg(player, "race", "圈数需为 1-99 的整数", "error");
    return;
  }
  await prisma.race.update({ where: { id: race.id }, data: { laps } });
  sysMsg(player, "race", `圈数已设为 ${laps}`, "success");
}

/**
 * 设置挑战等级（逐级编辑）：5 个等级各显示当前秒数/分数，选中一个 → 输入
 * "秒数 分数"（如 `350 10`）保存。另含"失败扣分"与"清除等级"两项。
 * 未设置等级（levelData 为 null）→ 空档显示"未设置"。
 */
async function editRaceLevels(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const race = await prisma.race.findUnique({ where: { id: state.raceId } });
  if (!race) return;
  const tiers = parseLevelData(race.levelData);
  const summary = formatLevelSummary(tiers);
  const penalty = race.failedScoreFix;

  // 行：5 个等级（神→渣）+ 失败扣分 + 清除等级
  const lines: { label: string; desc: string }[] = [];
  for (let i = TIER_LABELS.length - 1; i >= 0; i--) {
    const t = tiers?.[i];
    const desc = t && isTierSet(t) ? `${Math.round(t.seconds)}秒 / ${t.score}分` : "未设置";
    lines.push({ label: TIER_LABELS[i], desc });
  }
  lines.push({ label: "失败扣分", desc: penalty !== 0 ? `${penalty} 分` : "0（不扣分）" });
  lines.push({ label: "清除等级", desc: "" });

  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "设置挑战等级",
      info: [
        summary ? `当前: ${summary}` : "当前: 未设置等级",
        "选择要编辑的项：",
        ...lines.map((l, i) => `${i + 1}. ${l.label}（${l.desc}）`),
      ].join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  // info 前 2 行为 header（当前摘要/选择提示），listItem 是渲染行号需偏移
  const idx = res.listItem - 2;
  if (idx < 0 || idx >= lines.length) return;

  // 清除等级（破坏性操作：清空 levelData + failedScoreFix，二次确认防误触）
  if (idx === 6) {
    const confirm = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.MSGBOX,
        caption: "清除挑战等级",
        info: "确定清除该赛道的全部挑战等级与失败扣分吗？\n清除后赛道将无等级限制（需重新逐级设置）。",
        button1: "确认清除",
        button2: "取消",
      }),
    );
    if (!confirm || confirm.response !== 1) {
      sysMsg(player, "race", "已取消清除", "info");
      return;
    }
    await prisma.race.update({
      where: { id: race.id },
      data: { levelData: null, failedScoreFix: 0 },
    });
    sysMsg(player, "race", "已清除挑战等级", "success");
    return;
  }

  // 失败扣分（整数，0=不扣分，范围 -999..999）
  if (idx === 5) {
    const input = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "失败扣分",
        info: `输入失败扣分（整数，当前 ${penalty}，0=不扣分）：\n超时未完成者完成时展示的扣分数，纯展示不扣真实分数`,
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!input || input.response !== 1) return;
    const v = Number(input.inputText.trim());
    if (!Number.isInteger(v) || v < -999 || v > 999) {
      sysMsg(player, "race", "失败扣分需为 -999~999 的整数", "error");
      return;
    }
    await prisma.race.update({ where: { id: race.id }, data: { failedScoreFix: v } });
    sysMsg(player, "race", `失败扣分已设为 ${v}`, "success");
    return;
  }

  // 逐级编辑：idx 0..4 对应 神鬼人菜渣（列表按 神→渣，idx0=神）
  const tierIdx = 4 - idx; // 神(idx0)=tier4 … 渣(idx4)=tier0
  const tier = tiers?.[tierIdx];
  const curDesc =
    tier && isTierSet(tier) ? `${Math.round(tier.seconds)}秒 / ${tier.score}分` : "未设置";
  const input = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: `设置「${TIER_LABELS[tierIdx]}」等级`,
      info: `输入「秒数 分数」（如 350 10），当前：${curDesc}。\n用时不超过该秒数即达到此等级。`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!input || input.response !== 1) return;
  const parts = input.inputText.trim().split(/\s+/);
  if (parts.length < 2) {
    sysMsg(player, "race", "格式：秒数 分数（如 350 10）", "error");
    return;
  }
  const sec = Number(parts[0]);
  const score = Number(parts[1]);
  // score 必须 >0：isTierSet 要求 score>0 才算有效档，score=0 会静默"存了但忽略"
  if (!Number.isInteger(sec) || !Number.isInteger(score) || sec <= 0 || score <= 0) {
    sysMsg(player, "race", "秒数与分数均为正整数", "error");
    return;
  }
  // 当前等级数据（未设置 → 全 0），更新目标档
  const cur = tiers
    ? tiers.map((t) => ({ seconds: t.seconds, score: t.score }))
    : Array.from({ length: 5 }, () => ({ seconds: 0, score: 0 }));
  cur[tierIdx] = { seconds: sec, score };
  // 顺序校验：已设置档秒数必须严格递增（渣<菜<人<鬼<神），乱配会让等级判定崩坏
  const orderErr = validateTierOrder(cur);
  if (orderErr) {
    sysMsg(player, "race", `等级顺序冲突：${orderErr}`, "error");
    return;
  }
  await prisma.race.update({
    where: { id: race.id },
    data: { levelData: formatLevelData(cur) },
  });
  sysMsg(player, "race", `「${TIER_LABELS[tierIdx]}」已设为 ${sec}秒/${score}分`, "success");
}

/** 在玩家当前位置放置 CP（/r edit cp 命令入口也调它） */
export async function addCp(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const pos = player.getPos();
  const angle = player.getFacingAngle().angle;
  try {
    const last = await prisma.raceCp.findFirst({
      where: { raceId: state.raceId },
      orderBy: { index: "desc" },
    });
    const index = last ? last.index + 1 : 0;
    await prisma.raceCp.create({
      data: {
        raceId: state.raceId,
        index,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        angle,
        size: state.cpSize,
      },
    });
    await recalcRaceLength(state.raceId);
    sysMsg(player, "race", `CP${index + 1} 已放置`, "success");
  } catch (e) {
    logger.error(`[race] 放置CP失败`, e);
    sysMsg(player, "race", "放置失败", "error");
  }
}

/** CP 列表管理 */
async function cpListMenu(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const cps = await prisma.raceCp.findMany({
    where: { raceId: state.raceId },
    orderBy: { index: "asc" },
  });
  if (cps.length === 0) {
    sysMsg(player, "race", "还没有CP，先放置一个", "error");
    await showEditMenu(player);
    return;
  }
  // TABLIST_HEADERS 多列：CP序号 / 坐标X / Y / Z / 尺寸（表头不占行号）
  const info = [
    "{FFD700}CP\tX\tY\tZ\t尺寸",
    ...cps.map(
      (c) =>
        `CP${c.index + 1}\t${Number(c.x).toFixed(1)}\t${Number(c.y).toFixed(1)}\t${Number(c.z).toFixed(1)}\t${Number(c.size).toFixed(1)}`,
    ),
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.TABLIST_HEADERS,
      caption: "CP列表",
      info,
      button1: "管理",
      button2: "返回",
    }),
  );
  if (!res) return;
  if (res.response !== 1) {
    await showEditMenu(player);
    return;
  }
  state.cpIndex = cps[res.listItem].index;
  await cpDetailMenu(player);
}

/** 单个 CP 管理：移动/删除/插入/脚本/尺寸 */
async function cpDetailMenu(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const cp = await prisma.raceCp.findUnique({
    where: { raceId_index: { raceId: state.raceId, index: state.cpIndex } },
  });
  if (!cp) {
    await cpListMenu(player);
    return;
  }
  const scripts = await prisma.raceCpScript.findMany({ where: { checkpointId: cp.id } });
  const info = [
    `CP${state.cpIndex + 1}（共${scripts.length}条脚本）`,
    "1. 移动到当前位置",
    "2. 删除此CP",
    "3. 在此CP后插入CP",
    "4. 修改尺寸",
    "5. 管理脚本",
    "6. 与此CP交换顺序",
    "7. 返回CP列表",
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "CP 管理",
      info,
      button1: "确定",
      button2: "返回",
    }),
  );
  if (!res) return;
  if (res.response !== 1) {
    await cpListMenu(player);
    return;
  }
  switch (res.listItem) {
    case 0:
      await moveCp(player, cp);
      await cpDetailMenu(player);
      break;
    case 1:
      // 删除 CP 二次确认（连带删除脚本，防误触）
      {
        const confirm = await showDialog(
          player,
          new Dialog({
            style: DialogStylesEnum.MSGBOX,
            caption: "删除CP",
            info: `确定删除 CP${cp.index + 1} 吗？\n该 CP 上的脚本将一并删除！`,
            button1: "确认删除",
            button2: "取消",
          }),
        );
        if (confirm && confirm.response === 1) {
          await deleteCp(player, cp);
          await cpListMenu(player);
          return;
        }
        await cpDetailMenu(player);
      }
      break;
    case 2:
      await insertCp(player, cp);
      await cpListMenu(player);
      break;
    case 3:
      await editCpSize(player, cp);
      await cpDetailMenu(player);
      break;
    case 4:
      await cpScriptMenu(player, cp);
      break;
    case 5:
      await reorderCp(player);
      break;
    case 6:
      await cpListMenu(player);
      break;
  }
}

/** 交换当前 CP 与相邻 CP 的顺序（上移/下移），改 index + 重算赛道长度 */
async function reorderCp(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const cps = await prisma.raceCp.findMany({
    where: { raceId: state.raceId },
    orderBy: { index: "asc" },
  });
  const idx = cps.findIndex((c) => c.index === state.cpIndex);
  if (idx < 0) return;
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `CP${state.cpIndex + 1} 排序`,
      info: `1. 与前一CP（CP${cps[idx - 1] ? cps[idx - 1].index + 1 : "—"}）交换\n2. 与后一CP（CP${cps[idx + 1] ? cps[idx + 1].index + 1 : "—"}）交换`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) {
    await cpDetailMenu(player);
    return;
  }
  const target = res.listItem === 0 ? cps[idx - 1] : cps[idx + 1];
  if (!target) {
    sysMsg(player, "race", res.listItem === 0 ? "已是第一个CP" : "已是最后一个CP", "error");
    await cpDetailMenu(player);
    return;
  }
  // G4：交换三步写包事务，防中途失败留下 index=-1 的临时行
  await prisma.$transaction(async (tx) => {
    await swapSortIndex(cps[idx], target, (id, index) =>
      tx.raceCp.update({ where: { id }, data: { index } }),
    );
  });
  await recalcRaceLength(state.raceId);
  state.cpIndex = target.index; // 当前聚焦的 CP 跟随移动
  sysMsg(
    player,
    "race",
    `CP${state.cpIndex + 1} 顺序已${res.listItem === 0 ? "前移" : "后移"}`,
    "success",
  );
  await cpDetailMenu(player);
}

/** 移动 CP 到玩家当前位置 */
async function moveCp(player: Player, cp: { id: string; raceId: string | null }): Promise<void> {
  const pos = player.getPos();
  await prisma.raceCp.update({
    where: { id: cp.id },
    data: { x: pos.x, y: pos.y, z: pos.z, angle: player.getFacingAngle().angle },
  });
  if (cp.raceId) await recalcRaceLength(cp.raceId);
  sysMsg(player, "race", "CP 已移动", "success");
}

/** 删除 CP（后续 index 前移）——事务内完成，中途失败整体回滚 */
async function deleteCp(
  player: Player,
  cp: { id: string; index: number; raceId: string | null },
): Promise<void> {
  const state = editStates.get(player.id);
  if (!state || !cp.raceId) return;
  const raceId: string = cp.raceId; // 闭包内捕获（TS 不在嵌套函数中保留参数窄化）
  await prisma.$transaction(async (tx) => {
    await tx.raceCpScript.deleteMany({ where: { checkpointId: cp.id } });
    await tx.raceCp.delete({ where: { id: cp.id } });
    await tx.raceCp.updateMany({
      where: { raceId, index: { gt: cp.index } },
      data: { index: { decrement: 1 } },
    });
    await recalcRaceLength(raceId, tx);
  });
  sysMsg(player, "race", "CP 已删除", "success");
}

/** 在指定 CP 后插入新 CP（后续 index 后移）——事务内完成，中途失败整体回滚 */
async function insertCp(
  player: Player,
  cp: { raceId: string | null; index: number },
): Promise<void> {
  const pos = player.getPos();
  const state = editStates.get(player.id);
  if (!state || !cp.raceId) return;
  const raceId: string = cp.raceId; // 闭包内捕获（TS 不在嵌套函数中保留参数窄化）
  await prisma.$transaction(async (tx) => {
    await tx.raceCp.updateMany({
      where: { raceId, index: { gt: cp.index } },
      data: { index: { increment: 1 } },
    });
    await tx.raceCp.create({
      data: {
        raceId,
        index: cp.index + 1,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        angle: player.getFacingAngle().angle,
        size: state.cpSize, // 与 addCp 同口径：用 /r edit cpsize 设置的默认尺寸
      },
    });
    await recalcRaceLength(raceId, tx);
  });
  sysMsg(player, "race", "已插入新 CP", "success");
}

/** 修改 CP 尺寸 */
async function editCpSize(player: Player, cp: { id: string }): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "修改CP尺寸",
      info: "输入检测半径（默认8）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const size = Number(res.inputText.trim());
  // 上限 100：防止超大检测半径（RaceCheckpoint 无法渲染、且影响判断）
  if (!Number.isFinite(size) || size <= 0 || size > 100) {
    sysMsg(player, "race", "尺寸需在 1-100 之间", "error");
    return;
  }
  await prisma.raceCp.update({ where: { id: cp.id }, data: { size } });
  sysMsg(player, "race", `CP 尺寸已设为 ${size}`, "success");
}

/** CP 脚本管理：查看/添加/上移下移/删除（脚本按 index 顺序执行，支持重排） */
async function cpScriptMenu(player: Player, cp: { id: string }): Promise<void> {
  const scripts = await prisma.raceCpScript.findMany({ where: { checkpointId: cp.id } });
  const options = ["添加脚本"];
  for (let i = 0; i < scripts.length; i++) {
    options.push(`${i + 1}号: ${scripts[i].script}`);
    options.push(`↑↓ 上移/下移 ${i + 1}号`);
  }
  options.push("返回");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "CP 脚本",
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "确定",
      button2: "返回",
    }),
  );
  if (!res || res.response !== 1) {
    const state = editStates.get(player.id);
    if (state) await cpDetailMenu(player);
    return;
  }
  const state = editStates.get(player.id);
  if (res.listItem === 0) {
    // 添加脚本
    const input = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "添加脚本",
        info: "输入脚本（如: msg 欢迎来到本赛道 / time 12 30 / speed | 0 | 120）：",
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!input || input.response !== 1) {
      if (state) await cpScriptMenu(player, cp);
      return;
    }
    const script = input.inputText.trim();
    if (!script) return;
    try {
      await prisma.raceCpScript.create({
        data: {
          checkpointId: cp.id,
          script,
          index: nextSortIndex(scripts),
          raceId: state!.raceId,
        },
      });
      sysMsg(player, "race", "脚本已添加", "success");
    } catch (e) {
      logger.error(`[race] 添加脚本失败`, e);
      sysMsg(player, "race", "添加失败", "error");
    }
    if (state) await cpScriptMenu(player, cp);
    return;
  }
  const target = scripts[(res.listItem - 1) >> 1];
  if (!target) {
    if (state) await cpScriptMenu(player, cp);
    return;
  }
  if (res.listItem % 2 === 0) {
    // 偶数项 = 重排入口
    await reorderScript(player, cp, scripts, target);
    return;
  }
  // 选中脚本本体 → 操作菜单（删除）
  const confirm = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "删除脚本",
      info: `确定删除脚本「${target.script}」吗？`,
      button1: "删除",
      button2: "取消",
    }),
  );
  if (confirm && confirm.response === 1) {
    await prisma.raceCpScript.delete({ where: { id: target.id } });
    // 删除后重排：该 CP 后续脚本 index 前移，防空洞
    const rest = scripts
      .filter((s) => s.id !== target.id)
      .map((s) => ({ id: s.id, index: s.index }));
    await compactSortIndex(rest, target.index, (id, index) =>
      prisma.raceCpScript.update({ where: { id }, data: { index } }),
    );
    sysMsg(player, "race", "脚本已删除", "success");
  }
  if (state) await cpScriptMenu(player, cp);
}

/** 脚本重排：上移/下移（与相邻脚本交换 index），完成后刷新脚本列表 */
async function reorderScript(
  player: Player,
  cp: { id: string },
  scripts: { id: string; index: number; script: string }[],
  target: { id: string; index: number },
): Promise<void> {
  const idx = scripts.findIndex((s) => s.id === target.id);
  if (idx < 0) return;
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `${idx + 1}号脚本 排序`,
      info: `1. 上移（与${idx > 0 ? `${idx}号` : "无"}交换）\n2. 下移（与${idx < scripts.length - 1 ? `${idx + 2}号` : "无"}交换）`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) {
    await cpScriptMenu(player, cp);
    return;
  }
  const neighbor = res.listItem === 0 ? scripts[idx - 1] : scripts[idx + 1];
  if (!neighbor) {
    sysMsg(player, "race", res.listItem === 0 ? "已是第一条脚本" : "已是最后一条脚本", "error");
    await cpScriptMenu(player, cp);
    return;
  }
  // G4：交换三步写包事务，防中途失败留下 index=-1 的临时行
  await prisma.$transaction(async (tx) => {
    await swapSortIndex(target, neighbor, (id, index) =>
      tx.raceCpScript.update({ where: { id }, data: { index } }),
    );
  });
  sysMsg(player, "race", `脚本已${res.listItem === 0 ? "上移" : "下移"}`, "success");
  await cpScriptMenu(player, cp);
}

/** 修改赛道名称/描述 */
async function editRaceInfo(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const race = await prisma.race.findUnique({ where: { id: state.raceId } });
  if (!race) return;
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "修改赛道信息",
      info: `输入新名称（当前：${race.name}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const name = res.inputText.trim();
  if (!name) {
    sysMsg(player, "race", "名称不能为空", "error");
    return;
  }
  await prisma.race.update({ where: { id: race.id }, data: { name } });
  sysMsg(player, "race", "赛道名称已更新", "success");
}

/** 测试赛道：刷出默认比赛车（首个 CP 有 cveh 换车用其车型，否则 411）放到第一个 CP 起点 */
async function testRace(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  // 清理上一次的测试车（scriptVehicles 登记会被覆盖但旧车不销毁 → 防每次测试泄漏一辆）
  cleanupScriptVehicle(player.id);
  const first = await prisma.raceCp.findFirst({
    where: { raceId: state.raceId },
    orderBy: { index: "asc" },
  });
  if (!first) {
    sysMsg(player, "race", "赛道还没有CP", "error");
    return;
  }
  const cps = await prisma.raceCp.findMany({
    where: { raceId: state.raceId },
    orderBy: { index: "asc" },
    include: { raceCpScripts: { orderBy: { index: "asc" } } },
  });
  // 起点朝向用 CP1→CP2 走向校正（作者放置时 getFacingAngle 可能滞后/放歪，
  // 见 getFirstCpStartAngle）
  const startAngle = getFirstCpStartAngle(
    cps.map((c) => ({ x: Number(c.x), y: Number(c.y), angle: Number(c.angle) })),
  );
  spawnRaceVehicleAt(
    player,
    getDefaultRaceModel(cps.map((c) => ({ scripts: c.raceCpScripts.map((s) => s.script) }))),
    Number(first.x),
    Number(first.y),
    Number(first.z),
    startAngle.angle,
  );
  if (startAngle.corrected) {
    sysMsg(
      player,
      "race",
      `起点朝向与赛道走向不符，已按走向校正车头（${Number(first.angle).toFixed(0)}° → ${startAngle.angle.toFixed(0)}°）`,
      "warn",
    );
  }
  sysMsg(player, "race", "已刷出测试车辆并传送到赛道起点（测试模式）", "info");
}

/** 初始化编辑命令 */
export function initRaceEditor(): void {
  PlayerEvent.onCommandText("redit", async ({ player, subcommand, next }) => {
    const raceId = subcommand[0];
    if (!raceId) {
      sysMsg(player, "race", "用法: /redit 赛道ID", "info");
      return next();
    }
    // id 是 uuid 列：非 uuid 输入直接查会让 PostgreSQL 抛类型错误
    if (!UUID_RE.test(raceId)) {
      sysMsg(player, "race", "赛道ID无效（需为 UUID 格式）", "error");
      return next();
    }
    await enterRaceEdit(player, raceId);
    return next();
  });
  PlayerEvent.onCommandText("redit quit", ({ player, next }) => {
    // 不在编辑模式：明确提示而不是假装退出成功（对齐 /r edit q 的守卫）
    if (!isEditing(player.id)) {
      sysMsg(player, "race", "你不在赛道编辑中，先 /r edit 赛道名 进入编辑", "warn");
      return next();
    }
    exitEdit(player.id);
    sysMsg(player, "race", "已退出编辑模式", "info");
    return next();
  });
}
