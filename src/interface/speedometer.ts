import {
  DynamicObject,
  ObjectMaterialAlignmentEnum,
  ObjectMaterialTextSizeEnum,
  Player,
  TextDraw,
  Vehicle,
  VehicleModelInfoEnum,
} from "@infernus/core";

/** 速度表刻度颜色（移植自原 RST 项目） */
const REACHED_FAST = 0xffcc00c8; // 已到达（黄）
const REACHED_HIGH = 0xf20d0dc8; // 已到达红区（红）
const UNREACHED = 0xc0c0c0c8; // 未到达（灰）
const UNREACHED_HIGH = 0x9d4d4dff; // 未到达红区（半透明红）

/**
 * 创建 2d 速度表：22 个 TextDraw 仪表盘
 * td[0] = "KM/H" 标签, td[1] = 速度数字, td[2..21] = 20 格刻度
 * 整体 y 比原版上移 40px：避免底部调试信息栏（y=440 起，向上延伸约 3-5 行）
 * 叠在刻度（原 y≈430）上方
 */
export function createSpeed2d(player: Player): TextDraw[] {
  const tds: TextDraw[] = [];

  tds.push(
    new TextDraw({ player, x: 517.0, y: 382.5, text: "KM/H" })
      .create()
      .setBackgroundColors(255)
      .setFont(1)
      .setLetterSize(0.2, 0.8)
      .setColor(0xfefbacff)
      .setOutline(1)
      .setProportional(true)
      .setShadow(1)
      .setSelectable(false),
  );

  tds.push(
    new TextDraw({ player, x: 516.0, y: 371.5, text: "-1" })
      .create()
      .setAlignment(3)
      .setBackgroundColors(255)
      .setFont(2)
      .setLetterSize(0.6, 2.4)
      .setColor(0xfffee6ff)
      .setOutline(1)
      .setProportional(true)
      .setShadow(1)
      .setSelectable(false),
  );

  // 20 格刻度（index 2..21）
  for (let i = 0; i < 20; i++) {
    tds.push(
      new TextDraw({ player, x: i * 4 + 455.0, y: 390.5, text: "/" })
        .create()
        .setBackgroundColors(255)
        .setFont(1)
        .setLetterSize(0.41, 1.3)
        .setColor(UNREACHED)
        .setOutline(0)
        .setProportional(true)
        .setShadow(1)
        .setSelectable(false),
    );
  }

  tds.forEach((t) => t.show(player));
  return tds;
}

/**
 * 刷新 2d 速度表文本与刻度颜色。
 * 刻度逻辑（每格 = 10km/h）：
 * - 前 17 格（0-170）：越过变黄 REACHED_FAST，未达灰色
 * - 后 3 格（170/180/190 红区）：越过变红 REACHED_HIGH，未达半透明
 */
export function updateSpeed2d(tds: TextDraw[], speed: number): void {
  const kmh = Math.floor(speed);
  tds[1].setString(String(kmh).padStart(3, "0"));
  for (let j = 0; j < 20; j++) {
    const passed = kmh >= (j + 1) * 10;
    tds[j + 2].setColor(
      j <= 16 ? (passed ? REACHED_FAST : UNREACHED) : passed ? REACHED_HIGH : UNREACHED_HIGH,
    );
  }
}

export function destroySpeed2d(tds: TextDraw[]): void {
  tds.forEach((t) => {
    if (t.isValid()) t.destroy();
  });
}

/**
 * 创建 3d 速度表：DynamicObject 贴图板，attach 到玩家所在车辆。
 * 仅在玩家处于车内时创建（参考原 RST 项目 modelId 19482 + setMaterialText）。
 */
export function createSpeed3d(player: Player, vehicle: Vehicle): DynamicObject | null {
  const obj = new DynamicObject({
    modelId: 19482,
    x: 0,
    y: 0,
    z: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    playerId: player.id,
    drawDistance: 200,
  }).create();

  let { x: vmSizeX } = Vehicle.getModelInfo(vehicle.getModel(), VehicleModelInfoEnum.SIZE);
  if (vmSizeX < 1.5) vmSizeX = 1.5;
  obj.attachToVehicle(vehicle, vmSizeX - 1.75, -1.0, -0.6, 0.0, 0.0, -110.0);
  return obj;
}

/** 刷新 3d 速度表贴图文字（原版格式：三位补零 + KMH） */
export function updateSpeed3d(player: Player, obj: DynamicObject, speed: number): void {
  obj.setMaterialText(
    player.charset,
    0,
    `${String(Math.floor(speed)).padStart(3, "0")} KMH`,
    ObjectMaterialTextSizeEnum._512x256,
    "Arial",
    52,
    0,
    0xffffffff,
    0,
    ObjectMaterialAlignmentEnum.RIGHT,
  );
}

export function destroySpeed3d(obj: DynamicObject | null): void {
  if (obj && obj.isValid()) {
    obj.destroy();
  }
}
