import { Player } from "@infernus/core";
import { IPacket, PacketIdList } from "@infernus/raknet";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { setTimeoutSafe } from "@/core/timers";
import { deleteRecordingFile, readPendingIndex, writePendingIndex, RECORDING_DIR } from "./storage";
import { initReplayCommands } from "./commands";
import {
  initRecorder,
  cleanupRecorder,
  forceStopRecording,
  isRecording,
  getRecording,
  startRecording,
  stopRecording,
} from "./recorder";
import {
  cleanupPlayback,
  destroyAllPlaybacks,
  stopReplaySession,
  getReplaySession,
  isReplayNpc,
} from "./playback";
import {
  initChallenge,
  destroyAllChallenges,
  challengeDisconnect,
  cleanupChallenge,
} from "./challenge";
import { ensureRecordingDir, cleanupOrphanFiles } from "./storage";

/**
 * 回放系统总入口：
 * - GameMode.onInit 建录制目录 + 清理孤儿文件/.tmp 残留
 * - initReplayCommands 注册命令；initRecorder 挂 RakNet 拦截 + 兜底采样
 * - initChallenge 注册影子挑战 CP 检测（与比赛共用 RaceCpEvent 入口）
 * - onExit 销毁全部回放/挑战会话/NPC/车辆 + 录制强制落盘
 */

/** 初始化回放系统（callbacks init 序列调用） */
export function initReplay(): void {
  ensureRecordingDir();
  // 启动清理 + 补建：
  // 1. 先补建待落库索引（上一轮退出/DB 失败时文件已落盘但记录未确认的录像）——
  //    对每条：文件已不存在 → 删条目；DB 已有该 fileName（含软删）→ 删条目；
  //    否则 create 建记录，成功删条目。补建后才进孤儿清理，防补建过的文件被误删
  // 2. 再清孤儿回放文件（DB 无记录且不在索引）与 .tmp 残留
  void (async () => {
    try {
      const pending = readPendingIndex();
      if (pending.length > 0) {
        logger.info(`[replay] 待落库索引 ${pending.length} 条，开始补建 DB 记录`);
        const existing = await prisma.replay.findMany({
          where: { fileName: { in: pending.map((p) => p.fileName) } },
          select: { fileName: true, trackIndex: true },
        });
        // 多轨道共享 fileName：已存在判定按 fileName+trackIndex 联合（同一文件的
        // 不同轨道互不覆盖，各自补建）
        const existingKeys = new Set(existing.map((r) => `${r.fileName}#${r.trackIndex ?? ""}`));
        const remaining: typeof pending = [];
        for (const entry of pending) {
          try {
            if (!existsSync(join(RECORDING_DIR, entry.fileName))) {
              logger.warn(`[replay] 补建跳过：文件不存在 ${entry.fileName}`);
              continue; // 文件没了，条目随之丢弃
            }
            if (existingKeys.has(`${entry.fileName}#${entry.trackIndex ?? ""}`)) {
              logger.warn(
                `[replay] 补建跳过：DB 已有记录 ${entry.fileName} 轨道 ${entry.trackIndex ?? "-"}`,
              );
              continue; // 记录已存在（含软删），条目丢弃
            }
            await prisma.replay.create({ data: entry });
            logger.info(`[replay] 补建落库 ${entry.fileName} 轨道 ${entry.trackIndex ?? "-"}`);
          } catch (e) {
            // 单条失败保留条目（下次启动再试），其余继续
            remaining.push(entry);
            logger.error(`[replay] 补建失败 ${entry.fileName}`, e);
          }
        }
        writePendingIndex(remaining);
      }
      // 补建期间可能有录制完成并 addPendingEntry（运行期并发）——重新读合并，
      // 防 writePendingIndex(remaining) 把新条目覆盖丢（其 create 若恰失败则变孤儿）
      const merged = readPendingIndex();
      const recorded = await prisma.replay.findMany({
        where: { deletedAt: null },
        select: { fileName: true },
      });
      const names = new Set(recorded.map((r) => r.fileName));
      // 孤儿清理 keep 集 = DB 有效记录 + 待落库索引条目：补建失败（remaining 还在
      // 索引里）的文件必须保留，否则同批孤儿扫描会把它删掉 → 下次启动补建
      // "文件不存在"条目丢弃，录像永久丢失
      for (const entry of merged) {
        names.add(entry.fileName);
      }
      cleanupOrphanFiles([...names]);
    } catch (e) {
      logger.error(`[replay] 孤儿文件扫描失败`, e);
    }
  })();
  initReplayCommands();
  initRecorder();
  initChallenge();
  // 屏蔽回放 NPC 的真实 sync 包：回放驱动改为 emulateIncomingPacket 模拟
  // DriverSync 传入（emulate 的包不会进 onIncomingPacket 回调），但 NPC 自身/
  // 残留状态（putInVehicle/setVehiclePos immediate 等）可能发真实 sync，
  // 会与模拟广播冲突（位置/速度打架）——直接丢弃不交给游戏处理。
  // Pawn.RakNet 修复版约定：return false(0) = 舍弃该包（不交给游戏/后续 handler）。
  // IPacket 是 samp.on 事件注册（与 PlayerEvent 同构），模块导入期注册即有效。
  try {
    IPacket(PacketIdList.DriverSync, ({ playerId, next }) => {
      if (isReplayNpc(playerId)) return false; // 舍弃（不转发给游戏）
      return next();
    });
    IPacket(PacketIdList.OnFootSync, ({ playerId, next }) => {
      if (isReplayNpc(playerId)) return false;
      return next();
    });
  } catch (e) {
    logger.warn(`[replay] 回放 NPC sync 屏蔽注册失败`, e);
  }
  logger.info("[replay] 回放系统已初始化");
}

