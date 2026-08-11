import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import {
  createRaceRoom,
  changeRoomTrack,
  startRace,
  leaveRace,
  isInRace,
  joinRoom,
  broadcastToRoom,
  findWaitingRoom,
  getRacePlayerState,
  getRaceRoom,
  UUID_RE,
} from "./room";
import {
  isEditing,
  enterRaceEdit,
  canEditRace,
  addCp,
  showEditMenu,
  exitEdit,
  getEditCpSize,
  setEditCpSize,
} from "./editor";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import { pickOption } from "@/personalize/settings";
import { isInChallenge, exitChallenge } from "@/replay/challenge";
import { openRaceDetailPanel } from "./manage";
import { sysMsg } from "@/utils/msg";

/**
 * 比赛命令/对话框层（UI）：/r 命令入口 + 赛道列表/信息/创建/编辑子命令。
 * 与比赛状态机（room.ts）分离：本文件只通过 room 的公开 API 交互，不碰内部 Map。
 */

async function startRaceFlow(player: Player, query: string): Promise<void> {
  if (!query) {
    // 无赛道名 → 打开赛道列表（对齐面板「赛道列表」，含排序与「全部随机」首行）
    void openRaceListDialog(player);
    return;
  }
  // 先按名字查（同名字符串，参数安全）；查不到且 query 形如 uuid 才按 id 查——
  // 不能直接用 OR: [{name},{id}]：id 是 uuid 列，非 uuid 字符串会让 PostgreSQL
  // 参数类型检查直接报错（invalid input syntax for type uuid），即使用户输入的是赛道名
  const race =
    (await prisma.race.findFirst({
      where: { isEnabled: true, deletedAt: null, name: query },
    })) ??
    (UUID_RE.test(query)
      ? await prisma.race.findFirst({
          where: { isEnabled: true, deletedAt: null, id: query },
        })
      : null);
  if (!race) {
    // 指定赛道不存在 → 打开赛道列表让玩家选（原版是弹列表；随机建房是
    // gm-lite 旧行为，与面板/命令对齐后改为列表——列表首行即有「全部随机」）
    sysMsg(player, "race", `未找到赛道「${query}」，请从列表选择`, "warn");
    void openRaceListDialog(player);
    return;
  }
  const room = await createRaceRoom(player, race.id);
  if (room) {
    // 创建后等待加入：房主再次 /r s 开始
    sysMsg(player, "race", "再输入 /r s 开始比赛", "info");
  }
}

/** 全部随机的占位赛道 id（列表首行：随机抽一张创建） */
const RANDOM_RACE_ID = "__RANDOM__";

/** 赛道列表排序参数（创建时间/名称/总长度 × 升降序） */
type RaceOrderBy =
  | { createdAt: "asc" | "desc" }
  | { name: "asc" | "desc" }
  | { totalLength: "asc" | "desc" };

/** 排序选择（赛道列表/更换赛道共用）：字段 + 方向两步 pickOption，
 *  任一步取消返回 null（对齐面板 raceListFlow 的交互） */
async function pickRaceSort(player: Player): Promise<RaceOrderBy | null> {
  const fieldIndex = await pickOption(player, "赛道列表 · 排序", [
    "按创建时间",
    "按名称",
    "按总长度",
  ]);
  if (fieldIndex < 0) return null;
  const dirIndex = await pickOption(player, "排序方向", ["升序", "降序"]);
  if (dirIndex < 0) return null;
  const dir = dirIndex === 0 ? "asc" : "desc";
  if (fieldIndex === 0) return { createdAt: dir };
  if (fieldIndex === 1) return { name: dir };
  return { totalLength: dir };
}

/** 查询启用赛道（分页选择共用：列表创建 + 换赛道 + 命令列表排序）。
 * orderBy 支持创建时间/名称/总长度 × 升降序（对齐面板「赛道列表」的排序） */
