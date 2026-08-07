import { PUBLIC_WORLD_ID } from "@/sessions/session";

/**
 * 电梯系统配置（移植自 infernus filterscript 的 4 个电梯脚本：
 * ls_elevator / ls_apartments1 / ls_beach_side / sf_zombo_tech）。
 * 原版是 4 份几乎重复的 IFilterScript，这里收敛为 1 个通用引擎 + 4 份纯数据配置，
 * 引擎只依赖本文件定义的结构，不感知具体建筑。
 */

/** 相对电梯中心的矩形检测区（x/y 偏移范围） */
export interface RangeBox {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

/** 门的开/关目标位置（仅 x/y，z 由楼层高度推导） */
export interface DoorTargets {
  readonly closed: { readonly x: number; readonly y: number };
  readonly leftOpen: { readonly x: number; readonly y: number };
  readonly rightOpen: { readonly x: number; readonly y: number };
}

/** 门是否关到位（onMoved 判定）：沿该轴的坐标 <= closedPos + margin */
export interface DoorClosedCheck {
  readonly axis: "x" | "y";
  readonly closedPos: number;
  readonly margin: number;
}

/** 需要为玩家移除的原版地图建筑（removeBuilding 是 per-player） */
export interface RemoveBuilding {
  readonly modelId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

export interface ElevatorConfig {
  /** 唯一标识（同时用于实例管理） */
  readonly id: string;
  /** 建筑名（对话框标题等中文展示） */
  readonly buildingName: string;
  /** 电梯轿厢中心坐标 */
  readonly x: number;
  readonly y: number;
  /** 底层地面高度 */
  readonly groundZ: number;
  /** 轿厢相对楼层地面的额外抬升（模型原因） */
  readonly elevatorZOffset: number;
  /** 楼层门 z 的基础偏移（轿厢门也用它：门随轿厢升降） */
  readonly doorZBaseOffset: number;
  /** 楼层门创建时的额外 z 偏移 */
  readonly floorDoorCreateZOffset: number;
  /** 楼层门开/关移动时的额外 z 偏移 */
  readonly floorDoorMoveZOffset: number;
  /** 轿厢门与楼层门的开/关目标（沿对应轴平移） */
  readonly carDoors: DoorTargets;
  readonly floorDoors: DoorTargets;
  /** 楼层门关到位判定 */
  readonly doorClosedCheck: DoorClosedCheck;
  readonly elevatorRotation: number;
  /** 楼层名（中文，按楼层索引顺序） */
  readonly floors: readonly string[];
  /** 各楼层相对 groundZ 的高度 */
  readonly floorZOffsets: readonly number[];
  /** 各楼层 3D 标签的 z（各建筑标签算法不同，显式给出） */
  readonly floorLabelZ: readonly number[];
  /** 楼层 3D 标签相对中心的 x/y 偏移 */
  readonly floorLabelOffset: { readonly x: number; readonly y: number };
  /** 轿厢内按钮 3D 标签相对中心的偏移（z 为相对轿厢到达层地面） */
  readonly elevatorLabelOffset: { readonly x: number; readonly y: number; readonly z: number };
  /** 轿厢内按钮检测区（相对中心） */
  readonly insideRange: RangeBox;
  /** 楼层按钮检测区（相对中心） */
  readonly floorButtonRange: RangeBox;
  /** 楼层判定方式：z-scan 逐层扫 / zombo 按高度二选一 */
  readonly floorMode: "z-scan" | "zombo";
  /** z-scan 起始索引（最高层，向下扫描；= floors.length - 1） */
  readonly floorCheckStart: number;
  /** 按楼层按钮时若电梯已在此层是否提示（而非重复呼叫） */
  readonly alreadyOnFloorNotify: boolean;
  /** 呼叫后是否发聊天消息（含电梯当前所在/前往楼层） */
  readonly callChatMessage: boolean;
  /** 额外创建的建筑物件（公寓楼/科技楼的替换模型） */
  readonly extraObjects: readonly {
    readonly modelId: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly rx: number;
    readonly ry: number;
    readonly rz: number;
  }[];
  /** per-player 移除的原版建筑 */
  readonly removeBuildings: readonly RemoveBuilding[];
}

export const ELEVATOR_SPEED = 5.0; // 电梯移动速度
export const DOORS_SPEED = 5.0; // 门移动速度
export const ELEVATOR_WAIT_TIME = 5000; // 到层后停留时间（随后继续队列）
export const ELEVATOR_BOOST_DELAY = 2000; // 起步后提速延迟（给客户端同步踩轿厢的时间）

export const ELEVATOR_STATE_IDLE = 0;
export const ELEVATOR_STATE_WAITING = 1;
export const ELEVATOR_STATE_MOVING = 2;

export const INVALID_FLOOR = -1;

/** 楼层门/电梯门开关音效（原版 fs 使用 6401） */
export const DOOR_SOUND_ID = 6401;

// ---------------------------------------------------------------------------
// 1. LS 大楼电梯（原 ls_elevator，21 层）
// ---------------------------------------------------------------------------
const lsElevatorFloorZ = [
  0.0, 8.5479, 13.99945, 19.451, 24.90255, 30.3541, 35.80565, 41.2572, 46.70875, 52.1603, 57.61185,
  63.0634, 68.51495, 73.9665, 79.41805, 84.8696, 90.32115, 95.7727, 101.22425, 106.6758, 112.12735,
];
const lsElevatorLabelZ = Array.from({ length: 21 }, (_, i) =>
  i === 0 ? 13.4713 : 13.4713 + 8.7396 + (i - 1) * 5.45155,
);

const LS_ELEVATOR: ElevatorConfig = {
  id: "ls_elevator",
  buildingName: "LS 大楼",
  x: 1786.6781,
  y: -1303.459472,
  groundZ: 14.511476,
  elevatorZOffset: 0.059523,
  doorZBaseOffset: 0,
  floorDoorCreateZOffset: 0,
  floorDoorMoveZOffset: 0,
  carDoors: {
    closed: { x: 1786.627685, y: -1303.459472 },
    leftOpen: { x: 1788.227685, y: -1303.459472 },
    rightOpen: { x: 1785.027685, y: -1303.459472 },
  },
  floorDoors: {
    closed: { x: 1786.627685, y: -1303.171142 },
    leftOpen: { x: 1788.227685, y: -1303.171142 },
    rightOpen: { x: 1785.027685, y: -1303.171142 },
  },
  doorClosedCheck: { axis: "x", closedPos: 1786.627685, margin: 1.1 },
  elevatorRotation: 270,
  floors: [
    "地面层",
    "2层",
    "3层",
    "4层",
    "5层",
    "6层",
    "7层",
    "8层",
    "9层",
    "10层",
    "11层",
    "12层",
    "13层",
    "14层",
    "15层",
    "16层",
    "17层",
    "18层",
    "19层",
    "20层",
    "顶层",
  ],
  floorZOffsets: lsElevatorFloorZ,
  floorLabelZ: lsElevatorLabelZ,
  floorLabelOffset: { x: -2.6982, y: 2.6935 },
  elevatorLabelOffset: { x: -1.6959, y: 1.4168, z: -0.9 },
  // 原版按钮区为绝对坐标：轿厢内 (1784.1555~1786.2131, -1303.2417~-1301.4)，
  // 楼层按钮 (1781.9902~1785.6147, -1301.4~-1299.1447)，换算为相对中心 (1786.6781, -1303.459472)
  insideRange: { xMin: -2.5226, xMax: -0.465, yMin: 0.2178, yMax: 2.059 },
  floorButtonRange: { xMin: -4.6879, xMax: -1.0634, yMin: 2.059, yMax: 4.3148 },
  floorMode: "z-scan",
  floorCheckStart: 20,
  alreadyOnFloorNotify: false,
  callChatMessage: false,
  extraObjects: [],
  removeBuildings: [],
};

// ---------------------------------------------------------------------------
// 2. LS 公寓楼 1 电梯（原 ls_apartments1，地下停车场 + 10 层）
// ---------------------------------------------------------------------------
const lsApartmentsFloorZ = [
  0.0, 13.604544, 18.808519, 24.012494, 29.216469, 34.420444, 39.624419, 44.828394, 50.032369,
  55.236344, 60.440319,
];
const lsApartmentsLabelZ = lsApartmentsFloorZ.map((off) => 20.879316 + off + 0.059523 - 0.2);

const LS_APARTMENTS_1: ElevatorConfig = {
  id: "ls_apartments_1",
  buildingName: "LS 公寓楼 1",
  x: 1181.622924,
  y: -1180.554687,
  groundZ: 20.879316,
  elevatorZOffset: 0.059523,
  doorZBaseOffset: 0.059523,
  floorDoorCreateZOffset: 0,
  floorDoorMoveZOffset: 0.05,
  carDoors: {
    closed: { x: 1181.622924, y: -1180.535917 },
    leftOpen: { x: 1181.622924, y: -1178.935917 },
    rightOpen: { x: 1181.622924, y: -1182.135917 },
  },
  floorDoors: {
    // 原版 floor_CloseDoors 关闭目标为 (X, Y-0.245)，创建位是 (X-0.245, Y)——保持原样
    closed: { x: 1181.622924, y: -1180.799687 },
    leftOpen: { x: 1181.377924, y: -1178.935917 },
    rightOpen: { x: 1181.377924, y: -1182.135917 },
  },
  doorClosedCheck: { axis: "y", closedPos: -1180.535917, margin: 1.1 },
  elevatorRotation: 0,
  floors: ["地下停车场", "地面层", "2层", "3层", "4层", "5层", "6层", "7层", "8层", "9层", "10层"],
  floorZOffsets: lsApartmentsFloorZ,
  floorLabelZ: lsApartmentsLabelZ,
  floorLabelOffset: { x: -2.5, y: -2.5 },
  elevatorLabelOffset: { x: -1.7, y: -1.75, z: -0.4 },
  insideRange: { xMin: -1.8, xMax: 1.8, yMin: -1.8, yMax: 1.8 },
  floorButtonRange: { xMin: -3.8, xMax: -1.81, yMin: -3.8, yMax: -1.81 },
  floorMode: "z-scan",
  floorCheckStart: 10,
  alreadyOnFloorNotify: true,
  callChatMessage: true,
  extraObjects: [
    { modelId: 19595, x: 1160.96, y: -1180.58, z: 70.4141, rx: 0, ry: 0, rz: 0 }, // 公寓楼
    { modelId: 19798, x: 1160.96, y: -1180.58, z: 20.4141, rx: 0, ry: 0, rz: 0 }, // 地下停车场
  ],
  removeBuildings: [
    { modelId: 5766, x: 1160.96, y: -1180.58, z: 70.4141, radius: 250 }, // 遮阳阴影
    { modelId: 5767, x: 1160.96, y: -1180.58, z: 70.4141, radius: 250 }, // 原版建筑
    { modelId: 5964, x: 1160.96, y: -1180.58, z: 70.4141, radius: 250 }, // LOD
  ],
};

// ---------------------------------------------------------------------------
// 3. LS 海滨公寓电梯（原 ls_beach_side，地下停车场 + 13 层）
// ---------------------------------------------------------------------------
const lsBeachFloorZ = [
  0.0, 15.069729, 29.130733, 33.630733, 38.130733, 42.630733, 47.130733, 51.630733, 56.130733,
  60.630733, 65.130733, 69.630733, 74.130733, 78.630733,
];
const lsBeachLabelZ = lsBeachFloorZ.map((off) => 18.755348 + off - 0.2);
const BEACH_Y_CLOSED = -1609.341064 - 0.245; // 楼层门关闭位 = 中心 y - 0.245

const LS_BEACH_SIDE: ElevatorConfig = {
  id: "ls_beach_side",
  buildingName: "LS 海滨公寓",
  x: 287.942413,
  y: -1609.341064,
  groundZ: 18.755348,
  elevatorZOffset: 0,
  doorZBaseOffset: 0,
  floorDoorCreateZOffset: 0.05,
  floorDoorMoveZOffset: 0.05,
  carDoors: {
    closed: { x: 287.942413, y: -1609.341064 },
    leftOpen: { x: 286.342407, y: -1609.076049 },
    rightOpen: { x: 289.542419, y: -1609.640991 },
  },
  floorDoors: {
    closed: { x: 287.942413, y: BEACH_Y_CLOSED },
    leftOpen: { x: 286.292419, y: -1609.30603 },
    rightOpen: { x: 289.492431, y: -1609.870971 },
  },
  doorClosedCheck: { axis: "y", closedPos: BEACH_Y_CLOSED, margin: 0.01 },
  elevatorRotation: 80,
  floors: [
    "地下停车场",
    "地面层",
    "2层",
    "3层",
    "4层",
    "5层",
    "6层",
    "7层",
    "8层",
    "9层",
    "10层",
    "11层",
    "12层",
    "13层",
  ],
  floorZOffsets: lsBeachFloorZ,
  floorLabelZ: lsBeachLabelZ,
  floorLabelOffset: { x: 2, y: -3 },
  elevatorLabelOffset: { x: 1.6, y: -1.85, z: -0.4 },
  insideRange: { xMin: -1.8, xMax: 1.8, yMin: -1.8, yMax: 1.8 },
  floorButtonRange: { xMin: 1.21, xMax: 3.8, yMin: -3.8, yMax: -1.81 },
  floorMode: "z-scan",
  floorCheckStart: 13,
  alreadyOnFloorNotify: true,
  callChatMessage: true,
  extraObjects: [],
  removeBuildings: [
    { modelId: 1226, x: 265.481, y: -1581.1, z: 32.9311, radius: 5 }, // 地下停车场入口灯柱
    { modelId: 6518, x: 280.297, y: -1606.2, z: 72.3984, radius: 250 }, // 夜间灯光（含遮挡区）
  ],
};

// ---------------------------------------------------------------------------
// 4. SF ZomboTech 大楼电梯（原 sf_zombo_tech，地面层 + 实验层）
// ---------------------------------------------------------------------------
const SF_ZOMBO_TECH: ElevatorConfig = {
  id: "sf_zombo_tech",
  buildingName: "SF ZomboTech",
  x: -1951.603027,
  y: 636.418334,
  groundZ: 47.451492,
  elevatorZOffset: 0,
  doorZBaseOffset: 0,
  floorDoorCreateZOffset: 0,
  floorDoorMoveZOffset: 0,
  carDoors: {
    closed: { x: -1951.603027, y: 636.418334 },
    leftOpen: { x: -1950.003027, y: 636.418334 },
    rightOpen: { x: -1953.203027, y: 636.418334 },
  },
  floorDoors: {
    closed: { x: -1951.603027, y: 636.663334 },
    leftOpen: { x: -1950.003027, y: 636.663334 },
    rightOpen: { x: -1953.203027, y: 636.663334 },
  },
  doorClosedCheck: { axis: "x", closedPos: -1951.603027, margin: 0.05 },
  elevatorRotation: 270,
  floors: ["地面层", "实验层"],
  floorZOffsets: [0.0, -21.628007],
  floorLabelZ: [47.460277, 25.820274],
  floorLabelOffset: { x: -2.5, y: 2.5 },
  elevatorLabelOffset: { x: -1.8, y: 1.6, z: -0.6 },
  insideRange: { xMin: -1.8, xMax: 1.8, yMin: -1.8, yMax: 1.8 },
  floorButtonRange: { xMin: -3.8, xMax: -1.81, yMin: 1.81, yMax: 3.8 },
  floorMode: "zombo",
  floorCheckStart: 1,
  alreadyOnFloorNotify: true,
  callChatMessage: false,
  extraObjects: [
    { modelId: 19593, x: -1951.6875, y: 660.023986, z: 89.507797, rx: 0, ry: 0, rz: 0 }, // 大楼
    { modelId: 19594, x: -1951.6875, y: 660.023986, z: 29.507797, rx: 0, ry: 0, rz: 0 }, // 实验室
  ],
  removeBuildings: [
    { modelId: 10027, x: -1951.6875, y: 660.023986, z: 89.507797, radius: 250 }, // 原版大楼
    { modelId: 9939, x: -1951.6875, y: 660.023986, z: 89.507797, radius: 250 }, // LOD
  ],
};

/** 全部电梯配置（按此顺序初始化/遍历） */
export const ELEVATOR_CONFIGS: readonly ElevatorConfig[] = [
  LS_ELEVATOR,
  LS_APARTMENTS_1,
  LS_BEACH_SIDE,
  SF_ZOMBO_TECH,
];

/** 电梯实体所在世界（公共大世界，与玩家战局隔离无关：建筑在 world 0） */
export const ELEVATOR_WORLD_ID = PUBLIC_WORLD_ID;
