import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import { loadAllHouseObjects, unloadAllHouseObjects } from "./index";
import { sysMsg } from "@/utils/msg";
import type { MenuBack } from "@/core/panel";

/**
 * OP 房屋管理（仅 superadmin，对齐 backend house-model API 的导入/导出/校验）：
 * - 导入：house_import/ 下的源文件（每行 "type args"，// # 注释）→ 解析校验
 *   （移植 backend VALID_TYPE_ARGS 规则）→ 事务整体替换该房屋 house_model → 重载实体
 * - 导出：全部模型写成 "type args" 文本到 house_export/{房屋名}.txt，提示路径
 * - 单条：添加（选类型 + args 格式提示）/ 删除 / 房屋启用停用
 * 入口：面板「管理 → 房屋管理」（isSuperAdmin 可见）
 */

/** OP 导入源文件目录（服务器运行目录下；OP 把模型源文件放这里再游戏内指定文件名） */
const HOUSE_IMPORT_DIR = "scriptfiles/house_import";
/** 导出模型文件目录 */
const HOUSE_EXPORT_DIR = "scriptfiles/house_export";

/**
 * 模型类型校验规则（移植 rst-backend house-model.service VALID_TYPE_ARGS）。
 * minParts 以 gm-lite 加载器口径为准：obj 的 drawDistance 可选（≥7）；
 * 加载器会跳过 sell/move/moveobj/changeobj（依赖经济/动画/状态机），但允许导入
 *（保留数据、加载时跳过并记日志），避免 OP 导入原版文件时被拒。
 */
const TYPE_RULES: Record<string, { minParts: number; desc: string; skipped?: boolean }> = {
  obj: { minParts: 7, desc: "{modelId} {x} {y} {z} {rX} {rY} {rZ} [drawDistance]" },
  material: { minParts: 5, desc: "{index} {modelId} {txdName} {textureName} {color}" },
  materialtext: {
    minParts: 9,
    desc: "{index} {text} {textSize} {fontFace} {fontSize} {textBold} {fontColor} {bgColor} {alignment}",
  },
  removeobj: { minParts: 5, desc: "{modelId} {x} {y} {z} {radius}" },
  CreateVehicle: { minParts: 7, desc: "{modelId} {x} {y} {z} {angle} {color1} {color2}" },
  "3dtext": { minParts: 4, desc: "{text} {x} {y} {z}" },
  area: { minParts: 3, desc: "{x} {y} {radius}" },
  sell: { minParts: 5, desc: "{price} {x} {y} {z} {angle}", skipped: true },
  move: {
    minParts: 19,
    desc: "{modelId} {x} {y} {z} {rX} {rY} {rZ} {speed} {x1} {y1} {z1} {rX1} {rY1} {rZ1} {speed1} {time} {range} {distance} {status}",
    skipped: true,
  },
  moveobj: {
    minParts: 11,
    desc: "{model1} {x} {y} {z} {rX} {rY} {rZ} {model2} {status} {range} {distance}",
    skipped: true,
  },
  changeobj: {
    minParts: 11,
    desc: "{model1} {x} {y} {z} {rX} {rY} {rZ} {model2} {status} {range} {distance}",
    skipped: true,
  },
};

/** 校验一条模型（类型存在 + 参数数足够）；失败抛带前缀的错误（前端展示行号） */
function validateModel(type: string, args: string, linePrefix = ""): void {
  const prefix = linePrefix ? `${linePrefix}: ` : "";
  const rule = TYPE_RULES[type];
  if (!rule) {
    throw new Error(`${prefix}未知类型"${type}"。可用类型：${Object.keys(TYPE_RULES).join(", ")}`);
  }
  if (!args) {
    throw new Error(`${prefix}缺少 args 参数（类型 "${type}" 格式：${rule.desc}）`);
  }
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length < rule.minParts) {
    throw new Error(
      `${prefix}类型 "${type}" 至少需要 ${rule.minParts} 个参数，当前 ${parts.length} 个。格式：${rule.desc}`,
    );
  }
}

/** 解析导入文件内容（每行 "type args"，// # 注释跳过；空行跳过）。返回模型条目数组 */
function parseImportContent(content: string): { type: string; args: string }[] {
  const lines = content.split("\n");
  const entries: { type: string; args: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("//") || raw.startsWith("#")) continue;
    const spaceIdx = raw.indexOf(" ");
    const type = spaceIdx > 0 ? raw.slice(0, spaceIdx).trim() : raw;
    const args = spaceIdx > 0 ? raw.slice(spaceIdx + 1).trim() : "";
    validateModel(type, args, `Line ${i + 1}`);
    entries.push({ type, args });
  }
  if (entries.length === 0) {
    throw new Error('文件中没有有效条目（支持 "type args" 每行一条，// # 注释）');
  }
  return entries;
}

