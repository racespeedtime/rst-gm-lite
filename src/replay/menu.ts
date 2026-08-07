import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import { isSuperAdmin } from "@/admin/op";
import { deleteRecordingFile } from "./storage";
import { spawnReplay, controlReplay, getReplaySession, REPLAY_SPEEDS } from "./playback";
import { startRecording, stopRecording, isRecording } from "./recorder";
import { isInChallenge, startChallengeWithReplay } from "./challenge";
import { isInRace } from "@/race/room";
import { formatDuration, formatShortDate } from "@/utils/format";
import type { MenuBack } from "@/core/panel";
import { COLOR_ERROR, COLOR_SUCCESS } from "@/utils/colors";

/** 时长/时间格式化收敛至 utils/format（formatDuration/formatShortDate） */

/** 类型标签 */
function typeLabel(t: string): string {
  return t === "race" ? "比赛" : "自定义";
}

/** 二次确认删除（本人）：MSGBOX 确认 + INPUT 输入文件名二次验证（复用删除赛道模式） */
async function confirmDeleteReplay(
  player: Player,
  replayId: string,
  fileName: string,
  back?: MenuBack,
): Promise<void> {
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

/** 打开"我的录制"（分页列表 → 观看/分身挑战/删除）。type 过滤比赛/自定义页签 */
export async function openReplayMenu(
  player: Player,
  back?: MenuBack,
  type?: "race" | "ghost",
): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return back?.();
  const list = await prisma.replay.findMany({
    where: { userId: auth.userId, deletedAt: null, ...(type ? { type } : {}) },
    orderBy: { createdAt: "desc" },
  });
  const caption =
    type === "race" ? "我的比赛回放" : type === "ghost" ? "我的自定义录制" : "我的录制";
  if (list.length === 0) {
    player.sendClientMessage(
      COLOR_ERROR,
      type === "race"
        ? "你还没有比赛回放（跑一场比赛后自动生成）"
        : type === "ghost"
          ? "你还没有自定义录制（/rec start 开始录制）"
          : "你还没有回放记录（/rec start 开始录制）",
    );
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: `${caption}（${list.length}）`,
    data: list,
    cacheKey: `replay:mine:${type ?? "all"}`, // 记忆上次翻到的页（翻列表找片，退出再进回到原页）
    headers: ["类型", "赛道", "名次", "时长", "时间"],
    format: (v) => [
      typeLabel(v.type),
      v.raceName || "—",
      v.type === "race" ? (v.rank != null ? `No.${v.rank}` : "{FF0000}未完成") : "—",
      formatDuration(v.durationMs),
      formatShortDate(v.createdAt),
    ],
    button1: "操作",
    button2: "取消",
  });
  if (!r) return back?.();
  // 我的录制：ghost（自定义）可删；race（比赛）为系统自动录制，用户不可删
  await openReplayActions(player, r.item, {
    back,
    deleteBack: () => openReplayMenu(player, back, type), // 删除后回到刷新后的列表
    allowDelete: r.item.type !== "race",
  });
}

/** 分身挑战流程：选数量（2-5 台）→ 选错峰间隔（秒，留空/0 = 自动均分全程） */
async function runGhostReplay(player: Player, replayId: string, back?: MenuBack): Promise<void> {
  const cnt = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "分身数量",
      info: "1. 2 台\n2. 3 台\n3. 4 台\n4. 5 台",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!cnt || cnt.response !== 1) return back?.();
  const n = cnt.listItem + 2; // 2..5
  const gap = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "错峰间隔",
      info: "分身起步间隔（秒，留空或 0 = 自动均分全程）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!gap || gap.response !== 1) return back?.();
  const sec = Number(gap.inputText.trim());
  const staggerMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : undefined;
  await spawnReplay(player, replayId, { npcCount: n, staggerMs });
  return back?.();
}

/** 回放操作菜单：观看 / 分身挑战 /（allowDelete 时）删除。我的录制、公开回放库、
 *  赛道详情回放列表、点击玩家"查看TA的回放"共用 */
export async function openReplayActions(
  player: Player,
  replay: { id: string; type: string; fileName: string; finished?: boolean | null },
  opts: { back?: MenuBack; deleteBack?: MenuBack; allowDelete: boolean },
): Promise<void> {
  const actions: { label: string; run: () => Promise<void> | void }[] = [
    { label: "观看（1 台车）", run: () => void spawnReplay(player, replay.id, { npcCount: 1 }) },
    {
      label: "分身挑战（2-5 台错峰同跑）",
      run: () => runGhostReplay(player, replay.id, opts.back),
    },
  ];
  // 影子挑战仅对已完成的比赛回放开放（未完成回放影子只跑已录部分，不完整）
  if (replay.type === "race" && replay.finished === true) {
    actions.push({
      label: "影子挑战（与录像者比一场）",
      run: () => void startChallengeWithReplay(player, replay.id),
    });
  }
  if (opts.allowDelete) {
    actions.push({
      label: "删除",
      run: () => confirmDeleteReplay(player, replay.id, replay.fileName, opts.deleteBack),
    });
  }
  const op = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "回放操作",
      info: actions.map((a, i) => `${i + 1}. ${a.label}`).join("\n"),
      button1: "执行",
      button2: "取消",
    }),
  );
  if (!op || op.response !== 1) return opts.back?.();
  const action = actions[op.listItem];
  if (action) await action.run();
}

