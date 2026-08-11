import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { isPlayerLocked } from "@/core/interaction";
import { isInRace } from "@/race/room";
import { showDialog } from "@/utils/dialog";
import { sysMsg } from "@/utils/msg";
import { startRecording, stopRecording, isRecording } from "./recorder";
import { controlReplay, getReplaySession, REPLAY_SPEEDS, toggleReplayLabels } from "./playback";
import {
  isInChallenge,
  exitChallenge,
  goChallenge,
  restartChallenge,
  toggleChallengeShadowLabel,
} from "./challenge";
import { openReplayMenu } from "./menu";

/**
 * 回放命令：
 * /rec start|stop|list — 自定义录制（562 漂移等，赛车系统外）
 * /rp play|pause|speed|seek|stop — 回放控制（只支持正放）
 */

function guard(player: Player, next: () => unknown): boolean {
  if (!getAuthState(player.id)) {
    sysMsg(player, "replay", "请先登录", "error");
    next();
    return false;
  }
  if (isPlayerLocked(player.id)) {
    sysMsg(player, "replay", "当前正在其他流程中，请稍后再试", "error");
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
        sysMsg(player, "replay", "比赛中已自动录制，无需手动 /rec start", "error");
        return next();
      }
      if (isInChallenge(player.id) || getReplaySession(player.id)) {
        sysMsg(player, "replay", "影子挑战/回放中不能录制", "error");
        return next();
      }
      void (async () => {
        // startRecording 内部已发错误提示（未登录/已在录制/无车等），
        // 仅成功时补充"录制中"引导（失败不再追加误导文案）
        const ok = await startRecording(player, { type: "ghost" });
        if (ok) sysMsg(player, "replay", "录制中… /rec stop 停止", "info");
      })();
      return next();
    }
    if (arg === "stop") {
      // 比赛中禁止手动停止：比赛自动录制由系统管理，提前停止会丢名次元数据
      //（endRoom 的 raceRecordingStop 找不到会话，完赛录像永远缺 rank/finished）
      if (isInRace(player.id)) {
        sysMsg(player, "replay", "比赛中由系统自动录制，比赛结束后自动保存", "info");
        return next();
      }
      void (async () => {
        if (!isRecording(player.id)) {
          sysMsg(player, "replay", "你不在录制中", "error");
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
    sysMsg(
      player,
      "replay",
      "用法: /rec start 开始录制 · /rec stop 停止 · /rec list 我的录制",
      "info",
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
      case "label": {
        // ghost 身份标签（车顶"身份+扮演谁+ghost N/M"）临时显隐：不落库，
        // 断线重置为显示。多分身时标签可能遮挡视线，玩家可暂时屏蔽。
        // 回放 ghost 与挑战影子标签共用同一偏好：切换一次两侧同时生效
        const visible = toggleReplayLabels(player);
        toggleChallengeShadowLabel(player.id);
        sysMsg(player, "replay", `回放 ghost 标签已${visible ? "显示" : "隐藏"}`, "info");
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
                "  watch     镜头观战（比赛回放带 CP/TIME/BEST）",
                "  watch off 退出观战/副驾并回到录制起点（回放继续播放）",
                "  ride      副驾模式（坐进 ghost 车跟随 NPC 开车）",
                "  label     显示/隐藏 ghost 身份标签（默认显示）",
                "  stop      停止回放",
                "",
                "观战/副驾中方向键 ←/→ 切车",
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
    if (arg === "go") {
      // 统一待命制：待命/重开后就绪后由玩家自己触发开始（倒计时 3 秒）
      goChallenge(player);
      return next();
    }
    if (arg === "restart") {
      // 局内重开：任意时刻重置回起点待命（同影子再跑，不重选）
      restartChallenge(player);
      return next();
    }
    if (arg === "stop") {
      // 统一走 exitChallenge（不在挑战中也会明确提示）
      exitChallenge(player);
      return next();
    }
    sysMsg(
      player,
      "replay",
      "用法: /challenge go 起跑 · /challenge restart 重开 · /challenge stop 退出（入口在赛道详情）",
      "info",
    );
    return next();
  });
}
