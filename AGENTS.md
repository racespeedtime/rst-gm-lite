# AGENTS.md

## Repo Overview

"RST"（RaceSpeedTime）轻量化竞技重构版游戏模式：**open.mp + samp-node + @infernus/core 0.14.7**，纯 TypeScript（无 Pawn）。PostgreSQL + Prisma 7 存储。中文服务器。

- 入口 `src/main.ts`（仅 `import "./logger" "./raknet" "./callbacks"`）；samp-node 加载 `dist/bundle.js`（vite SSR 打包产物）。
- 全部事件注册与模块初始化集中在 `src/callbacks/index.ts`（onConnect 认证流程、各模块 `initXxx`）。
- 语义对齐源：**D:\Work\pawn-server**（原版 pawn RST：`gamemodes/racespeedtime.pwn` + `pawno/include/common/*.inc`）；数据库结构对齐 **D:\Work\rst-backend**。

## Build & Verify

```sh
npx tsc --noEmit        # 改完必须通过（严格模式）
pnpm lint               # oxlint（提交前跑）
pnpm build              # vite 生产打包（dist/bundle.js）
pnpm dev                # 开发：vite watch + nodemon 重启 omp-server.exe
pnpm serve              # 生产模式
```

无测试框架；验证靠编译 + 实机连服，运行时日志 `log.txt` / `samp-node.log`。

## Project Layout（src/）

| 路径 | 职责 |
|------|------|
| `callbacks/` | 事件注册总入口：认证流程、登录镜头、所有模块 init |
| `core/` | 通用系统：`spawn` 出生（onRequestSpawn gate）/`panel` 万能面板/`observe` 观战/`timers` 登记式 timer/`colandreas` 碰撞与地面/`vehicleAuto` 无碰撞+翻正+stunt/`invincible` 无敌/`loginCamera`/`ratelimit`/`help`/`worldenv` 世界时间天气/`playerStyle`/`profile`/`interaction` 锁定 |
| `auth/` | 登录认证 + 会话心跳（`sys_user_game_session`） |
| `sessions/` | 公共大世界与战局（常量 `PUBLIC_WORLD_ID`、`PUBLIC_SESSION_ID`） |
| `race/` | 比赛：`room` 房间/`scripts` CP 脚本解析执行/`editor` 赛道编辑器/`vehicle` 比赛车 |
| `vehicles/` | 爱车系统（一人一车 `playerVehs`）、`catalog` 车型目录、`menu` 选车 |
| `attire/` | 装扮/挂件（含 EditAttachedObject 实时编辑）、`admin` 装扮管理 |
| `personalize/` | `settings` 个人设置/pickOption 表格、`skinPicker` 3D 选肤、`quickActions` 快捷命令、`lobby` 登录大厅、character/world/interface/vehicle 子菜单 |
| `admin/` | OP 命令（op/ban/unban/…） |
| `chat/` | 聊天 / pm 私聊 |
| `house/` `teleport/` `interface/gui.ts` | 房屋 / 传送 / GUI |
| `utils/` | `constants`（DEFAULT_CHARSET）、`colors`、`format`、`dialog`、`pagedDialog`、`parse`、`sort`、`map` |
| `prisma/` | `schema.prisma` + `migrations/` + `generated/` |

## 关键约定（血泪，改代码前必读）

1. **infernus dispatcher `ci` 语义**：`async` handler 的返回值**被忽略**（返回 defaultValue）；只有**同步** handler 的返回值才是分派结果；`next()` 继续后续 handler。热路径（`onRequestSpawn`/`onTakeDamage`/`onWeaponShot`/`onCommandError`）必须**同步 `return false`**。`next()` 与 `return false` 不可同用（语义矛盾）。open.mp 的 `RequestSpawn` 不检查 spect——登录/重生 gate 全靠 `onRequestSpawn` 同步拦截。
2. **Timer 必须登记**：open.mp 不会帮清理 Node timers。一律用 `src/core/timers.ts` 的 `setIntervalSafe`/`setTimeoutSafe`（GameMode.onExit 统一清理），禁止裸 `setTimeout`/`setInterval`。延迟可用共享 `sleep(ms)`。
3. **字符集**：`DEFAULT_CHARSET = "gbk"`（`src/utils/constants.ts`），必须统一用它、不要手写 `"gbk"`。**e-selection 用 TextDraw 渲染、不支持中文**（3D 选车/选肤界面一律英文标题）；`TextLabel` 可 `charset: DEFAULT_CHARSET` 显示中文；`TextDraw`/`GameText` 不支持中文。
4. **GTA 角度是逆时针的**：0=北、90=**西**、180=南、270=东（与真实罗盘相反，open.mp 文档明确 "Angles are reversed in GTA:SA"）。车前方向（世界坐标）= `(-sinθ, -cosθ)`；位置偏移同式。CP 脚本 `speed`/`speedex` 是独立坐标系：x=速度·cos(na)、y=速度·sin(na)、角度基准=玩家朝向+90、`|` 模式=角度+90、角度 0=正东、只设速度不设朝向（`src/race/scripts.ts:setVehicleSpeed`）。
5. **世界 id**：公共大世界 `PUBLIC_WORLD_ID = 0`（用常量，禁手写 0）；战局 1..n；比赛房间独立世界从 `RACE_WORLD_BASE = 5000` 起。
6. **人数**：玩家上限 1000、NPC 槽位 100（config.json `max_players`/`max_npcs`）。所有事件回调统一排除 NPC。
7. **config.json 现代键**：服务器名/模式用顶层 `name` 与 `game.mode`（UTF-8）；**不要**用 rcon legacy 键 `hostname`/`gamemodetext`（触发 "Legacy key supplied" 警告）。
8. **对话框**：`TABLIST_HEADERS` 表头不占 listItem 行号（从 0 起）；e-selection `maxItemPerPage` 布局 = 第一行 6 + 第二行 8（一页 14 格铺满）。
9. **colandreas**：`findZ_For2DCoord` 水域返回海底；`getSafeGroundZ` fallback -100；水中找陆地以 `SEA_LEVEL = 0` 以上 1.5 判陆地。
10. **比赛 CP 脚本**：`spawnpos` 返回 false **终止整条脚本链**；**第一 CP 的 `cveh` = 赛道标准车型**（进赛道 joinRoom 即按它匹配/懒创建爱车，触碰第一 CP 跳过换车，`skipCveh`）；其他 CP 的 cveh 照常（如 Car 赛道 CP11 的 562）；`cveh` 换车后新车 `registerOwnedVehicle` 登记为爱车（离开比赛保留），脚本车（`registerScriptVehicle`）随离开/断线/比赛结束清理（爱车跳过）。
11. **爱车语义**：一人一车（`playerVehs`，`src/vehicles/index.ts`）。`spawnVehicle` 懒创建 `user_vehicle` 行（有该模型则复用外观预设），无该模型爱车则自动创建——"玩家始终用自己的爱车"。刷车/换车都会销毁旧车实体。
12. **数据库**：**不要动数据库里的数据**（用户明确）；schema 改动用 `npx prisma migrate dev --name xxx`（prisma.config.ts 指向 `src/prisma/schema.prisma`），`public.sql` 是线上 dump 只读参考。

## Git 习惯

- 每个功能/修复一个独立 commit，描述具体做了什么 + 为什么（用户常要求推送）。
- 用户要求清理历史时优先 rebase 重放（保留穿插的非相关修复），再 `push --force-with-lease`；本地有他人 clone 时提醒对方 reset。
- 不要重复提交同一话题的反复修正（先想清楚再做）。
