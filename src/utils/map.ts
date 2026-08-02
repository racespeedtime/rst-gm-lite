/** 圣安地列斯地图边界 */
const MAP_LIMIT = 3000;
export const MIN_Z = -100;
export const MAX_Z = 800;

/** 判断坐标是否在游戏地图范围内（超出则视为非法位置） */
export function isInsideMap(x: number, y: number, z: number): boolean {
  return Math.abs(x) <= MAP_LIMIT && Math.abs(y) <= MAP_LIMIT && z >= MIN_Z && z <= MAX_Z;
}
