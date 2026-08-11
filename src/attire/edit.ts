import { EditResponseTypesEnum, ObjectMpEvent, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { sysMsg } from "@/utils/msg";
import { playerEditing, vehicleEditing, cleanupAttireEditing } from "./state";
import { applyPlayerPreset } from "./player";

/**
 * 初始化装扮实时编辑器（对齐原版 Attire_EditAttachedObject / 物件编辑）：
 * - 人物挂件：EditAttachedObject 拖拽编辑，OnPlayerEditAttachedObject 回调保存
 *   （response=1 保存新参数并落库；response=0 取消，保持原参数）
 * - 车辆挂件：按键微调（方向键/小键盘 4/6）+ destroy/recreate/attachToVehicle，
 *   由 vehicle.ts 的 startEditVehicleAttire 会话驱动，无独立回调注册（纯 API）
 * 人物编辑保存后重新应用预设（updateAttachedObject）并提示。
 */
export function initAttireEditor(): void {
  // 人物挂件编辑回调
  ObjectMpEvent.onPlayerEditAttached(
    ({
      player,
      response,
      fOffsetX,
      fOffsetY,
      fOffsetZ,
      fRotX,
      fRotY,
      fRotZ,
      fScaleX,
      fScaleY,
      fScaleZ,
      next,
    }) => {
      const st = playerEditing.get(player.id);
      if (!st) return next();
      // 拖拽期间会持续发 UPDATE 预览（不断改位置）；只有保存(FINAL)/取消(CANCEL)
      // 才结束编辑并清状态，否则下一次 UPDATE 就丢了 st，保存/取消失效
      if (response === EditResponseTypesEnum.CANCEL) {
        playerEditing.delete(player.id);
        // 取消：重新应用当前预设，恢复原位
        void applyPlayerPreset(player, st.presetId);
        sysMsg(player, "attire", "已取消编辑，恢复原位置", "info");
        return next();
      }
      if (response === EditResponseTypesEnum.FINAL) {
        playerEditing.delete(player.id);
      } else {
        // UPDATE 预览帧：客户端本地编辑态已实时显示效果，不落库（防拖拽
        // 每帧写 DB 造成几十上百次写）；仅 FINAL 保存时写一次
        return next();
      }
      // 保存（FINAL）：落库最终参数
      void (async () => {
        try {
          await prisma.playerPresetItem.update({
            where: { id: st.itemId },
            data: {
              x: fOffsetX,
              y: fOffsetY,
              z: fOffsetZ,
              rX: fRotX,
              rY: fRotY,
              rZ: fRotZ,
              sX: fScaleX,
              sY: fScaleY,
              sZ: fScaleZ,
            },
          });
          sysMsg(player, "attire", "已保存编辑", "success");
        } catch (e) {
          logger.error(`[attire] 保存挂件编辑失败 ${player.getName().name}`, e);
          sysMsg(player, "attire", "保存失败", "error");
        }
      })();
      return next();
    },
  );

  // 断线清理编辑态
  PlayerEvent.onDisconnect(({ player, next }) => {
    playerEditing.delete(player.id);
    vehicleEditing.delete(player.id);
    return next();
  });
  // 死亡/重生兜底清编辑态（编辑中死亡回调不来 → 防编辑态残留）
  PlayerEvent.onSpawn(({ player, next }) => {
    if (playerEditing.has(player.id) || vehicleEditing.has(player.id)) {
      cleanupAttireEditing(player.id);
    }
    return next();
  });
}
