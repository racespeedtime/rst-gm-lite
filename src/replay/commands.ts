import { Player, PlayerEvent } from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { isPlayerLocked } from "@/core/interaction";
import { isInRace } from "@/race/room";
import { startRecording, stopRecording, isRecording } from "./recorder";
import { controlReplay, getReplaySession } from "./playback";
import { isInChallenge, cleanupChallenge } from "./challenge";
import { openReplayMenu } from "./menu";
import { COLOR_ERROR, COLOR_INFO, COLOR_SUCCESS } from "@/utils/colors";

/**
 * 回放命令：
 * /rec start|stop|list — 自定义录制（562 漂移等，赛车系统外）
 * /rp play|pause|forward|back|speed|seek|stop — 回放控制
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
        await startRecording(player, { type: "ghost" });
        player.sendClientMessage(COLOR_INFO, "录制中… /rec stop 停止");
      })();
      return next();
    }
    if (arg === "stop") {
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
    player.sendClientMessage(COLOR_INFO, "用法: /rec start 开始录制 · /rec stop 停止 · /rec list 我的录制");
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
      case "forward":
      case "back":
      case "speed":
      case "seek":
      case "watch":
      case "stop": {
        controlReplay(player, action, arg);
        return next();
      }
      default:
        player.sendClientMessage(
          COLOR_INFO,
          "用法: /rp play 开始/继续 · /rp pause 暂停 · /rp forward [2|4] 快进 · /rp back [0.5|1|2|4] 倒放 · /rp speed [0.5|1|2|4] 倍速 · /rp seek 秒 跳转 · /rp stop 停止",
        );
        return next();
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