async function fetchEnabledRaces(
  orderBy: RaceOrderBy = {
    createdAt: "desc",
  },
): Promise<
  {
    id: string;
    name: string;
    totalLength: unknown;
    laps: number | null;
    sysUser: { username: string } | null;
  }[]
> {
  const races = await prisma.race.findMany({
    where: { isEnabled: true, deletedAt: null },
    // 名称排序由 JS 端做不区分大小写（DB 默认按字节序区分大小写，A 会排在 a 前）
    orderBy: "name" in orderBy ? undefined : orderBy,
    include: { sysUser: true },
  });
  // 名称排序：toLowerCase 后按码点比较——英文大小写混杂排列（ABC 与 abc 交错）；
  // 中文无大小写概念，toLowerCase 无副作用，排序结果与 DB 码点序一致
  if ("name" in orderBy) {
    races.sort((a, b) => {
      const la = a.name.toLowerCase();
      const lb = b.name.toLowerCase();
      const cmp = la < lb ? -1 : la > lb ? 1 : 0;
      return orderBy.name === "asc" ? cmp : -cmp;
    });
  }
  return races;
}

/**
 * /r 无参数 → 赛道列表对话框（对齐原版 Race_ShowGameMainSel 分页列表）。
 * 排序与面板「赛道列表」对齐：先选排序字段（创建时间/名称/总长度）→ 方向。
 * 首行「全部随机」→ 随机抽一张赛道创建房间；其余选中进赛道详情（与面板
 * 「赛道列表」一致：先看详情再决定开始比赛/回放/挑战/排行榜）。
 */
async function openRaceListDialog(player: Player): Promise<void> {
  // 排序选择（对齐面板 raceListFlow：字段 + 方向，取消则返回不弹列表）
  const orderBy = await pickRaceSort(player);
  if (!orderBy) return;
  const races = await fetchEnabledRaces(orderBy);
  if (races.length === 0) {
    sysMsg(player, "race", "暂无可用赛道", "error");
    return;
  }
  // 首行「全部随机」：id 用占位符，其余字段留空（format 按 id 分支）
  const data: (typeof races)[number][] = [
    { id: RANDOM_RACE_ID, name: "", totalLength: null, laps: null, sysUser: null },
    ...races,
  ];
  const r = await showPagedDialog(player, {
    caption: "选择赛道开始比赛",
    data,
    headers: ["#", "名称", "长度", "圈数", "作者"],
    format: (race, index) =>
      race.id === RANDOM_RACE_ID
        ? ["随", "全部随机（随机一张赛道）", "", "", ""]
        : [
            String(index),
            race.name,
            `${Math.round(Number(race.totalLength))}m`,
            `${race.laps ?? 1}`,
            race.sysUser?.username ?? "?",
          ],
    button1: "查看",
    button2: "取消",
  });
  if (!r) return;
  // 选中普通赛道 → 赛道详情（与面板「赛道列表」一致：先看详情再决定开始比赛/
  // 回放/挑战/排行榜，不再直接建房跳层）；「全部随机」无详情可言，保持直接
  // 随机建房。详情取消直接关闭，不弹回本列表（详情即目标面板）
  if (r.item.id === RANDOM_RACE_ID) {
    const room = await createRaceRoom(player, null);
    if (room) {
      sysMsg(player, "race", "再输入 /r s 开始比赛", "info");
    }
    return;
  }
  await openRaceDetailPanel(player, r.item.id);
}

/** 赛道选择器（换赛道/创建共用）：先选排序再分页选择返回选中赛道，取消返回 null */
async function showTrackPicker(
  player: Player,
  title: string,
  button: string,
): Promise<{ id: string } | null> {
  // 排序选择与赛道列表一致（对齐面板「更换赛道」也走 raceListFlow 的排序交互）
  const orderBy = await pickRaceSort(player);
  if (!orderBy) return null;
  const races = await fetchEnabledRaces(orderBy);
  if (races.length === 0) {
    sysMsg(player, "race", "暂无可用赛道", "error");
    return null;
  }
  const r = await showPagedDialog(player, {
    caption: title,
    data: races,
    headers: ["#", "名称", "长度", "圈数", "作者"],
    format: (race, index) => [
      String(index + 1),
      race.name,
      `${Math.round(Number(race.totalLength))}m`,
      `${race.laps ?? 1}`,
      race.sysUser?.username ?? "?",
    ],
    button1: button,
    button2: "取消",
  });
  if (!r) return null;
  return r.item;
}

