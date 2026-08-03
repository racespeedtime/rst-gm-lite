import { NetStats, Player, TextDraw } from "@infernus/core";

const WHITE = 0xffffffff;
const YELLOW = 0xffd700ff;
const RED = 0xff0000ff;
// SA-MP TextDraw 颜色是 0xRRGGBBAA（字节序），GREEN 应为 R=00,G=FF,B=00,A=FF。
// 原值 16711935 = 0x00FF00FF（不透明绿）；曾有"等价重构"写成 0xff00ff00
// = A=0 全透明 → ping≤80（绿色档）时数字不可见，只有 ping 消失。
const GREEN = 0x00ff00ff;

/** 网络信息 GUI 状态（用于计算速率） */
export interface NetstatState {
  tds: TextDraw[];
  lastBytesSent: number;
  lastMessagesSent: number;
  lastBytesRec: number;
  lastMessagesRec: number;
}

/**
 * 创建网络信息 GUI：11 个 TextDraw（移植自原 RST 项目）
 * 布局：上行速率 / 下行速率 / ping（chit 图标+数字）/ LOSS（数字）/ 底部 box
 */
export function createNetstat(player: Player): NetstatState {
  const tds: TextDraw[] = [];
  const add = (td: TextDraw) => tds.push(td);

  // 上行速率
  add(
    new TextDraw({ player, x: 265.93, y: 0.62, text: "0.00KB/s 0pkt/s" })
      .create()
      .setLetterSize(0.18, 0.9)
      .setAlignment(1)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(1)
      .setProportional(true),
  );
  add(
    new TextDraw({ player, x: 255.44, y: 2.58, text: "LD_BEAT:up" })
      .create()
      .setLetterSize(0, 0)
      .setTextSize(6, 6)
      .setAlignment(1)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(4)
      .setProportional(false),
  );
  // 下行速率
  add(
    new TextDraw({ player, x: 333.2, y: 0.65, text: "0.00KB/s 0pkt/s" })
      .create()
      .setLetterSize(0.18, 0.9)
      .setAlignment(1)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(1)
      .setProportional(true),
  );
  add(
    new TextDraw({ player, x: 322.7, y: 3.21, text: "LD_BEAT:down" })
      .create()
      .setLetterSize(0, 0)
      .setTextSize(6, 6)
      .setAlignment(1)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(4)
      .setProportional(false),
  );
  add(
    new TextDraw({ player, x: 259.73, y: 0.72, text: "LD_BEAT:up" })
      .create()
      .setLetterSize(0, 0)
      .setTextSize(6, 6)
      .setAlignment(1)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(4)
      .setProportional(false),
  );
  add(
    new TextDraw({ player, x: 326.9, y: 1.29, text: "LD_BEAT:down" })
      .create()
      .setLetterSize(0, 0)
      .setTextSize(6, 6)
      .setAlignment(1)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(4)
      .setProportional(false),
  );
  // 底部 box
  add(
    new TextDraw({ player, x: 329, y: 0, text: "box" })
      .create()
      .setLetterSize(0, 0.97)
      .setTextSize(0, 202)
      .setAlignment(2)
      .setColor(255)
      .useBox(true)
      .setBoxColors(130)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(1)
      .setProportional(true),
  );
  // ping chit 图标 + 数字
  add(
    new TextDraw({ player, x: 228.63, y: 1.56, text: "LD_BEAT:chit" })
      .create()
      .setLetterSize(0, 0)
      .setTextSize(5, 6)
      .setAlignment(1)
      .setColor(GREEN)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(4)
      .setProportional(false),
  );
  add(
    new TextDraw({ player, x: 234.03, y: 0.35, text: "0ms" })
      .create()
      .setLetterSize(0.18, 0.9)
      .setAlignment(1)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(1)
      .setProportional(true),
  );
  // LOSS 标签 + 数字
  add(
    new TextDraw({ player, x: 429.83, y: 0.44, text: "0%" })
      .create()
      .setLetterSize(0.18, 0.9)
      .setAlignment(3)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(1)
      .setProportional(true),
  );
  add(
    new TextDraw({ player, x: 410.87, y: 0.43, text: "LOSS" })
      .create()
      .setLetterSize(0.18, 0.9)
      .setAlignment(3)
      .setColor(WHITE)
      .setShadow(0)
      .setOutline(0)
      .setBackgroundColors(255)
      .setFont(3)
      .setProportional(true),
  );

  // baseline 快照为当前累计值：避免首次更新时把历史累计当成本秒速率（爆表）
  const state: NetstatState = {
    tds,
    lastBytesSent: NetStats.getBytesSent(player),
    lastMessagesSent: NetStats.getMessagesSent(player),
    lastBytesRec: NetStats.getBytesReceived(player),
    lastMessagesRec: NetStats.getMessagesReceived(player),
  };
  tds.forEach((t) => t.show(player));
  return state;
}

/** 刷新网络信息文本（速率 / ping 分级变色 / 丢包分级变色） */
export function updateNetstat(state: NetstatState, player: Player): void {
  const { tds } = state;
  // 与原版 updatePlayerNetWorkState 算法一致：差值 /1024 → KB/s（%.2f 两位小数），
  // 消息数差值 → pkt/s（%i 整数，不换算）
  const bytesSent = (NetStats.getBytesSent(player) - state.lastBytesSent) / 1024;
  const msgSent = NetStats.getMessagesSent(player) - state.lastMessagesSent;
  tds[0].setString(`${bytesSent.toFixed(2)}KB/s ${Math.round(msgSent)}pkt/s`);

  const bytesRec = (NetStats.getBytesReceived(player) - state.lastBytesRec) / 1024;
  const msgRec = NetStats.getMessagesReceived(player) - state.lastMessagesRec;
  tds[2].setString(`${bytesRec.toFixed(2)}KB/s ${Math.round(msgRec)}pkt/s`);

  const ping = player.getPing();
  // tds[7] 是 chit 图标、tds[8] 是 "0ms" 数字：变色应作用在数字上。
  // 必须 show：e9f2a84 曾删掉此处的 show，ping TD 仅靠 createNetstat 的一次性
  // show 撑——玩家重生/隐藏 GUI 开关往返后 TD 显示状态可能丢失，setString 只
  // 改文本不显示 → ping 消失（loss 行一直保留 show 所以正常）。补回并保持
  // 与 loss 一致的每帧 show（幂等，不影响其它 TD）
  tds[8].setColor(ping <= 80 ? GREEN : ping <= 130 ? YELLOW : RED);
  tds[8].setString(`${ping}ms`);
  tds[8].show(player);

  // loss 取整对齐原版 %.0f（四舍五入）；分级：<1 白 / 1-5 黄 / >5 红（黄档为增强）
  const loss = Math.round(NetStats.getPacketLossPercent(player));
  tds[9].setString(`${loss}%`);
  tds[9].setColor(loss < 1 ? WHITE : loss <= 5 ? YELLOW : RED);
  tds[9].show(player);

  state.lastBytesSent = NetStats.getBytesSent(player);
  state.lastMessagesSent = NetStats.getMessagesSent(player);
  state.lastBytesRec = NetStats.getBytesReceived(player);
  state.lastMessagesRec = NetStats.getMessagesReceived(player);
}

export function destroyNetstat(state: NetstatState): void {
  state.tds.forEach((t) => {
    if (t.isValid()) t.destroy();
  });
}
