import { Player, PlayerEvent, PlayerStateEnum, SpecialActionsEnum } from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { isPlayerLocked } from "@/core/interaction";
import { isInRace } from "@/race/room";
import { isEditing } from "@/race/editor";
import { isObserving } from "@/core/observe";
import { getReplaySession } from "@/replay/playback";
import { isInChallenge } from "@/replay/challenge";
import { showPagedDialog } from "@/utils/pagedDialog";
import type { MenuBack } from "@/core/panel";
import { COLOR_ERROR, COLOR_SUCCESS } from "@/utils/colors";

/**
 * 玩家动作系统（对齐原版 pawn-server 的 /anim 21 号动作映射，Action_Play）：
 * - 动画类：ApplyAnimation（animLib/animName 循环或单次）
 * - 特殊动作类：SetPlayerSpecialAction（跳舞/尿尿/投降）
 * 入口：万能面板「个性化 → 动作」（分页列表）+ 命令 /anim <ID>（保留原版调用方式）。
 * 边界：比赛/赛道编辑/观战/回放/影子挑战/车内/死亡状态下禁止使用；
 * 清理：上车/死亡/观战等状态切换（onStateChange）自动清除，断线 cleanupAction。
 */

/** 单个动作定义 */
interface ActionDef {
  id: number;
  name: string;
  kind: "special" | "anim";
  /** kind=special：SetPlayerSpecialAction 的动作值 */
  special?: number;
  /** kind=anim：动画库 / 动画名（循环动画持续播放直到清除） */
  lib?: string;
  anim?: string;
  loop?: boolean;
  lockX?: boolean;
  lockY?: boolean;
}

/** 动作表（编号 1~21，对齐原版 Action_Play）：
 *  特殊动作（SetPlayerSpecialAction）：1 尿尿 · 13-16 跳舞 · 19 投降
 *  动画（ApplyAnimation，delta=4.1 / time=0 / 不同步给他人）：
 *  站立/靠墙类循环动画 lockX/lockY 锁位防走动打断；躺/坐类不锁由循环维持 */
const ACTIONS: ActionDef[] = [
  { id: 1, name: "尿尿", kind: "special", special: SpecialActionsEnum.PISSING },
  {
    id: 2,
    name: "蹲下抱头",
    kind: "anim",
    lib: "ped",
    anim: "cower",
    loop: true,
    lockX: true,
    lockY: true,
  },
  {
    id: 3,
    name: "躺下1（沙滩）",
    kind: "anim",
    lib: "BEACH",
    anim: "bather",
    loop: false,
    lockX: true,
    lockY: true,
  },
  { id: 4, name: "坐下（躺椅）", kind: "anim", lib: "BEACH", anim: "ParkSit_M_loop", loop: true },
  { id: 5, name: "躺下2（躺背）", kind: "anim", lib: "BEACH", anim: "lay_bac_loop", loop: true },
  { id: 6, name: "躺下3（坐等）", kind: "anim", lib: "BEACH", anim: "sitnwait_loop_w", loop: true },
  {
    id: 7,
    name: "躺下4（日光浴）",
    kind: "anim",
    lib: "SUNBATHE",
    anim: "batherdown",
    loop: false,
    lockX: true,
    lockY: true,
  },
  {
    id: 8,
    name: "躺下修车",
    kind: "anim",
    lib: "CAR",
    anim: "Fixn_Car_Loop",
    loop: true,
    lockX: true,
    lockY: true,
  },
  {
    id: 9,
    name: "靠墙抽烟1",
    kind: "anim",
    lib: "SMOKING",
    anim: "M_smklean_loop",
    loop: true,
    lockX: true,
    lockY: true,
  },
  {
    id: 10,
    name: "靠墙抽烟2",
    kind: "anim",
    lib: "SMOKING",
    anim: "F_smklean_loop",
    loop: true,
    lockX: true,
    lockY: true,
  },
  {
    id: 11,
    name: "抽烟",
    kind: "anim",
    lib: "SMOKING",
    anim: "M_smkstnd_loop",
    loop: true,
    lockX: true,
    lockY: true,
  },
  { id: 12, name: "抽烟吐圈", kind: "anim", lib: "SMOKING", anim: "M_smk_out", loop: false },
  { id: 13, name: "跳舞1", kind: "special", special: SpecialActionsEnum.DANCE1 },
  { id: 14, name: "跳舞2", kind: "special", special: SpecialActionsEnum.DANCE2 },
  { id: 15, name: "跳舞3", kind: "special", special: SpecialActionsEnum.DANCE3 },
  { id: 16, name: "跳舞4", kind: "special", special: SpecialActionsEnum.DANCE4 },
  {
    id: 17,
    name: "打太极",
    kind: "anim",
    lib: "PARK",
    anim: "Tai_Chi_Loop",
    loop: true,
    lockX: true,
    lockY: true,
  },
  { id: 18, name: "坐下（地面）", kind: "anim", lib: "ped", anim: "SEAT_DOWN", loop: false },
  { id: 19, name: "投降", kind: "special", special: SpecialActionsEnum.HANDSUP },
  { id: 20, name: "坚持（举枪）", kind: "anim", lib: "SHOP", anim: "ROB_StickUp_In", loop: false },
  { id: 21, name: "假死", kind: "anim", lib: "PARACHUTE", anim: "FALL_skyDive_DIE", loop: false },
];

