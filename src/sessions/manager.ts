import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getSpawnGroundZ } from "@/core/colandreas";
import { isInRace } from "@/race/room";
import { isEditing } from "@/race/editor";
import { isPlayerLocked } from "@/core/interaction";
import { Session, SESSION_COLOR, PUBLIC_SESSION_ID, PUBLIC_WORLD_ID } from "./session";
import { PREFIX } from "@/utils/msg";

/** 断线理由文案（SA-MP disconnect reason 下标：0=掉线/超时崩溃 1=正常退出 2=Kick/Ban，
 *  对齐原版 disconnectReasons 格式；未知 reason 不加后缀） */
const DISCONNECT_REASONS = ["(掉线)", "(正常退出)", "(Kick/Ban)"] as const;

/** 公共大世界人数上限（不限制） */
const PUBLIC_CAPACITY = Number.MAX_SAFE_INTEGER;

export class SessionManager {
  /** 公共大世界（战局 id=0，world=0） */
  readonly publicWorld: Session;
  /** 所有私人战局（id>=1） */
  private readonly privateSessions = new Map<number, Session>();
  /** 玩家当前所在战局 id */
  private readonly playerSessions = new Map<number, number>();
  /** 战局 id 与 world id 分配器 */
  private nextSessionId = 1;
  private nextWorldId = 1;
  /** 已解散战局回收的 world id（复用防无界增长：战局频繁创建/解散，
   *  极端在线 1000 人 worldId 最多到 1000，与比赛世界（RACE_WORLD_BASE=1001）
   *  边界不冲突；回收复用仍保留防异常） */
  private freedWorldIds: number[] = [];
  /** 缓存出生点，用于加入战局时的传送 */
  private spawnPoints: { x: number; y: number; z: number; angle: number }[] | null = null;

  constructor() {
    this.publicWorld = new Session({
      id: PUBLIC_SESSION_ID,
      worldId: PUBLIC_WORLD_ID,
      name: "公共大世界",
      ownerUserId: null,
      password: null,
      capacity: PUBLIC_CAPACITY,
    });
  }

  /** 获取玩家当前所在战局（默认公共大世界） */
  getPlayerSession(player: Player): Session {
    const sid = this.playerSessions.get(player.id);
    return this.privateSessions.get(sid ?? -1) ?? this.publicWorld;
  }

  /** 战局内成员（含玩家自身） */
  getMembers(session: Session): Player[] {
    return [...session.members.values()];
  }

  /** 玩家的战局是否为其所有（房主） */
  isOwner(player: Player, session: Session): boolean {
    if (session.ownerUserId === null) return false;
    return session.ownerUserId === this.getOwnerUserId(player);
  }

  private getOwnerUserId(player: Player): string {
    return getAuthState(player.id)?.userId ?? "";
  }

  /** 懒加载出生点 */
  private async loadSpawnPoints(): Promise<{ x: number; y: number; z: number; angle: number }[]> {
    if (!this.spawnPoints) {
      const rows = await prisma.spawnPoint.findMany({ orderBy: { index: "asc" } });
      this.spawnPoints = rows.map((r) => ({
        x: Number(r.x),
        y: Number(r.y),
        z: Number(r.z),
        angle: Number(r.angle),
      }));
    }
    return this.spawnPoints;
  }

  /** 传送到随机出生点并切换世界（Z 用 colandreas 修正防卡建筑；车辆同步切世界，防人车分离） */
  private async teleportTo(player: Player, worldId: number): Promise<void> {
    const veh = player.isInAnyVehicle() ? player.getVehicle() : undefined;
    player.setVirtualWorld(worldId);
    if (veh) {
      veh.setVirtualWorld(worldId);
      veh.linkToInterior(player.getInterior());
    }
    const points = await this.loadSpawnPoints();
    if (points.length > 0) {
      const p = points[Math.floor(Math.random() * points.length)];
      // Z 修正：colandreas 找实际地面（防卡建筑/半身入地/被抬到遮挡物顶）
      const z = getSpawnGroundZ(p.x, p.y, p.z);
      player.setPos(p.x, p.y, z);
      player.setFacingAngle(p.angle);
    }
  }

