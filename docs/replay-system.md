# RST 回放系统实现说明

本文档按**当前实现**（`src/replay/`）总结回放系统的设计与实现思路：如何录制、如何回放、为什么这么设计。面向开发者，与代码逐项对应。

## 1. 概述

回放系统覆盖三件事：

- **自定义录制回放（ghost）**：玩家随手 `/rec` 录一段驾驶，`/rp play` 在**当前世界**重播（NPC 车，其他人看得见、可一起玩），发起人可控制倍速/暂停/seek；
- **比赛回放（race）**：每场比赛自动录制（`beginRace` 全员开录、`endRoom` 落盘带名次），`/rp play` 在**独立世界**重放，发起人自动观战，比赛信息 HUD（C P / TIME / BEST / RANK）随播放还原；
- **影子挑战（challenge）**：选一条"自己该赛道的比赛回放"当影子（NPC 车），玩家开**自己的爱车**与影子同场 PK。

核心技术手段：

| 环节 | 手段 |
|------|------|
| 录制 | RakNet 拦截玩家 `DriverSync`（InCarSync）包 30Hz 采点 + 100ms 定时兜底补帧 |
| 存储 | 自有二进制格式（**v8，定长 Header + 定长帧 74B**），整文件读入内存，O(1) seek |
| 回放 | open.mp 内置 NPC 按需创建 + `emulateIncomingPacket` 模拟 NPC 发 `DriverSync`，服务器按真实司机处理并广播，客户端本地物理驱动 |
| 观战 | 复用 `core/observe` 的 `startObserveVehicle`；比赛 TD / CP 箭头从**帧状态**渲染（事件无关） |

模块划分：

| 文件 | 职责 |
|------|------|
| `format.ts` | 二进制格式：Header/帧的编码、解码、插值、版本兼容 |
| `recorder.ts` | 录制：采样、兜底、挂起/续录、落盘 + DB 元数据 |
| `playback.ts` | 回放：NPC 池、emulate 驱动、60fps tick、控制命令、观战 HUD |
| `challenge.ts` | 影子挑战：赛道 CP 检测、影子渲染、结算（复用 playback 的采样/驱动/NPC 池） |
| `index.ts` | 总入口：命令注册、RakNet 拦截注册、NPC sync 屏蔽、孤儿文件清理/索引补建、断线/进比赛清理 |

---

## 2. 文件格式（format.ts）

### 2.1 设计目标

- **定长帧**：seek/快进/后退 = 按 `index × frameBytes` 偏移 O(1) 直取，零顺序解析；
- **每帧带"完整状态"**：不只是位置/速度，还带车型 / CP 进度 / 时间 / 天气 / 血量 / 在线标记 / 实时名次 / 帧时间戳——seek/回退 = **恢复状态而非重放事件**（见 §5）；
- **向后兼容**：新字段一律**尾部追加**，旧字段偏移永不改动；v3 起 Header 末尾自描述 `frameBytes`（帧字节数），新版本读旧文件、旧版本不读新文件，零破坏。

### 2.2 Header（当前 76B）

魔数 `RSTREP01` + 版本(1) + 类型(1，ghost=0 / race=1) + 帧间隔(2) + 车型(4) + 起始位置/四元数/速度(36) + 帧数(4) + 时长(4) + CP 总数(4) + 个人最佳(4) + **frameBytes(4)**。

`frameIntervalMs` 是**实际平均帧间隔**（兜底采样时 ≈100ms、RakNet 拦截时 ≈33ms），作为旧文件的播放推进基准；v7 起播放按每帧时间戳精确定位，不再依赖它。

### 2.3 帧（当前 74B）