/** 分页列表项：首项为"清除动作"（id 0），其余为 ACTIONS */
const MENU_ITEMS: { id: number; name: string }[] = [
  { id: 0, name: "清除动作（停止）" },
  ...ACTIONS.map((a) => ({ id: a.id, name: a.name })),
];

/** 当前播放中的动作记录（playerId → actionId；供清理管理与后续扩展） */
const activeActions = new Map<number, number>();

/** 断线/状态清理：删除动作记录（实体清理在 onDisconnect / onStateChange 中） */
export function cleanupAction(playerId: number): void {
  activeActions.delete(playerId);
}

/** 当前动作 ID（未播放/已清除为 undefined） */
export function getActiveAction(playerId: number): number | undefined {
  return activeActions.get(playerId);
}

/**
 * 边界检查：动作是否可在当前状态使用。返回 null = 允许；否则返回拒绝提示文案。
 * 覆盖：比赛 / 赛道编辑 / 观战 / 回放 / 影子挑战 / 车内 / 死亡·上下车·观战态。
 */
function canUseAction(player: Player): string | null {
  if (isInRace(player.id)) return "[动作] 比赛中不能使用动作";
  if (isEditing(player.id)) return "[动作] 赛道编辑中不能使用动作";
  if (isObserving(player.id)) return "[动作] 观战中不能使用动作";
  if (getReplaySession(player.id)) return "[动作] 回放中不能使用动作";
  if (isInChallenge(player.id)) return "[动作] 影子挑战中不能使用动作";
  if (player.isInAnyVehicle()) return "[动作] 请先下车再使用动作";
  const st = player.getState();
  if (st !== PlayerStateEnum.ONFOOT && st !== PlayerStateEnum.SPAWNED) {
    return "[动作] 当前状态下不能使用动作（死亡/上车/观战中）";
  }
  return null;
}

/** 清除动作（带提示，供玩家主动停止：/anim 0 · 面板「清除动作」） */
export function stopAction(player: Player): void {
  player.clearAnimations();
  player.setSpecialAction(SpecialActionsEnum.NONE);
  activeActions.delete(player.id);
  player.sendClientMessage(COLOR_SUCCESS, "已清除动作");
}

/** 清除动作（静默：状态切换自动清理时用，不刷提示消息） */
function stopActionSilent(player: Player): void {
  player.clearAnimations();
  player.setSpecialAction(SpecialActionsEnum.NONE);
  activeActions.delete(player.id);
}