  /** 玩家认证成功后进入游戏世界（默认公共大世界） */
  onPlayerAuthenticated(player: Player): void {
    this.publicWorld.members.set(player.id, player);
    this.playerSessions.set(player.id, PUBLIC_SESSION_ID);
    // 通知公共大世界内的其他玩家（登录广播）；本人由"欢迎回来"等提示覆盖，不重复发
    this.publicWorld.broadcastOthers(
      `${PREFIX.session} ${player.getName().name} 进入了公共大世界`,
      player,
    );
  }

  /**
   * 玩家离开当前战局（统一从 publicWorld.members 与私人战局移除）。
   * 若 notify 为 true 且当前在私人战局，通知战局内成员。
   */
  private leaveCurrentSession(player: Player, notify: boolean): void {
    this.publicWorld.members.delete(player.id);
    const sid = this.playerSessions.get(player.id);
    if (sid != null && sid !== PUBLIC_SESSION_ID) {
      const session = this.privateSessions.get(sid);
      if (session) {
        session.members.delete(player.id);
        if (notify) {
          session.broadcast(`${PREFIX.session} ${player.getName().name} 离开了战局`);
        }
        // 空战局回收：房主离开/被踢后 0 人战局立即删除，防 privateSessions 无界增长，
        // 且 findOwnedSession 命中旧空局导致房主永远无法创建新战局
        if (session.members.size === 0) {
          this.privateSessions.delete(sid);
          this.freedWorldIds.push(session.worldId); // 回收战局 world id 供复用
        }
      }
    }
    this.playerSessions.delete(player.id);
  }

  /** 玩家进入公共大世界 */
  async joinPublicWorld(player: Player): Promise<void> {
    const current = this.getPlayerSession(player);
    if (current.id === PUBLIC_SESSION_ID) return;
    // 离开当前私人战局（含从 publicWorld 移除/加回）
    this.leaveCurrentSession(player, true);
    this.publicWorld.members.set(player.id, player);
    this.playerSessions.set(player.id, PUBLIC_SESSION_ID);
    await this.teleportTo(player, PUBLIC_WORLD_ID);
    // 通知公共大世界内的其他玩家（本人由"你已回到..."覆盖，不重复发）
    this.publicWorld.broadcastOthers(
      `${PREFIX.session} ${player.getName().name} 回到了公共大世界`,
      player,
    );
    player.sendClientMessage(SESSION_COLOR, `你已回到${this.publicWorld.name}`);
  }

  /** 列出当前可加入的私人战局（未满、玩家未在其中） */
  listJoinableSessions(player: Player): Session[] {
    return [...this.privateSessions.values()].filter((s) => !s.isFull && !s.has(player));
  }

  /** 加入战局（有密码时校验） */
  async joinSession(
    player: Player,
    session: Session,
    password?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    // 幂等：已在目标战局直接返回——否则"回到已有战局"（createSession 命中
    // findOwnedSession）会先 leaveCurrentSession 把自己唯一成员的战局解散
    //（释放 worldId），随后又加回 → 幽灵战局 + worldId 复用冲突
    if (session.has(player)) return { ok: true };
    if (session.isFull) return { ok: false, reason: "战局已满" };
    if (session.password && session.password !== password) {
      return { ok: false, reason: "战局密码错误" };
    }
    // 目标正在比赛/编辑中：加入战局会把玩家拉出比赛世界（悬空比赛状态 + 幽灵世界）
    if (isInRace(player.id) || isEditing(player.id)) {
      return { ok: false, reason: "目标正在比赛/编辑中，无法加入战局" };
    }
    // 无论当前在哪（公共大世界或私人战局），统一先离开
    this.leaveCurrentSession(player, true);
    session.members.set(player.id, player);
    this.playerSessions.set(player.id, session.id);
    await this.teleportTo(player, session.worldId);
    // 加入提示：默认全员可见但排除本人（本人由成功提示覆盖）；silentSelf 时同样排除
    const name = player.getName().name;
    session.broadcastOthers(`${PREFIX.session} ${name} 加入了战局`, player);
    player.sendClientMessage(SESSION_COLOR, `你已加入战局「${session.name}」`);
    return { ok: true };
  }

