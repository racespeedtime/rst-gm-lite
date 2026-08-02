import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { isSuperAdmin, sendNoPermission } from "@/admin/op";
import type { MenuBack } from "@/core/panel";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";

import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";

/** OP 装扮管理：创建/编辑/删除系统装扮目录。子功能取消返回本面板，本面板"关闭"返回上一层 */
export async function openAttireAdmin(player: Player, back?: MenuBack): Promise<void> {
  // 纵深防御：函数内再次校验权限（不依赖面板入口过滤）
  if (!isSuperAdmin(player)) {
    sendNoPermission(player);
    return;
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "装扮管理",
      info: "1. 创建装扮\n2. 编辑装扮\n3. 删除装扮",
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const toThis = () => openAttireAdmin(player, back);
  if (res.listItem === 0) {
    await createAttire(player, toThis);
  } else if (res.listItem === 1) {
    await editAttire(player, toThis);
  } else if (res.listItem === 2) {
    await deleteAttire(player, toThis);
  }
}

async function createAttire(player: Player, back: MenuBack): Promise<void> {
  const nameRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "创建装扮",
      info: "输入装扮名称：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!nameRes) return;
  if (nameRes.response !== 1) return back();
  const name = nameRes.inputText.trim();
  if (!name) {
    player.sendClientMessage(COLOR_ERROR, "名称不能为空");
    return back();
  }
  const typeRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "装扮类型",
      info: "1. 人物装扮（PLAYER）\n2. 车辆装扮（VEHICLE）\n3. 通用（COMMON）",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!typeRes) return;
  if (typeRes.response !== 1) return back();
  const type = typeRes.listItem === 0 ? "PLAYER" : typeRes.listItem === 1 ? "VEHICLE" : "COMMON";

  const modelRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "模型与骨骼",
      info: "输入 模型ID 骨骼ID（空格分隔，车辆装扮骨骼可填0）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!modelRes) return;
  if (modelRes.response !== 1) return back();
  const [modelId, boneId] = modelRes.inputText.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(modelId) || modelId <= 0) {
    player.sendClientMessage(COLOR_ERROR, "模型ID无效");
    return back();
  }
  const offsetRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "装配参数",
      info: "输入 偏移X Y Z 旋转X Y Z 缩放X Y Z（9个数，空格分隔，默认 0 0 0 0 0 0 1 1 1）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!offsetRes) return;
  if (offsetRes.response !== 1) return back();
  const nums = offsetRes.inputText.trim()
    ? offsetRes.inputText.trim().split(/\s+/).map(Number)
    : [0, 0, 0, 0, 0, 0, 1, 1, 1];
  if (nums.length !== 9 || nums.some((n) => !Number.isFinite(n))) {
    player.sendClientMessage(COLOR_ERROR, "需要 9 个数字");
    return back();
  }
  try {
    await prisma.attire.create({
      data: {
        name,
        modelId,
        boneId: Number.isInteger(boneId) && boneId > 0 ? boneId : 0,
        x: nums[0],
        y: nums[1],
        z: nums[2],
        rX: nums[3],
        rY: nums[4],
        rZ: nums[5],
        sX: nums[6],
        sY: nums[7],
        sZ: nums[8],
        type,
      },
    });
    player.sendClientMessage(COLOR_SUCCESS, `装扮「${name}」创建成功`);
  } catch (e) {
    logger.error(`[attire] OP 创建装扮失败`, e);
    player.sendClientMessage(COLOR_ERROR, "创建失败");
  }
  return back();
}

async function editAttire(player: Player, back: MenuBack): Promise<void> {
  const attires = await prisma.attire.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (attires.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "装扮库为空");
    return back();
  }
  const r = await showPagedDialog(player, {
    caption: "选择要编辑的装扮",
    data: attires,
    format: (a) => `${a.name}（${a.type} 模型${a.modelId}）`,
    button1: "确定",
    button2: "取消",
  });
  if (!r) return back();
  const attire = r.item;
  // 修改装配参数
  const offsetRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "编辑装配参数",
      info: `输入 模型ID 骨骼ID 偏移X Y Z 旋转X Y Z 缩放X Y Z（11个数，当前 ${attire.modelId} ${attire.boneId} ${attire.x} ${attire.y} ${attire.z} ${attire.rX} ${attire.rY} ${attire.rZ} ${attire.sX} ${attire.sY} ${attire.sZ}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!offsetRes) return;
  if (offsetRes.response !== 1) return back();
  const nums = offsetRes.inputText.trim().split(/\s+/).map(Number);
  if (nums.length !== 11 || nums.some((n) => !Number.isFinite(n))) {
    player.sendClientMessage(COLOR_ERROR, "需要 11 个数字");
    return back();
  }
  await prisma.attire.update({
    where: { id: attire.id },
    data: {
      modelId: nums[0],
      boneId: nums[1],
      x: nums[2],
      y: nums[3],
      z: nums[4],
      rX: nums[5],
      rY: nums[6],
      rZ: nums[7],
      sX: nums[8],
      sY: nums[9],
      sZ: nums[10],
    },
  });
  player.sendClientMessage(COLOR_SUCCESS, `装扮「${attire.name}」已更新`);
  return back();
}

async function deleteAttire(player: Player, back: MenuBack): Promise<void> {
  const attires = await prisma.attire.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (attires.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "装扮库为空");
    return back();
  }
  const r = await showPagedDialog(player, {
    caption: "选择要删除的装扮",
    data: attires,
    format: (a) => `${a.name}（${a.type}）`,
    button1: "确定",
    button2: "取消",
  });
  if (!r) return back();
  const attire = r.item;
  const confirm = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "删除装扮",
      info: `确定删除装扮「${attire.name}」吗？\n使用该装扮的预设条目将一并删除！`,
      button1: "确认删除",
      button2: "取消",
    }),
  );
  if (!confirm) return;
  if (confirm.response !== 1) return back();
  // 事务：软删装扮 + 级联删除引用它的预设条目（与提示文案一致，防残留条目继续挂载已删装扮）
  await prisma.$transaction(async (tx) => {
    await tx.playerPresetItem.deleteMany({ where: { attireId: attire.id } });
    await tx.vehiclePresetItem.deleteMany({ where: { attireId: attire.id } });
    await tx.attire.update({
      where: { id: attire.id },
      data: { deletedAt: new Date() },
    });
  });
  player.sendClientMessage(COLOR_SUCCESS, `装扮「${attire.name}」已删除`);
  return back();
}
