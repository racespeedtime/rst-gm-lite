# rst-gm-lite

定位轻量化竞技的完全自研重构的 RST 游戏模式分支，极度精简非必要内容。

**关于"完全自研重构"**：这里的"完全自研"指**代码与整体架构**——没有复制粘贴历史脚本，而是从零开始编写，并将实现语言整体切换（由 Pawn 重写为 TypeScript，运行于 open.mp 生态）。而**数据资产**则站在前人的积累之上：赛道、传送点、NPC 数据、房屋物件等，广泛使用了社区开源项目与过去项目多年积累的数据（详见文末「致谢」）。

🚧 施工中（WIP）：本项目仍在活跃开发，尚未达到生产环境稳定标准——功能与行为可能随时变化，存在未完善的边界与潜在 bug。仅供开发、测试与尝鲜使用。

纯游戏端实现（open.mp + samp-node），无独立前后端。持久化用 PostgreSQL + Prisma：游戏内可经 API 操作的数据全部走代码；仅 API 覆盖不到的场景（如线上数据修正、后台维护）才直接操作数据库。

> 📋 实机测试手册：[TESTING.md](./TESTING.md)（玩家视角验证清单，随业务更新）
> 🎬 回放系统实现说明：[docs/replay-system.md](./docs/replay-system.md)（录制 / 回放 / 挑战的架构与设计决策）

## 源码模块一览

RST-GM-Lite 是 `open.mp + samp-node + @infernus/core` 纯 TypeScript 实现的游戏模式。服务器以「认证 → 世界 → 比赛 → 回放」为主轴，全部功能按领域划分模块，以 `src/callbacks/index.ts` 为事件总入口。下表两列分别写给两类读者：**玩家视角**说这个模块"能做什么"，**开发者视角**说它"怎么实现"。

### 入口与骨架

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `main.ts` / `logger` | — | 程序入口（仅装载 logger / raknet / callbacks）；winston 日志体系 |
| `callbacks/` | — | 事件总线总入口：onConnect 认证流程、onDisconnect 清理链、全部模块 init、onInit/onExit 生命周期 |
| `raknet/` | — | 必须注册的 RakNet 回调占位（infernus 要求 onIncoming/Outgoing Packet/RPC 全部注册，否则回调链不放行）；录制采样在 replay/recorder.ts（IPacket 拦截 DriverSync） |
| `core/` | 无处不在的底层体验 | 通用系统集：出生、面板、观战、计时器、碰撞、无敌等（见下） |

### 账号与身份

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `auth/` | 登录 / 注册 / 改密 / 登录记录 | 账号即昵称，密码 bcrypt（旧格式自动升级）；会话写库 + 心跳续活 + 掉线清理 |
| `sessions/` | 公共大世界与战局（创建 / 加入 / 管理） | 世界 id 规划（0=大世界，1-1000=战局），成员注册与广播 |

### 世界与社交

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `chat/` | 聊天 / 私聊 / 范围设置 | 按战局/全局分发，onText 拦截 |
| `teleport/` | 传送点（/ 系统点、// 用户点）、/s /l、/tpa 请求 | 传送点落库，`/名字` 与 `//名字` 未知命令兜底；传送后冻结防穿模 |
| `house/` | 赛道 / 传送点场景的静态物件加载器（不做房屋本身玩法） | 模型文件解析（obj/material/3dtext/CreateVehicle/area…），按世界区间流式加载 |
| `elevator/` | 电梯（LS 大楼 / 公寓等） | 与万能面板共用 Y 键，区域优先消费按键 |
| `npcs/` | 漂移 NPC 与 /drift 随行 | 沿 .rec 路线循环漂移的演员车 |

### 车辆与装扮

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `vehicles/` | 爱车系统：一人一车、刷车、车型目录 | 懒创建 `user_vehicle` 行、位置定时保存、改装存储 |
| `attire/` | 装扮 / 挂件（含实时编辑）与管理员装扮管理 | 由**装扮模型 + 预设**驱动：`Attire` 表定义 3D 模型与挂点参数，`PlayerPreset`/`VehiclePreset` 组合多个装扮项成一套方案；EditAttachedObject 在线编辑，预设保存/清理孤儿 |
| `personalize/` | 个性化全家桶：人物 / 车辆 / 世界 / 界面 / 动作 / 快捷操作 | 设置表驱动（pickOption/notifySaved），3D 选肤、登录大厅、动作系统（对齐原版 /anim） |

### 赛道与比赛

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `race/` | 比赛房间：创建 / 加入 / 倒计时 / 实时排名 / 掉线重连 | 房间状态机（WAITING→COUNTDOWN→RACING→FINISHED），CP 脚本解析执行，赛道编辑器，爱车入场 |
| `race/editor.ts` | 赛道编辑器（/redit 命令 + 面板入口） | 对话框交互：放 CP / 管理 CP / 圈数 / 测试 / 保存，落库赛道数据 |

