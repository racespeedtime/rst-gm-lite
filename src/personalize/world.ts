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
import { parseIntInRange } from "@/utils/parse";
import { showDialog } from "@/utils/dialog";
import type { MenuBack } from "@/core/panel";

/** 玩家游戏内颜色色板 */
const COLOR_PALETTE = [
  { label: "白色", value: "#ffffff" },
  { label: "红色", value: "#ff5555" },
  { label: "绿色", value: "#55ff55" },
  { label: "蓝色", value: "#5555ff" },
  { label: "黄色", value: "#ffff55" },
  { label: "青色", value: "#55ffff" },
  { label: "紫色", value: "#ff55ff" },
  { label: "橙色", value: "#ffaa00" },
  { label: "粉色", value: "#ffaacc" },
  { label: "灰色", value: "#aaaaaa" },
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
 */
export async function openWorldMenu(player: Player, back?: MenuBack): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const options = [
    `跟随世界时间：${toggleText(setting.syncGameTime)}`,
    `跟随世界天气：${toggleText(setting.syncWorldWeather)}`,
    `个人时间流逝：${toggleText(setting.timeFlow)}`,
    `个人时间天气（时:${pad2(setting.timeHour)} 天气:${setting.weather}）`,
    `显示物件（obj）：${toggleText(setting.showObject)}`,
    `游戏内颜色`,
    `出生点设置`,
    `接受传送：${toggleText(setting.acceptTeleport)}`,
  ];
  const index = await pickOption(player, "世界个性化", options);
  if (index < 0) return back?.();

  if (index === 0) {
    // 跟随世界时间：切换后立即应用（否则要等下一个 60s 同步才生效）
    await toggleSetting(player, "syncGameTime", "跟随世界时间");
    await applyWorldEnv(player);
    return;
  }
  if (index === 1) {
    // 跟随世界天气：切换后立即应用（否则保持旧天气直到下次轮换）
    await toggleSetting(player, "syncWorldWeather", "跟随世界天气");
    await applyWorldEnv(player);
    return;
  }
  if (index === 2) {
    await toggleSetting(player, "timeFlow", "个人时间流逝");
    return;
  }
  if (index === 3) {
    await openTimeWeatherFlow(player);
    return;
  }
  if (index === 4) {
    // 显示物件：切换后立即对玩家生效（房屋/场景物件显隐）
    const next = !setting.showObject;
    await updateSetting(player, { showObject: next });
    notifySaved(player, `显示物件已${next ? "开启" : "关闭"}`);
    setHouseObjectsVisibleForPlayer(player, next);
    return;
  }
  if (index === 5) {
    const current = setting.playerColor || "#ffffff";
    const options = COLOR_PALETTE.map((c) =>
      c.value.toLowerCase() === current.toLowerCase() ? `${c.label}（当前）` : c.label,
    );
    options.push(`自定义（当前：${current}）`);
    const colorIndex = await pickOption(player, "游戏内颜色", options);
    if (colorIndex < 0) return;
    let next: string;
    if (colorIndex < COLOR_PALETTE.length) {
      next = COLOR_PALETTE[colorIndex].value;
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
      if (!res || res.response !== 1) return;
      const input = res.inputText.trim();
      // 归一化为 hex（#fff → #ffffff、(r,g,b) → #rrggbb、(r,g,b,a) → #rrggbbaa），
      // 保证长度 ≤9 兼容 player_color VarChar(9)，否则 (255,255,255,255) 超长写库抛错
      const hexColor = normalizeHexColor(input);
      if (!hexColor) {
        player.sendClientMessage(COLOR_ERROR, "颜色格式不正确（支持 #fff / #ff0000 / (r,g,b,a)）");
        return;
      }
      next = hexColor;
    }
    await updateSetting(player, { playerColor: next });
    player.setColor(next);
    notifySaved(player, `游戏内颜色已设为：${next}`);
    return;
  }
  if (index === 6) {
    await openSpawnSettingsFlow(player);
    return;
  }
  if (index === 7) {
    await toggleSetting(player, "acceptTeleport", "接受传送");
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
