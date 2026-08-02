import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { isSuperAdmin, sendNoPermission } from "@/admin/op";
import { showDialog } from "@/utils/dialog";

import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";

/** OP 装扮管理：创建/编辑/删除系统装扮目录 */
export async function openAttireAdmin(player: Player): Promise<void> {
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
  if (!res || res.response !== 1) return;
  if (res.listItem === 0) {
    await createAttire(player);
  } else if (res.listItem === 1) {
    await editAttire(player);
  } else if (res.listItem === 2) {
    await deleteAttire(player);
  }
}

async function createAttire(player: Player): Promise<void> {
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
  if (!nameRes || nameRes.response !== 1) return;
  const name = nameRes.inputText.trim();
  if (!name) {
    player.sendClientMessage(COLOR_ERROR, "名称不能为空");
    return;
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
  if (!typeRes || typeRes.response !== 1) return;
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
  if (!modelRes || modelRes.response !== 1) return;
  const [modelId, boneId] = modelRes.inputText.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(modelId) || modelId <= 0) {
    player.sendClientMessage(COLOR_ERROR, "模型ID无效");
    return;
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
  if (!offsetRes || offsetRes.response !== 1) return;
  const nums = offsetRes.inputText.trim()
    ? offsetRes.inputText.trim().split(/\s+/).map(Number)
    : [0, 0, 0, 0, 0, 0, 1, 1, 1];
  if (nums.length !== 9 || nums.some((n) => !Number.isFinite(n))) {
    player.sendClientMessage(COLOR_ERROR, "需要 9 个数字");
    return;
  }
  try {
    await prisma.attire.create({
      data: {
        name,
        modelId,
        boneId: Number.isInteger(boneId) && boneId > 0 ? boneId : 0,
        x: nums[0], y: nums[1], z: nums[2],
        rX: nums[3], rY: nums[4], rZ: nums[5],
        sX: nums[6], sY: nums[7], sZ: nums[8],
        type,
      },
    });
    player.sendClientMessage(COLOR_SUCCESS, `装扮「${name}」创建成功`);
  } catch (e) {
    logger.error(`[attire] OP 创建装扮失败`, e);
    player.sendClientMessage(COLOR_ERROR, "创建失败");
  }
}

async function editAttire(player: Player): Promise<void> {
  const attires = await prisma.attire.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (attires.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "装扮库为空");
    return;
  }
  const options = attires.map((a) => `${a.name}（${a.type} 模型${a.modelId}）`);
  const r = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "选择要编辑的装扮",
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!r || r.response !== 1) return;
  const attire = attires[r.listItem];
  if (!attire) return;
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
  if (!offsetRes || offsetRes.response !== 1) return;
  const nums = offsetRes.inputText.trim().split(/\s+/).map(Number);
  if (nums.length !== 11 || nums.some((n) => !Number.isFinite(n))) {
    player.sendClientMessage(COLOR_ERROR, "需要 11 个数字");
    return;
  }
  await prisma.attire.update({
    where: { id: attire.id },
    data: {
      modelId: nums[0],
      boneId: nums[1],
      x: nums[2], y: nums[3], z: nums[4],
      rX: nums[5], rY: nums[6], rZ: nums[7],
      sX: nums[8], sY: nums[9], sZ: nums[10],
    },
  });
  player.sendClientMessage(COLOR_SUCCESS, `装扮「${attire.name}」已更新`);
}

async function deleteAttire(player: Player): Promise<void> {
  const attires = await prisma.attire.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });
  if (attires.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "装扮库为空");
    return;
  }
  const options = attires.map((a) => `${a.name}（${a.type}）`);
  const r = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "选择要删除的装扮",
      info: options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!r || r.response !== 1) return;
  const attire = attires[r.listItem];
  if (!attire) return;
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
  if (!confirm || confirm.response !== 1) return;
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
}