/** 玩家断线清理（callbacks onDisconnect 调用）：录制强制落盘 + 回放/挑战会话销毁 */
export function cleanupReplay(playerId: number): void {
  if (isRecording(playerId)) {
    void forceStopRecording(playerId);
  }
  cleanupPlayback(playerId);
  challengeDisconnect(playerId);
}

/**
 * 玩家离开当前活动状态（进入比赛/房间切换）：停止其回放会话 + 影子挑战。
 * 比赛中 /rp 命令被白名单拦截无法主动停回放，且挑战世界与比赛世界隔离——
 * 不清理会留下挂机 ghost（进比赛时自动清理，防 ghost 残留/挑战残留）。
 */
export function stopReplayForPlayer(playerId: number): void {
  if (getReplaySession(playerId)) {
    stopReplaySession(playerId);
  }
  cleanupChallenge(playerId);
}

/**
 * 比赛自动录制钩子（room.ts 调用）：
 * startRace/beginRace 时对每个成员开启录制（type=race）；endRoom 时停止。
 * raceRoomId 记录所属房间：房间销毁/结束收尾时校验归属，防跨房间误停误丢。
 */
export function raceRecordingStart(
  playerId: number,
  opts?: { raceId?: string; raceName?: string; raceRoomId?: number },
): void {
  // 玩家正在自定义（ghost）录制中进比赛：先落盘保存（forceStopRecording 对
  // ghost 是直接丢弃——玩家辛苦录的长段漂移会静默丢失），再开比赛录制
  const cur = getRecording(playerId);
  if (cur && !cur.suspended && cur.type === "ghost") {
    void stopRecording(playerId, { quiet: true });
  } else {
    void forceStopRecording(playerId); // 防残留（重复开赛/重连）
  }
  const p = Player.getInstance(playerId);
  if (!p || !p.isConnected()) return;
  void startRecording(p, {
    type: "race",
    raceId: opts?.raceId ?? null,
    raceName: opts?.raceName ?? null,
    raceRoomId: opts?.raceRoomId ?? null,
  });
}

/** 比赛结束/离开时停止录制（落盘 + 元数据含名次） */
export function raceRecordingStop(
  playerId: number,
  meta?: { rank?: number | null; finished?: boolean | null },
): void {
  if (isRecording(playerId)) {
    void stopRecording(playerId, { quiet: true, ...meta });
  }
}

/**
 * 作废一次已落盘的比赛回放（整场无人完成）：删录像文件 + 软删 DB 记录。
 * 用于"房间销毁且无人完成"和"掉线重连成功删掉线段"——删除前留 800ms
 * 让刚触发的 stopRecording 落盘完成（断线走 forceStopRecording 是异步的，
 * 立即查可能查到旧记录）。raceRoomId 精确匹配本场房间（比赛房间 id 服务端
 * 递增不复用）：防误删"有人完成的比赛里掉线玩家的保留段"（那部分 rank 同样
 * 为 null，若按 userId+raceId+rank=null 最近一条会删错）。旧录像无
 * raceRoomId → 无法精确匹配，回退按 userId+raceId 取最近一条（rank=null）。
 * userId 为可选快照（room.raceMembersLast 存）：掉线/重连超时玩家 auth 已清，
 * 必须靠快照才能离线作废其未完成录像，否则文件 + DB 记录永久泄漏。
 */
export function discardRaceReplay(
  playerId: number,
  raceId?: string | null,
  userId?: string,
  raceRoomId?: number | null,
): void {
  setTimeoutSafe(async () => {
    // 优先用快照 userId；无快照（历史调用）回退在线 auth
    const uid = userId ?? getAuthState(playerId)?.userId;
    if (!uid) return;
    try {
      // 精确匹配本场房间（raceRoomId 递增不复用，本场唯一）。旧录像（无
      // raceRoomId）回退 userId+raceId+rank=null 最近一条——历史数据作废
      const row = await prisma.replay.findFirst({
        where: {
          userId: uid,
          type: "race",
          deletedAt: null,
          ...(raceId ? { raceId } : {}),
          ...(raceRoomId != null ? { raceRoomId } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
      // 只作废"未完成"段（rank==null）；有 rank 说明该段有人冲线，保留。
      // v9 多轨道文件是混合 rank（完成者行有 rank、未完成者 rank=null）——仅当
      // 该文件**所有**行都 rank=null（整场无人完成）才整场作废；否则只作废当前
      // 玩家自己的未完成行，不碰文件里完成者的轨道
      if (!row || row.rank != null) return;
      const sameFile = await prisma.replay.findMany({
        where: { fileName: row.fileName, deletedAt: null },
        select: { id: true, rank: true },
      });
      if (sameFile.some((r) => r.rank != null)) {
        // 文件里有人完成：只软删当前玩家这一行，保留文件与完成者轨道
        await prisma.replay.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
        return;
      }
      deleteRecordingFile(row.fileName);
      // 整场无人完成：软删所有共享该文件的行（整场作废），防残留孤儿行
      await prisma.replay.updateMany({
        where: { fileName: row.fileName, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      logger.info(
        `[replay] 作废无人完成的比赛回放 ${row.fileName}（playerId=${playerId} room=${raceRoomId ?? "?"}）`,
      );
    } catch (e) {
      logger.error(`[replay] 作废比赛回放失败 playerId=${playerId}`, e);
    }
  }, 800);
}

/** 服务器退出：全部回放/挑战销毁 + 录制落盘 */
export function shutdownReplay(): void {
  destroyAllPlaybacks();
  destroyAllChallenges();
  void cleanupRecorder();
}
