import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { sessionManager } from "./manager";
import { getSetting } from "@/personalize/settings";
import { showDialog } from "@/utils/dialog";

import { COLOR_ERROR } from "@/utils/colors";

/** 按用户名查找在线玩家 */
function findOnlinePlayer(name: string): Player | undefined {
  return Player.getInstances().find((p) => p.getName().name === name);
}

/**
 * 战局菜单（万能面板入口之一）
 * 1. 加入战局  2. 创建私人战局  3. 回到公共大世界  4. 返回自身战局  5. 我的战局管理
 */
export async function openSessionMenu(player: Player): Promise<void> {
  const items: { label: string; run: () => Promise<void> }[] = [];
  items.push({ label: "加入战局", run: () => joinSessionFlow(player) });
  items.push({ label: "创建私人战局", run: () => createSessionFlow(player) });
  items.push({
    label: "回到公共大世界",
    run: async () => {
      const current = sessionManager.getPlayerSession(player);
      if (current.id === 0) {
        player.sendClientMessage(COLOR_ERROR, "你已经在公共大世界");
        return;
      }
      await sessionManager.joinPublicWorld(player);
    },
  });
  if (sessionManager.findOwnedSession(player)) {
    items.push({
      label: "返回自身战局",
      run: async () => {
        const mine = sessionManager.findOwnedSession(player)!;
        if (sessionManager.getPlayerSession(player).id === mine.id) {
          player.sendClientMessage(COLOR_ERROR, "你已经在自己的战局中");
          return;
        }
        await sessionManager.joinSession(player, mine);
      },
    });
  }
  const current = sessionManager.getPlayerSession(player);
  if (current.id !== 0 && sessionManager.isOwner(player, current)) {
    items.push({ label: "我的战局管理", run: () => openOwnerMenu(player) });
  }

  const info = items.map((item, i) => `${i + 1}. ${item.label}`).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "战局",
      info,
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res || res.response !== 1) return;
  await items[res.listItem].run();
}

/** 加入战局流程 */
async function joinSessionFlow(player: Player): Promise<void> {
  const list = sessionManager.listJoinableSessions(player);
  if (list.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "当前没有可加入的战局，你可以创建一个");
    return;
  }
  const info = list
    .map(
      (s, i) =>
        `${i + 1}. ${s.name}（${s.memberCount}/${s.capacity}人）${s.password ? "【需要密码】" : ""}`,
    )
    .join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "加入战局",
      info,
      button1: "加入",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const target = list[res.listItem];
  if (!target) return;
  if (!target.password) {
    const result = await sessionManager.joinSession(player, target);
    if (!result.ok) player.sendClientMessage(COLOR_ERROR, result.reason!);
    return;
  }
  // 需要密码
  const pwdRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.PASSWORD,
      caption: "加入战局",
      info: `战局「${target.name}」需要密码：`,
      button1: "加入",
      button2: "取消",
    }),
  );
  if (!pwdRes || pwdRes.response !== 1) return;
  const result = await sessionManager.joinSession(player, target, pwdRes.inputText);
  if (!result.ok) {
    player.sendClientMessage(COLOR_ERROR, result.reason!);
  }
}

/** 创建私人战局流程（尊重战局设置：sessionType=PRIVATE 时应用设置的密码） */
async function createSessionFlow(player: Player): Promise<void> {
  // 战局名（可空 → 默认）
  const nameRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "创建私人战局",
      info: "输入战局名称（留空使用默认名称）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!nameRes || nameRes.response !== 1) return;
  const name = nameRes.inputText.trim();
  // 战局设置：sessionType=PRIVATE 时直接应用已设置的密码（无需再询问）
  const setting = await getSetting(player);
  if (setting?.sessionType === "PRIVATE") {
    await sessionManager.createSession(player, name, setting.sessionPassword ?? null);
    return;
  }
  // 是否设置密码
  const pwdAsk = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "创建私人战局",
      info: "是否为战局设置密码？",
      button1: "设置",
      button2: "不设",
    }),
  );
  if (!pwdAsk) return;
  let password: string | null = null;
  if (pwdAsk.response === 1) {
    const pwdRes = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.PASSWORD,
        caption: "创建私人战局",
        info: "输入战局密码：",
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!pwdRes || pwdRes.response !== 1) return;
    if (pwdRes.inputText) {
      password = pwdRes.inputText;
    }
  }
  await sessionManager.createSession(player, name, password);
}

/** 房主管理菜单：设置密码 / 踢人 / 邀请 */
async function openOwnerMenu(player: Player): Promise<void> {
  const items: { label: string; run: () => Promise<void> }[] = [
    { label: "设置战局密码", run: () => setPasswordFlow(player) },
    { label: "踢人", run: () => kickMemberFlow(player) },
    { label: "邀请玩家", run: () => inviteFlow(player) },
  ];
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "我的战局管理",
      info: items.map((item, i) => `${i + 1}. ${item.label}`).join("\n"),
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res || res.response !== 1) return;
  await items[res.listItem].run();
}

/** 设置战局密码 */
async function setPasswordFlow(player: Player): Promise<void> {
  const session = sessionManager.getPlayerSession(player);
  const current = session.password ? `（当前已设置密码）` : "（当前无密码）";
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.PASSWORD,
      caption: "设置战局密码",
      info: `输入新密码${current}\n留空则清除密码：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const result = await sessionManager.setPassword(player, res.inputText.trim() || null);
  if (!result.ok) player.sendClientMessage(COLOR_ERROR, result.reason!);
}

/** 踢人流程 */
async function kickMemberFlow(player: Player): Promise<void> {
  const session = sessionManager.getPlayerSession(player);
  const others = sessionManager.getMembers(session).filter((p) => p.id !== player.id);
  if (others.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "战局内没有其他成员");
    return;
  }
  const info = others.map((p, i) => `${i + 1}. ${p.getName().name}`).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "踢人",
      info,
      button1: "踢出",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const target = others[res.listItem];
  if (!target) return;
  const result = await sessionManager.kickMember(player, target);
  if (!result.ok) player.sendClientMessage(COLOR_ERROR, result.reason!);
}

/** 邀请玩家流程 */
async function inviteFlow(player: Player): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "邀请玩家",
      info: "输入要邀请的玩家用户名：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const target = findOnlinePlayer(res.inputText.trim());
  if (!target) {
    player.sendClientMessage(COLOR_ERROR, "未找到该在线玩家");
    return;
  }
  if (target.id === player.id) {
    player.sendClientMessage(COLOR_ERROR, "不能邀请自己");
    return;
  }
  const result = await sessionManager.inviteMember(player, target);
  if (!result.ok) player.sendClientMessage(COLOR_ERROR, result.reason!);
}