### 回放与挑战

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `replay/` | 自定义录制、比赛回放（倍速 / 暂停 / seek / 观战）、影子挑战 | 自有二进制格式（v9 多轨道：一场比赛一个 .rec 内含 N 玩家轨道，帧内含在线标记 + 相对时间戳 + 实时名次），RakNet DriverSync 拦截 + 定时兜底双轨采样录制（recorder.ts），NPC 分身回放 + 模拟驱动，挑战 = 影子 NPC 与你同场 PK。详见 [回放系统实现说明](./docs/replay-system.md) |

### 系统支撑

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `core/panel.ts` | 万能面板（Y 键 / /p） | 分组菜单结构，条件可见性（比赛/编辑中自动收起），层级记忆 |
| `core/observe.ts` | 观战与观战切换 | /tv 命令（ID 观战 / off 停止 / next prev 切换），候选登记/注销 |
| `core/spawn.ts` | 出生 / 重生定位 | onRequestSpawn 同步门禁，登录大厅出生方式 |
| `core/timers.ts` | — | 登记式计时器：一律用 setIntervalSafe/setTimeoutSafe，服务器退出统一清理 |
| `core/vehicleAuto.ts` | 翻车自动翻正 / 自动修复 / 换色 / 氮气 | 定时器 + 状态同步，比赛中由比赛系统接管 |
| `core/invincible.ts` | 无敌模式（按个人设置） | 伤害回血 + RakNet 子弹包拦截 |
| `core/` 其余 | 世界时间天气、人物预设、信息查看、防刷屏等 | colandreas 碰撞、armor 护甲、money 无限金钱、loginCamera 登录镜头、interaction 流程锁、playerStyle 标识缓存、profile 信息汇总、ban 封禁、help 帮助 |
| `interface/` | 速度表 / 网络信息 / 调试面板 | GUI 定时刷新；调试面板由数据库控制开关，可显示坐标四元数等原始数据 |
| `admin/` | OP 命令与管理员面板 | /op 面板驱动（重置密码 / 玩家信息 / 登录记录 / 回放删除），封禁命令（/ban /unban /banip /unbanip） |
| `utils/` | — | 常量（gbk 字符集）、颜色、格式化、对话框封装、分页列表、解析与排序工具 |
| `prisma/` | — | Prisma 7 schema + 迁移 + 生成客户端；数据不动线上（只读参考 public.sql） |

### 关键约定（开发者必读）

- 热路径事件（onRequestSpawn / onTakeDamage / onWeaponShot / onCommandError）必须**同步**返回，async handler 返回值会被忽略
- 计时器一律走 `core/timers.ts`，禁止裸 `setTimeout`/`setInterval`
- 字符集统一 `DEFAULT_CHARSET = "gbk"`；TextDraw / GameText 不支持中文，TextLabel 可
- GTA 角度逆时针（0=北，90=**西**），车前方向 = `(-sinθ, -cosθ)`
- 世界 id：大世界 0、战局 1-1000、比赛 1001-2000、回放 2001+
- 玩家上限 1000 / NPC 槽位 100，事件回调统一排除 NPC

## 与原版 pawn-server 的定位差异

本分支定位**轻量化竞技**，与过去 pawn-server 是**不同的功能定位**——并非逐模块移植，而是按新定位取舍。核心玩法模块（赛车/回放/影子挑战/爱车/装扮/传送/动作等）均有**实现上的差异**（如爱车=刷车即登记、动作收在 /anim、赛道编辑无密码机制），详见源码模块一览。

**房屋系统**同样被精简：当前仅作为**赛道 / 传送点场景的 DynamicObject 加载器**（按 house.race / house.teleport 关联，把静态物件加载到对应世界区间），**不考虑房屋本身的玩法**（买卖 / 居住 / 家具等）。

以下原版模块**不在计划内**：

| 原版模块 | 定位/现状 |
|---|---|
| 敏感词系统 | 可缓开发 |
| 信用分系统 | 暂不开发 |
| 金币等级系统 | 不需要（无货币/等级概念） |
| 团队系统 | 不需要，用战局替换 |
| 组队竞速 | 暂不考虑——优先打磨个人竞速并确保整体逻辑稳定，后续（有生之年）再评估 |
| DM 枪战 | 暂不开发 |
| 小游戏（碰碰车 PPC 等） | 暂不开发 |
| 纪念碑 | 暂不开发 |
| 反作弊系统 | 暂不开发——用战局做信任化隔离，赛车作弊走人工封禁 + 清数据 |
| 广告牌系统 | 暂不开发 |
| 家具系统 | 暂不开发 |
| 问答系统 | 暂不开发 |
| 小提示 | 暂不开发（原版无明确独立模块） |
| 公告系统 | 暂不开发 |
| 审核系统 | 暂不开发（原版无明确独立模块） |