/** 播放动作：先清旧动作再播（对齐原版 /anim：ClearAnimations + SetPlayerSpecialAction(0)）。失败返回 false（已发提示） */
export function playAction(player: Player, id: number): boolean {
  if (id === 0) {
    stopAction(player);
    return true;
  }
  const def = ACTIONS.find((a) => a.id === id);
  if (!def) return false;
  const reason = canUseAction(player);
  if (reason) {
    player.sendClientMessage(COLOR_ERROR, reason);
    return false;
  }
  player.clearAnimations();
  player.setSpecialAction(SpecialActionsEnum.NONE);
  if (def.kind === "special") {
    player.setSpecialAction(def.special!);
  } else {
    // delta=4.1 快速过渡；loop 循环动画持续播放；lockX/lockY 锁位防走动打断；
    // freeze=0 / time=0（无限，循环由 loop 维持）；sync=0 不同步给其他玩家
    player.applyAnimation(
      def.lib!,
      def.anim!,
      4.1,
      def.loop ?? false,
      def.lockX ?? false,
      def.lockY ?? false,
      false,
      0,
      0,
    );
  }
  activeActions.set(player.id, id);
  player.sendClientMessage(COLOR_SUCCESS, `已播放动作「${def.name}」，按 F 或 /anim 0 清除`);
  return true;
}

/** 动作选择对话框（分页列表）：首项「清除动作」，选中即播放/清除；取消返回上一级 */
export async function openActionMenu(player: Player, back?: MenuBack): Promise<void> {
  const res = await showPagedDialog(player, {
    caption: "动作",
    headers: ["编号", "动作"],
    data: MENU_ITEMS,
    pageSize: 10,
    format: (item) => [item.id.toString().padStart(2, "0"), item.name],
    button2: "返回",
  });
  if (!res) return back?.();
  playAction(player, res.item.id);
}

/**
 * 动作清理钩子：玩家离开安全状态（进车/上下车过渡/死亡/观战）时静默清除动作——
 * 防止动作残留在车内/尸体/观战目标上（SA 客户端在车内/死亡后动作本就异常）。
 * 统一在 onStateChange 一处处理，各模式切换无需各自清动作。
 */
export function initActionCleanup(): void {
  PlayerEvent.onStateChange(({ player, newState, next }) => {
    if (newState !== PlayerStateEnum.ONFOOT && newState !== PlayerStateEnum.SPAWNED) {
      try {
        stopActionSilent(player);
      } catch {
        /* 断线瞬时的 native 调用可能已失效，忽略 */
      }
    }
    return next();
  });
}

/** /anim 命令（保留原版调用方式）：
 *  /anim 无参 / /anim help → 打开动作选择列表（分页）
 *  /anim <1-21> → 播放指定动作
 *  /anim 0 / /anim off → 清除动作 */
export function initActionCommands(): void {
  PlayerEvent.onCommandText("anim", ({ player, subcommand, next }) => {
    if (isPlayerLocked(player.id) || !getAuthState(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "当前流程中不可操作");
      return next();
    }
    const arg = subcommand[0];
    if (!arg || arg === "help") {
      void openActionMenu(player);
      return next();
    }
    if (arg === "off") {
      stopAction(player);
      return next();
    }
    const id = Number(arg);
    if (!Number.isInteger(id)) {
      player.sendClientMessage(
        COLOR_ERROR,
        `用法: /anim <1-${ACTIONS.length}> 播放动作 · /anim 0 清除 · /anim 无参打开列表`,
      );
      return next();
    }
    if (id < 0 || id > ACTIONS.length) {
      player.sendClientMessage(COLOR_ERROR, `动作 ID 范围 1-${ACTIONS.length}（0 清除）`);
      return next();
    }
    playAction(player, id);
    return next();
  });
}
