import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import {
  getSetting,
  updateSetting,
  pickOption,
  notifySaved,
  toggleText,
  toggleSetting,
  COLOR_ERROR,
} from "./settings";
import { openSpawnSettingsFlow } from "@/core/spawn";
import { setHouseObjectsVisibleForPlayer } from "@/house";
import { applyWorldEnv } from "@/core/worldenv";
import { applyPlayerStyle } from "@/core/playerStyle";
import { showPagedDialog } from "@/utils/pagedDialog";
import { parseIntInRange } from "@/utils/parse";
import { showDialog } from "@/utils/dialog";
import type { MenuBack } from "@/core/panel";

/** 玩家游戏内颜色色板：60 色（Hue 渐变）+ 自定义入口 */
function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const rgb = Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
    return rgb.toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 60 色：色相 0-354（步进 6°），饱和 100%、亮度 45%（鲜艳且文字可读） */
const GENERATED_COLORS: string[] = Array.from({ length: 60 }, (_, i) => hslToHex((i * 6) % 360, 1, 0.45));

/** 颜色选择条目：value = hex，label = 显示文本（渲染时用实际颜色） */
interface ColorEntry {
  value: string;
  label: string;
}

/** 色板条目：60 生成色 + 自定义入口（分页选择，实际颜色渲染） */
const COLOR_ENTRIES: ColorEntry[] = [
  ...GENERATED_COLORS.map((v) => ({ value: v, label: v })),
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
    const hexStr = [r, g, b]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
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
    { name: "个人时间天气", value: `${pad2(setting.timeHour)}:${pad2(setting.timeMinute)} · ${setting.weather}` },
    { name: "显示物件（obj）", value: toggleText(setting.showObject) },
    { name: "游戏内颜色", value: setting.playerColor || "#ffffff" },
    { name: "出生点设置", value: "" },
    { name: "接受传送", value: toggleText(setting.acceptTeleport) },
  ];
  const index = await pickOption(player, "世界个性化", rows.map((r) => r.name), {
    headers: ["设置", "当前"],
    format: (_o, i) => [rows[i].name, rows[i].value],
  });
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
    await toggleSetting(player, "timeFlow", "个人时间流逝");
    return again();
  }
  if (index === 3) {
    await openTimeWeatherFlow(player);
    return again();
  }
  if (index === 4) {
    // 显示物件：切换后立即对玩家生效（房屋/场景物件显隐）
    const next = !setting.showObject;
    await updateSetting(player, { showObject: next });
    notifySaved(player, `显示物件已${next ? "开启" : "关闭"}`);
    setHouseObjectsVisibleForPlayer(player, next);
    return again();
  }
  if (index === 5) {
    const current = (setting.playerColor || "#ffffff").toLowerCase();
    // 分页选择（每页 12 色 × 5 页 + 自定义），条目用实际颜色渲染（{RRGGBB} 前缀）
    const r = await showPagedDialog(player, {
      caption: "游戏内颜色",
      data: COLOR_ENTRIES,
      pageSize: 12,
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
    player.setTime(hour, minute);
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
