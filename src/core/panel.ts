import { Dialog, DialogStylesEnum, KeysEnum, Player, PlayerEvent } from "@infernus/core";
import { getAuthState, changeOwnPassword } from "@/auth/auth";
import { isPlayerLocked, lockPlayer, unlockPlayer } from "@/core/interaction";
import { isSuperAdmin, openOpPanel } from "@/admin/op";
import { openSessionMenu } from "@/sessions/menu";
import { changeChatRangeFlow } from "@/chat";
import { openVehicleMenu } from "@/personalize/vehicle";
import { openWorldMenu } from "@/personalize/world";
import { openCharacterMenu } from "@/personalize/character";
import { openSessionSettingsMenu } from "@/personalize/sessionSettings";
import { openQuickActionsMenu } from "@/personalize/quickActions";
import { openInterfaceMenu } from "@/personalize/interface";
import { openMyVehicleMenu } from "@/vehicles/menu";
import { openTeleportMenu } from "@/teleport";
import { openAttireMenu } from "@/attire";
import { openAttireAdmin } from "@/attire/admin";
import { openRaceMenu } from "@/race/manage";
import { isInRace } from "@/race/room";
import { showMySessionLogs } from "@/auth/sessionLog";
import { showMyProfile } from "@/core/profile";
import { showDialog } from "@/utils/dialog";

/** 面板条目：条件可见 + 点击执行 */
interface PanelItem {
  label: string;
  visible?: (player: Player) => boolean;
  /** 比赛中是否允许（默认 false，比赛中隐藏） */
  raceSafe?: boolean;
  /** back：返回上一级菜单的回调（子菜单取消时调用，保证面板连贯性） */
  run: (player: Player, back?: () => void | Promise<void>) => void | Promise<void>;
}

/** 菜单返回回调类型（所有菜单函数统一签名：取消时调用 back 返回上一层） */
export type MenuBack = () => void | Promise<void>;

/** 万能面板分类条目（后续功能入口统一在这里扩展） */
const panelItems: PanelItem[] = [
  { label: "战局", run: openSessionMenu },
  { label: "战局设置", run: openSessionSettingsMenu },
  { label: "赛车", run: openRaceMenu },
  { label: "爱车", run: openMyVehicleMenu },
  { label: "装扮", run: openAttireMenu },
  { label: "传送", run: openTeleportMenu },
  { label: "车辆个性化", run: openVehicleMenu },
  { label: "人物个性化", run: openCharacterMenu },
  { label: "世界个性化", run: openWorldMenu },
  { label: "界面个性化", run: openInterfaceMenu },
  // 比赛中仍可用的安全条目
  { label: "快捷操作", raceSafe: true, run: openQuickActionsMenu },
  { label: "聊天范围", raceSafe: true, run: changeChatRangeFlow },
  { label: "修改密码", raceSafe: true, run: changeOwnPassword },
  { label: "我的信息", raceSafe: true, run: showMyProfile },
  { label: "我的登录记录", raceSafe: true, run: showMySessionLogs },
  { label: "管理员面板", visible: isSuperAdmin, raceSafe: true, run: openOpPanel },
  { label: "装扮管理", visible: isSuperAdmin, run: openAttireAdmin },
];

function getVisibleItems(player: Player): PanelItem[] {
  const inRace = isInRace(player.id);
  return panelItems.filter((item) => {
    if (item.visible && !item.visible(player)) return false;
    if (inRace && !item.raceSafe) return false;
    return true;
  });
}

/**
 * 打开万能面板（Y 键呼出）。
 * 整个面板流程（含子菜单）期间锁定玩家，防止重复触发。
 * 子菜单取消时通过 back 回调回到主菜单（连贯导航，不会直接关闭）。
 */
export async function openPanel(player: Player): Promise<void> {
  lockPlayer(player.id);
  try {
    const items = getVisibleItems(player);
    const info = items.map((item, i) => `${i + 1}. ${item.label}`).join("\n");
    const res = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.LIST,
        caption: "万能面板",
        info,
        button1: "确定",
        button2: "关闭",
      }),
    );
    if (!res) return; // 断线直接退出
    if (res.response !== 1) return; // 主菜单点"关闭"→ 关闭面板
    const item = items[res.listItem];
    if (item) {
      // 子菜单取消时回到主菜单（继续本次面板流程）
      await item.run(player, () => openPanel(player));
    }
  } finally {
    unlockPlayer(player.id);
  }
}

/** 注册万能面板快捷键（Y 键，按下瞬间触发） */
export function initPanel(): void {
  PlayerEvent.onKeyStateChange(({ player, newKeys, oldKeys, next }) => {
    const pressed =
      (newKeys & KeysEnum.YES) !== 0 && (oldKeys & KeysEnum.YES) === 0;
    if (
      pressed &&
      getAuthState(player.id) && // 已认证（排除注册/登录流程）
      !isPlayerLocked(player.id) // 不在其他流程中
    ) {
      void openPanel(player);
    }
    return next();
  });
}