  /** 创建私人战局并加入（成为房主） */
  async createSession(player: Player, name: string, password: string | null): Promise<Session> {
    // 若已有自己的战局则先加入它（防止重复创建）
    const mine = this.findOwnedSession(player);
    if (mine) {
      // 回到已有战局：静默加入（自己不看"加入了"），其他成员仍可见
      await this.joinSession(player, mine);
      player.sendClientMessage(SESSION_COLOR, `已回到你的战局「${mine.name}」`);
      return mine;
    }
    const session = new Session({
      id: this.nextSessionId++,
      // 优先复用已解散战局释放的 world id；无则分配新 id（防无界增长撞比赛世界）
      worldId: this.freedWorldIds.pop() ?? this.nextWorldId++,
      name: name || `${player.getName().name} 的战局`,
      ownerUserId: this.getOwnerUserId(player),
      password,
    });
    this.privateSessions.set(session.id, session);
    // 静默加入：房主不需要"加入了战局"提示（下面"创建成功，你是房主"已覆盖）
    const joined = await this.joinSession(player, session);
    // 加入失败（比赛/编辑中拦截等）必须回收：战局已登记但玩家没进去，
    // 会留下 0 人、房主不在、无人可清理的幽灵战局（除非房主断线）
    if (!joined.ok) {
      this.privateSessions.delete(session.id);
      this.freedWorldIds.push(session.worldId); // 归还 world id 供复用
      player.sendClientMessage(SESSION_COLOR, `战局创建失败：${joined.reason ?? "未知原因"}`);
      throw new Error(`createSession 加入失败: ${joined.reason ?? "未知"}`);
    }
    player.sendClientMessage(SESSION_COLOR, `战局「${session.name}」创建成功，你是房主`);
    return session;
  }

  /** 查找玩家拥有的私人战局 */
  findOwnedSession(player: Player): Session | undefined {
    const ownerId = this.getOwnerUserId(player);
    if (!ownerId) return undefined;
    return [...this.privateSessions.values()].find((s) => s.ownerUserId === ownerId);
  }

  /** 房主踢人（被踢者回到公共大世界） */
  async kickMember(owner: Player, target: Player): Promise<{ ok: boolean; reason?: string }> {
    const session = this.getPlayerSession(owner);
    if (!this.isOwner(owner, session) || session.id === PUBLIC_SESSION_ID) {
      return { ok: false, reason: "你不是房主" };
    }
    if (target.id === owner.id) return { ok: false, reason: "不能踢自己" };
    if (!session.has(target)) return { ok: false, reason: "目标不在战局内" };
    // 目标在比赛/编辑中：踢出会拉出比赛世界（悬空比赛状态 + 幽灵世界），拒绝
    if (isInRace(target.id) || isEditing(target.id)) {
      return { ok: false, reason: "目标正在比赛/编辑中，无法移出" };
    }
    session.broadcast(`${PREFIX.session} ${target.getName().name} 被房主移出了战局`);
    // 被踢者回到公共大世界
    this.leaveCurrentSession(target, false);
    this.publicWorld.members.set(target.id, target);
    this.playerSessions.set(target.id, PUBLIC_SESSION_ID);
    await this.teleportTo(target, PUBLIC_WORLD_ID);
    target.sendClientMessage(SESSION_COLOR, `你已被移出战局「${session.name}」`);
    return { ok: true };
  }

  /** 房主邀请玩家（目标弹确认对话框） */
  async inviteMember(owner: Player, target: Player): Promise<{ ok: boolean; reason?: string }> {
    const session = this.getPlayerSession(owner);
    if (!this.isOwner(owner, session) || session.id === PUBLIC_SESSION_ID) {
      return { ok: false, reason: "你不是房主" };
    }
    if (session.isFull) return { ok: false, reason: "战局已满" };
    if (session.has(target)) return { ok: false, reason: "对方已在战局内" };
    // 目标正在比赛/编辑中：拉出会破坏比赛状态
    if (isInRace(target.id) || isEditing(target.id)) {
      return { ok: false, reason: "对方正在比赛/编辑中" };
    }
    // 目标在别的流程（面板/对话框）中：邀请框会覆盖其当前对话框造成状态错乱
    if (isPlayerLocked(target.id)) {
      return { ok: false, reason: "对方正在操作中，稍后再试" };
    }
    // 弹确认对话框给目标玩家
    try {
      const res = await new Dialog({
        style: DialogStylesEnum.MSGBOX,
        caption: "战局邀请",
        info: `${owner.getName().name} 邀请你加入战局「${session.name}」\n是否加入？`,
        button1: "加入",
        button2: "拒绝",
      }).show(target);
      if (res && res.response === 1) {
        await this.joinSession(target, session);
      }
    } catch {
      return { ok: false, reason: "对方无响应" };
    }
    return { ok: true };
  }

