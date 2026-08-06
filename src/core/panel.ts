import { Dialog, DialogStylesEnum, KeysEnum, isPressed, Player, PlayerEvent } from "@infernus/core";
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
import { openHouseAdminMenu } from "@/house/admin";
import { openRaceMenu } from "@/race/manage";
import { openActionMenu } from "@/personalize/action";
import {
  isInRace,
  getRacePlayerState,
  getRaceRoom,
  startRace,
  leaveRace,
  respawnToLastCp,
  rollbackToPrevCp,
  restartRace,
} from "@/race/room";
import { openChangeTrackMenu } from "@/race/roomUi";
import { isEditing, exitEdit } from "@/race/editor";
import { isInChallenge, goChallenge, restartChallenge, exitChallenge } from "@/replay/challenge";
import { showMySessionLogs } from "@/auth/sessionLog";
import { showMyProfile, openLookupPlayerInfo } from "@/core/profile";
import { openHelp } from "@/core/help";
import { openReplayMenuPanel } from "@/replay/menu";
import { showDialog } from "@/utils/dialog";
import { COLOR_ERROR, COLOR_INFO } from "@/utils/colors";

/** 面板条目：条件可见 + 点击执行 */
interface PanelItem {
  label: string;
  /** 简短说明（主面板表格第二列/分组菜单表格第二列展示） */
  desc?: string;
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
  /** 简短说明（主面板表格第二列展示，一眼看出该分组能做什么） */
  desc?: string;
  /** 组级可见条件（如 OP 专属） */
  visible?: (player: Player) => boolean;
  /**
   * 禁止单子项自动展开（默认 false：组内只有一个可见项时直接执行该项）。
   * 状态驱动的分组（比赛房间/赛道编辑）必须开启——比赛中"离开房间"是唯一可见项，
   * 若自动展开会在按 Y 的瞬间直接执行离开，把玩家踢出比赛。
   */
  noAutoExpand?: boolean;
  items: PanelItem[];
}

/**
 * 万能面板分组结构。
 * 一级菜单（玩法域）：战局 / 赛车 / 爱车 / 个性化 / 我的 / 传送 / 管理(OP)
 * - 战局设置已并入「战局」菜单（原一级菜单收纳为二级入口）
 * - 5 个个性化设置（人物/车辆/世界/界面/装扮）收纳进「个性化」
 * - 个人相关（信息/登录记录/改密/快捷操作/聊天范围）归入「我的」，比赛期间仍可用
 * - 比赛房间内：显示「比赛房间」组（开始比赛[仅房主]/离开房间），其余玩法组隐藏
 * - 赛道编辑中：显示「赛道编辑」组（退出编辑），其余玩法组隐藏
 */
