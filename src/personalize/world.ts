import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import {
  getSetting,
  updateSetting,
  pickOption,
  notifySaved,
  toggleText,
  toggleSetting,
} from "./settings";
import { COLOR_ERROR } from "@/utils/colors";
import { openSpawnSettingsFlow } from "@/core/spawn";
import { setHouseObjectsVisibleForPlayer } from "@/house";
import { applyWorldEnv } from "@/core/worldenv";
import { applyPlayerStyle } from "@/core/playerStyle";
import { showPagedDialog } from "@/utils/pagedDialog";
import { parseIntInRange } from "@/utils/parse";
import { showDialog } from "@/utils/dialog";
import type { MenuBack } from "@/core/panel";

/**
 * 玩家游戏内颜色色板：经典 SA-MP PlayerColors[200]（0xAARRGGBB，0-99 唯一、
 * 100-199 为前段重复）。忠实保留原版配色——老玩家对这套默认玩家颜色有肌肉记忆
 * （小地图点/NameTag 都是这套色）。运行时转 #RRGGBB（alpha 恒 FF）+ 去重（去重后
 * 99 色，因原数组前段末尾 0xD8C762FF 出现两次）。加自定义共 100 条 × 每页 20 = 5 页铺满。
 */
const SA_PLAYER_COLORS = [
  0xff8c13ff, 0xc715ffff, 0x20b2aaff, 0xdc143cff, 0x6495edff, 0xf0e68cff, 0x778899ff, 0xff1493ff,
  0xf4a460ff, 0xee82eeff, 0xffd720ff, 0x8b4513ff, 0x4949a0ff, 0x148b8bff, 0x14ff7fff, 0x556b2fff,
  0x0fd9faff, 0x10dc29ff, 0x534081ff, 0x0495cdff, 0xef6ce8ff, 0xbd34daff, 0x247c1bff, 0x0c8e5dff,
  0x635b03ff, 0xcb7ed3ff, 0x65adebff, 0x5c1accff, 0xf2f853ff, 0x11f891ff, 0x7b39aaff, 0x53eb10ff,
  0x54137dff, 0x275222ff, 0xf09f5bff, 0x3d0a4fff, 0x22f767ff, 0xd63034ff, 0x9a6980ff, 0xdfb935ff,
  0x3793faff, 0x90239dff, 0xe9ab2fff, 0xaf2ff3ff, 0x057f94ff, 0xb98519ff, 0x388eeaff, 0x028151ff,
  0xa55043ff, 0x0de018ff, 0x93ab1cff, 0x95baf0ff, 0x369976ff, 0x18f71fff, 0x4b8987ff, 0x491b9eff,
  0x829dc7ff, 0xbce635ff, 0xcea6dfff, 0x20d4adff, 0x2d74fdff, 0x3c1c0dff, 0x12d6d4ff, 0x48c000ff,
  0x2a51e2ff, 0xe3ac12ff, 0xfc42a8ff, 0x2fc827ff, 0x1a30bfff, 0xb740c2ff, 0x42acf5ff, 0x2fd9deff,
  0xfafb71ff, 0x05d1cdff, 0xc471bdff, 0x94436eff, 0xc1f7ecff, 0xce79eeff, 0xbd1ef2ff, 0x93b7e4ff,
  0x3214aaff, 0x184d3bff, 0xae4b99ff, 0x7e49d7ff, 0x4c436eff, 0xfa24ccff, 0xce76beff, 0xa04e0aff,
  0x9f945cff, 0xdcde3dff, 0x10c9c5ff, 0x70524dff, 0x0be472ff, 0x8a2cd7ff, 0x6152c2ff, 0xcf72a9ff,
  0xe59338ff, 0xeedc2dff, 0xd8c762ff,
];

