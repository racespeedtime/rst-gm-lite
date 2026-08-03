import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import { isSuperAdmin } from "@/admin/op";
import { deleteRecordingFile } from "./storage";
import { spawnReplay, controlReplay, getReplaySession } from "./playback";
import { startRecording, stopRecording, isRecording } from "./recorder";
import { isInChallenge } from "./challenge";
import { isInRace } from "@/race/room";
import type { MenuBack } from "@/core/panel";
import { COLOR_ERROR, COLOR_SUCCESS } from "@/utils/colors";

/** 时长格式化（mm:ss 或 ss） */
function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 类型标签 */
function typeLabel(t: string): string {
  return t === "race" ? "比赛" : "自定义";
}

/** 二次确认删除（本人）：MSGBOX 确认 + INPUT 输入文件名二次验证（复用删除赛道模式） */
async function confirmDeleteReplay(player: Player, replayId: string, fileName: string, back?: MenuBack): Promise<void> {
  const c = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "删除回放",
      info: `确定删除该回放吗？\n录像文件 ${fileName} 将一并删除，不可恢复！`,
      button1: "确认删除",
      button2: "取消",
    }),
  );
  if (!c) return;
  if (c.response !== 1) return back?.();
  const v = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "二次验证",
      info: `输入回放文件名「${fileName}」确认删除：`,
      button1: "确认",
      button2: "取消",
    }),
  );
  if (!v || v.response !== 1 || v.inputText.trim() !== fileName) {
    player.sendClientMessage(COLOR_ERROR, "删除已取消（文件名不匹配）");
    return back?.();
  }
  await prisma.replay.update({ where: { id: replayId }, data: { deletedAt: new Date() } });
  deleteRecordingFile(fileName);
  player.sendClientMessage(COLOR_SUCCESS, "回放已删除");
  return back?.();
}

/** 打开"我的录制"（分页列表 → 观看/分身挑战/删除） */
export async function openReplayMenu(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return back?.();
  const list = await prisma.replay.findMany({
    where: { userId: auth.userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (list.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "你还没有回放记录（/rec start 开始录制）");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: `我的录制（${list.length}）`,
    data: list,
    headers: ["类型", "赛道", "时长", "时间"],
    format: (v) => [
      typeLabel(v.type),
      v.raceName || "—",
      fmtDur(v.durationMs),
      v.createdAt.toLocaleString("zh-CN", { hour12: false }).slice(5, 16),
    ],
    button1: "操作",
    button2: "取消",
  });
  if (!r) return back?.();
  const replay = r.item;
  // 操作选择：观看 / 分身挑战 / 删除
  const op = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "回放操作",
      info: "1. 观看（1 台车）\n2. 分身挑战（3 台车错峰同跑）\n3. 删除",
      button1: "执行",
      button2: "取消",
    }),
  );
  if (!op) return back?.();
  if (op.response !== 1) return back?.();
  if (op.listItem === 0) {
    await spawnReplay(player, replay.id, { npcCount: 1 });
    return back?.();
  }
  if (op.listItem === 1) {
    await spawnReplay(player, replay.id, { npcCount: 3 });
    return back?.();
  }
  if (op.listItem === 2) {
    await confirmDeleteReplay(player, replay.id, replay.fileName, () => openReplayMenu(player, back));
  }
}

/** OP：全部回放管理（列出含录者，可删除任意回放） */
export async function openOpReplayPanel(player: Player, back?: MenuBack): Promise<void> {
  if (!isSuperAdmin(player)) {
    player.sendClientMessage(COLOR_ERROR, "你没有执行此操作的权限");
    return back?.();
  }
  const list = await prisma.replay.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (list.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "暂无回放记录");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: `全部回放（${list.length}）`,
    data: list,
    headers: ["录者", "类型", "赛道", "时长", "时间"],
    format: (v) => [
      v.recorderName,
      typeLabel(v.type),
      v.raceName || "—",
      fmtDur(v.durationMs),
      v.createdAt.toLocaleString("zh-CN", { hour12: false }).slice(5, 16),
    ],
    button1: "删除",
    button2: "取消",
  });
  if (!r) return back?.();
  await confirmDeleteReplay(player, r.item.id, r.item.fileName, () => openOpReplayPanel(player, back));
}

/** 万能面板"回放"分组菜单（开始/停止录制 + 我的录制 + 回放控制） */
export async function openReplayMenuPanel(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "回放",
      info: [
        "1. 我的录制（观看 / 分身挑战 / 删除）",
        `2. ${isRecording(player.id) ? "停止录制（落盘）" : "开始录制（当前行驶）"}`,
        "3. 回放控制（播放 / 暂停 / 快进 / 后退 / 倍速 / 跳转 / 停止）",
      ].join("\n"),
      button1: "执行",
      button2: "关闭",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  if (res.listItem === 0) {
    await openReplayMenu(player, () => openReplayMenuPanel(player, back));
  } else if (res.listItem === 1) {
    if (isRecording(player.id)) {
      await stopRecording(player.id);
    } else if (isInRace(player.id)) {
      // 比赛中由比赛系统自动录制（race 类型），手动开始会与自动录制抢会话
      player.sendClientMessage(COLOR_ERROR, "比赛中已自动录制（结束自动保存），无需手动开始");
    } else if (isInChallenge(player.id) || getReplaySession(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "影子挑战/回放中不能录制");
    } else {
      await startRecording(player, { type: "ghost" });
    }
    return back?.();
  } else if (res.listItem === 2) {
    await openReplayControlMenu(player, () => openReplayMenuPanel(player, back));
  }
}

/** 回放控制菜单（播放/暂停/快进/后退/倍速/跳转/停止） */
export async function openReplayControlMenu(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "回放控制",
      info: [
        "1. 播放 / 继续",
        "2. 暂停",
        "3. 快进 ×2",
        "4. 后退 ×2",
        "5. 倍速（0.5 / 1 / 2 / 4）",
        "6. 跳转时间（秒）",
        "7. 观看视角",
        "8. 停止回放",
      ].join("\n"),
      button1: "执行",
      button2: "关闭",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const session = getReplaySession(player.id);
  if (!session && res.listItem !== 7) {
    player.sendClientMessage(COLOR_ERROR, "你不在播放回放中，先在「我的录制」选择播放");
    return back?.();
  }
  switch (res.listItem) {
    case 0:
      controlReplay(player, "play");
      return back?.();
    case 1:
      controlReplay(player, "pause");
      return back?.();
    case 2:
      controlReplay(player, "forward", "2");
      return back?.();
    case 3:
      controlReplay(player, "back", "2");
      return back?.();
    case 4: {
      const sp = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.INPUT,
          caption: "倍速",
          info: "输入倍速（0.5 / 1 / 2 / 4）：",
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!sp || sp.response !== 1) return back?.();
      controlReplay(player, "speed", sp.inputText.trim());
      return back?.();
    }
    case 5: {
      const t = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.INPUT,
          caption: "跳转时间",
          info: "输入时间（秒或 mm:ss）：",
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!t || t.response !== 1) return back?.();
      controlReplay(player, "seek", t.inputText.trim());
      return back?.();
    }
    case 6:
      controlReplay(player, "watch");
      return back?.();
    case 7:
      controlReplay(player, "stop");
      return back?.();
  }
  return back?.();
}