const panelGroups: PanelGroup[] = [
  {
    label: "比赛房间",
    desc: "开始 / 离开比赛",
    // 状态驱动分组：不自动展开单子项（否则比赛中唯一可见的"离开房间"会在按 Y 瞬间执行）
    noAutoExpand: true,
    // 仅在比赛房间内（创建/加入比赛后）显示；其余玩法组在比赛中自动隐藏
    visible: (player) => isInRace(player.id),
    items: [
      {
        label: "开始比赛",
        raceSafe: true,
        // 仅房主且房间处于等待状态才显示（非房主/已开跑时点了也是"只有房主能开始/比赛已开始"）
        visible: (player) => {
          const pr = getRacePlayerState(player.id);
          const room = pr ? getRaceRoom(pr.roomId) : undefined;
          return !!room && room.state === "WAITING" && room.ownerId === player.id;
        },
        run: startRace,
      },
      {
        label: "更换赛道",
        raceSafe: true,
        // 仅房主且等待阶段：随机换一张 / 从列表选择（开赛后锁定）
        visible: (player) => {
          const pr = getRacePlayerState(player.id);
          const room = pr ? getRaceRoom(pr.roomId) : undefined;
          return !!room && room.state === "WAITING" && room.ownerId === player.id;
        },
        run: openChangeTrackMenu,
      },
      {
        label: "重生",
        raceSafe: true,
        // 常用操作置前：比赛房间组仅在比赛中显示；RACING 重生回上一 CP
        //（对齐原版 /kill），未开跑（等待/倒计时）正常重生
        run: (player) => {
          const pr = getRacePlayerState(player.id);
          const room = pr ? getRaceRoom(pr.roomId) : undefined;
          if (pr && room && room.state === "RACING") {
            respawnToLastCp(player, pr, room);
          } else {
            player.spawn();
          }
        },
      },
      {
        label: "回退到更早检查点",
        raceSafe: true,
        // 再往前回退一个 CP（上一 CP 在空中/无落点重生落空时的兜底）；
        // 同步回撤该 CP 触达后的状态（cveh 车型/time/weather）。仅开跑后显示
        visible: (player) => {
          const pr = getRacePlayerState(player.id);
          const room = pr ? getRaceRoom(pr.roomId) : undefined;
          // 已触达累计序号 ≥ 1（跨圈后 cpIndex=-1 但累计序号仍指向上一圈末 CP）
          return (
            !!room && room.state === "RACING" && !!pr && pr.lap * room.cps.length + pr.cpIndex >= 1
          );
        },
        run: (player) => {
          const pr = getRacePlayerState(player.id);
          const room = pr ? getRaceRoom(pr.roomId) : undefined;
          if (pr && room && room.state === "RACING") {
            rollbackToPrevCp(player, pr, room);
          } else {
            player.sendClientMessage(COLOR_ERROR, "[赛车] 当前不在比赛中");
          }
        },
      },
      {
        label: "重开比赛",
        raceSafe: true,
        // 仅房主：当前赛道重置回起点（同一赛道再来一场），倒计时/比赛中也可用
        visible: (player) => {
          const pr = getRacePlayerState(player.id);
          const room = pr ? getRaceRoom(pr.roomId) : undefined;
          return !!room && room.state !== "FINISHED" && room.ownerId === player.id;
        },
        run: async (player, back) => {
          // 二次确认：重开会作废整场进度、所有成员回到起点（影响全房，防误触）
          const pr = getRacePlayerState(player.id);
          const room = pr ? getRaceRoom(pr.roomId) : undefined;
          const res = await showDialog(
            player,
            new Dialog({
              style: DialogStylesEnum.MSGBOX,
              caption: "重开比赛",
              info: `确定重开比赛「${room?.raceName ?? ""}」吗？\n当前比赛将作废，所有成员回到起点重新开始！`,
              button1: "确认重开",
              button2: "取消",
            }),
          );
          if (res && res.response === 1) {
            await restartRace(player);
          }
          return back?.();
        },
      },
      {
        label: "离开房间",
        raceSafe: true,
        run: (player, back) => {
          leaveRace(player);
          return back?.();
        },
      },
    ],
  },
  {
    label: "影子挑战",
    desc: "开始 / 重开 / 退出",
    // 状态驱动分组：不自动展开单子项（待命时"退出挑战"可能成为唯一可见项，自动
    // 展开会在按 Y 瞬间直接退出挑战——对齐比赛房间组的防误触处理）
    noAutoExpand: true,
    // 仅在影子挑战中显示；其余玩法组在挑战中自动隐藏（对齐比赛房间的收窄——
    // 挑战是独立竞速世界，刷车/传送/换装等玩法操作会破坏挑战状态）
    visible: (player) => isInChallenge(player.id),
    items: [
      {
        label: "开始（起跑）",
        raceSafe: true,
        // goChallenge 内部按状态校验：待命→倒计时、比赛中提示已开始、倒计时中提示等待
        run: goChallenge,
      },
      {
        label: "重开（回起点）",
        raceSafe: true,
        run: restartChallenge,
      },
      {
        label: "退出挑战",
        raceSafe: true,
        run: (player, back) => {
          exitChallenge(player);
          return back?.();
        },
      },
    ],
  },
  {
    label: "赛道编辑",
    desc: "退出编辑模式",
    noAutoExpand: true,
    // 仅在赛道编辑模式中显示；其余玩法组在编辑中自动隐藏（编辑是对话框交互，避免干扰）
    visible: (player) => isEditing(player.id),
    items: [
      {
        label: "退出编辑",
        raceSafe: true,
        run: (player) => {
          exitEdit(player.id);
          player.sendClientMessage(COLOR_INFO, "已退出赛道编辑模式");
        },
      },
    ],
  },
  {
    label: "战局",
    desc: "创建 / 加入 / 管理战局",
    items: [{ label: "战局", run: openSessionMenu }],
  },
  {
    label: "赛车",
    desc: "创建赛道 / 列表 / 排行 / 分组",
    items: [{ label: "赛车", run: openRaceMenu }],
  },
  {
    label: "爱车",
    desc: "刷车 / 爱车列表 / 管理",
    items: [{ label: "爱车", run: openMyVehicleMenu }],
  },
  {
    label: "个性化",
    desc: "人物 / 车辆 / 世界 / 界面 / 装扮",
    items: [
      { label: "人物", desc: "皮肤 / NameTag / 前缀 / 预设 / 无敌", run: openCharacterMenu },
      { label: "车辆", desc: "装扮 / 换色 / 修复 / 氮气 / 翻正", run: openVehicleMenu },
      { label: "世界", desc: "时间 / 天气 / 物件 / 颜色 / 出生 / 传送", run: openWorldMenu },
      { label: "界面", desc: "GUI / 速度表 / 特技", run: openInterfaceMenu },
      { label: "装扮", desc: "预设 / 挂件 / 编辑", run: openAttireMenu },
      { label: "动作", desc: "抽烟 / 跳舞 / 坐下 / 躺下 / 投降…", run: openActionMenu },
    ],
  },
  {
    label: "我的",
    desc: "信息 / 登录记录 / 密码 / 快捷操作",
    items: [
      { label: "我的信息", raceSafe: true, run: showMyProfile },
      {
        label: "查看玩家信息",
        desc: "输入玩家名 / 列出全部玩家",
        raceSafe: true,
        run: openLookupPlayerInfo,
      },
      { label: "我的登录记录", raceSafe: true, run: showMySessionLogs },
      { label: "修改密码", raceSafe: true, run: changeOwnPassword },
      { label: "快捷操作", raceSafe: true, run: openQuickActionsMenu },
      { label: "聊天范围", raceSafe: true, run: changeChatRangeFlow },
      // 帮助：面板流程内无法用 /help 命令（isPlayerLocked 拦截），补面板入口
      { label: "帮助", desc: "常用命令 / 玩法指引", raceSafe: true, run: openHelp },
    ],
  },
  {
    label: "回放",
    desc: "录制 / 观看 / 控制",
    items: [
      {
        label: "回放",
        desc: "我的录制 · 开始/停止录制 · 回放控制",
        // 比赛中允许（比赛自动录制回放、回放控制）——用独立菜单避免比赛房间组膨胀
        raceSafe: true,
        run: openReplayMenuPanel,
      },
    ],
  },
  {
    label: "传送",
    desc: "系统 / 用户传送点 · 创建 / 管理",
    items: [{ label: "传送", run: openTeleportMenu }],
  },
  {
    label: "管理",
    desc: "管理员面板 / 装扮管理（仅管理员）",
    visible: isSuperAdmin,
    items: [
      { label: "管理员面板", raceSafe: true, run: openOpPanel },
      { label: "装扮管理", run: openAttireAdmin },
      { label: "房屋管理", run: openHouseAdminMenu },
    ],
  },
];