/** 经典配色去重 + 转 #RRGGBB（0xAARRGGBB 的 alpha 恒 FF，颜色取后 6 位） */
const PLAYER_PALETTE: string[] = [
  ...new Set(SA_PLAYER_COLORS.map((c) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`)),
];

/** 颜色选择条目：value = hex，label = 显示文本（渲染时用实际颜色） */
interface ColorEntry {
  value: string;
  label: string;
}

/** 色板条目：经典配色（去重后 100 色）+ 自定义入口（分页选择，实际颜色渲染） */
const COLOR_ENTRIES: ColorEntry[] = [
  ...PLAYER_PALETTE.map((v) => ({ value: v, label: v })),
  { value: "", label: "自定义…" },
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 颜色归一化为 hex：支持 #fff / #ffffff / (r,g,b) / (r,g,b,a)。
 * 返回 "#rrggbb"（≤7）或 "#rrggbbaa"（9），保证兼容 player_color VarChar(9)；
 * 非法输入返回 null。
 */
function normalizeHexColor(input: string): string | null {
  const s = input.trim();
  const hex = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s);
  if (hex) {
    let v = hex[1].toLowerCase();
    if (v.length === 3) v = [...v].map((c) => c + c).join("");
    return `#${v}`;
  }
  const rgba = /^\((\d{1,3}),(\d{1,3}),(\d{1,3})(,(\d{1,3}))?\)$/.exec(s);
  if (rgba) {
    const [r, g, b] = [rgba[1], rgba[2], rgba[3]].map((n) => Math.min(255, Number(n)));
    const a = rgba[5] != null ? Math.min(255, Number(rgba[5])) : null;
    const hexStr = [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
    return a != null ? `#${hexStr}${a.toString(16).padStart(2, "0")}` : `#${hexStr}`;
  }
  return null;
}

/**
 * 世界个性化菜单
 * 1. 跟随世界时间（开关）
 * 2. 跟随世界天气（开关）
 * 3. 个人时间流逝（开关）
 * 4. 个人时间天气（设置具体时间点与天气）
 * 5. 开关obj
 * 6. 游戏内颜色（色板）
 * 7. 出生点设置（随机/上次位置）
 * 8. 接受传送（开关）
 *
 * 表格两列（功能 | 当前值），操作一项后自动刷新回本菜单（状态实时刷新），
 * 点"取消"才退出面板。
 */
export async function openWorldMenu(player: Player, back?: MenuBack): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const rows = [
    { name: "跟随世界时间", value: toggleText(setting.syncGameTime) },
    { name: "跟随世界天气", value: toggleText(setting.syncWorldWeather) },
    { name: "个人时间流逝", value: toggleText(setting.timeFlow) },
    {
      name: "个人时间天气",
      value: `${pad2(setting.timeHour)}:${pad2(setting.timeMinute)} · ${setting.weather}`,
    },
    { name: "显示物件（obj）", value: toggleText(setting.showObject) },
    { name: "游戏内颜色", value: setting.playerColor || "#ffffff" },
    { name: "出生点设置", value: "" },
    { name: "接受传送", value: toggleText(setting.acceptTeleport) },
  ];
  const index = await pickOption(
    player,
    "世界个性化",
    rows.map((r) => r.name),
    {
      headers: ["设置", "当前"],
      format: (_o, i) => [rows[i].name, rows[i].value],
    },
  );
  if (index < 0) return back?.();

  const again = () => openWorldMenu(player, back);
  if (index === 0) {
    // 跟随世界时间：切换后立即应用（否则要等下一个 60s 同步才生效）
    await toggleSetting(player, "syncGameTime", "跟随世界时间");
    await applyWorldEnv(player);
    return again();
  }
  if (index === 1) {
    // 跟随世界天气：切换后立即应用（否则保持旧天气直到下次轮换）
    await toggleSetting(player, "syncWorldWeather", "跟随世界天气");
    await applyWorldEnv(player);
    return again();
  }
  if (index === 2) {
    // 个人时间流逝：切换后立即重建冻结定时器（否则旧 60s interval 继续把
    // 时间回退到旧设定值，开关表现为延迟到下次重生才生效）
    await toggleSetting(player, "timeFlow", "个人时间流逝");
    await applyWorldEnv(player);
    return again();
  }
  if (index === 3) {
    await openTimeWeatherFlow(player);
    return again();
  }
  if (index === 4) {
    // 显示物件：切换后立即对玩家生效（房屋/场景物件显隐）。
    // 说明：隐藏是全局 streamer 虚拟坐标方案（infernus 无 per-object 玩家级
    // 显隐 API），3D 速度表与爱车挂件（DynamicObject attach 车辆）也会一并隐藏
    const next = !setting.showObject;
    await updateSetting(player, { showObject: next });
    notifySaved(
      player,
      next ? "显示物件已开启" : "显示物件已关闭（3D 速度表与爱车挂件也会一并隐藏）",
    );
    setHouseObjectsVisibleForPlayer(player, next);
    return again();
  }
  if (index === 5) {
    const current = (setting.playerColor || "#ffffff").toLowerCase();
    // 分页选择（每页 20 色 × 5 页铺满经典配色 + 自定义），条目用实际颜色渲染（{RRGGBB} 前缀）
    const r = await showPagedDialog(player, {
      caption: "游戏内颜色",
      data: COLOR_ENTRIES,
      pageSize: 20,
      format: (entry) => {
        const isCurrent = entry.value && entry.value.toLowerCase() === current;
        const mark = isCurrent ? "（当前）" : "";
        // 实际颜色渲染：{色值}色值（颜色码即显示颜色），自定义项白色显示
        const color = entry.value || "#ffffff";
        return `{${color.replace("#", "")}}${entry.value || "自定义"}${mark}`;
      },
      button1: "选择",
      button2: "取消",
    });
    if (!r) return again();
    let next: string;
    if (r.item.value) {
      next = r.item.value;
    } else {
      // 自定义颜色：输入（校验格式）
      const res = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.INPUT,
          caption: "游戏内颜色",
          info: "输入颜色（支持 #fff / #ff0000 / (r,g,b,a)）：",
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!res || res.response !== 1) return again();
      const input = res.inputText.trim();
      // 归一化为 hex（#fff → #ffffff、(r,g,b) → #rrggbb、(r,g,b,a) → #rrggbbaa），
      // 保证长度 ≤9 兼容 player_color VarChar(9)，否则 (255,255,255,255) 超长写库抛错
      const hexColor = normalizeHexColor(input);
      if (!hexColor) {
        player.sendClientMessage(COLOR_ERROR, "颜色格式不正确（支持 #fff / #ff0000 / (r,g,b,a)）");
        return again();
      }
      next = hexColor;
    }
    await updateSetting(player, { playerColor: next });
    player.setColor(next);
    // 聊天名颜色跟随玩家颜色（刷新聊天名缓存）
    await applyPlayerStyle(player);
    notifySaved(player, `游戏内颜色已设为：${next}`);
    return again();
  }
  if (index === 6) {
    await openSpawnSettingsFlow(player);
    return again();
  }
  if (index === 7) {
    await toggleSetting(player, "acceptTeleport", "接受传送");
    return again();
  }
}