| 偏移 | 字段 | 说明 |
|------|------|------|
| 0 | 位置 x/y/z | 3×f32 |
| 12 | 四元数 qx/qy/qz/qw | 4×f32（归一化单位四元数） |
| 28 | 速度 vx/vy/vz | 3×f32 |
| 40 | 车型 vehicleModel | i32（cveh 换车后变化 → 回放重建车辆） |
| 44 | CP 进度 cpProgress | i32（已完成 CP 数，比赛录制事件驱动写入） |
| 48 | 时/分/天气 | 各 u8（天气必须 UInt8：范围 0-255） |
| 51 | 血量 vehicleHealth | f32 |
| 55 | keys | u16（v4+：DriverSync 按键位集，氮气=SPRINT） |
| 57 | lrKey/udKey/additionalKey/起落架/警笛/trailerId/trainSpeed | 11B（v5+：DriverSync 完整字段） |
| 68 | online | u8（v6+：该帧玩家是否在线，掉线静止帧=false） |
| 69 | relTimeMs | u32（v7+：相对录制开始的时间戳，播放二分定位） |
| 73 | rank | u8（v8+：实时名次 1-based，回放 RANK TD 动态还原） |

版本演进：v2(55B) → v4(57B, keys) → v5(68B, 完整 sync 字段) → v6(69B, online) → v7(73B, 时间戳) → v8(74B, rank)。

### 2.4 插值（lerpFrame）

帧间线性插值：位置/速度直接插；**四元数插值后必须归一化**（两个单位四元数的线性中间值长度 <1，直接当单位四元数用会让车头乱摆）；离散状态字段（车型/时间/天气/血量/按键/在线/名次）取最近帧不插值。

---

## 3. 录制（recorder.ts）

### 3.1 双轨采样