/** 文件名净化：只保留安全字符，拒绝路径穿越（.. / \\） */
function sanitizeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!clean || clean === "." || clean === "..") throw new Error("文件名无效");
  return clean;
}

/** 确保导入/导出目录存在 */
function ensureDirs(): void {
  for (const dir of [HOUSE_IMPORT_DIR, HOUSE_EXPORT_DIR]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (e) {
      logger.error(`[house] 创建目录失败 ${dir}`, e);
    }
  }
}

/** 重载全部房屋实体（OP 改动后生效；全量重载最可靠——material 材质绑定跨行依赖 obj 表） */
async function reloadHouseObjects(): Promise<void> {
  unloadAllHouseObjects();
  await loadAllHouseObjects();
}

/** 房屋操作菜单（导入/导出/添加/删除/启用） */
async function houseActions(
  player: Player,
  house: { id: string; name: string; isEnabled: boolean },
  back?: MenuBack,
): Promise<void> {
  const again = () => houseActions(player, house, back);
  const modelCount = await prisma.houseModel.count({ where: { houseId: house.id } });
  const race = await prisma.race.findFirst({
    where: { houseId: house.id },
    select: { name: true },
  });
  const tele = await prisma.teleport.findFirst({
    where: { houseId: house.id },
    select: { name: true },
  });
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `房屋「${house.name}」（${modelCount} 模型${race ? ` · 赛道 ${race.name}` : ""}${tele ? ` · 传送点 ${tele.name}` : ""}）`,
      info: [
        `1. 导入模型源文件（整体替换）`,
        `2. 导出全部模型（写文件）`,
        `3. 添加单个模型`,
        `4. 删除模型`,
        `5. ${house.isEnabled ? "停用" : "启用"}房屋`,
        `6. 关联赛道${race ? `（当前：${race.name}）` : ""}`,
        `7. 关联传送点${tele ? `（当前：${tele.name}）` : ""}`,
      ].join("\n"),
      button1: "确定",
      button2: "返回",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  switch (res.listItem) {
    case 0: {
      // 导入：house_import/ 目录下的源文件
      let files: string[] = [];
      try {
        ensureDirs();
        files = readdirSync(HOUSE_IMPORT_DIR).filter((f) => !f.startsWith("."));
      } catch (e) {
        logger.error("[house] 读取导入目录失败", e);
      }
      const fileRes = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.INPUT,
          caption: "导入模型源文件",
          info:
            `输入 house_import/ 下的文件名（每行 "type args"，// # 注释）：\n` +
            (files.length
              ? `可用文件：${files.join("、")}`
              : `（目录为空，先把 .txt/.map 源文件放进 scriptfiles/house_import/）`) +
            `\n提示：3dtext 的 text、materialtext 的 text/fontFace 含空格/中文时需 URL 编码（对齐后端导入约定）`,
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!fileRes || fileRes.response !== 1) return again();
      const fileName = sanitizeFileName(fileRes.inputText.trim());
      let content: string;
      try {
        content = readFileSync(join(HOUSE_IMPORT_DIR, fileName), "utf8");
      } catch {
        sysMsg(player, "house", `文件 ${fileName} 不存在于 house_import/`, "error");
        return again();
      }
      let entries: { type: string; args: string }[];
      try {
        entries = parseImportContent(content);
      } catch (e) {
        sysMsg(player, "house", `导入解析失败：${(e as Error).message}`, "error");
        return again();
      }
      // 二次确认（整体替换不可逆）
      const confirm = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.MSGBOX,
          caption: "确认导入",
          info: `将用 ${entries.length} 条模型**整体替换**「${house.name}」现有 ${modelCount} 条？\n此操作会清空原模型！`,
          button1: "确认导入",
          button2: "取消",
        }),
      );
      if (!confirm || confirm.response !== 1) return again();
      try {
        // 事务：整体替换（index 按文件行序重排 0..n-1）
        await prisma.$transaction([
          prisma.houseModel.deleteMany({ where: { houseId: house.id } }),
          prisma.houseModel.createMany({
            data: entries.map((e, i) => ({
              houseId: house.id,
              type: e.type,
              args: e.args,
              index: i,
            })),
          }),
        ]);
        await reloadHouseObjects();
        const skipped = entries.filter((e) => TYPE_RULES[e.type]?.skipped).length;
        sysMsg(
          player,
          "house",
          `导入成功：${entries.length} 条${skipped ? `（含 ${skipped} 条动态类型会被加载器跳过）` : ""}`,
          "success",
        );
      } catch (e) {
        logger.error(`[house] OP 导入失败 house=${house.name}`, e);
        sysMsg(player, "house", "导入失败（事务回滚，原模型已保留）", "error");
      }
      return again();
    }
    case 1: {
      // 导出：全量写 house_export/{name}.txt
      try {
        const models = await prisma.houseModel.findMany({
          where: { houseId: house.id },
          orderBy: { index: "asc" },
        });
        if (models.length === 0) {
          sysMsg(player, "house", "该房屋没有模型可导出", "warn");
          return again();
        }
        ensureDirs();
        const safeName = sanitizeFileName(house.name);
        const fileName = `${safeName}.txt`;
        // 临时文件 + rename 原子写（防中断半文件）
        const tmp = join(HOUSE_EXPORT_DIR, `${fileName}.tmp`);
        writeFileSync(tmp, models.map((m) => `${m.type} ${m.args}`).join("\n"));
        const final = join(HOUSE_EXPORT_DIR, fileName);
        rmSync(final, { force: true }); // Windows rename 无法覆盖已存在文件
        renameSync(tmp, final);
        sysMsg(
          player,
          "house",
          `已导出 ${models.length} 条到 scriptfiles/house_export/${fileName}`,
          "success",
        );
      } catch (e) {
        logger.error(`[house] OP 导出失败 house=${house.name}`, e);
        sysMsg(player, "house", "导出失败（写入文件异常）", "error");
      }
      return again();
    }
    case 2: {
      // 添加单个模型：选类型 → 输入 args（带格式提示）
      const typeRes = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.LIST,
          caption: "选择模型类型",
          info: Object.entries(TYPE_RULES)
            .map(([t, r]) => `${t}${r.skipped ? "（加载时跳过）" : ""} — ${r.desc}`)
            .join("\n"),
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!typeRes || typeRes.response !== 1) return again();
      const types = Object.keys(TYPE_RULES);
      const type = types[typeRes.listItem];
      if (!type) return again();
      const rule = TYPE_RULES[type];
      const argsRes = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.INPUT,
          caption: `添加 ${type}`,
          info: `格式：${rule.desc}\n（空格分隔，至少 ${rule.minParts} 个参数）`,
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!argsRes || argsRes.response !== 1) return again();
      const args = argsRes.inputText.trim();
      try {
        validateModel(type, args);
      } catch (e) {
        sysMsg(player, "house", (e as Error).message, "error");
        return again();
      }
      try {
        // index = 当前最大 + 1（保持追加语义，不重排）
        const max = await prisma.houseModel.aggregate({
          where: { houseId: house.id },
          _max: { index: true },
        });
        await prisma.houseModel.create({
          data: { houseId: house.id, type, args, index: (max._max.index ?? -1) + 1 },
        });
        await reloadHouseObjects();
        sysMsg(
          player,
          "house",
          `已添加 ${type}：${args.slice(0, 40)}${args.length > 40 ? "…" : ""}`,
          "success",
        );
      } catch (e) {
        logger.error(`[house] OP 添加模型失败 house=${house.name}`, e);
        sysMsg(player, "house", "添加失败", "error");
      }
      return again();
    }
    case 3: {
      // 删除模型：分页列出 → 选中 → 二次确认删除
      const models = await prisma.houseModel.findMany({
        where: { houseId: house.id },
        orderBy: { index: "asc" },
      });
      if (models.length === 0) {
        sysMsg(player, "house", "该房屋没有模型", "warn");
        return again();
      }
      const r = await showPagedDialog(player, {
        caption: `删除模型（${house.name}）`,
        data: models,
        format: (m) => `${m.index}\t${m.type}\t${m.args}`,
        headers: ["#", "类型", "参数"],
        button1: "删除",
        button2: "取消",
      });
      if (!r) return again();
      const target = r.item;
      const confirm = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.MSGBOX,
          caption: "确认删除",
          info: `删除模型 ${target.type}：${target.args.slice(0, 50)}${target.args.length > 50 ? "…" : ""}？`,
          button1: "删除",
          button2: "取消",
        }),
      );
      if (!confirm || confirm.response !== 1) return again();
      try {
        await prisma.houseModel.delete({ where: { id: target.id } });
        await reloadHouseObjects();
        sysMsg(player, "house", "模型已删除", "success");
      } catch (e) {
        logger.error(`[house] OP 删除模型失败 house=${house.name}`, e);
        sysMsg(player, "house", "删除失败", "error");
      }
      return again();
    }
    case 4: {
      // 启用/停用房屋
      try {
        await prisma.house.update({
          where: { id: house.id },
          data: { isEnabled: !house.isEnabled },
        });
        await reloadHouseObjects();
        sysMsg(
          player,
          "house",
          `房屋「${house.name}」已${house.isEnabled ? "停用" : "启用"}`,
          "success",
        );
      } catch (e) {
        logger.error(`[house] OP 切换房屋启用失败 house=${house.name}`, e);
        sysMsg(player, "house", "操作失败", "error");
      }
      return again();
    }
    case 5: {
      // 关联赛道（手输名称——一个房屋最多关联一个赛道，race.houseId @unique；列表选几百条不现实）
      const raceRes = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.INPUT,
          caption: "关联赛道",
          info: `输入要关联的赛道名称（留空 = 解除当前关联${race ? `「${race.name}」` : ""}）：\n当前关联：${race?.name ?? "无"}`,
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!raceRes || raceRes.response !== 1) return again();
      const raceName = raceRes.inputText.trim();
      try {
        if (raceName) {
          const target = await prisma.race.findFirst({
            where: { name: raceName, isEnabled: true, deletedAt: null },
            select: { id: true },
          });
          if (!target) {
            sysMsg(
              player,
              "house",
              `未找到启用赛道「${raceName}」（确认名称或数据库创建）`,
              "error",
            );
            return again();
          }
          // 换绑事务：先清旧关联（race.house_id @unique，两行指向同屋会冲突）再设新
          await prisma.$transaction([
            prisma.race.updateMany({ where: { houseId: house.id }, data: { houseId: null } }),
            prisma.race.update({ where: { id: target.id }, data: { houseId: house.id } }),
          ]);
          await reloadHouseObjects(); // 关联赛道 → obj 在比赛世界可见，需重载
          sysMsg(player, "house", `已关联赛道「${raceName}」`, "success");
        } else {
          await prisma.race.updateMany({ where: { houseId: house.id }, data: { houseId: null } });
          await reloadHouseObjects();
          sysMsg(player, "house", "已解除赛道关联", "success");
        }
      } catch (e) {
        logger.error(`[house] OP 关联赛道失败 house=${house.name}`, e);
        sysMsg(player, "house", "操作失败", "error");
      }
      return again();
    }
    case 6: {
      // 关联传送点（手输名称；teleport.houseId @unique 一对一）
      const teleRes = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.INPUT,
          caption: "关联传送点",
          info: `输入要关联的传送点名称（留空 = 解除当前关联${tele ? `「${tele.name}」` : ""}）：\n当前关联：${tele?.name ?? "无"}`,
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!teleRes || teleRes.response !== 1) return again();
      const teleName = teleRes.inputText.trim();
      try {
        if (teleName) {
          const target = await prisma.teleport.findFirst({
            where: { name: teleName, isEnabled: true, deletedAt: null },
            select: { id: true },
          });
          if (!target) {
            sysMsg(player, "house", `未找到传送点「${teleName}」`, "error");
            return again();
          }
          // 换绑事务（teleport.house_id @unique）
          await prisma.$transaction([
            prisma.teleport.updateMany({ where: { houseId: house.id }, data: { houseId: null } }),
            prisma.teleport.update({ where: { id: target.id }, data: { houseId: house.id } }),
          ]);
          sysMsg(player, "house", `已关联传送点「${teleName}」`, "success");
        } else {
          await prisma.teleport.updateMany({
            where: { houseId: house.id },
            data: { houseId: null },
          });
          sysMsg(player, "house", "已解除传送点关联", "success");
        }
      } catch (e) {
        logger.error(`[house] OP 关联传送点失败 house=${house.name}`, e);
        sysMsg(player, "house", "操作失败", "error");
      }
      return again();
    }
    default:
      return again();
  }
}

