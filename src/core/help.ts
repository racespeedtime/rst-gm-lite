import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { isPlayerLocked } from "@/core/interaction";
import { showDialog } from "@/utils/dialog";
import { COLOR_INFO } from "@/utils/colors";

/** 登录欢迎消息（服务器名 + 核心玩法指引） */
export function sendWelcomeMessage(player: Player): void {
  player.sendClientMessage(COLOR_INFO, "[RST] 欢迎回来！按 Y 打开万能面板（赛车/爱车/个性化等主要入口）");
  player.sendClientMessage(COLOR_INFO, "[RST] 输入 /help 查看常用命令，/r 进入赛车（创建/加入比赛），/drift 乘坐漂移 NPC");
}

/** 常用命令帮助内容（Dialog 支持中文） */
const HELP_LINES = [
  "{FFD700}Y 键 — 万能面板（主要入口：赛车/爱车/战局/个性化/装扮）",
  "{FFFFFF}/r — 赛车：无参数打开赛道列表，/r s 创建比赛 · /r j 加入 · /r l 离开",
  "{FFFFFF}/c — 刷车（/c 车辆ID · /c list 图片选车 · /c wode 召唤）",
  "{FFFFFF}/skin — 3D 选皮肤（/skin 打开菜单 · /skin ID 直接切换）",
  "{FFFFFF}/drift — 乘坐漂移 NPC 随行观光（NPC 开车，您当乘客）",
  "{FFFFFF}/tv — 观战玩家（/tv 玩家ID · /tv off 关闭）",
  "{FFFFFF}/s /l — 保存当前位置 / 传送回去",
  "{FFFFFF}/rec — 自由录制回放（/rec start 开始 · /rec stop 停止 · /rec list 我的录制）",
  "{FFFFFF}/rp — 回放控制（/rp play · pause · forward · back · speed · seek · stop）",
  "{FFFFFF}/challenge — 影子挑战（赛道详情进入 · /challenge stop 中途退出）",
  "{FFFFFF}/pm 玩家ID 消息 — 私聊（比赛中可用）",
  "{FFFFFF}/house list — 房屋列表 · /house goto 名称 传送",
  "{FFFFFF}/s 传送到系统点（/ls 等）· //名称 传送到自己的点",
  "{808080}命令输入 /xxx 查看具体用法（如 /r、/c）",
];

/**
 * 打开帮助对话框（/help）：列出常用命令。取消返回上一层（面板入口时）。
 */
export async function openHelp(player: Player, back?: () => void | Promise<void>): Promise<void> {
  await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "[RST] 常用命令",
      info: HELP_LINES.join("\n"),
      button1: "确定",
      button2: "关闭",
    }),
  );
  return back?.();
}

/** 初始化帮助命令：/help 打开常用命令 */
export function initHelpCommand(): void {
  PlayerEvent.onCommandText("help", ({ player, next }) => {
    if (!getAuthState(player.id)) return next();
    if (isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_INFO, "当前正在其他流程中，请稍后再试");
      return next();
    }
    void openHelp(player);
    return next();
  });
}
