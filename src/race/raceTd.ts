import { Player, TextDraw } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getObserveTarget, isObserving } from "@/core/observe";
import { formatRaceTimeCs } from "@/utils/format";
import type { RaceRoom, RoomRaceTds } from "./types";
import { rooms, playerRaces } from "./state";

/**
 * 比赛信息 UI（对齐原版 CreatePRaceTextDraw 的 4 行独立 TD）：
 * 创建/销毁/高频刷新。CP/BEST 由事件驱动更新；TIME/RANK 由 tickRooms（200ms）
 * 写缓存、本模块 60fps 按缓存重放（秒表跳表去重，稳定段零 native）。
 */

function raceTdBase(player: Player, y: number, text: string): TextDraw {
  return new TextDraw({ player, x: 500, y, text })
    .create()
    .setFont(2)
    .setLetterSize(0.238, 1.19)
    .setAlignment(1)
    .setColor(0xffffffff)
    .setOutline(0)
    .setShadow(1)
    .setProportional(true);
}

/** TIME TD 颜色（对齐 MSG_COLOR：白=正常计时、黄=限时告急、红=已超时） */
export const TIME_COLOR_NORMAL = 0xffffffff;
export const TIME_COLOR_WARN = 0xffffff00;
export const TIME_COLOR_OVER = 0xffff5555;

/** 限时告急阈值（剩余 ≤ 此毫秒 → 黄色） */
const LIMIT_WARN_MS = 10_000;

/** 创建比赛信息 UI（每人 4 行独立 TD，位置与原版一致：x 500 左缘，y 118/136/154/172） */
export function createRaceTd(player: Player, room: RaceRoom): RoomRaceTds {
  const tds: RoomRaceTds = {
    cp: raceTdBase(player, 118, `C  P / ~p~1~w~/~y~${room.cps.length}`),
    time: raceTdBase(player, 136, "TIME / 00:00:00"),
    best: raceTdBase(player, 154, "BEST / 00:00:00"),
    rank: raceTdBase(player, 172, "RANK / 1 st"),
  };
  Object.values(tds).forEach((t) => t.show(player));
  room.raceTextTds.set(player.id, tds);
  return tds;
}

/** 排名后缀（对齐原版 RANK / %i st/nd/rd/th） */
export function rankSuffix(rank: number): string {
  const n = rank + 1;
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

/** 查询赛道个人最佳并更新 BEST TD（对齐原版进比赛时 Race_GetPlayerRecord：
 * 无记录显示 BEST / 99:99:99，有记录显示 BEST / mm:ss.cc）。房间级缓存，只查一次。 */
export async function updateBestTd(
  player: Player,
  room: RaceRoom,
  tds: RoomRaceTds,
): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  try {
    let best = room.bestTimes.get(auth.userId);
    if (best === undefined) {
      const rec = await prisma.raceRecord.findFirst({
        where: { userId: auth.userId, raceId: room.raceId, deletedAt: null },
        orderBy: { record: "asc" },
      });
      best = rec ? rec.record : -1;
      room.bestTimes.set(auth.userId, best);
    }
    // DB 查询为异步：查询期间玩家可能已掉线（TD 被 infernus 自动销毁）或
    // 已离开比赛——setString 前守卫 isValid，防 async 续体对失效 TD 抛错
    if (tds.best.isValid()) {
      tds.best.setString(best === -1 ? "BEST / 99:99:99" : `BEST / ${formatRaceTimeCs(best)}`);
    }
  } catch (e) {
    logger.error(`[race] 查询个人最佳失败 ${player.getName().name}`, e);
  }
}

/** 销毁房间所有比赛信息 TD（防未创建/已失效的 TD destroy 抛异常） */
export function destroyRaceTds(room: RaceRoom): void {
  for (const tds of room.raceTextTds.values()) {
    for (const td of Object.values(tds)) {
      if (td.isValid()) {
        td.destroy();
      }
    }
  }
  room.raceTextTds.clear();
  room.tdTextCache.clear();
}

/** 写比赛信息 TD 文本 + 更新文本缓存（去重：相同文本不重复 setString）。
 * 成员与观战者共用：cache 按 playerId 记录上次显示的文本，60fps 高频刷新
 * 只对变化的内容调 native——静态/稳定段零开销。
 * timeText 传 null 表示跳过 TIME（挑战限时模式 TIME 由 syncRaceTds 独占） */
export function setRaceTdText(
  room: RaceRoom,
  playerId: number,
  timeText: string | null,
  rankText: string,
): void {
  const tds = room.raceTextTds.get(playerId);
  if (!tds) return;
  // TD 可能已被销毁但 Map 条目残留（如掉线瞬间 infernus 自动销毁玩家 TD 后
  // 清理中断）——setString 前守卫 isValid，防止定时器对已销毁 TD 无限抛错
  if (!tds.time.isValid() || !tds.rank.isValid()) return;
  let cache = room.tdTextCache.get(playerId);
  if (!cache) {
    cache = { time: "", rank: "", timeCs: -1, timeColor: TIME_COLOR_NORMAL };
    room.tdTextCache.set(playerId, cache);
  }
  if (timeText != null && timeText !== cache.time) {
    cache.time = timeText;
    tds.time.setString(timeText);
  }
  if (rankText !== cache.rank) {
    cache.rank = rankText;
    tds.rank.setString(rankText);
  }
}

/**
 * 限时倒计时文本：剩余 = 限时 - 已用。剩余 ≥ 0 → 正数 mm:ss.cc；已超时 → 红色
 * 负数 -mm:ss.cc（超出限时的量）。仅挑战限时（challengeTierSeconds>0）时调用。
 */
