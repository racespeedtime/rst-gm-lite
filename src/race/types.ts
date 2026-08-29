import type { TextDraw } from "@infernus/core";
import type { Player } from "@infernus/core";

/** 比赛房间状态 */
export type RaceRoomState = "WAITING" | "COUNTDOWN" | "RACING" | "FINISHED";

/** 玩家比赛状态（含圈数进度） */
export interface PlayerRace {
  roomId: number;
  cpIndex: number; // 当前已通过的最大 CP 下标（-1 = 未过任何 CP）
  lap: number; // 当前圈（0 = 第一圈，laps-1 = 最后一圈）
  startTime: number;
  finished: boolean;
  /** 挑战等级限时已超时（挑战失败标记）：不踢出，可继续跑完，完成时展示扣分 */
  timeUp?: boolean;
  /** 当前名次（0-based，tickRooms 排名计算写入）。60fps TD 刷新（syncRaceTds）
   * 只读该缓存——排名计算要做距离采样+排序，200ms 足够，高频刷新不重算 */
  rank?: number;
  /** 加入比赛前的世界（开赛切独立世界，离开/结束时恢复） */
  prevWorld: number;
  /** 过 CP 后（脚本执行完）的状态快照，按"比赛累计 CP 序号"索引：
   *  k = lap × 一圈CP数 + cpIndex（跨圈瞬间 cpIndex=-1、lap++，公式仍指向该 CP）。
   *  记录 cveh 换车后的车型 + time/weather 脚本结果——重生多回退一格时
   *  恢复目标 CP 触达后的状态（对齐"回放式状态回撤"，否则车模型/时间天气残留）。 */
  cpSnapshots: CpSnapshot[];
}

/** 触达一个 CP 并执行完脚本后的状态快照（回退重生恢复用） */
export interface CpSnapshot {
  vehModel: number; // 过该 CP 后玩家座驾车型（cveh 换车后的）
  hour: number;
  minute: number;
  weather: number;
}

/** 比赛信息 UI（对齐原版 CreatePRaceTextDraw 的 4 行独立 TD） */
export interface RoomRaceTds {
  cp: TextDraw; //   C  P / ~p~进度~w~/~y~总数
  time: TextDraw; // TIME / mm:ss.cc（挑战限时模式显示剩余倒计时，超时红色负数）
  best: TextDraw; // BEST / mm:ss.cc（无记录 99:99:99）
  rank: TextDraw; // RANK / N st/nd/rd/th
}

/** 比赛房间 */
export interface RaceRoom {
  id: number;
  raceId: string;
  raceName: string;
  authorName: string; // 赛道作者名（CP 脚本 #aname 变量，创建时预载避免逐脚本查库）
  laps: number; // 圈数（赛道配置）
  worldId: number; // 比赛独立世界（开赛时成员切换）
  ownerId: number;
  ownerUserId: string; // 房主 userId（重连恢复房主身份用）
  state: RaceRoomState;
  members: Map<number, Player>;
  cps: {
    index: number;
    id: string;
    x: number;
    y: number;
    z: number;
    angle: number;
    size: number;
    scripts: string[];
  }[];
  results: { playerId: number; time: number; name: string }[];
  /** 挂机检测：playerId -> 上次采样位置 + 已静止累计毫秒（仅 RACING 检测；
   *  对齐原版 AFKTimes 每秒位移 <0.001 累计 45 秒移出赛道） */
  afk: Map<number, { x: number; y: number; z: number; idleMs: number }>;
  /** 最近一次 tickRooms 采样的成员位置（200ms 更新；掉线快照兜底——onDisconnect 时
   *  Player.getInstance 可能已失效取不到坐标，用最近采样位置恢复重连定位） */
  lastPositions: Map<number, { x: number; y: number; z: number }>;
  endTimer?: NodeJS.Timeout;
  /** 每个成员的比赛信息 TextDraw（playerId -> 4 行 TD，开赛时创建） */
  raceTextTds: Map<number, RoomRaceTds>;
  /** 比赛信息 TD 文本缓存（playerId -> 上次显示文本，成员与观战者各一条）。
   *  60fps 高频刷新只对变化的内容 setString——静态/稳定段零 native 调用。
   *  timeCs：上次显示的厘秒（秒表跳表去重，60fps 下大多数 tick 厘秒未变，
   *  提前比较跳过 formatRaceTime 的格式化开销）
   *  timeColor：TIME TD 当前颜色（挑战限时倒计时按剩余阈值变色，只变时 setColor） */
  tdTextCache: Map<number, { time: string; rank: string; timeCs: number; timeColor: number }>;
  /** 赛道个人最佳缓存（userId -> 最佳毫秒，开赛时查一次；重连复用） */
  bestTimes: Map<string, number>;
  /** 完成结果索引（playerId -> time），避免每 tick 线性查找 */
  resultIndex: Map<number, number>;
  /** 创建时间（WAITING 超时回收） */
  createdAt: number;
  /** 掉线重连：userId -> 重连截止时间戳（窗口内不清理）。
   *  用 userId 而非 playerId 作 key：掉线期间 playerId 可能被新连接复用，
   *  新玩家若命中旧窗口会劫持旧玩家的进度/名次/房主。 */
  reconnectUntil: Map<string, number>;
  /** 掉线重连：userId -> 断线时进度快照（含距下一 CP 距离——掉线玩家按快照
   *  继续参与实时/最终排名，车停在原地被超越）。slot.playerId 为掉线时的
   *  playerId：重连成功且 id 变化时用它把挂起的录制会话迁移到新 playerId；
   *  超时落盘时也用它找挂起会话 */
  reconnectSlots: Map<
    string,
    {
      playerId: number;
      cpIndex: number;
      lap: number;
      startTime: number;
      prevWorld: number;
      dist: number;
      name: string;
      /** 掉线瞬间位置：重连是全新连接（跳过 spawnPlayer/出生定位），须恢复到此
       *  位置（配合 prevWorld 战局归属），否则玩家重连后出现在默认出生点 */
      x: number;
      y: number;
      z: number;
      /** 掉线瞬间原战局 id（callbacks 在 handlePlayerDisconnect 前快照）。sessionId
       *  自增不复用——重连时按它精确匹配原战局（worldId 会被解散战局回收复用，
       *  按 worldId 可能塞进无关新战局） */
      sessionId?: number;
    }
  >;
  /** 本场比赛参与过录制的成员（playerId → userId 快照：房间销毁且无人完成时
   *  据此作废其未完成录像。存 userId 而非在线查 auth——掉线/重连超时者 auth
   *  已清，离线作废依赖此快照） */
  raceMembersLast: Map<number, string>;
  /** 开赛时按房主设置定的房间统一时间天气（重连玩家是新连接，恢复用；
   *  CP 脚本改时间天气后由脚本路径直接 setTime/setWeather，不更新此缓存） */
  roomTime: { hour: number; minute: number };
  roomWeather: number;
  /** 挑战等级（level_data 原文，房主开赛前选择，null=本场无挑战限时） */
  challengeLevelData?: string | null;
  /** 挑战等级所选档位秒数上限：0=未选（开赛前弹选择），-1=已明确"无挑战"（不再弹），>0=该档限时秒数 */
  challengeTierSeconds: number;
  /** 挑战失败扣分（failed_score_fix，纯展示） */
  failedScoreFix: number;
}