/** 打开"全部比赛回放"（所有玩家的 race 录制，公开回看库；只可看，无删除权） */
export async function openPublicReplayMenu(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return back?.();
  const list = await prisma.replay.findMany({
    where: { type: "race", deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (list.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "暂无比赛回放（跑一场比赛后自动生成）");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: `全部比赛回放（${list.length}）`,
    data: list,
    cacheKey: "replay:public",
    headers: ["录者", "赛道", "名次", "时长", "时间"],
    format: (v) => [
      v.recorderName,
      v.raceName || "—",
      v.rank != null ? `No.${v.rank}` : "{FF0000}未完成",
      formatDuration(v.durationMs),
      formatShortDate(v.createdAt),
    ],
    button1: "操作",
    button2: "取消",
  });
  if (!r) return back?.();
  await openReplayActions(player, r.item, { back, allowDelete: false });
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
      formatDuration(v.durationMs),
      formatShortDate(v.createdAt),
    ],
    button1: "删除",
    button2: "取消",
  });
  if (!r) return back?.();
  await confirmDeleteReplay(player, r.item.id, r.item.fileName, () =>
    openOpReplayPanel(player, back),
  );
}

/** 万能面板"回放"分组菜单（开始/停止录制 + 我的录制 + 回放控制） */
export async function openReplayMenuPanel(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "回放",
      info: [
        "1. 我的比赛回放",
        "2. 我的自定义录制",
        "3. 全部比赛回放（观看所有玩家的比赛录制）",
        `4. ${isRecording(player.id) ? "停止录制（落盘）" : "开始录制（当前行驶）"}`,
        "5. 回放控制（播放 / 暂停 / 倍速 / 跳转 / 停止）",
      ].join("\n"),
      button1: "执行",
      button2: "关闭",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const panelBack = () => openReplayMenuPanel(player, back);
  if (res.listItem === 0) {
    await openReplayMenu(player, panelBack, "race");
  } else if (res.listItem === 1) {
    await openReplayMenu(player, panelBack, "ghost");
  } else if (res.listItem === 2) {
    // 全部比赛回放：公开回看库（所有玩家的 race 录制），只可看不可删
    await openPublicReplayMenu(player, panelBack);
  } else if (res.listItem === 3) {
    if (isRecording(player.id)) {
      // 比赛中禁止手动停止：比赛自动录制由系统管理，提前停止会丢名次元数据
      //（endRoom 的 raceRecordingStop 找不到会话，完赛录像永远缺 rank/finished）
      if (isInRace(player.id)) {
        player.sendClientMessage(COLOR_ERROR, "[比赛] 比赛中由系统自动录制，比赛结束后自动保存");
        return back?.();
      }
      await stopRecording(player.id);
      return back?.(); // 停止后回面板（可能继续查看列表等操作）
    }
    if (isInRace(player.id)) {
      // 比赛中由比赛系统自动录制（race 类型），手动开始会与自动录制抢会话
      player.sendClientMessage(COLOR_ERROR, "比赛中已自动录制（结束自动保存），无需手动开始");
      return back?.();
    }
    if (isInChallenge(player.id) || getReplaySession(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "影子挑战/回放中不能录制");
      return back?.();
    }
    // 开始录制前确认：录制会持续采集当前行驶，误触会白录一段
    const c = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.MSGBOX,
        caption: "开始录制",
        info: "确认开始录制当前行驶？\n结束后自动保存为回放（/rec stop 或 /p → 回放 → 停止录制），可用 /rp 观看。",
        button1: "开始录制",
        button2: "取消",
      }),
    );
    if (!c || c.response !== 1) return back?.(); // 取消 → 回面板
    const ok = await startRecording(player, { type: "ghost" });
    if (!ok) return back?.(); // 失败（无车等，startRecording 已发错误提示）→ 回面板
    // 录制已正式开始：不再回到面板（结束整个面板流程），提示录制中
    player.sendClientMessage(COLOR_SUCCESS, "录制中… 用 /rec stop 或 /p → 回放 停止并保存");
    return;
  } else if (res.listItem === 4) {
    await openReplayControlMenu(player, panelBack);
  }
}

/** 回放控制菜单（播放/暂停/倍速/跳转/停止；回放只支持正放） */
export async function openReplayControlMenu(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "回放控制",
      info: [
        "1. 播放 / 继续",
        "2. 暂停",
        "3. 倍速（0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 4）",
        "4. 跳转时间（秒）",
        "5. 观看视角",
        "6. 停止回放",
      ].join("\n"),
      button1: "执行",
      button2: "关闭",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const session = getReplaySession(player.id);
  if (!session && res.listItem !== 5) {
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
    case 2: {
      // 倍速档位选择（LIST 避免手输 1,5 这种错误；档位复用 playback 常量）
      const sp = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.LIST,
          caption: "倍速",
          info: REPLAY_SPEEDS.map((s, i) => `${i + 1}. ×${s}`).join("\n"),
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!sp || sp.response !== 1) return back?.();
      const speed = REPLAY_SPEEDS[sp.listItem];
      controlReplay(player, "speed", String(speed));
      return back?.();
    }
    case 3: {
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
    case 4:
      controlReplay(player, "watch");
      return back?.();
    case 5:
      controlReplay(player, "stop");
      return back?.();
  }
  return back?.();
}