/** 面板「更换赛道」：随机换一张 / 从列表选择（房主 + WAITING） */
export async function openChangeTrackMenu(
  player: Player,
  back?: () => void | Promise<void>,
): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "更换赛道",
      info: "1. 随机换一张\n2. 从列表选择",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  if (res.listItem === 0) {
    await changeRoomTrack(player);
  } else if (res.listItem === 1) {
    const race = await showTrackPicker(player, "选择新赛道", "更换");
    if (race) {
      await changeRoomTrack(player, race.id);
    }
  }
  return back?.();
}

/** 加入房间流程 */
function joinRoomFlow(player: Player): void {
  // 已在比赛中：直接提示而非静默踢出——joinRoom 会对已参赛玩家 leaveRace，
  // 正在跑的比赛进度/录像/排名会被无声放弃
  if (isInRace(player.id)) {
    sysMsg(player, "race", "你已在比赛中，先 /r l 离开后再加入其他房间", "warn");
    return;
  }
  const room = findWaitingRoom();
  if (!room) {
    sysMsg(player, "race", "当前没有等待中的比赛房间", "error");
    return;
  }
  void joinRoom(player, room).then(() => {
    broadcastToRoom(room, `${player.getName().name} 加入了比赛`);
  });
}

/** 赛道详情（/r info）：按名字或 id 查赛道 → 打开详情面板
 *（基本信息 + 开始比赛/影子挑战/排行榜/编辑/删除，与赛车管理菜单共用） */
async function showRaceInfo(player: Player, query: string): Promise<void> {
  const race =
    (await prisma.race.findFirst({
      where: { isEnabled: true, deletedAt: null, name: query },
    })) ??
    (UUID_RE.test(query)
      ? await prisma.race.findFirst({
          where: { isEnabled: true, deletedAt: null, id: query },
        })
      : null);
  if (!race) {
    sysMsg(player, "race", `未找到赛道「${query}」`, "error");
    return;
  }
  await openRaceDetailPanel(player, race.id);
}

/** 创建赛道（/r create）：名字查重后创建 + 进入编辑（对齐原版 /r create 流程，无密码机制） */
async function createRaceByCommand(player: Player, name: string): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const dup = await prisma.race.findFirst({ where: { name } });
  if (dup) {
    sysMsg(player, "race", `赛道「${name}」已存在`, "error");
    return;
  }
  try {
    const race = await prisma.race.create({
      data: { name, isEnabled: true, userId: auth.userId },
    });
    if (isInRace(player.id)) {
      // 比赛中不能进编辑（对齐原版 /r edit 门禁）：赛道已建但只提示，不刷编辑车
      sysMsg(player, "race", `赛道「${name}」创建成功（比赛中，请离开比赛后编辑）`, "info");
      return;
    }
    sysMsg(player, "race", `赛道「${name}」创建成功，进入编辑模式放置检查点`, "success");
    await enterRaceEdit(player, race.id);
  } catch (e) {
    logger.error(`[race] /r create 创建赛道失败 ${name}`, e);
    sysMsg(player, "race", "创建失败（名称可能已存在）", "error");
  }
}

