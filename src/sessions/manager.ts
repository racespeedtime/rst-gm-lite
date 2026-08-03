import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getSafeGroundZ } from "@/core/colandreas";
import { Session, SESSION_COLOR } from "./session";

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
  /** 缓存出生点，用于加入战局时的传送 */
  private spawnPoints: { x: number; y: number; z: number; angle: number }[] | null = null;

  constructor() {
    this.publicWorld = new Session({
      id: 0,
      worldId: 0,
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
      const z = getSafeGroundZ(p.x, p.y, p.z);
      player.setPos(p.x, p.y, z);
      player.setFacingAngle(p.angle);
    }
  }

  /** 玩家认证成功后进入游戏世界（默认公共大世界） */
  onPlayerAuthenticated(player: Player): void {
    this.publicWorld.members.set(player.id, player);
    this.playerSessions.set(player.id, 0);
  }

  /**
   * 玩家离开当前战局（统一从 publicWorld.members 与私人战局移除）。
   * 若 notify 为 true 且当前在私人战局，通知战局内成员。
   */
  private leaveCurrentSession(player: Player, notify: boolean): void {
    this.publicWorld.members.delete(player.id);
    const sid = this.playerSessions.get(player.id);
    if (sid != null && sid !== 0) {
      const session = this.privateSessions.get(sid);
      if (session) {
        session.members.delete(player.id);
        if (notify) {
          session.broadcast(`[战局] ${player.getName().name} 离开了战局`);
        }
      }
    }
    this.playerSessions.delete(player.id);
  }

  /** 玩家进入公共大世界 */
  async joinPublicWorld(player: Player): Promise<void> {
    const current = this.getPlayerSession(player);
    if (current.id === 0) return;
    // 离开当前私人战局（含从 publicWorld 移除/加回）
    this.leaveCurrentSession(player, true);
    this.publicWorld.members.set(player.id, player);
    this.playerSessions.set(player.id, 0);
    await this.teleportTo(player, 0);
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
    /** 加入提示不发给加入者本人（房主创建/回到自己的战局时用，避免"自己加入了"的重复提示） */
    silentSelf = false,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (session.isFull) return { ok: false, reason: "战局已满" };
    if (session.password && session.password !== password) {
      return { ok: false, reason: "战局密码错误" };
    }
    // 无论当前在哪（公共大世界或私人战局），统一先离开
    this.leaveCurrentSession(player, true);
    session.members.set(player.id, player);
    this.playerSessions.set(player.id, session.id);
    await this.teleportTo(player, session.worldId);
    // 加入提示：默认全员可见；silentSelf 时不发给本人（本人由"创建成功/已回到"提示覆盖）
    const name = player.getName().name;
    if (silentSelf) {
      for (const p of session.members.values()) {
        if (p.id !== player.id) {
          p.sendClientMessage(SESSION_COLOR, `[战局] ${name} 加入了战局`);
        }
      }
    } else {
      session.broadcast(`[战局] ${name} 加入了战局`);
    }
    return { ok: true };
  }

  /** 创建私人战局并加入（成为房主） */
  async createSession(player: Player, name: string, password: string | null): Promise<Session> {
    // 若已有自己的战局则先加入它（防止重复创建）
    const mine = this.findOwnedSession(player);
    if (mine) {
      // 回到已有战局：静默加入（自己不看"加入了"），其他成员仍可见
      await this.joinSession(player, mine, undefined, true);
      player.sendClientMessage(SESSION_COLOR, `已回到你的战局「${mine.name}」`);
      return mine;
    }
    const session = new Session({
      id: this.nextSessionId++,
      worldId: this.nextWorldId++,
      name: name || `${player.getName().name} 的战局`,
      ownerUserId: this.getOwnerUserId(player),
      password,
    });
    this.privateSessions.set(session.id, session);
    // 静默加入：房主不需要"加入了战局"提示（下面"创建成功，你是房主"已覆盖）
    await this.joinSession(player, session, undefined, true);
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
    if (!this.isOwner(owner, session) || session.id === 0) {
      return { ok: false, reason: "你不是房主" };
    }
    if (target.id === owner.id) return { ok: false, reason: "不能踢自己" };
    if (!session.has(target)) return { ok: false, reason: "目标不在战局内" };
    session.broadcast(`[战局] ${target.getName().name} 被房主移出了战局`);
    // 被踢者回到公共大世界
    this.leaveCurrentSession(target, false);
    this.publicWorld.members.set(target.id, target);
    this.playerSessions.set(target.id, 0);
    await this.teleportTo(target, 0);
    target.sendClientMessage(SESSION_COLOR, `你已被移出战局「${session.name}」`);
    return { ok: true };
  }

  /** 房主邀请玩家（目标弹确认对话框） */
  async inviteMember(owner: Player, target: Player): Promise<{ ok: boolean; reason?: string }> {
    const session = this.getPlayerSession(owner);
    if (!this.isOwner(owner, session) || session.id === 0) {
      return { ok: false, reason: "你不是房主" };
    }
    if (session.isFull) return { ok: false, reason: "战局已满" };
    if (session.has(target)) return { ok: false, reason: "对方已在战局内" };
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
    if (!this.isOwner(owner, session) || session.id === 0) {
      return { ok: false, reason: "你不是房主" };
    }
    session.password = password && password.length > 0 ? password : null;
    session.broadcast(password ? `[战局] 房主已设置战局密码` : `[战局] 房主已清除战局密码`);
    return { ok: true };
  }

  /**
   * 按世界恢复玩家战局归属（比赛掉线重连用）。
   * 掉线时玩家已被移出战局（战局可能已解散）；重连后把玩家登记回
   * prevWorld 对应的战局（若仍存在），否则回公共大世界。
   * 返回是否加入了私人战局（供调用方决定 prevWorld 是否有效）。
   */
  rejoinPlayerSessionByWorld(player: Player, worldId: number): boolean {
    this.publicWorld.members.delete(player.id);
    this.playerSessions.delete(player.id);
    const session = [...this.privateSessions.values()].find((s) => s.worldId === worldId);
    if (session && !session.isFull) {
      session.members.set(player.id, player);
      this.playerSessions.set(player.id, session.id);
      return true;
    }
    this.publicWorld.members.set(player.id, player);
    this.playerSessions.set(player.id, 0);
    return false;
  }

  /** 处理玩家掉线：移出所在战局，房主掉线则转移或解散 */
  handlePlayerDisconnect(player: Player): void {    const current = this.getPlayerSession(player);
    // 统一从 publicWorld.members 移除（防幽灵成员）
    this.publicWorld.members.delete(player.id);
    this.playerSessions.delete(player.id);
    if (current.id === 0) {
      return;
    }
    const name = player.getName().name;
    current.members.delete(player.id);
    if (current.members.size === 0) {
      // 没其他人 → 解散战局
      this.privateSessions.delete(current.id);
      logger.info(`[session] 战局「${current.name}」已解散（成员全部离开）`);
      return;
    }
    // 房主掉线 → 随机转移给其他成员
    if (current.ownerUserId === this.getOwnerUserId(player)) {
      const members = [...current.members.values()];
      const next = members[Math.floor(Math.random() * members.length)];
      current.ownerUserId = this.getOwnerUserId(next);
      current.broadcast(`[战局] 房主 ${name} 已掉线，${next.getName().name} 成为新房主`);
      logger.info(
        `[session] 战局「${current.name}」房主 ${name} 掉线，转移给 ${next.getName().name}`,
      );
    } else {
      current.broadcast(`[战局] ${name} 离开了战局`);
    }
  }
}

/** 全局单例 */
export const sessionManager = new SessionManager();
