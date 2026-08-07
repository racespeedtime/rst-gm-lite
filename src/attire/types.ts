/** 实时编辑中的状态（open.mp 一次只编辑一个对象，per-player 串行） */
export interface AttireEditState {
  presetId: string;
  itemId: string;
}

/** 车辆挂件按键微调会话（对齐原版 CDIALOG_CarZB：选轴 → 小键盘 4/6 连续微调，
 *  numpad 2 重开操作框；全程 destroy+recreate+attachToVehicle，纯 API 无拖拽） */
export interface VehEditState extends AttireEditState {
  /** 当前微调轴（1=X 左右 2=Y 前后 3=Z 上下 4=RX 前翻 5=RY 侧翻 6=RZ 旋转，对齐原版） */
  axis: number;
  /** 微调步长（默认 0.1，操作框可调速） */
  step: number;
  /** 操作框打开中（打开时轮询不响应微调键，防误触） */
  dialogOpen: boolean;
  /** 上次轮询的按键位（numpad 2 重开操作框的边沿检测） */
  prevKeys: number;
  /** 本次会话的偏移工作副本：微调改这里，保存时才写 DB（对齐原版：DB 仅在保存时落） */
  work: { x: number; y: number; z: number; rX: number; rY: number; rZ: number };
  /** 开始编辑时的虚拟世界：传送/换世界会退出编辑（还原），防轮询/dialog 残留 */
  worldId: number;
}
