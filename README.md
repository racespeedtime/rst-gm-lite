# rst-gm-lite

定位轻量化竞技的完全自研重构的RST游戏模式分支，极度精简非必要内容。

🚧 施工中（WIP）：本项目仍在活跃开发，尚未达到生产环境稳定标准——功能与行为可能随时变化，存在未完善的边界与潜在 bug。仅供开发、测试与尝鲜使用。

纯游戏端实现（open.mp + samp-node），无独立前后端。持久化用 PostgreSQL + Prisma：游戏内可经 API 操作的数据全部走代码；仅 API 覆盖不到的场景（如线上数据修正、后台维护）才直接操作数据库。

> 📋 实机测试手册：[TESTING.md](./TESTING.md)（玩家视角验证清单，随业务更新）

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
| `attire/` | 装扮 / 挂件（含实时编辑）与管理员装扮管理 | EditAttachedObject 在线编辑，预设保存/清理孤儿 |
| `personalize/` | 个性化全家桶：人物 / 车辆 / 世界 / 界面 / 动作 / 快捷操作 | 设置表驱动（pickOption/notifySaved），3D 选肤、登录大厅、动作系统（对齐原版 /anim） |

### 赛道与比赛

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `race/` | 比赛房间：创建 / 加入 / 倒计时 / 实时排名 / 掉线重连 | 房间状态机（WAITING→COUNTDOWN→RACING→FINISHED），CP 脚本解析执行，赛道编辑器，爱车入场 |
| `race/editor.ts` | 赛道编辑器（/redit 命令 + 面板入口） | 对话框交互：放 CP / 管理 CP / 圈数 / 测试 / 保存，落库赛道数据 |

### 回放与挑战

| 模块 | 玩家视角 | 开发者视角 |
|------|---------|-----------|
| `replay/` | 自定义录制、比赛回放（倍速 / 暂停 / seek / 观战）、影子挑战 | 自有二进制格式（v6，帧内含在线标记），RakNet DriverSync 拦截 + 定时兜底双轨采样录制（recorder.ts），NPC 分身回放 + 模拟驱动，挑战 = 影子 NPC 与你同场 PK |

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

## License

[MIT](./LICENSE) License © 2026-PRESENT Carl You
