import { Player } from "@infernus/core";
import { getSafeGroundZ } from "@/core/colandreas";

/** 登录界面随机音效（对齐原版 randSounds[7]） */
const LOGIN_SOUNDS = [1062, 1068, 1076, 1097, 1183, 1185, 1187];
/** 登录成功覆盖/停止音乐音效（原版做法） */
const LOGIN_OK_SOUND = 1186;

/**
 * 随机镜头点（全图范围）：
 * x/y 随机后，用 colandreas 找该点实际地面高度（命中房屋 obj 注册的碰撞），
 * 镜头抬到地面之上 40-80 米——插值路径在地表上空滑动，不会穿过山体/建筑
 * （colandreas 不可用时降级为原随机高度，镜头仍工作但无地形感知）。
 */
function randomCamPoint(): { x: number; y: number; z: number } {
  const x = Math.random() * 6000 - 3000;
  const y = Math.random() * 6000 - 3000;
  // colandreas 找 (x,y) 实际地面（含房屋 obj 碰撞），镜头 = 地面 + 40~80 高空
  const ground = getSafeGroundZ(x, y, 0);
  const z = ground + 40 + Math.random() * 40;
  return { x, y, z };
}

/**
 * 登录界面过场（认证对话框期间调用）：
 * 随机播放 SAMP 音效 + 镜头在随机两点间缓慢插值滑动（60 秒）。
 * 镜头点经 colandreas 地面修正，避免插值路径卡进物体。
 */
export function playLoginCamera(player: Player): void {
  const sound = LOGIN_SOUNDS[Math.floor(Math.random() * LOGIN_SOUNDS.length)];
  const pos = player.getPos();
  player.playSound(sound, pos.x, pos.y, pos.z);
  // 随机起止点（全图范围），60 秒滑动
  const from = randomCamPoint();
  const to = randomCamPoint();
  player.interpolateCameraPos(from.x, from.y, from.z, to.x, to.y, to.z, 60_000, 1); // CAMERA_MOVE
}

/** 登录成功：停止登录音乐 + 回到第三人称视角 */
export function stopLoginCamera(player: Player): void {
  const pos = player.getPos();
  player.playSound(LOGIN_OK_SOUND, pos.x, pos.y, pos.z);
  player.setCameraBehind();
}