- **主采样**：`IPacket(PacketIdList.DriverSync)` 拦截玩家 DriverSync 包，`readSync()` 读取位置/四元数/速度/**完整按键字段**（keys、lrKey、udKey、additionalKey、起落架、警笛、trailerId、trainSpeed）。
- **兜底采样**：100ms 定时器 `fallbackSample` 直接读车辆实体——RakNet 拦截失效、玩家静止不发 sync 包时补帧，防帧数稀疏（录制 15s 只有 8 帧 → 回放"瞬移+原地开"）。

采样来源带诊断计数（`raknetFrames` / `interceptHits` / `lastRaknetAt`），落盘时打印——用于定位"帧数少/拦截未触发"问题。

### 3.2 离散状态缓存

时间/天气/车型/血量这些字段如果每帧读会打 6-7 个 native（30Hz 下开销大）。用**会话内缓存** 2s 节流：`refreshDiscreteCache` 只在距上次刷新 ≥2s 时重读，帧间用缓存值。缓存必须 **per-session**——多人比赛同时录制时模块级缓存会互相污染（A 的车型/血量写进 B 的帧）。

CP 进度与实时名次不走缓存：由 `noteCpProgress`（room 过 CP）/ `noteRank`（room tickRooms 排名）**事件驱动**写入会话，采样时读。

### 3.3 帧时间戳

`sample()` 统一注入 `relTimeMs`（相对录制开始），取 `max(前帧, 当前)` 保**单调不减**——播放端二分定位依赖时间戳单调，系统时钟回退（NTP/校时）时不抖动。

### 3.4 边界检查

每次采样前检查：超过时长上限（ghost 1h / race 6h）或**离开录制起始世界**（传送/换战局/死亡回世界）→ 自动停止落盘。跨世界录制位置跳变会让回放 ghost 瞬移，录出错误轨迹。

### 3.5 挂起 / 续录（掉线重连）

- `suspendRecording`：掉线进重连窗口 / 退赛时标记挂起，会话**不落盘**，缓存最近一帧作静止帧数据源；挂起期间 `fallbackSample` 每 100ms 生成一帧静止帧（位置/姿态/车型/时间天气血量保持，速度/按键清零）。
- `suspendedOffline`：true=掉线挂起（静止帧 `online=false`，回放红字"掉线"）；false=主动退赛（保持在线标记）。
- `resumeRecording`：重连成功续录，清除挂起标记并把 `startWorld` 更新为当前世界（否则"已离开录制世界"边界检查会立即误触发自动停止）。
- `rebindRecording`：掉线期间 playerId 可能被新连接复用，重连恢复时按 **userId + raceRoomId 归属校验**把挂起会话从旧 id 迁移到新 id，防劫持别人的会话。

### 3.6 落盘

1. 停止瞬间**无条件补一帧**当前车辆状态（尾帧 = 结束位置），带身份校验（playerId 可能被复用，auth/userId 对不上则跳过补帧）；
2. 帧数 <2 直接取消（"录制内容过短"）；
3. 组装 `Header + 定长帧` 的单个 Buffer（一次性分配），写文件 `${playerId}_${startAt}.rec`；
4. **待落库索引**（同步写文件）：DB 建记录前先写索引条目，DB 建成功移除——服务器退出瞬间 create 未 settle 时，重启靠索引补建 DB 记录，防"文件写了但无索引 → 孤儿清理误删"；
5. 建 DB `replay` 记录（含录制者快照、名次、raceRoomId 等）。

### 3.7 作废

- `discard=true`（整场无人完成/房主重开）：落盘即删文件、不建 DB 记录（原子）；
- `discardRaceReplay`（房间销毁且无人完成 / 掉线重连删线段）：延迟 800ms（等刚触发的 stopRecording 落盘完成）按 **userId + raceId + raceRoomId + rank=null** 精确匹配软删，防误删"有人完成的比赛里掉线玩家的保留段"。

---

## 4. 回放（playback.ts）

### 4.1 NPC 池（按需分配，非固定预创建）

- 上限 `MAX_REPLAY_NPC = 100`（对齐 `config.json max_bots`，回放/挑战共用）；
- `allocReplayNpc`：`new Npc(name).create()` → **isValid 校验**（open.mp npc_create 失败静默，不校验会拿到无效实体）→ `getPlayer()` 触发 NpcException 校验；创建失败必须销毁（否则 NPC 槽位泄漏，反复触发会耗尽池子）；
- 创建前 `npcSlotsLeft()` 查剩余槽位，不足直接提示；
- 多分身创建中途失败自动降级（已建成 ≥1 个则继续用，否则整体回滚清理 + 回收世界 id）。

**NPC sync 屏蔽**：回放/挑战专属 NPC 的 playerId 登记进 `replayNpcIds`，`IPacket(DriverSync / OnFootSync)` 里 `isReplayNpc → return false`（舍弃包）。原因：emulate 模拟的包走 `emulateIncomingPacket` 直入游戏、不进 onIncomingPacket 回调，但 NPC 自身（putInVehicle 残留状态 / setVehiclePos immediate 路径）可能发真实 sync，与模拟广播冲突。

### 4.2 emulate 驱动（emulateDriverSync）

回放的核心：

1. 构造 `InCarSync`（vehicleId / 按键 / 四元数 `[w,x,y,z]` / 位置 / 速度 / 血量 / 起落架 / 警笛 / 拖挂）；
2. `bs.emulateIncomingPacket(npcPlayerId)` 模拟 NPC 传入 → 服务器按**真实司机**处理车辆状态；
3. **显式 `send` 给所有能看到该车的玩家**（遍历 `Player.getInstances`，`vehicle.isStreamedIn(p)`）——客户端本地物理驱动，车速表/氮气按键真实。

两个关键坑的处理：

- **不能用 `sendPacketToPlayerStream(players, npcPlayer)`**：NPC 无客户端实体，`isStreamedIn(npc)` 恒 false，一个玩家都收不到 → 改用**车辆维度** `Vehicle.isStreamedIn`（服务器按世界+距离维护）。
- **发包 30Hz 节流**（`EMULATE_INTERVAL_MS=33`，对齐 open.mp `in_vehicle_sync_rate=30`）：60fps tick 每 2 tick 发一次；seek/快进后播放时间跳变，首帧/跳转帧强制立即发（`lastEmulateAt=0`）。

`atEnd`（播完/暂停/倒计时锚定帧）时速度与按键清零——尾帧非零速度会让车辆在停发后继续滑行/终点抖动。

### 4.3 60fps tick（tickSession）

- **真实流逝时间推进**：`elapsed = min(250, now - lastTickAt)`，播放时间 += `elapsed × speed`。固定 16ms/tick 在事件循环繁忙/定时器节流时实际间隔 >16ms，播放会呈慢倍速感；真实流逝时间保证快慢恒定 1:1。clamp 250ms 防服务器卡顿单次大延迟跳变。
- **发起人离开会话世界 → 自动停止**：ghost 留在无人世界继续播是资源浪费。
- **清扫已退出观战的 watcher**：/tv off 离开回放后不清理，其比赛 TD 会残留屏幕并持续被更新。

### 4.4 播放状态机

| 状态 | 行为 |
|------|------|
| 开场倒计时 | `countdownMs>0`：只推进倒计时，**持续发静止锚定帧**（车停起始位置、速度/按键清零，防物理滑走）；`onGo` 归 0 放行正常播放。仅比赛回放有（3-2-1-GO，TextDraw 动画，对齐比赛倒计时） |
| 播放 | playTime 按 `elapsed × speed` 推进，clamp 到 [0, maxTime]（播到结尾停在边界，不循环；seek 可回看） |
| 暂停 | 时间不推进，但**每 tick 持续发静止锚定帧**——车停在斜坡/不平地形时客户端本地物理无持续校正会缓慢滑走；30Hz 节流 |
| 播完 | playTime ≥ maxTime → 发完尾帧（速度/按键清零）后 `stopped=true` 停发；`endedNotified` 只提示一次；比赛回放补一个 `RACE FINISHED` GameText |

**为什么暂停是"持续发静止帧"而不是"循环重复一段 tick"**：对赛车回放，"停住"才是正确语义（不像角色动画需要原地踏步）；持续静止帧 = 位置冻结 + 持续物理校正，效果是原地停稳。

### 4.5 采样与插值

- `sampleIndexAt`：v7 起按每帧真实时间戳**二分**定位（帧间真实间隔不等——掉线静止帧 100ms / 驾驶帧 33ms，必须按真实时间定位，否则静止段频率摊平全片、驾驶段回放被放慢）；旧文件回退均匀间隔。
- `sampleAt`：定位帧 + `lerpFrame` 插值（四元数归一化）。
- `replayDurationMs` / `frameTimeAt`：末帧时间戳 = 播放总时长 / 帧绝对时间（`frameTs` 惰性构建缓存，只读共享安全）。

### 4.6 多分身（ghost 错峰）

- 同一文件最多 5 辆（`npcCount` 默认 1，`staggerMs` 自定义或自动等分总时长）；
- 每 ghost 独立 `playTime`（错峰起始 = `i × baseGap`），编号**反序**（头车 playTime 最大 = ghost 1/N，与视觉顺序一致）；
- seek 时叠加各自 `staggerMs` 保持错峰（否则 seek 后全部分身重合）；
- 创建数少于请求数时统一重编号（防显示 "ghost 3/2"）；
- **观战切换方向与编号一致**：观战切换候选按视觉顺序注册（头车 ghost 1/N 在前、尾车 N/N 在后，创建顺序是 playTime 升序需显式排序），初始观战/副驾目标 = 视觉头车（`leadGhost`）——方向键 → 切编号 +1、← 切编号 -1。

### 4.7 倍速

- 档位 `REPLAY_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4]`；
- 播放时间按 `elapsed × speed` 推进，`renderGhost` 里**速度字段同步乘倍速**（位置按倍速跳变，速度字段不缩放会出现"位置快、速度慢"的抽动）；
- 车速表侧 `getReplaySpeedScaleForVehicle` 反向除回倍速显示**录制原始速度**；
- **慢放断氮气兜底**：客户端氮气罐按**现实时间**消耗（约 1-2s 喷完），而补管节流是**播放时间**——0.25x 下播放 1s = 现实 4s，点按补管间隔被拉到 4s 现实会断罐。修复：FIRE 按住期间叠加**墙钟兜底**（`NITRO_TOPDUP_MS=1s` 现实补一管，`addNitro` 幂等）；只在 `speed<1` 启用（≥1x 播放时间间隔 ≤1s 现实，罐子不断；challenge 影子固定 1x 不启用）。

**不支持倒放**：倒放时帧间速度插值方向与录制速度矛盾，客户端物理按正向速度处理，车辆会一抽一抽。支持 seek 回看即可。

### 4.8 seek

- 目标 = clamp(arg, 0, maxTime)（上限与 tick 的 maxTime 一致，防 seek 到尾端触发 atEnd + "已播完"提示失效）；
- 强制立即发包（`lastEmulateAt=0`）+ 恢复 `stopped` + 重置 `endedNotified` + 跳过开场倒计时（`countdownMs=0`，取消倒计时动画 TD）。

### 4.9 换车型（ensureGhostVehicle）

帧里 `vehicleModel` 变化（cveh 换车）时：**先摘除旧车所有观战者**（`detachObservingVehicle`——否则 destroy 触发 onStreamOut → suggestStop 弹"对象已无法跟踪"对话框，用户点"是"会撤销后面的重挂）→ 销毁旧车 → 建新车（位置延续、带氮气、注册观战候选）→ NPC 立即上车 → 同一同步函数内重挂观战者。

### 4.10 观战与副驾

- **镜头观战（watch）**：发起人 `startObserveVehicle`（比赛回放自动切独立世界 + 自动观战）；观察者切车键：**方向键 ←/→**（观战/副驾下方向键不触发 onKeyStateChange，统一由 getKeys 轮询边沿检测驱动，见 `pollObserveKeys`。Q/E 不做切换——观战模式客户端把 Q/E 当本地镜头键不上传，实机验证收不到）。
- **副驾模式（ride）**：真实坐进 ghost 乘客座跟随 NPC 开车（`startRideVehicle`，非镜头观战）。切换键同样只用**方向键 ←/→**（FIRE 让位给氮气）；只切车辆目标（不会切到真人玩家）。换车型/重挂失败兜底回镜头观战。
- **退出观战保留回放（`/rp watch off`）**：`stopObserve(stayInWorld)` 不恢复观战前世界——玩家留在回放世界自由活动（回放继续播放），`tickSession` 的"owner 离开回放世界自动停止"判定不触发；再 `/rp watch` 重新观战。
- 比赛信息 TD（C P / TIME / BEST / RANK）从**视觉头车（leadGhost）的当前帧状态**渲染：CP 进度、实时名次、时间/天气全在帧里 → seek/变速天然同步，内容去重（变化才 setString）；
- 3D CP 箭头 + 小地图图标：按帧 `cpProgress` 计算当前要过的 CP，进度推进播 1056 音效；
- 时间/天气随帧应用到观察者视角（CP 脚本 time/weather 的效果"状态化"重放）。

### 4.11 掉线标记

帧 `online` 翻转（跨过掉线边界帧）→ 更新车顶 3D 标签（红字"掉线"）+ 聊天提示一次。检测放采样后、节流前——保证边界帧即使被 30Hz 节流跳过也能触发。

### 4.12 控制命令（controlReplay）

`/rp pause|play|speed|seek|watch|ride|stop`（各看各的：只作用于自己发起的会话）。pause 立即发一帧静止帧（即时反馈，不等 tick）；play 解除暂停继续推进（全部停发则提示"已播完"）。

### 4.13 清理（stopReplaySession）

先统一退出观战（防 destroy 车辆触发 suggestStop 弹窗）→ 注销 sync 屏蔽 + 移出观战候选 → 销毁标签/NPC/车辆 → 销毁观战 TD → 回收独立世界 id → 取消倒计时动画 → 恢复观察者时间/天气（`applyWorldEnv`）→ 恢复发起人世界 + 爱车世界（防爱车留独立世界成幽灵车）。

---

## 5. 核心设计决策

### 5.1 为什么"每帧存完整状态"而不是"重放事件"

CP 脚本是离散事件（cveh 换车、time/weather、fix/damage），NPC 回放不会重新触发 `onPlayerReachCp`。若只录位置，seek/回退到某帧时"事件顺序"必然错乱。改为每帧记录那一刻的**完整可观测状态**——事件的效果已编码进后续帧（换车后的车型、改过的时间天气），seek = **恢复状态而非重放事件**，天然无时序问题。观战 HUD 也从帧状态渲染，不依赖事件。这也让"前进/后退时手动销毁重建 CP/TextDraw/3DText"整个不需要了——一切由帧驱动，会话停止统一销毁。

### 5.2 为什么不用固定 tick 步进

固定 16ms/tick 在定时器节流时播放时间走得比现实慢 → 慢倍速感。用真实流逝时间推进，快慢恒定 1:1。

### 5.3 为什么不接管真实玩家的车

你无法主动设置真实玩家的 CarSync/FootSync。现状回放是**旁观/竞技**定位：ghost 车锁门只可看；**副驾模式（/rp ride）是真实坐进 ghost 乘客座跟随 NPC 开车**（`startRideVehicle`，服务端 `putPlayerIn` 入座，非接管主驾——司机仍是录制 NPC），比赛中副驾主视角也可用；挑战是玩家开自己的车 vs NPC 影子。没有"NPC 接管玩家主驾"的场景，所以那套"副驾→接管→换回"逻辑未实现。

---

## 6. 生命周期与清理

| 路径 | 处理 |
|------|------|
| `initReplay` | 建录制目录 → 补建待落库索引（防孤儿误删）→ 清理孤儿文件/.tmp → 注册命令 → 挂 RakNet 拦截 + 兜底定时器 → 注册 NPC sync 屏蔽 |
| 断线 `cleanupReplay` | 录制强制落盘（ghost 直接丢弃）→ 回放会话销毁 → 挑战清理 |
| 进比赛/房间切换 `stopReplayForPlayer` | 停止回放 + 清理挑战（比赛中 /rp 被白名单拦截无法主动停，不清理会留下挂机 ghost） |
| 服务器退出 `shutdownReplay` | 全部回放/挑战销毁 + 录制落盘（含挂起会话；同步写文件 + 索引，await create 未 settle 由索引兜底） |

## 7. 影子挑战（challenge.ts）

- 玩家开自己的爱车（坐主驾），选一条"自己的该赛道比赛回放"作影子：`sampleAt` 采样 + `emulateDriverSync` 驱动影子 NPC（与回放同一套）；
- 复用 playback 的 NPC 池 / 世界段（`REPLAY_WORLD_BASE=2001` 起）/ sync 屏蔽集；
- 赛道 CP 检测（与比赛共用 RaceCpEvent 入口）、AFK/掉线/结算各自独立；
- 影子播完边界 = 播放终点，`CHALLENGE_END_GRACE_MS=20s` 宽限；
- **玩家与影子并排起步**：影子车起点 = 回放录制起点（`data.header.startX/Y/Z`），玩家爱车 `seatPlayerAtStart` 也放到同一录制起点（此前用第一个 CP `cps[0]`，与影子错位）；起步朝向 0（header 未存录制角度），与影子车一致；CP 箭头仍指向第一个 CP。
- 挑战**不进入观战**：玩家开自己车实时 PK（观战是回放 watch 的事，两套互斥入口——挑战中 `/rp` 被拦截）。
