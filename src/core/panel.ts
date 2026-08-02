import { Dialog, DialogStylesEnum, KeysEnum, Player, PlayerEvent } from "@infernus/core";
import { getAuthState, changeOwnPassword } from "@/auth/auth";
import { isPlayerLocked, lockPlayer, unlockPlayer } from "@/core/interaction";
import { isSuperAdmin, openOpPanel } from "@/admin/op";
import { openSessionMenu } from "@/sessions/menu";
import { changeChatRangeFlow } from "@/chat";
import { openVehicleMenu } from "@/personalize/vehicle";
import { openWorldMenu } from "@/personalize/world";
import { openCharacterMenu } from "@/personalize/character";
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

/** 面板分组：一级菜单 = 玩法域，二级菜单 = 具体功能入口 */
interface PanelGroup {
  label: string;
  /** 组级可见条件（如 OP 专属） */
  visible?: (player: Player) => boolean;
  items: PanelItem[];
}

/**
 * 万能面板分组结构。
 * 一级菜单（玩法域）：战局 / 赛车 / 爱车 / 个性化 / 我的 / 传送 / 管理(OP)
 * - 战局设置已并入「战局」菜单（原一级菜单收纳为二级入口）
 * - 5 个个性化设置（人物/车辆/世界/界面/装扮）收纳进「个性化」
 * - 个人相关（信息/登录记录/改密/快捷操作/聊天范围）归入「我的」，比赛期间仍可用
 */
const panelGroups: PanelGroup[] = [
  {
    label: "战局",
    items: [{ label: "战局", run: openSessionMenu }],
  },
  {
    label: "赛车",
    items: [{ label: "赛车", run: openRaceMenu }],
  },
  {
    label: "爱车",
    items: [{ label: "爱车", run: openMyVehicleMenu }],
  },
  {
    label: "个性化",
    items: [
      { label: "人物", run: openCharacterMenu },
      { label: "车辆", run: openVehicleMenu },
      { label: "世界", run: openWorldMenu },
      { label: "界面", run: openInterfaceMenu },
      { label: "装扮", run: openAttireMenu },
    ],
  },
  {
    label: "我的",
    items: [
      { label: "我的信息", raceSafe: true, run: showMyProfile },
      { label: "我的登录记录", raceSafe: true, run: showMySessionLogs },
      { label: "修改密码", raceSafe: true, run: changeOwnPassword },
      { label: "快捷操作", raceSafe: true, run: openQuickActionsMenu },
      { label: "聊天范围", raceSafe: true, run: changeChatRangeFlow },
    ],
  },
  {
    label: "传送",
    items: [{ label: "传送", run: openTeleportMenu }],
  },
  {
    label: "管理",
    visible: isSuperAdmin,
    items: [
      { label: "管理员面板", raceSafe: true, run: openOpPanel },
      { label: "装扮管理", run: openAttireAdmin },
    ],
  },
];

/** 组内可见条目（组级条件 + 条目级条件 + 比赛限制） */
function getVisibleItems(group: PanelGroup, player: Player): PanelItem[] {
  const inRace = isInRace(player.id);
  return group.items.filter((item) => {
    if (item.visible && !item.visible(player)) return false;
    if (inRace && !item.raceSafe) return false;
    return true;
  });
}

/** 可见分组（组内至少有一个可见条目，避免出现空菜单） */
function getVisibleGroups(player: Player): PanelGroup[] {
  return panelGroups.filter((group) => {
    if (group.visible && !group.visible(player)) return false;
    return getVisibleItems(group, player).length > 0;
  });
}

/**
 * 打开万能面板（Y 键呼出）。
 * 两级导航：主面板（分组列表）→ 分组菜单（功能入口）→ 子菜单。
 * 任一层的"取消/关闭"逐级返回上一层，不会直接退出。
 */
export async function openPanel(player: Player): Promise<void> {
  lockPlayer(player.id);
  try {
    const groups = getVisibleGroups(player);
    if (groups.length === 0) return;
    const info = groups.map((group, i) => `${i + 1}. ${group.label}`).join("\n");
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
    if (res.response !== 1) return; // 主面板点"关闭"→ 关闭面板
    const group = groups[res.listItem];
    if (group) {
      await showGroupMenu(player, group, () => openPanel(player));
    }
  } finally {
    unlockPlayer(player.id);
  }
}

/** 分组菜单：显示组内功能入口，子菜单取消回本组，本组"关闭"回主面板 */
async function showGroupMenu(player: Player, group: PanelGroup, back: MenuBack): Promise<void> {
  const items = getVisibleItems(group, player);
  if (items.length === 0) return back();
  const info = items.map((item, i) => `${i + 1}. ${item.label}`).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: group.label,
      info,
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back(); // 取消 → 返回主面板
  const item = items[res.listItem];
  if (item) {
    // 子菜单取消时回到本分组菜单（继续本次面板流程）
    await item.run(player, () => showGroupMenu(player, group, back));
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
