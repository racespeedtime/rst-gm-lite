import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { swapSortIndex, compactSortIndex, nextSortIndex } from "@/utils/sort";
import { showDialog } from "@/utils/dialog";
import { spawnRaceVehicleAt, getDefaultRaceModel } from "./vehicle";

import { COLOR_RACE, COLOR_ERROR, COLOR_SUCCESS } from "@/utils/colors";

/** 编辑中的赛道（raceId + 玩家当前查看的 CP） */
interface EditState {
  raceId: string;
  cpIndex: number; // 当前聚焦的 CP 下标
}

const editStates = new Map<number, EditState>();

export function isEditing(playerId: number): boolean {
  return editStates.has(playerId);
}

export function exitEdit(playerId: number): void {
  editStates.delete(playerId);
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
    player.sendClientMessage(COLOR_ERROR, "你无权编辑该赛道");
    return;
  }
  try {
    const cps = await prisma.raceCp.findMany({
      where: { raceId },
      orderBy: { index: "asc" },
      include: { raceCpScripts: { orderBy: { index: "asc" } } },
    });
    // 先查库成功再登记状态，避免 DB 异常后残留编辑态
    editStates.set(player.id, { raceId, cpIndex: cps.length > 0 ? 0 : -1 });
    // 编辑/测试用车：刷出默认比赛车（首个 CP 有 cveh 换车用其车型，否则 411）并放入车内
    const model = getDefaultRaceModel(
      cps.map((c) => ({ scripts: c.raceCpScripts.map((s) => s.script) })),
    );
    if (cps.length > 0) {
      // 已有 CP：车放到第一个 CP（起点），玩家上车
      spawnRaceVehicleAt(
        player,
        model,
        Number(cps[0].x),
        Number(cps[0].y),
        Number(cps[0].z),
        Number(cps[0].angle),
      );
      player.sendClientMessage(COLOR_RACE, "已刷出测试车辆并传送到赛道起点");
    } else {
      // 新赛道还没有 CP：在当前位置发车，放置第一个 CP 后可从起点测试
      const pos = player.getPos();
      spawnRaceVehicleAt(player, model, pos.x, pos.y, pos.z, player.getFacingAngle().angle);
      player.sendClientMessage(COLOR_RACE, "已刷出测试车辆，放置第一个 CP 后可测试赛道");
    }
  } catch (e) {
    logger.error(`[race] 进入编辑模式失败 ${raceId}`, e);
    player.sendClientMessage(COLOR_ERROR, "进入编辑模式失败，请稍后重试");
    return;
  }
  player.sendClientMessage(COLOR_RACE, "已进入赛道编辑模式，打开对话框操作");
  await showEditMenu(player);
}

/** 编辑主菜单 */
async function showEditMenu(player: Player): Promise<void> {
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
    "5. 测试赛道（从第一个CP开始）",
    "6. 保存并退出编辑",
    "7. 退出编辑（不保存修改）",
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
  if (!res || res.response !== 1) {
    exitEdit(player.id);
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
      await testRace(player);
      break;
    case 5:
      player.sendClientMessage(COLOR_SUCCESS, "赛道已保存，退出编辑模式");
      exitEdit(player.id);
      break;
    case 6:
      exitEdit(player.id);
      player.sendClientMessage(COLOR_RACE, "已退出编辑模式");
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
    player.sendClientMessage(COLOR_ERROR, "圈数需为 1-99 的整数");
    return;
  }
  await prisma.race.update({ where: { id: race.id }, data: { laps } });
  player.sendClientMessage(COLOR_SUCCESS, `圈数已设为 ${laps}`);
}