  /** 设置战局密码（房主操作，空串清除密码） */
  async setPassword(
    owner: Player,
    password: string | null,
  ): Promise<{ ok: boolean; reason?: string }> {
    const session = this.getPlayerSession(owner);
    if (!this.isOwner(owner, session) || session.id === PUBLIC_SESSION_ID) {
      return { ok: false, reason: "你不是房主" };
    }
    session.password = password && password.length > 0 ? password : null;
    session.broadcast(
      password ? `${PREFIX.session} 房主已设置战局密码` : `${PREFIX.session} 房主已清除战局密码`,
    );
    return { ok: true };
  }

  /**
   * 按战局 id 恢复玩家战局归属（比赛掉线重连用）。
   * 掉线时玩家已被移出战局（战局可能已解散）；重连后把玩家登记回原战局
   * （若仍存在），否则回公共大世界。
   * 返回是否加入了私人战局（供调用方决定 prevWorld 是否有效）。
   * 按 sessionId 匹配而非 worldId：worldId 会被解散战局回收复用（重连窗口内新
   * 战局可能占用同号 → 按 worldId 会把玩家塞进无关新战局）；sessionId 自增
   * 不复用，战局仍存在则必然命中原战局，不存在复用错配。
   */
  rejoinPlayerSession(player: Player, sessionId: number): boolean {
    this.publicWorld.members.delete(player.id);
    this.playerSessions.delete(player.id);
    const session = this.privateSessions.get(sessionId);
    if (session && !session.isFull) {
      session.members.set(player.id, player);
      this.playerSessions.set(player.id, session.id);
      return true;
    }
    this.publicWorld.members.set(player.id, player);
    this.playerSessions.set(player.id, PUBLIC_SESSION_ID);
    return false;
  }

  /** 处理玩家掉线：移出所在战局，房主掉线则转移或解散。
   *  reason：SA-MP disconnect reason（0=掉线/超时崩溃 1=正常退出 2=Kick/Ban），
   *  广播带理由后缀（对齐原版 disconnectReasons 文案）。 */
  handlePlayerDisconnect(player: Player, reason: number): void {
    const current = this.getPlayerSession(player);
    // 统一从 publicWorld.members 移除（防幽灵成员）
    this.publicWorld.members.delete(player.id);
    this.playerSessions.delete(player.id);
    if (current.id === PUBLIC_SESSION_ID) {
      return;
    }
    const name = player.getName().name;
    const suffix = DISCONNECT_REASONS[reason] ?? "";
    current.members.delete(player.id);
    if (current.members.size === 0) {
      // 没其他人 → 解散战局
      this.privateSessions.delete(current.id);
      this.freedWorldIds.push(current.worldId); // 回收战局 world id 供复用
      logger.info(`[session] 战局「${current.name}」已解散（成员全部离开）`);
      return;
    }
    // 房主掉线 → 随机转移给其他成员
    if (current.ownerUserId === this.getOwnerUserId(player)) {
      const members = [...current.members.values()];
      const next = members[Math.floor(Math.random() * members.length)];
      current.ownerUserId = this.getOwnerUserId(next);
      current.broadcast(
        `${PREFIX.session} 房主 ${name} 已离开${suffix}，${next.getName().name} 成为新房主`,
      );
      logger.info(
        `[session] 战局「${current.name}」房主 ${name} 离开，转移给 ${next.getName().name}`,
      );
    } else {
      current.broadcast(`${PREFIX.session} ${name} 离开了战局${suffix}`);
    }
  }
}

/** 全局单例 */
export const sessionManager = new SessionManager();