export function formatLimitCountdown(
  limitMs: number,
  elapsedMs: number,
): {
  text: string;
  color: number;
} {
  const remain = limitMs - elapsedMs;
  if (remain >= 0) {
    // 正数：mm:ss.cc（不补毫秒前缀），黄色告急
    const m = Math.floor(remain / 60000);
    const s = Math.floor((remain % 60000) / 1000);
    const cs = Math.floor((remain % 1000) / 10);
    return {
      text: `TIME / ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(cs).padStart(2, "0")}`,
      color: remain <= LIMIT_WARN_MS ? TIME_COLOR_WARN : TIME_COLOR_NORMAL,
    };
  }
  // 负数：-mm:ss.cc（超出量），红色
  const over = -remain;
  const m = Math.floor(over / 60000);
  const s = Math.floor((over % 60000) / 1000);
  const cs = Math.floor((over % 1000) / 10);
  return {
    text: `TIME / -${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(cs).padStart(2, "0")}`,
    color: TIME_COLOR_OVER,
  };
}

/** TIME TD 同步颜色（只在颜色变化时调 setColor，去重） */
function setTimeColor(tds: RoomRaceTds, cache: { timeColor: number }, color: number): void {
  if (cache.timeColor !== color) {
    cache.timeColor = color;
    if (tds.time.isValid()) tds.time.setColor(color);
  }
}

/** 60fps 比赛信息 TD 高频刷新（对齐回放观战的平滑效果）：TIME 实时推进跳表。
 * 排名由 tickRooms（200ms）计算写入 mp.rank / tdTextCache，本函数只按缓存重放
 * 文本——不做距离采样/排序，内容未变零 native 调用（cache 去重），仅 RACING
 * 房间参与（WAITING/COUNTDOWN/FINISHED 直接跳过，空转开销忽略）。
 * 成员刷自己的计时；观战者刷被观战者的计时（其 TD 缓存由 tickRooms 写入，
 * 这里按被观战者 startTime 重算同值） */
export function syncRaceTds(): void {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state !== "RACING") continue;
    // 成员本人：TIME 实时推进（finished 定格在 tickRooms 写入的完成时间）。
    // 观战中的成员跳过：其 TD 显示被观战者的信息（下面观战循环写），否则
    // 60fps 会用自己的时间覆盖掉 tickRooms 写入的被观战者时间——出现"自己的
    // 时间 + 别人的名次"错乱。
    // 挑战限时（challengeTierSeconds>0）：TIME 显示剩余倒计时（超时红色负数），
    // 已完成者定格为最终用时（白色），未完成者倒计时。
    const limitMs = room.challengeTierSeconds > 0 ? room.challengeTierSeconds * 1000 : 0;
    for (const m of room.members.values()) {
      const mp = playerRaces.get(m.id);
      const tds = room.raceTextTds.get(m.id);
      const cache = room.tdTextCache.get(m.id);
      if (!mp || !tds || !cache || mp.finished || isObserving(m.id)) continue;
      // 60fps 热路径：TD 可能因掉线被 infernus 自动销毁（残留条目不命中上面
      // 的 !tds）——setString 前守卫 isValid，防对已销毁 TD 抛错刷屏
      if (!tds.time.isValid()) continue;
      // 秒表跳表：仅当显示值（厘秒）变化才格式化+setString——60fps 下大多数
      // tick 的厘秒没变，跳过能省下 formatRaceTime 的除法/padStart/模板串
      const cs = Math.floor((now - mp.startTime) / 10);
      if (cs !== cache.timeCs) {
        cache.timeCs = cs;
        if (limitMs > 0) {
          // 挑战限时：倒计时 + 按剩余变色
          const { text, color } = formatLimitCountdown(limitMs, now - mp.startTime);
          cache.time = text;
          tds.time.setString(text);
          setTimeColor(tds, cache, color);
        } else {
          const timeText = `TIME / ${formatRaceTimeCs(now - mp.startTime)}`;
          cache.time = timeText;
          tds.time.setString(timeText);
          setTimeColor(tds, cache, TIME_COLOR_NORMAL);
        }
      }
    }
    // 观战中的房内成员：同步被观战者（玩家）的 TIME（RANK 由 tickRooms 写入
    // 被观战者名次，两者一致）。只处理房内成员（tdTextCache 只为有房间 TD 的
    // 成员/观察者创建；房外观察者无本房 TD，本就没有 TD 可刷）。
    for (const pid of room.tdTextCache.keys()) {
      if (!isObserving(pid)) continue;
      const st = getObserveTarget(pid);
      if (!st || st.kind !== "player") continue;
      // 跨房间校验：房间 X 成员可能 /tv 观战别的房间的步行玩家，此时不能用
      // 目标房间 Y 的 startTime 写本房间 X 的 TD（"Y 的时间 + 自己的名次"错乱）
      const tmp = playerRaces.get(st.targetId);
      if (!tmp || tmp.roomId !== room.id) continue;
      const target = Player.getInstance(st.targetId);
      if (!target || !target.isConnected()) continue;
      const tds = room.raceTextTds.get(pid);
      const cache = room.tdTextCache.get(pid);
      if (!tds || !cache || tmp.finished) continue;
      if (!tds.time.isValid()) continue;
      const cs = Math.floor((now - tmp.startTime) / 10);
      if (cs !== cache.timeCs) {
        cache.timeCs = cs;
        if (limitMs > 0) {
          const { text, color } = formatLimitCountdown(limitMs, now - tmp.startTime);
          cache.time = text;
          tds.time.setString(text);
          setTimeColor(tds, cache, color);
        } else {
          const timeText = `TIME / ${formatRaceTimeCs(now - tmp.startTime)}`;
          cache.time = timeText;
          tds.time.setString(timeText);
          setTimeColor(tds, cache, TIME_COLOR_NORMAL);
        }
      }
    }
  }
}