/** 组内可见条目（组级条件 + 条目级条件 + 比赛/编辑/挑战限制） */
function getVisibleItems(group: PanelGroup, player: Player): PanelItem[] {
  const restricted = isInRace(player.id) || isEditing(player.id) || isInChallenge(player.id);
  return group.items.filter((item) => {
    if (item.visible && !item.visible(player)) return false;
    if (restricted && !item.raceSafe) return false;
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
 * 面板层级记忆：记录玩家上次停留在哪个分组（null = 主面板）。
 * 打开面板时恢复到该分组菜单；若该分组当前不可见（如比赛中/权限变化），
 * 则逐级回退到可用的上一层（即主面板），并清除失效记忆。
 */
const lastGroupByPlayer = new Map<number, string | null>();

/** 玩家断线清理面板记忆 */
export function cleanupPanel(playerId: number): void {
  lastGroupByPlayer.delete(playerId);
}

/**
 * 打开万能面板（Y 键呼出）。
 * 两级导航：主面板（分组列表）→ 分组菜单（功能入口）→ 子菜单。
 * 任一层的"取消/关闭"逐级返回上一层，不会直接退出。
 * 打开时若上次停留的分组仍可用则直接进入该分组菜单（记忆恢复）。
 */
export async function openPanel(player: Player): Promise<void> {
  lockPlayer(player.id);
  try {
    const groups = getVisibleGroups(player);
    if (groups.length === 0) return;
    // 记忆恢复：上次所在分组若仍可见（含组内条目可用）则直接进入
    const last = lastGroupByPlayer.get(player.id);
    const target = last != null ? groups.find((g) => g.label === last) : undefined;
    if (target) {
      await showGroupMenu(player, target, () => showPanelList(player));
    } else {
      // 无记忆 / 记忆分组已不可用 → 回到主面板（失效记忆一并清除）
      if (last != null) lastGroupByPlayer.delete(player.id);
      await showPanelList(player);
    }
  } finally {
    unlockPlayer(player.id);
  }
}

/** 主面板：分组列表（表格：分组 | 说明）。点"关闭"终止面板；选组进入分组菜单（停留主面板 → 记忆清空） */
async function showPanelList(player: Player): Promise<void> {
  const groups = getVisibleGroups(player);
  if (groups.length === 0) return;
  lastGroupByPlayer.set(player.id, null);
  // TABLIST_HEADERS 两列：分组 + 简短说明（一眼看出每个分组能做什么）
  const info = [
    ["{FFD700}分组", "{FFD700}说明"].join("\t"),
    ...groups.map((g) => [g.label, g.desc ?? ""].join("\t")),
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.TABLIST_HEADERS,
      caption: "万能面板",
      info,
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return; // 断线直接退出
  if (res.response !== 1) return; // 主面板点"关闭"→ 关闭面板
  const group = groups[res.listItem]; // TABLIST_HEADERS 表头不占行号，listItem 即分组下标
  if (group) {
    await showGroupMenu(player, group, () => showPanelList(player));
  }
}

/** 分组菜单：显示组内功能入口（表格：功能 | 说明），子菜单取消回本组，本组"关闭"回主面板（停留本组 → 记忆本组） */
async function showGroupMenu(player: Player, group: PanelGroup, back: MenuBack): Promise<void> {
  const items = getVisibleItems(group, player);
  if (items.length === 0) return back();
  // 单子项分组（战局/赛车/爱车/传送）：跳过分组中间层直接执行子项，
  // 子菜单取消时回主面板（back）——导航保持"主面板 ⇄ 功能菜单"两层，
  // 避免点进去先看到一个只有一条的冗余菜单。
  // 状态驱动分组（noAutoExpand，如比赛房间/赛道编辑）例外：始终显示菜单列表，
  // 让玩家主动选择，防止"比赛中唯一可见的离开房间"被自动执行。
  if (items.length === 1 && !group.noAutoExpand) {
    await items[0].run(player, back);
    return;
  }
  lastGroupByPlayer.set(player.id, group.label);
  const info = [
    ["{FFD700}功能", "{FFD700}说明"].join("\t"),
    ...items.map((item) => [item.label, item.desc ?? ""].join("\t")),
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.TABLIST_HEADERS,
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

/** 注册万能面板入口：
 * - Y 键（按下瞬间触发）
 * - /p 命令：观战（spectator）模式下客户端收不到按键事件（open.mp 文档
 *   明确 "This key can not be detected when the player is in spectator mode"），
 *   但聊天框命令不受 spect 限制——观战中可用 /p 打开面板 */
export function initPanel(): void {
  PlayerEvent.onKeyStateChange(({ player, newKeys, oldKeys, next }) => {
    const pressed = isPressed(newKeys, oldKeys, KeysEnum.YES); // 按下瞬间（旧没按、新按下）
    if (
      pressed &&
      getAuthState(player.id) && // 已认证（排除注册/登录流程）
      !isPlayerLocked(player.id) // 不在其他流程中
    ) {
      void openPanel(player);
    }
    return next();
  });

  // 命令打开面板（与 Y 键同样的前置校验：未认证 / 在其它流程中（对话框互斥）
  // 时不打开，避免覆盖当前对话框或把别人的流程锁解开）
  const openPanelByCommand = (player: Player): void => {
    if (!getAuthState(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "请先完成登录");
      return;
    }
    if (isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_INFO, "当前正在其他流程中，请稍后再试");
      return;
    }
    void openPanel(player); // openPanel 内部自行 lock/unlock
  };
  // /p 为主命令（短），/panel 保留兼容别名（老玩家习惯/旧文档）
  PlayerEvent.onCommandText("p", ({ player, next }) => {
    openPanelByCommand(player);
    return next();
  });
  PlayerEvent.onCommandText("panel", ({ player, next }) => {
    openPanelByCommand(player);
    return next();
  });
  // /sz /wdsz 我的设置（对齐原版 OnPlayerSettings"我的设置"列表）：
  // 原版 8 项（安全中心/我的装扮/我的家具/我的爱车/我的颜色/我的称号/我的小尾巴/个性化设置）
  // 映射到 gm-lite 有对应的项——家具/玩家颜色无此概念（家具不开发），
  // 称号=名字前缀、小尾巴=名字后缀（人物菜单内）；全部复用面板现有子菜单。
  const openMySettings = (player: Player): void => {
    if (!getAuthState(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "请先完成登录");
      return;
    }
    if (isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_INFO, "当前正在其他流程中，请稍后再试");
      return;
    }
    void openMySettingsMenu(player);
  };
  PlayerEvent.onCommandText(["sz", "wdsz"], ({ player, next }) => {
    openMySettings(player);
    return next();
  });
}

/**
 * 我的设置聚合菜单（/sz /wdsz 入口；对齐原版 PlayerInfoDialog 列表）：
 * 我的装扮 / 我的爱车 / 我的称号（前缀后缀·人物菜单）/ 个性化设置 / 我的信息 /
 * 登录记录 / 修改密码 / 快捷操作。全部复用面板现有子菜单（无新增逻辑）。
 */
export async function openMySettingsMenu(player: Player, back?: MenuBack): Promise<void> {
  const again = () => openMySettingsMenu(player, back); // 子菜单返回本菜单
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "我的设置",
      info: [
        "1. 我的装扮",
        "2. 我的爱车",
        "3. 我的称号（前缀/后缀）",
        "4. 个性化设置",
        "5. 我的信息",
        "6. 我的登录记录",
        "7. 修改密码",
        "8. 快捷操作",
      ].join("\n"),
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res || res.response !== 1) return back?.();
  switch (res.listItem) {
    case 0:
      await openAttireMenu(player, again);
      break;
    case 1:
      await openMyVehicleMenu(player, again);
      break;
    case 2:
      await openCharacterMenu(player, again);
      break;
    case 3: {
      // 个性化设置二级：人物/车辆/世界/界面/装扮/动作
      const sub = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.LIST,
          caption: "个性化设置",
          info: [
            "1. 人物（皮肤 / NameTag / 前缀 / 预设 / 无敌）",
            "2. 车辆（装扮 / 换色 / 修复 / 氮气 / 翻正）",
            "3. 世界（时间 / 天气 / 物件 / 颜色 / 出生）",
            "4. 界面（GUI / 速度表 / 特技）",
            "5. 装扮（预设 / 挂件 / 编辑）",
            "6. 动作（抽烟 / 跳舞 / 坐下 / 躺下…）",
          ].join("\n"),
          button1: "确定",
          button2: "返回",
        }),
      );
      if (!sub || sub.response !== 1) {
        await openMySettingsMenu(player, back);
        break;
      }
      const subs = [
        () => openCharacterMenu(player, again),
        () => openVehicleMenu(player, again),
        () => openWorldMenu(player, again),
        () => openInterfaceMenu(player, again),
        () => openAttireMenu(player, again),
        () => openActionMenu(player, again),
      ];
      await subs[sub.listItem]?.();
      break;
    }
    case 4:
      await showMyProfile(player, again);
      break;
    case 5:
      await showMySessionLogs(player, again);
      break;
    case 6:
      await changeOwnPassword(player, again);
      break;
    case 7:
      await openQuickActionsMenu(player, again);
      break;
    default:
      await openMySettingsMenu(player, back);
  }
}
