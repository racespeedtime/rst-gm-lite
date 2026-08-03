import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { sessionManager } from "./manager";
import { PUBLIC_SESSION_ID } from "./session";
import { getSetting } from "@/personalize/settings";
import { openSessionSettingsMenu } from "@/personalize/sessionSettings";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import type { MenuBack } from "@/core/panel";

import { COLOR_ERROR } from "@/utils/colors";

/** 按用户名查找在线玩家（大小写不敏感，排除 NPC） */
function findOnlinePlayer(name: string): Player | undefined {
  return Player.getInstances().find(
    (p) => !p.isNpc() && p.isConnected() && p.getName().name.toLowerCase() === name.toLowerCase(),
  );
}

/**
 * 战局菜单（万能面板入口之一）
 * 1. 加入战局  2. 创建私人战局  3. 回到公共大世界  4. 返回自身战局  5. 我的战局管理  6. 战局设置
 */
export async function openSessionMenu(player: Player, back?: MenuBack): Promise<void> {
  const items: { label: string; run: () => Promise<void> }[] = [];
  items.push({
    label: "加入战局",
    run: () => joinSessionFlow(player, () => openSessionMenu(player, back)),
  });
  items.push({
    label: "创建私人战局",
    run: () => createSessionFlow(player, () => openSessionMenu(player, back)),
  });
  items.push({
    label: "回到公共大世界",
    run: async () => {
      const current = sessionManager.getPlayerSession(player);
      if (current.id === PUBLIC_SESSION_ID) {
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
        // 路由到 createSession：内部找到已有战局静默加入 + 提示"已回到你的战局"，
        // 不再给自己广播"加入了战局"的重复提示
        await sessionManager.createSession(player, mine.name, mine.password);
      },
    });
  }
  const current = sessionManager.getPlayerSession(player);
  if (current.id !== PUBLIC_SESSION_ID && sessionManager.isOwner(player, current)) {
    items.push({
      label: "我的战局管理",
      run: () => openOwnerMenu(player, () => openSessionMenu(player, back)),
    });
  }
  // 战局设置（原一级菜单并入）：自身战局类型/密码/启动进入方式
  items.push({
    label: "战局设置",
    run: () => openSessionSettingsMenu(player, () => openSessionMenu(player, back)),
  });

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
  if (!res) return; // 断线直接退出
  if (res.response !== 1) return back?.(); // 取消 → 返回上一层（万能面板）
  await items[res.listItem].run();
}

/** 加入战局流程（分页） */
async function joinSessionFlow(player: Player, back?: MenuBack): Promise<void> {
  const list = sessionManager.listJoinableSessions(player);
  if (list.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "当前没有可加入的战局，你可以创建一个");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "加入战局",
    data: list,
    format: (s) =>
      `${s.name}（${s.memberCount}/${s.capacity}人）${s.password ? "【需要密码】" : ""}`,
    button1: "加入",
    button2: "取消",
  });
  if (!r) return back?.();
  const target = r.item;
  if (!target.password) {
    const result = await sessionManager.joinSession(player, target);
    if (!result.ok) player.sendClientMessage(COLOR_ERROR, result.reason!);
    return back?.();
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
  if (!pwdRes) return;
  if (pwdRes.response !== 1) return back?.();
  const result = await sessionManager.joinSession(player, target, pwdRes.inputText);
  if (!result.ok) {
    player.sendClientMessage(COLOR_ERROR, result.reason!);
  }
  return back?.();
}

/** 创建私人战局流程（尊重战局设置：sessionType=PRIVATE 时应用设置的密码） */
async function createSessionFlow(player: Player, back?: MenuBack): Promise<void> {
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
  if (!nameRes) return;
  if (nameRes.response !== 1) return back?.();
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
    if (!pwdRes) return;
    if (pwdRes.response !== 1) return back?.();
    if (pwdRes.inputText) {
      password = pwdRes.inputText;
    }
  }
  await sessionManager.createSession(player, name, password);
}

/** 房主管理菜单：设置密码 / 踢人 / 邀请 */
async function openOwnerMenu(player: Player, back?: MenuBack): Promise<void> {
  const items: { label: string; run: () => Promise<void> }[] = [
    {
      label: "设置战局密码",
      run: () => setPasswordFlow(player, () => openOwnerMenu(player, back)),
    },
    { label: "踢人", run: () => kickMemberFlow(player, () => openOwnerMenu(player, back)) },
    { label: "邀请玩家", run: () => inviteFlow(player, () => openOwnerMenu(player, back)) },
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
  if (!res) return;
  if (res.response !== 1) return back?.();
  await items[res.listItem].run();
}

/** 设置战局密码 */
async function setPasswordFlow(player: Player, back?: MenuBack): Promise<void> {
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
  if (!res) return;
  if (res.response !== 1) return back?.();
  const result = await sessionManager.setPassword(player, res.inputText.trim() || null);
  if (!result.ok) player.sendClientMessage(COLOR_ERROR, result.reason!);
  return back?.();
}

/** 踢人流程（分页） */
async function kickMemberFlow(player: Player, back?: MenuBack): Promise<void> {
  const session = sessionManager.getPlayerSession(player);
  const others = sessionManager.getMembers(session).filter((p) => p.id !== player.id);
  if (others.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "战局内没有其他成员");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "踢人",
    data: others,
    format: (p) => p.getName().name,
    button1: "踢出",
    button2: "取消",
  });
  if (!r) return back?.();
  const target = r.item;
  const result = await sessionManager.kickMember(player, target);
  if (!result.ok) player.sendClientMessage(COLOR_ERROR, result.reason!);
  return back?.();
}

/** 邀请玩家流程 */
async function inviteFlow(player: Player, back?: MenuBack): Promise<void> {
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
  if (!res) return;
  if (res.response !== 1) return back?.();
  const target = findOnlinePlayer(res.inputText.trim());
  if (!target) {
    player.sendClientMessage(COLOR_ERROR, "未找到该在线玩家");
    return back?.();
  }
  if (target.id === player.id) {
    player.sendClientMessage(COLOR_ERROR, "不能邀请自己");
    return back?.();
  }
  const result = await sessionManager.inviteMember(player, target);
  if (!result.ok) player.sendClientMessage(COLOR_ERROR, result.reason!);
  return back?.();
}