/** 在玩家当前位置放置 CP */
async function addCp(player: Player): Promise<void> {
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
      data: { raceId: state.raceId, index, x: pos.x, y: pos.y, z: pos.z, angle, size: 8 },
    });
    await recalcRaceLength(state.raceId);
    player.sendClientMessage(COLOR_SUCCESS, `CP${index + 1} 已放置`);
  } catch (e) {
    logger.error(`[race] 放置CP失败`, e);
    player.sendClientMessage(COLOR_ERROR, "放置失败");
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
    player.sendClientMessage(COLOR_ERROR, "还没有CP，先放置一个");
    await showEditMenu(player);
    return;
  }
  const options = cps.map(
    (c) =>
      `CP${c.index + 1}（${Number(c.x).toFixed(1)}, ${Number(c.y).toFixed(1)}, ${Number(c.z).toFixed(1)}）`,
  );
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "CP列表",
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
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
    player.sendClientMessage(COLOR_ERROR, res.listItem === 0 ? "已是第一个CP" : "已是最后一个CP");
    await cpDetailMenu(player);
    return;
  }
  await swapSortIndex(cps[idx], target, (id, index) =>
    prisma.raceCp.update({ where: { id }, data: { index } }),
  );
  await recalcRaceLength(state.raceId);
  state.cpIndex = target.index; // 当前聚焦的 CP 跟随移动
  player.sendClientMessage(
    COLOR_SUCCESS,
    `CP${state.cpIndex + 1} 顺序已${res.listItem === 0 ? "前移" : "后移"}`,
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
  player.sendClientMessage(COLOR_SUCCESS, "CP 已移动");
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
  player.sendClientMessage(COLOR_SUCCESS, "CP 已删除");
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
        size: 8,
      },
    });
    await recalcRaceLength(raceId, tx);
  });
  player.sendClientMessage(COLOR_SUCCESS, "已插入新 CP");
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
  if (!Number.isFinite(size) || size <= 0) {
    player.sendClientMessage(COLOR_ERROR, "尺寸需为正数");
    return;
  }
  await prisma.raceCp.update({ where: { id: cp.id }, data: { size } });
  player.sendClientMessage(COLOR_SUCCESS, `CP 尺寸已设为 ${size}`);
}

/** CP 脚本管理：查看/添加/上移下移/删除（脚本按 index 顺序执行，支持重排） */
async function cpScriptMenu(player: Player, cp: { id: string }): Promise<void> {
  const scripts = await prisma.raceCpScript.findMany({ where: { checkpointId: cp.id } });
  const options = ["添加脚本"];
  for (let i = 0; i < scripts.length; i++) {
    options.push(`${i + 1}号: ${scripts[i].script}`);
    options.push(`↕ 上移/下移 ${i + 1}号`);
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
      player.sendClientMessage(COLOR_SUCCESS, "脚本已添加");
    } catch (e) {
      logger.error(`[race] 添加脚本失败`, e);
      player.sendClientMessage(COLOR_ERROR, "添加失败");
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
    player.sendClientMessage(COLOR_SUCCESS, "脚本已删除");
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
    player.sendClientMessage(
      COLOR_ERROR,
      res.listItem === 0 ? "已是第一条脚本" : "已是最后一条脚本",
    );
    await cpScriptMenu(player, cp);
    return;
  }
  await swapSortIndex(target, neighbor, (id, index) =>
    prisma.raceCpScript.update({ where: { id }, data: { index } }),
  );
  player.sendClientMessage(COLOR_SUCCESS, `脚本已${res.listItem === 0 ? "上移" : "下移"}`);
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
    player.sendClientMessage(COLOR_ERROR, "名称不能为空");
    return;
  }
  await prisma.race.update({ where: { id: race.id }, data: { name } });
  player.sendClientMessage(COLOR_SUCCESS, "赛道名称已更新");
}

/** 测试赛道：刷出默认比赛车（首个 CP 有 cveh 换车用其车型，否则 411）放到第一个 CP 起点 */
async function testRace(player: Player): Promise<void> {
  const state = editStates.get(player.id);
  if (!state) return;
  const first = await prisma.raceCp.findFirst({
    where: { raceId: state.raceId },
    orderBy: { index: "asc" },
  });
  if (!first) {
    player.sendClientMessage(COLOR_ERROR, "赛道还没有CP");
    return;
  }
  const cps = await prisma.raceCp.findMany({
    where: { raceId: state.raceId },
    orderBy: { index: "asc" },
    include: { raceCpScripts: { orderBy: { index: "asc" } } },
  });
  spawnRaceVehicleAt(
    player,
    getDefaultRaceModel(cps.map((c) => ({ scripts: c.raceCpScripts.map((s) => s.script) }))),
    Number(first.x),
    Number(first.y),
    Number(first.z),
    Number(first.angle),
  );
  player.sendClientMessage(COLOR_RACE, "已刷出测试车辆并传送到赛道起点（测试模式）");
}

/** 初始化编辑命令 */
export function initRaceEditor(): void {
  PlayerEvent.onCommandText("redit", async ({ player, subcommand, next }) => {
    const raceId = subcommand[0];
    if (!raceId) {
      player.sendClientMessage(COLOR_RACE, "用法: /redit 赛道ID");
      return next();
    }
    await enterRaceEdit(player, raceId);
    return next();
  });
  PlayerEvent.onCommandText("redit quit", ({ player, next }) => {
    exitEdit(player.id);
    player.sendClientMessage(COLOR_RACE, "已退出编辑模式");
    return next();
  });
}
