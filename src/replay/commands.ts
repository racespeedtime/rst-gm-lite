import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { isPlayerLocked } from "@/core/interaction";
import { isInRace } from "@/race/room";
import { showDialog } from "@/utils/dialog";
import { startRecording, stopRecording, isRecording } from "./recorder";
import { controlReplay, getReplaySession, REPLAY_SPEEDS } from "./playback";
import { isInChallenge, cleanupChallenge } from "./challenge";
import { openReplayMenu } from "./menu";
import { COLOR_ERROR, COLOR_INFO, COLOR_SUCCESS } from "@/utils/colors";

/**
 * 回放命令：
 * /rec start|stop|list — 自定义录制（562 漂移等，赛车系统外）
 * /rp play|pause|speed|seek|stop — 回放控制（只支持正放）
 */

function guard(player: Player, next: () => unknown): boolean {
  if (!getAuthState(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "请先登录");
    next();
    return false;
  }
  if (isPlayerLocked(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "当前正在其他流程中，请稍后再试");
    next();
    return false;
  }
  return true;
}

export function initReplayCommands(): void {
  PlayerEvent.onCommandText("rec", ({ player, subcommand, next }) => {
    if (!guard(player, next)) return;
    const arg = subcommand[0] ?? "help";
    if (arg === "start") {
      // 比赛中自动录制由比赛系统触发，手动录制主要用于赛车系统外（漂移等）
      if (isInRace(player.id)) {
        player.sendClientMessage(COLOR_ERROR, "比赛中已自动录制，无需手动 /rec start");
        return next();
      }
      if (isInChallenge(player.id) || getReplaySession(player.id)) {
        player.sendClientMessage(COLOR_ERROR, "影子挑战/回放中不能录制");
        return next();
      }
      void (async () => {
        // startRecording 内部已发错误提示（未登录/已在录制/无车等），
        // 仅成功时补充"录制中"引导（失败不再追加误导文案）
        const ok = await startRecording(player, { type: "ghost" });
        if (ok) player.sendClientMessage(COLOR_INFO, "录制中… /rec stop 停止");
      })();
      return next();
    }
    if (arg === "stop") {
      // 比赛中禁止手动停止：比赛自动录制由系统管理，提前停止会丢名次元数据
      //（endRoom 的 raceRecordingStop 找不到会话，完赛录像永远缺 rank/finished）
      if (isInRace(player.id)) {
        player.sendClientMessage(COLOR_ERROR, "[比赛] 比赛中由系统自动录制，比赛结束后自动保存");
        return next();
      }
      void (async () => {
        if (!isRecording(player.id)) {
          player.sendClientMessage(COLOR_ERROR, "你不在录制中");
          return;
        }
        await stopRecording(player.id);
      })();
      return next();
    }
    if (arg === "list") {
      void openReplayMenu(player);
      return next();
    }
    player.sendClientMessage(
      COLOR_INFO,
      "用法: /rec start 开始录制 · /rec stop 停止 · /rec list 我的录制",
    );
    return next();
  });

  PlayerEvent.onCommandText("rp", ({ player, subcommand, next }) => {
    if (!guard(player, next)) return;
    const action = subcommand[0] ?? "help";
    const arg = subcommand[1];
    switch (action) {
      case "play": {
        void (async () => {
          if (!getReplaySession(player.id)) {
            // 未在播放：从"我的录制"选择播放
            await openReplayMenu(player);
            return;
          }
          controlReplay(player, "play");
        })();
        return next();
      }
      case "pause":
      case "speed":
      case "seek":
      case "watch":
      case "stop": {
        controlReplay(player, action, arg);
        return next();
      }
      case "help":
      default: {
        // /rp 帮助：MSGBOX 弹出（7 行聊天刷屏不友好；Dialog 支持中文）
        void (async () => {
          await showDialog(
            player,
            new Dialog({
              style: DialogStylesEnum.MSGBOX,
              caption: "/rp 回放控制",
              info: [
                "用法: /rp <指令> [参数]",
                "",
                "  play      开始/继续播放（暂停后恢复；未在播放则打开我的录制）",
                "  pause     暂停",
                `  speed [${REPLAY_SPEEDS.join("|")}]  倍速（不填则提示当前倍速）`,
                "  seek <秒|mm:ss>  跳转（多分身保持错峰）",
                "  watch     观看回放视角（比赛回放带 C P/TIME/BEST）",
                "  stop      停止回放",
                "",
                "面板入口：/p → 回放 分组，功能与命令一致",
              ].join("\n"),
              button1: "确定",
              button2: "关闭",
            }),
          );
        })();
        return next();
      }
    }
  });

  PlayerEvent.onCommandText("challenge", ({ player, subcommand, next }) => {
    if (!guard(player, next)) return;
    const arg = subcommand[0] ?? "help";
    if (arg === "stop") {
      if (!isInChallenge(player.id)) {
        player.sendClientMessage(COLOR_ERROR, "你不在影子挑战中");
        return next();
      }
      cleanupChallenge(player.id);
      player.sendClientMessage(COLOR_SUCCESS, "影子挑战已退出");
      return next();
    }
    player.sendClientMessage(COLOR_INFO, "用法: /challenge stop 退出影子挑战（入口在赛道详情）");
    return next();
  });
}