/** OP 房屋管理入口：房屋列表（分页，含启用状态/关联赛道）→ 操作菜单 */
export async function openHouseAdminMenu(player: Player, back?: MenuBack): Promise<void> {
  ensureDirs(); // 惰性建目录（导入/导出可用）
  const again = () => openHouseAdminMenu(player, back);
  const houses = await prisma.house.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (houses.length === 0) {
    sysMsg(player, "house", "暂无房屋（可在数据库创建，然后游戏内填充模型）", "warn");
    return back?.();
  }
  // 关联赛道名（一条查询带出，避免 N+1）
  const races = await prisma.race.findMany({
    where: { houseId: { in: houses.map((h) => h.id) } },
    select: { houseId: true, name: true },
  });
  const raceName = new Map(races.map((r) => [r.houseId, r.name]));
  const r = await showPagedDialog(player, {
    caption: "房屋管理（OP）",
    data: houses,
    format: (h) => [
      h.name,
      h.isEnabled ? "{00FF00}启用" : "{FF0000}停用",
      raceName.get(h.id) ?? "—",
      String(h.userId ? "有主" : "无主"),
    ],
    headers: ["名称", "状态", "关联赛道", "归属"],
    button1: "管理",
    button2: "取消",
  });
  if (!r) return again();
  await houseActions(player, r.item, again);
}
