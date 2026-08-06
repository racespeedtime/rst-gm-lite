import { logger } from "@/logger";
import { GameMode, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { closePlayerSession, runAuthFlow, getAuthState } from "@/auth/auth";
import { startSessionHeartbeat, cleanupStaleSessionsOnBoot } from "@/auth/heartbeat";
import { playLoginCamera, stopLoginCamera } from "@/core/loginCamera";
import { initOpCommands } from "@/admin/op";
import { lockPlayer, unlockPlayer } from "@/core/interaction";
import { initPanel, cleanupPanel } from "@/core/panel";
import { initRateLimit, cleanupRateLimit } from "@/core/ratelimit";
import { sessionManager } from "@/sessions/manager";
import { getSetting, invalidateSettingCache } from "@/personalize/settings";
import { cleanupChat, initChat, initChatState } from "@/chat";
import { initSpawnSystem, savePlayerPosition, cleanupLoginSpawned } from "@/core/spawn";
import { runLobby } from "@/personalize/lobby";
import { cleanupGui, initGui } from "@/interface/gui";
import { initVehicleCommands, onPlayerDisconnectVehicle, startVehicleSaveTimer } from "@/vehicles";
import { initMyVehicleCommands } from "@/vehicles/menu";
import { cleanupTeleport, fallbackTeleport, initTeleport, initTpTimeoutLoop } from "@/teleport";
import {
  initHouseCommands,
  loadAllHouseObjects,
  unloadAllHouseObjects,
  setHouseObjectsVisibleForPlayer,
  applyHouseRemovedBuildings,
} from "@/house";
import { applyPlayerPreset, cleanupAttire, cleanupOrphanPresets, initAttireEditor } from "@/attire";
import { initRaceSystem, cleanupRacePlayer, tryReconnectRace, isInRace } from "@/race/room";
import { initRaceUi } from "@/race/roomUi";
import { initRaceEditor, exitEdit } from "@/race/editor";
import { initRaceCommands } from "@/race/manage";
import { initObserve, cleanupObserve } from "@/core/observe";
import { initPlayerInfo } from "@/core/profile";
import { initInvincible, applyInvincibleState, cleanupInvincible } from "@/core/invincible";
import { initArmor } from "@/core/armor";
import { initMoneySystem, giveInfinityMoney } from "@/core/money";
import {
  initVehicleAuto,
  cleanupVehicleAuto,
  syncVehicleAutoState,
  syncStuntState,
  syncNoCollisionState,
} from "@/core/vehicleAuto";
import { cleanupDriftScore } from "@/core/driftScore";
import { cancelCountdownFx, disposeCountdownFxAll } from "@/interface/countdownFx";
import { applyPlayerStyle, applyStyleToNewPlayer, cleanupPlayerStyle } from "@/core/playerStyle";
import { initSkinCommands } from "@/personalize/skinPicker";
import { initQuickCommands } from "@/personalize/quickActions";
import { initActionCommands, initActionCleanup, cleanupAction } from "@/personalize/action";
import { initHelpCommand, sendWelcomeMessage } from "@/core/help";
import { initColandreas } from "@/core/colandreas";
import { initElevators } from "@/elevator";
import { initDrifterNpcs } from "@/npcs";
import { initReplay, cleanupReplay, shutdownReplay } from "@/replay";
import {
  applyWorldEnv,
  clearWorldEnvForPlayer,
  clearWorldEnvironment,
  initWorldEnvironment,
  startWorldClockTimers,
} from "@/core/worldenv";

import { COLOR_INFO, COLOR_ERROR } from "@/utils/colors";
import { DEFAULT_CHARSET } from "@/utils/constants";

/**
 * 判断是否为 NPC（所有回调事件统一排除 NPC）
 */
function isNpc(player: Player): boolean {
  return player.isNpc();
}

async function handlePlayerConnect(player: Player) {
  // 认证流程期间锁定，万能面板等入口不可打断
  lockPlayer(player.id);
  try {
    // 1. 默认字符集 gbk（须在所有文本交互前设置）
    player.charset = DEFAULT_CHARSET;

    // 2. 先进观战模式（隐藏玩家）：否则连接后客户端默认已出生在世界 0，
    //    认证/大厅选择期间人就已经出现在世界（虚空/默认点）。观战模式下
    //    玩家不可见、不参与世界，正式出生（spawnPlayer/重连恢复）时再解除。
    try {
      player.toggleSpectating(true);
    } catch (e) {
      logger.warn(`[auth] ${player.getName().name} 进入观战模式失败`, e);
    }

    // 3. 登录界面过场：随机音效 + 镜头插值滑动（认证对话框期间）
    playLoginCamera(player);

    // 3. 认证流程（对话框驱动：登录 / 注册）
    const auth = await runAuthFlow(player);
    if (!auth) {
      // 流程中断（离开/踢出/断线）——已断线则不重复踢
      if (player.isConnected()) {
        player.kick();
      }
      return;
    }
    logger.info(`[auth] ${auth.username}(${auth.userId}) 认证成功`);
    // 认证期间玩家可能已掉线：不再进入世界（战局/大厅/出生都跳过）
    if (!player.isConnected()) {
      return;
    }
    // 登录成功：停止登录音乐
    stopLoginCamera(player);
    // 无限金钱（对齐原版登录 GivePlayerMoney(99999999)）
    giveInfinityMoney(player);
    // 读取玩家设置（登录后统一取一次，供各系统应用；设置缓存保证最新）
    const loginSetting = await getSetting(player);
    // 应用无敌模式状态（按玩家设置，开启则满血）——普通登录与重连两条路径共用
    await applyInvincibleState(player);
    // 车辆自动状态：autoFix 子弹拦截名单同步写入（onWeaponShot 同步热路径用）
    if (loginSetting) syncVehicleAutoState(player, loginSetting);
    // 特技显示：按人启用/禁用原生 Stunt Bonus（登录时应用个人设置）
    syncStuntState(player, loginSetting?.showStunt ?? true);
    // 无碰撞按个人设置（非比赛状态；比赛中由比赛系统强制覆盖）
    syncNoCollisionState(player, loginSetting?.vehicleNoCollision ?? false);
    // 应用玩家标识（NameTag 显隐 + 聊天前后缀缓存）
    await applyPlayerStyle(player);
    // 同步给新人：让已隐藏 NameTag 的玩家对新登录者隐藏
    applyStyleToNewPlayer(player);
    // 掉线重连：若断线窗口未过期则恢复原比赛房间（跳过大厅/出生流程）
    if (await tryReconnectRace(player)) {
      // 重连路径：战局归属已由 tryReconnectRace 内的 rejoinPlayerSession
      // 注册（原战局按 sessionId 仍存在则加回，否则回公共大世界）——不能再调
      // onPlayerAuthenticated，否则会把玩家塞回 publicWorld 造成双注册/注册错乱
      initChatState(player.id);
      // 重连是全新连接：removeBuilding（房屋建筑移除）与物件显隐是 per-player
      // 的，断线后原建筑/物件显隐状态已重置，须与登录路径一致重新应用
      setHouseObjectsVisibleForPlayer(player, loginSetting?.showObject ?? true);
      applyHouseRemovedBuildings(player);
      // 解除连接时的观战模式，恢复可见（比赛世界）
      player.toggleSpectating(false);
      if (auth.isSuperAdmin) {
        player.sendClientMessage(COLOR_INFO, "你已登录为系统管理员，按 Y 打开万能面板");
      }
      return;
    }
    // 进入游戏世界（默认公共大世界）+ 初始化聊天范围（默认跟随战局）
    sessionManager.onPlayerAuthenticated(player);
    initChatState(player.id);
    // 按玩家设置应用世界环境（时间/天气跟随或固定）
    await applyWorldEnv(player);
    // 应用世界物件显隐（世界个性化→显示物件开关）
    setHouseObjectsVisibleForPlayer(player, loginSetting?.showObject ?? true);
    // 应用房屋建筑移除（removeobj，per-player 需要在世界内执行）
    applyHouseRemovedBuildings(player);
    if (!player.isConnected()) {
      return;
    }
    // 大厅（对话框序列）：选择出生方式 + 进入世界方式 → 进战局 → 出生
    await runLobby(player);
    if (!player.isConnected()) {
      return;
    }
    // 应用默认人物预设装扮
    const defaultPreset = await prisma.sysUserSetting
      .findUnique({ where: { userId: auth.userId } })
      .then((s) => s?.defaultPlayerPresetId ?? null);
    await applyPlayerPreset(player, defaultPreset);
    // 登录欢迎（服务器名 + 核心玩法指引）
    sendWelcomeMessage(player);
    if (auth.isSuperAdmin) {
      player.sendClientMessage(COLOR_INFO, "你已登录为系统管理员，按 Y 打开万能面板");
    }
  } catch (e) {
    logger.error(`[auth] 玩家 ${player.getName().name} 认证流程异常`, e);
    if (player.isConnected()) {
      player.kick();
    }
  } finally {
    unlockPlayer(player.id);
  }
}

PlayerEvent.onConnect(({ player, next }) => {
  if (isNpc(player)) {
    return next();
  }
  // 同步进入观战模式：open.mp 在连接后会立即触发默认出生（同步时序），
  // 而认证/大厅流程是异步的（void handlePlayerConnect）——必须先在这条同步
  // 路径隐藏玩家，否则玩家会在出生方式对话框期间被强制出生（实体出现在
  // 虚空，spect 才设上，出现"被出生但 spect 没关"的经典错乱态）。
  try {
    player.toggleSpectating(true);
  } catch {
    // 玩家已失效等，忽略
  }
  // 异步认证，不阻塞事件链（handlePlayerConnect 内的 toggleSpectating(true)
  // 保留作幂等确认）
  void handlePlayerConnect(player);
  return next();
});

PlayerEvent.onDisconnect(({ player, reason, next }) => {
  if (isNpc(player)) {
    return next();
  }
  // 注意顺序：战局处理需要认证状态（房主判断），须在清理 auth 之前执行。
  // reason：SA-MP disconnect reason（0=掉线/超时崩溃 1=正常退出 2=Kick/Ban），
  // 战局广播按下线理由展示（对齐原版 disconnectReasons 文案）
  // 掉线玩家原战局 id 快照：必须在 handlePlayerDisconnect（内部删 playerSessions）
  // 之前取，否则 cleanupRacePlayer 里再取 getPlayerSession 命中公共大世界、快照
  // 恒为 0——重连时按 sessionId 匹配失效（见 room.ts reconnect slot sessionId）
  const leavingSessionId = sessionManager.getPlayerSession(player).id;
  sessionManager.handlePlayerDisconnect(player, reason);
  // 断开前最后保存一次在线位置（失败由定时保存兜底）。
  // 必须在 cleanupRacePlayer 之前：此时玩家还在比赛中（比赛世界），
  // savePlayerPosition 内部按 isInRace 跳过比赛污染；若先清比赛状态，
  // 会误把比赛世界坐标存成 LAST_POSITION
  void savePlayerPosition(player).catch((e) =>
    logger.error(`[spawn] 断线保存位置失败 ${player.getName().name}`, e),
  );
  // 爱车：保存车辆位置 + 销毁车辆
  onPlayerDisconnectVehicle(player);
  // 传送：清理 tpa 状态
  cleanupTeleport(player.id);
  // 清理登录首次出生标记（防 playerId 复用残留跳过重生定位）
  cleanupLoginSpawned(player.id);
  // 装扮：清理挂载对象
  cleanupAttire(player.id);
  // 比赛：退出比赛房间/编辑模式（传原战局 id 快照：重连窗口按 sessionId 恢复归属）
  cleanupRacePlayer(player.id, { sessionId: leavingSessionId });
  exitEdit(player.id);
  // 观察：清理观战状态
  cleanupObserve(player.id);
  // 世界环境：清理 timeFlow 定时器
  clearWorldEnvForPlayer(player.id);
  // 回放：录制强制落盘 + 销毁该玩家发起的回放会话（NPC/车辆）
  cleanupReplay(player.id);
  // 断线清理：空白预设（在清 auth 前取 userId）
  const leavingUserId = getAuthState(player.id)?.userId;
  if (leavingUserId) {
    void cleanupOrphanPresets(leavingUserId);
  }
  unlockPlayer(player.id);
  cleanupChat(player.id);
  cleanupRateLimit(player.id);
  cleanupGui(player.id);
  // 无敌模式：清理进程内状态
  cleanupInvincible(player.id);
  // 车辆自动：清理换色/氮气计时
  cleanupVehicleAuto(player.id);
  // 漂移积分：清理状态 Map（TD 已由 cleanupGui 销毁）
  cleanupDriftScore(player.id);
  // 倒计时动画：断线清进行中的 TextDraw 动画链（TD 掉线时 infernus 已自动销毁）
  cancelCountdownFx(player.id);
  // 玩家标识：清理 NameTag/聊天名缓存
  cleanupPlayerStyle(player.id);
  // 万能面板：清理层级记忆（断线后重新登录从主面板开始）
  cleanupPanel(player.id);
  // 动作：清理播放记录（实体动作在断线时随客户端重置，无需发包清除）
  cleanupAction(player.id);
  // 设置缓存：按 userId 失效（防长期运行内存累积）
  if (leavingUserId) {
    invalidateSettingCache(leavingUserId);
  }
  // 关闭游戏会话 + 清理内存态（内部含 clearAuthState）
  void closePlayerSession(player.id);
  return next();
});

// 命令为辅：/op 打开管理员面板（对话框驱动主流程）
initOpCommands();

// 电梯系统（LS 大楼/公寓楼/海滨公寓/SF ZomboTech）。
// 必须注册在 initPanel 之前：电梯与万能面板共用 Y 键，电梯优先消费其检测区内的按键
//（轿厢内选层/楼层呼叫），未在检测区内的 Y 键继续放行给面板。
initElevators();

// 漂移 NPC 系统（8 个 Drifter NPC 沿 .rec 路线循环漂移 + /drift 随行）
initDrifterNpcs();

// 万能面板快捷键（Y 键）
initPanel();

// 聊天系统（拦截 onText 按战局/全局范围分发）
initChat();

// 指令/聊天全局限频
initRateLimit();

// 出生系统（定时保存在线位置）
initSpawnSystem();

// GUI 系统（速度表 / 网络信息，每 200ms 刷新，timer 由 GameMode.onExit 统一清理）
initGui();

// 爱车系统（刷车命令 + 位置定时保存 + 改装店 mod 存储）
initVehicleCommands();
startVehicleSaveTimer();
// 原版爱车命令兼容（/cars|/ac /wdac /llac）
initMyVehicleCommands();

// 无限金钱（登录发钱 + 进改装店补给）
initMoneySystem();

// 传送系统（/s /l /tpa 等 + 未知命令兜底 / // 传送点）
initTeleport();
initTpTimeoutLoop();
PlayerEvent.onCommandError(({ player, command, cmdText, error, getSuggestion, next }) => {
  // 命令不存在 → 尝试当作传送点（/名称 或 //名称）
  // 注意：command 已被解析器剥离斜杠，必须用 cmdText（保留原始 "/ls" 或 "//ls"）判断前缀
  if (error.type === "NOT_EXIST") {
    const used = cmdText ?? command;
    // 比赛中未知命令也统一按比赛隔离拒绝（onCommandReceived 只拦截已注册命令，
    // 未知命令会绕过隔离直接到这里；fallbackTeleport 只报"比赛中不能传送"，误导）
    if (isInRace(player.id)) {
      player.sendClientMessage(
        COLOR_ERROR,
        "[比赛] 比赛中只能使用 /r l 离开、/pm 私聊、/tv 观战或 /kill 重生",
      );
      return true;
    }
    // 同步 return true 抑制客户端默认的 "Unknown command" 提示；
    // 内部异步处理传送点/建议（infernus 忽略 async handler 的返回值）
    void (async () => {
      // 兜底传送：/名称 或 //名称 匹配系统/用户传送点；匹配到则已处理
      if (await fallbackTeleport(player, used)) {
        return;
      }
      // 传送点也不存在 → 命令确实不存在：提示 + 最接近的命令建议（避免静默吞掉）
      const { suggestion, distance } = getSuggestion();
      if (suggestion && Number.isFinite(distance) && distance <= 4) {
        player.sendClientMessage(
          COLOR_ERROR,
          `命令不存在: ${used}，你是不是想输入 /${suggestion}？`,
        );
      } else {
        player.sendClientMessage(COLOR_ERROR, `命令不存在: ${used}`);
      }
    })();
    return true;
  }
  return next();
});

// 房屋系统（加载模型 + 命令）
initHouseCommands();
GameMode.onInit(({ next }) => {
  void loadAllHouseObjects();
  return next();
});
GameMode.onExit(({ next }) => {
  unloadAllHouseObjects();
  // 房屋 obj 的 colandreas 碰撞（CA_Object）由 CA_Object 内部注册的
  // onExit destroyAll 自动清理，无需在此重复处理
  return next();
});

// 赛车系统（比赛房间 + 赛道编辑 + 赛道管理命令）
initRaceSystem();
initRaceUi(); // /r 命令入口 + 赛道列表/创建/编辑对话框（与比赛状态机分离的 UI 层）
initRaceEditor();
initRaceCommands();

// 观察系统（/tv 观战，比赛完成后自动观战）
initObserve();

// 点击玩家 → 查看其信息汇总
initPlayerInfo();

// 皮肤命令（/skin 3D 选肤 / /skin ID）
initSkinCommands();
// 快捷命令（/fxq 喷气背包 · /jls 降落伞）
initQuickCommands();
// 动作命令（/anim 播放动作）+ 状态切换清理（上车/死亡/观战清除动作）
initActionCommands();
initActionCleanup();

// 帮助命令（/help 常用命令）
initHelpCommand();

// 无敌模式：伤害回血 + raknet 子弹包拦截
initInvincible();

// 默认护甲：每次出生/重生补满护甲（不依赖无敌，所有人默认有甲）
initArmor();

// 车辆自动系统：翻车自动翻正/自动修复/定时换色/氮气补充
initVehicleAuto();

// 装扮实时编辑器（人物 EditAttachedObject / 车辆 DynamicObject 拖拽编辑保存）
initAttireEditor();

// 回放系统（/rec 录制 · /rp 回放控制 · 比赛自动录制 · RakNet 拦截采样）
initReplay();

// 游戏会话心跳：定时更新 last_heartbeat_at + 更正异常掉线会话
startSessionHeartbeat();

GameMode.onInit(({ next }) => {
  logger.info("RST GameMode 已启动");
  // 服务器列表显示（客户端浏览器可见）：hostname + gamemodetext。
  // 对齐原版 SendRconCommand 的 gbk 编码——SA-MP 客户端按 gbk 显示服务器名，
  // 中文必须用 gbk 编码发送否则乱码（infernus sendRconCommand 默认 utf8，显式传 gbk）。
  // hostname：服务器描述（轻量化竞技 + 玩法）
  GameMode.sendRconCommand("name [RST] 轻量化竞技 · 自由大世界 · 赛车", DEFAULT_CHARSET);
  // gamemodetext：浏览器 Mode 列（setGameModeText 无 charset 参数直接传字符串，
  // 中文会乱码，改走 sendRconCommand 的 gamemodetext rcon 命令 + gbk）
  GameMode.sendRconCommand("game.mode 赛车 / 自由", DEFAULT_CHARSET);
  // 昵称即账号：放开昵称字符限制（支持中文/特殊字符），否则部分昵称被 open.mp 默认规则拒绝连入
  GameMode.supportAllNickname();
  // 初始化碰撞检测插件（缺失时静默跳过，不影响其他功能）
  initColandreas();
  // 启动清理：上次崩溃/异常退出残留的 ONLINE 会话置为离线
  void cleanupStaleSessionsOnBoot();
  // 世界环境：全局时间天气 + MapIcon + 传送点标签 + 赛道起点展示
  void initWorldEnvironment();
  // 大世界时间流逝（现实同步）+ 天气轮换
  startWorldClockTimers();
  return next();
});

GameMode.onExit(({ next }) => {
  // 清理世界环境实体（图标/标签）与玩家 timeFlow 定时器
  clearWorldEnvironment();
  // 倒计时动画：清空全部进行中的 TextDraw 动画（定时器已由 clearAllTimers 兜底）
  disposeCountdownFxAll();
  // 回放：销毁全部回放会话（NPC/车辆）+ 录制强制落盘
  shutdownReplay();
  return next();
});