/** 个人时间天气设置：具体时间点（时:分）与天气ID */
async function openTimeWeatherFlow(player: Player): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const sub = await pickOption(player, "个人时间天气", [
    `个人时间（当前 ${pad2(setting.timeHour)}:${pad2(setting.timeMinute)}）`,
    `个人天气（当前 ${setting.weather}）`,
  ]);
  if (sub < 0) return;

  if (sub === 0) {
    // 设置时间点
    const res = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "个人时间",
        info: `输入时间（格式 时:分，如 12:30，当前 ${pad2(setting.timeHour)}:${pad2(setting.timeMinute)}）：`,
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!res || res.response !== 1) return;
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(res.inputText.trim());
    if (!m) {
      player.sendClientMessage(COLOR_ERROR, "时间格式不正确，应为 时:分（如 12:30）");
      return;
    }
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) {
      player.sendClientMessage(COLOR_ERROR, "时间超出范围（时 0-23，分 0-59）");
      return;
    }
    await updateSetting(player, { timeHour: hour, timeMinute: minute });
    // 立即重建冻结定时器：applyWorldEnv 会清除旧 60s interval 并按新时刻重设
    //（否则冻结模式下旧定时器把刚设的时间回退成旧值）
    await applyWorldEnv(player);
    notifySaved(player, `个人时间已设为 ${pad2(hour)}:${pad2(minute)}`);
    return;
  }

  // 设置天气
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "个人天气",
      info: `输入天气ID（0-255，当前 ${setting.weather}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return;
  const weather = parseIntInRange(res.inputText, 0, 255);
  if (weather == null) {
    player.sendClientMessage(COLOR_ERROR, "天气ID需为 0-255 的整数");
    return;
  }
  await updateSetting(player, { weather });
  player.setWeather(weather);
  notifySaved(player, `个人天气已设为 ${weather}`);
}
