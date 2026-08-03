import { Player } from "@infernus/core";

export const SESSION_COLOR = "#ffcc00";
const DEFAULT_CAPACITY = 20;

/** 公共大世界战局 id（公共大世界 = 战局 id 0，世界 worldId 0） */
export const PUBLIC_SESSION_ID = 0;
/** 公共大世界 world id（玩家/实体切回公共大世界时 setVirtualWorld 的目标） */
export const PUBLIC_WORLD_ID = 0;

/**
 * 战局（房间/世界）。
 * - 公共大世界：单例，worldId=0，无房主，不限制人数
 * - 私人战局：worldId>=1，有房主，上限 DEFAULT_CAPACITY 人，可设密码
 * 隔离通过 open.mp 的 virtual world 实现。
 */
export class Session {
  readonly id: number;
  readonly worldId: number;
  name: string;
  ownerUserId: string | null; // null = 公共大世界
  password: string | null;
  readonly capacity: number;
  readonly members = new Map<number, Player>();

  constructor(opts: {
    id: number;
    worldId: number;
    name: string;
    ownerUserId: string | null;
    password: string | null;
    capacity?: number;
  }) {
    this.id = opts.id;
    this.worldId = opts.worldId;
    this.name = opts.name;
    this.ownerUserId = opts.ownerUserId;
    this.password = opts.password;
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
  }

  get isPublic(): boolean {
    return this.ownerUserId === null;
  }

  get memberCount(): number {
    return this.members.size;
  }

  get isFull(): boolean {
    return this.members.size >= this.capacity;
  }

  /** 向战局内所有成员发送文字（含进出提示等） */
  broadcast(message: string): void {
    for (const p of this.members.values()) {
      p.sendClientMessage(SESSION_COLOR, message);
    }
  }

  /** 向战局内除指定玩家外的所有成员发送文字（进出提示不发给本人） */
  broadcastOthers(message: string, except?: Player): void {
    for (const p of this.members.values()) {
      if (p.id !== except?.id) {
        p.sendClientMessage(SESSION_COLOR, message);
      }
    }
  }

  /** 战局内是否包含指定玩家 */
  has(player: Player): boolean {
    return this.members.has(player.id);
  }
}