/** /r edit 子命令：无参数 → 编辑帮助；名称 → 进编辑；cp/q/d → 编辑态操作（对齐原版） */
async function handleRaceEditCommand(player: Player, rest: string[]): Promise<void> {
  const sub = rest[0];
  if (!sub) {
    // 拆两条短消息：SA 客户端聊天单条上限 128 字节（gbk），整条 usage 139 字节
    // 会被客户端静默丢弃（"无提示"）
    sysMsg(
      player,
      "race",
      "用法: /r edit 赛道名 进编辑 · /r edit cp 放CP · /r edit cpsize [值] 设尺寸",
      "info",
    );
    sysMsg(player, "race", " /r edit trg 脚本说明 · /r edit d 菜单 · /r edit q 退出", "info");
    return;
  }
  if (sub === "cp") {
    if (!isEditing(player.id)) {
      sysMsg(player, "race", "你不在赛道编辑中，先 /r edit 赛道名 进入编辑", "warn");
      return;
    }
    await addCp(player);
    return;
  }
  if (sub === "q") {
    // 不在编辑模式：明确提示而不是假装退出成功（对齐原版 /r edit q 的守卫语义）
    if (!isEditing(player.id)) {
      sysMsg(player, "race", "你不在赛道编辑中，先 /r edit 赛道名 进入编辑", "warn");
      return;
    }
    exitEdit(player.id);
    sysMsg(player, "race", "已退出编辑模式", "info");
    return;
  }
  if (sub === "d") {
    if (!isEditing(player.id)) {
      sysMsg(player, "race", "你不在赛道编辑中，先 /r edit 赛道名 进入编辑", "warn");
      return;
    }
    await showEditMenu(player);
    return;
  }
  if (sub === "cpsize") {
    // /r edit cpsize [值]：设置/查看新放置 CP 的默认尺寸（对齐原版 /r edit cpsize——
    // 设置编辑尺寸后放置的 CP 用该尺寸；无参查看当前值）
    if (!isEditing(player.id)) {
      sysMsg(player, "race", "你不在赛道编辑中，先 /r edit 赛道名 进入编辑", "warn");
      return;
    }
    const cur = getEditCpSize(player.id);
    const raw = rest[1];
    if (raw == null) {
      sysMsg(player, "race", `当前 CP 尺寸为: ${cur}`, "info");
      return;
    }
    const size = Number(raw);
    if (!Number.isFinite(size) || size <= 0 || size > 100) {
      sysMsg(player, "race", "尺寸需为 0-100 的数值", "error");
      return;
    }
    setEditCpSize(player.id, size);
    sysMsg(player, "race", `已设置新 CP 尺寸为: ${size}`, "success");
    return;
  }
  if (sub === "trg") {
    // /r edit trg：查看 CP 触发脚本说明（对齐原版 Race_ShowTrgDialog；MSGBOX 支持中文，
    // 列出 execCpScript 支持的函数——7 个触发函数 + 变量/运算说明）
    const info = [
      "{FFD700}CP 触发脚本语法",
      "",
      "每行一条，放置在 CP 上，玩家触达该 CP 时执行：",
      "  msg 消息    在聊天框显示自定义文本",
      "  time 时 分   更改游戏时间",
      "  weather ID  更改天气（0-255）",
      "  cveh 车型   中途换车（车型 400-611）",
      "  spawnpos x y z a  设置该 CP 的重生点（不触发）",
      "  speed/speedex/zspeed  改变车速（角度/速度/Z轴）",
      "  angle 角度  设置车辆朝向",
      "  fix 修复    修复车辆",
      "  damage 位   破坏车辆（0-15 轮胎位）",
      "  vgoto s|v x y z  传送到坐标",
      "",
      "变量：{FFD700}#ncpx #ncpy #ncpz{FFFFFF} 下一 CP 坐标、{FFD700}#playerid{FFFFFF} 玩家ID",
      "运算：{FFD700}| + - * /{FFFFFF} 前置运算符（如 | 直接设值）",
      "多条脚本从上到下执行；spawnpos 出现后其后的脚本不再执行",
    ].join("\n");
    await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.MSGBOX,
        caption: "/r edit trg 触发脚本说明",
        info,
        button1: "确定",
        button2: "关闭",
      }),
    );
    return;
  }
  // /r edit 赛道名 → 进入编辑（对齐原版，无密码机制；按名字查）
  const name = rest.join(" ");
  const race =
    (await prisma.race.findFirst({
      where: { isEnabled: true, deletedAt: null, name },
    })) ??
    (UUID_RE.test(name)
      ? await prisma.race.findFirst({ where: { isEnabled: true, deletedAt: null, id: name } })
      : null);
  if (!race) {
    sysMsg(player, "race", `未找到赛道「${name}」`, "error");
    return;
  }
  if (!(await canEditRace(player, race.id))) {
    sysMsg(player, "race", "你无权编辑该赛道（仅作者或管理员）", "error");
    return;
  }
  if (isInRace(player.id)) {
    // 比赛中禁止进编辑（对齐原版 /r edit 门禁：编辑会刷测试车/切走玩家，干扰比赛）
    sysMsg(player, "race", "比赛中不能进入赛道编辑，先 /r l 离开比赛", "warn");
    return;
  }
  await enterRaceEdit(player, race.id);
}

