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
import { initSpawnSystem, savePlayerPosition } from "@/core/spawn";
import { runLobby } from "@/personalize/lobby";
import { cleanupGui, initGui } from "@/interface/gui";
import { initVehicleCommands, onPlayerDisconnectVehicle, startVehicleSaveTimer } from "@/vehicles";
import { cleanupTeleport, fallbackTeleport, initTeleport, initTpTimeoutLoop } from "@/teleport";
import { initHouseCommands, loadAllHouseObjects, unloadAllHouseObjects, setHouseObjectsVisibleForPlayer } from "@/house";
import { applyPlayerPreset, cleanupAttire, cleanupOrphanPresets } from "@/attire";
import { initRaceSystem, cleanupRacePlayer, tryReconnectRace } from "@/race/room";
import { initRaceEditor, exitEdit } from "@/race/editor";
import { initRaceCommands } from "@/race/manage";
import { initObserve, cleanupObserve } from "@/core/observe";
import { initPlayerInfo } from "@/core/profile";
import { initInvincible, applyInvincibleState, cleanupInvincible } from "@/core/invincible";
import { initVehicleAuto, cleanupVehicleAuto, syncVehicleAutoState } from "@/core/vehicleAuto";
import { applyPlayerStyle, applyStyleToNewPlayer, cleanupPlayerStyle } from "@/core/playerStyle";
import { initColandreas } from "@/core/colandreas";
import {
  applyWorldEnv,
  clearWorldEnvForPlayer,
  clearWorldEnvironment,
  initWorldEnvironment,
  startWorldClockTimers,
} from "@/core/worldenv";

const DEFAULT_CHARSET = "gbk";
import { COLOR_INFO } from "@/utils/colors";

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

    // 2. 登录界面过场：随机音效 + 镜头插值滑动（认证对话框期间）
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
    // 登录成功：停止登录音乐 + 回到第三人称视角
    stopLoginCamera(player);
    // 读取玩家设置（登录后统一取一次，供各系统应用；设置缓存保证最新）
    const loginSetting = await getSetting(player);
    // 应用无敌模式状态（按玩家设置，开启则满血）——普通登录与重连两条路径共用
    await applyInvincibleState(player);
    // 车辆自动状态：autoFix 子弹拦截名单同步写入（onWeaponShot 同步热路径用）
    if (loginSetting) syncVehicleAutoState(player, loginSetting);
    // 应用玩家标识（NameTag 显隐 + 聊天前后缀缓存）
    await applyPlayerStyle(player);
    // 同步给新人：让已隐藏 NameTag 的玩家对新登录者隐藏
    applyStyleToNewPlayer(player);
    // 掉线重连：若断线窗口未过期则恢复原比赛房间（跳过大厅/出生流程）
    if (await tryReconnectRace(player)) {
      // 重连路径绕过了下方常规注册：补上战局成员登记 + 聊天范围，避免重连玩家不在任何战局
      sessionManager.onPlayerAuthenticated(player);
      initChatState(player.id);
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
  // 异步认证，不阻塞事件链
  void handlePlayerConnect(player);
  return next();
});

PlayerEvent.onDisconnect(({ player, next }) => {
  if (isNpc(player)) {
    return next();
  }
  // 注意顺序：战局处理需要认证状态（房主判断），须在清理 auth 之前执行
  sessionManager.handlePlayerDisconnect(player);
  // 断开前最后保存一次在线位置（失败由定时保存兜底）
  void savePlayerPosition(player).catch((e) => logger.error(`[spawn] 断线保存位置失败 ${player.getName().name}`, e));
  // 爱车：保存车辆位置 + 销毁车辆
  onPlayerDisconnectVehicle(player);
  // 传送：清理 tpa 状态
  cleanupTeleport(player.id);
  // 装扮：清理挂载对象
  cleanupAttire(player.id);
  // 比赛：退出比赛房间/编辑模式
  cleanupRacePlayer(player.id);
  exitEdit(player.id);
  // 观察：清理观战状态
  cleanupObserve(player.id);
  // 世界环境：清理 timeFlow 定时器
  clearWorldEnvForPlayer(player.id);
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
  // 玩家标识：清理 NameTag/聊天名缓存
  cleanupPlayerStyle(player.id);
  // 万能面板：清理层级记忆（断线后重新登录从主面板开始）
  cleanupPanel(player.id);
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

// 爱车系统（刷车命令 + 位置定时保存）
initVehicleCommands();
startVehicleSaveTimer();

// 传送系统（/s /l /tpa 等 + 未知命令兜底 / // 传送点）
initTeleport();
initTpTimeoutLoop();
PlayerEvent.onCommandError(({ player, command, cmdText, error, next }) => {
  // 命令不存在 → 尝试当作传送点（/名称 或 //名称）
  // 注意：command 已被解析器剥离斜杠，必须用 cmdText（保留原始 "/ls" 或 "//ls"）判断前缀
  if (error.type === "NOT_EXIST") {
    void fallbackTeleport(player, cmdText ?? command);
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
  return next();
});

// 赛车系统（比赛房间 + 赛道编辑 + 赛道管理命令）
initRaceSystem();
initRaceEditor();
initRaceCommands();

// 观察系统（/tv 观战，比赛完成后自动观战）
initObserve();

// 点击玩家 → 查看其信息汇总
initPlayerInfo();

  // 无敌模式：伤害回血 + raknet 子弹包拦截
  initInvincible();

  // 车辆自动系统：翻车自动翻正/自动修复/定时换色/氮气补充
  initVehicleAuto();

// 游戏会话心跳：定时更新 last_heartbeat_at + 更正异常掉线会话
startSessionHeartbeat();

GameMode.onInit(({ next }) => {
  logger.info("RST GameMode 已启动");
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
  return next();
});
