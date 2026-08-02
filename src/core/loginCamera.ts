import { Player } from "@infernus/core";

/** 登录界面随机音效（对齐原版 randSounds[7]） */
const LOGIN_SOUNDS = [1062, 1068, 1076, 1097, 1183, 1185, 1187];
/** 登录成功覆盖/停止音乐音效（原版做法） */
const LOGIN_OK_SOUND = 1186;

/**
 * 登录界面过场（认证对话框期间调用）：
 * 随机播放 SAMP 音效 + 镜头在随机两点间缓慢插值滑动（60 秒）。
 */
export function playLoginCamera(player: Player): void {
  const sound = LOGIN_SOUNDS[Math.floor(Math.random() * LOGIN_SOUNDS.length)];
  const pos = player.getPos();
  player.playSound(sound, pos.x, pos.y, pos.z);
  // 随机起止点（全图范围），60 秒滑动
  const from = { x: Math.random() * 6000 - 3000, y: Math.random() * 6000 - 3000, z: Math.random() * 120 + 50 };
  const to = { x: Math.random() * 6000 - 3000, y: Math.random() * 6000 - 3000, z: Math.random() * 120 + 50 };
  player.interpolateCameraPos(from.x, from.y, from.z, to.x, to.y, to.z, 60_000, 1); // CAMERA_MOVE
}

/** 登录成功：停止登录音乐 + 回到第三人称视角 */
export function stopLoginCamera(player: Player): void {
  const pos = player.getPos();
  player.playSound(LOGIN_OK_SOUND, pos.x, pos.y, pos.z);
  player.setCameraBehind();
}