/** 注册 /r(race) 命令（与比赛状态机分离：命令入口 + 对话框层） */
export function initRaceUi(): void {
  PlayerEvent.onCommandText(["r", "race"], ({ player, subcommand, next }) => {
    const cmd = subcommand[0];
    const rest = subcommand.slice(1);
    const query = rest.join(" ");
    if (cmd === "s") {
      if (query) {
        void startRaceFlow(player, query);
      } else {
        // 无参数三分支（对齐原版）：
        // - 房间内房主 → 开始比赛
        // - 房间内非房主 → 等房主开始（不随机建房）
        // - 不在房间 → 弹赛道列表选赛道建房（建房入口，列表首行有「全部随机」）
        const pr = getRacePlayerState(player.id);
        if (pr) {
          if (getRaceRoom(pr.roomId)?.ownerId === player.id) {
            void startRace(player);
          } else {
            sysMsg(player, "race", "等待房主开始比赛", "info");
          }
        } else {
          void openRaceListDialog(player);
        }
      }
    } else if (cmd === "j") {
      joinRoomFlow(player);
    } else if (cmd === "l" || cmd === "leave") {
      // 影子挑战中 /r l = 退出挑战（挑战用独立世界 2001+，玩家/命令层习惯用
      // /r l 离开当前竞技场景；退出后若想建比赛再 /r s）
      if (isInChallenge(player.id)) {
        exitChallenge(player);
      } else {
        leaveRace(player);
      }
    } else if (cmd === "info") {
      // /r info 赛道名 → 赛道详情面板（基本信息 + 开始/影子挑战/排行榜/编辑/删除）
      if (!query) {
        sysMsg(player, "race", "用法: /r info 赛道名称", "info");
      } else {
        void showRaceInfo(player, query);
      }
    } else if (cmd === "page") {
      // /r page [N] → 原版翻页入口，gm-lite 无页码概念 → 打开赛道选择列表
      void openRaceListDialog(player);
    } else if (cmd === "create") {
      // /r create 赛道名 → 创建赛道并进入编辑（对齐原版；无密码机制）
      if (!query) {
        sysMsg(player, "race", "用法: /r create 赛道名称", "info");
      } else {
        void createRaceByCommand(player, query);
      }
    } else if (cmd === "edit") {
      void handleRaceEditCommand(player, rest);
    } else if (!cmd) {
      // /r 无参数 → 弹赛道列表对话框（对齐原版 Race_ShowGameMainSel 分页列表，
      // 选中赛道直接创建比赛）
      void openRaceListDialog(player);
    } else {
      sysMsg(
        player,
        "race",
        "用法: /r s 赛道名称 创建比赛 · /r j 加入 · /r l 离开 · /r info 名称 · /r create 名称 · /r edit 名称|cp|q|d",
        "info",
      );
    }
    return next();
  });
}