> 注：以上状态随业务演进可能调整，更新于本表。

## 与原版命令的向下兼容

虽定位不同，但**老玩家熟悉的 pawn-server 命令习惯尽量保留**（老服迁移玩家可无缝上手）。已兼容的命令按系统分组：

| 系统 | 已兼容命令 |
|---|---|
| 传送 | `/vmake`（建 //用户点）· `/vsmake`（管理员建 /系统点）· `/telemenu`（系统点列表）· `/s` `/l`（含 `/sp` `/lp` 别名）· `/tpa` `/ta` `/td` + `/名字` `//名字` 未知命令兜底 |
| 动作 | `/anim <1-21>`（21 号映射对齐原版 Action_Play）+ `/anim 0\|off\|无参` · `/fxq` `/jetpack` 喷气背包 · `/jls` 降落伞 · `/stuck` `/xiufu` 脱离卡死 · `/djs` `/count` `/daojishi` 范围倒计时（20 单位同世界） |
| 赛车 | `/r`（无参弹列表）· `/r s [赛道名]` · `/r j` · `/r l\|leave` · `/r info` · `/r page` · `/r create` · `/r edit`（赛道名进编辑 / cp 放 CP / cpsize [值] 设置 CP 尺寸 / trg 脚本说明 / q 退出 / d 编辑菜单） |
| 爱车 | `/cars` `/ac`（list / wode / lock / chepai / kick / color / 3d / buyobj 车辆装扮）· `/wdac`（管理菜单）· `/llac`（列表）· `/aczb` 爱车装扮 |
| 我的设置 | `/sz` `/wdsz`（我的设置聚合菜单：装扮 / 爱车 / 称号前缀后缀 / 个性化 / 信息 / 登录记录 / 改密 / 快捷操作，对齐原版 PlayerInfoDialog） |
| 刷车 | `/c [车辆ID]` · `/c list` · `/c wode` · `/c lock` · `/cc` `/c color` · `/c chepai` · `/c kick` · `/c 3d` |
| 车辆杂项 | `/f` 翻正 · `/fix` 修车 · `/kill`（比赛内重生）· `/dcar` `/autofix` 载具无敌 · `/hys` 变色龙 · `/infobj`（警灯尾翼引导 → 车辆装扮预设） |

**部分兼容**（不报错，给引导提示）：`/cars buy`、`/cars create`——gm-lite 无"购买/造车"概念（刷车即自动登记爱车），提示引导。

**未做命令入口**（有面板等价功能或刻意不做）：`/wudi`（无敌，在 `个性化 → 人物`）——在面板中有等价功能。

## 起步

### 技术栈

- postgresql
- nodejs v22.x

### 手动安装依赖项

- [open.mp x64](https://github.com/openmultiplayer/open.mp/releases)
- [streamer x64](https://github.com/dockfries/samp-streamer-plugin/releases/tag/v2.9.6)
- [colandreas x64](https://github.com/dockfries/ColAndreas/releases/tag/v1.6.0)
- [samp-node x64](https://github.com/dockfries/samp-node/releases/tag/2.6.1)
- [Pawn.RakNet x64](https://github.com/dockfries/Pawn.RakNet/releases/tag/1.7.0-omp)

## 致谢

RaceSpeedTime 系列服务器的历史，离不开社区开源项目的慷慨馈赠。本分支的代码全部自研，但数据与玩法脉络深深受益于那些曾经在社区中影响深远的项目，在此致以诚挚的感谢：

- **自由居民区（5F）**——开源游戏模式的典范，RST 的诞生离不开它；
- **未来世界（7F）**——曾影响一代玩家与开发者的经典游戏模式；
- **兰草乡村（Dylan 初创一代）**——自由服务器玩法（自由 roam）的代表之一。该服务器后续历经开源、出售与多次转手，此处仅追溯其最初的第一代（Dylan 时期）原貌；
- **PRace**——影响深远的开源赛道系统，赛道数据与竞速玩法的重要源头；
- **PHouse**——开源房屋系统，房屋物件数据的重要来源。

同时也向 **open.mp 社区**、**gtaun 社区**以及所有默默奉献的开源脚本、插件与工具作者致以谢意——正是开放的生态，让自研与重构成为可能。文中未能一一列举的贡献者还有很多，你们的每一份代码都在影响着后来者。

## License

[MIT](./LICENSE) License © 2026-PRESENT Carl You
