// apps/web/src/scene3d/cameraMath.ts —— 摄像机机位的数学（纯函数，可单测）
//
// 三档机位（见 BattleScene3D）：
//   orbit  自由视角：绕棋盘中心转，可平移、缩放；
//   follow 跟随视角：站在某辆坦克后上方，随它一起转向；
//   gunner 炮手视角：贴在炮塔高度、沿炮口方向看向战场。
// 全部用球坐标表达，好处是"角度"始终是用户能理解的量（拖拽即改 yaw/pitch），
// 且不依赖 three 的相机对象，方便在这里把边界条件（俯仰钳制、距离拟合、角度回绕）钉死。
import type { Dir } from "@ai-game/protocol";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 世界坐标：格子中心 → 以棋盘中心为原点的坐标（格子边长 = 1 世界单位） */
export function tileToWorld(x: number, y: number, w: number, h: number): { x: number; z: number } {
  return { x: x - (w - 1) / 2, z: y - (h - 1) / 2 };
}

/** 四方向 → 世界朝向角（three 里物体默认朝 +Z，绕 Y 旋转 yaw 后指向 (sin yaw, cos yaw)） */
export function yawOfDir(dir: Dir): number {
  switch (dir) {
    case "N":
      return Math.PI;
    case "S":
      return 0;
    case "E":
      return Math.PI / 2;
    case "W":
      return -Math.PI / 2;
  }
}

/** 从"位移向量"推朝向角；零位移时返回 null（保持上一次朝向） */
export function yawOfStep(dx: number, dz: number): number | null {
  if (dx === 0 && dz === 0) return null;
  return Math.atan2(dx, dz);
}

export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r < -Math.PI) r += twoPi;
  return r;
}

/** 角度插值：走最短弧，避免"从 179° 到 -179° 转一大圈" */
export function lerpAngle(from: number, to: number, t: number): number {
  const d = wrapAngle(to - from);
  return from + d * Math.max(0, Math.min(1, t));
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.max(0, Math.min(1, t));
}

/**
 * 帧率无关的指数逼近系数：t = 1 - e^(-k·dt)。
 * 直接用固定 t 会在 30fps / 144fps 上得到不同的手感，这里按 dt 归一到"每秒 k 倍的收敛速度"。
 */
export function damp(k: number, dt: number): number {
  return 1 - Math.exp(-k * Math.max(0, Math.min(dt, 0.25)));
}

/** 俯仰角钳制：不让相机钻到地平面以下（-0.05π 之下会看到穿帮的内壁） */
export const PITCH_MIN = -0.04;
export const PITCH_MAX = 1.45;
export function clampPitch(pitch: number): number {
  return Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
}

/** 球坐标 → 相机位置（相对目标点；pitch = 抬升角，dist = 距离） */
export function orbitPosition(target: Vec3, yaw: number, pitch: number, dist: number): Vec3 {
  const p = clampPitch(pitch);
  const horiz = Math.cos(p) * dist;
  return {
    x: target.x + Math.sin(yaw) * horiz,
    y: target.y + Math.sin(p) * dist,
    z: target.z + Math.cos(yaw) * horiz,
  };
}

/**
 * 让整张地图恰好入镜的距离：取水平与垂直两个方向所需距离的较大者。
 * 宽高比越小（竖屏）越需要往后退，所以这里必须同时看 fov（垂直）与 aspect。
 */
export function fitDistance(spanX: number, spanZ: number, fovDeg: number, aspect: number, padding = 1.08): number {
  const fov = (fovDeg * Math.PI) / 180;
  const halfV = Math.tan(fov / 2);
  const halfH = halfV * Math.max(0.2, aspect);
  const halfX = (spanX * padding) / 2;
  const halfZ = (spanZ * padding) / 2;
  // 按外接圆算：用户可以把相机转到任意角度，斜着看时棋盘的对角线才是真正要装下的跨距。
  // （早期版本只按"正对"估算，24×24 的图转到 45° 就会切角。）
  const radius = Math.hypot(halfX, halfZ);
  const need = Math.max(radius / halfV, radius / halfH);
  return Math.max(4, need * 0.92);
}

/**
 * 跟随视角：相机挂在坦克（yaw 朝向）后方，yawOffset 让玩家自己再绕它转一点。
 * 返回位置与注视点 —— 两者一起给，避免"位置很顺但视线在抖"。
 */
export function followCamera(
  tank: Vec3,
  tankYaw: number,
  yawOffset: number,
  pitch: number,
  dist: number,
  lookAhead = 1.6,
): { pos: Vec3; look: Vec3 } {
  const p = clampPitch(pitch);
  const yaw = tankYaw + yawOffset;
  const back = Math.cos(p) * dist;
  return {
    pos: { x: tank.x - Math.sin(yaw) * back, y: tank.y + 0.6 + Math.sin(p) * dist, z: tank.z - Math.cos(yaw) * back },
    look: { x: tank.x + Math.sin(tankYaw) * lookAhead, y: tank.y + 0.5, z: tank.z + Math.cos(tankYaw) * lookAhead },
  };
}

/** 炮手视角：眼睛在炮塔上，朝炮口方向看（yawOffset / pitchOffset 是玩家能自由夺的方向偏移） */
export function gunnerCamera(
  tank: Vec3,
  turretYaw: number,
  yawOffset: number,
  pitchOffset: number,
  eyeHeight = 0.62,
): { pos: Vec3; look: Vec3 } {
  const yaw = turretYaw + yawOffset;
  const pitch = clampPitch(0.02 + pitchOffset) - 0.02;
  const pos = { x: tank.x, y: tank.y + eyeHeight, z: tank.z };
  return { pos, look: { x: pos.x + Math.sin(yaw) * 10, y: pos.y + Math.sin(pitch) * 10, z: pos.z + Math.cos(yaw) * 10 } };
}

/**
 * 拖拽增量 → 新的 yaw/pitch（orbit 与 follow/gunner 共用；像素灵敏度按容器高度归一，大小屏手感一致）。
 *
 * 方向约定：左右拖拽是"画面跟手"——向右拖，场景跟着往右走，相机于是往反方向绕
 * （与 Google 地图 / three.js OrbitControls 一致）；上下拖拽保持"向下拖 = 相机抬高"不变。
 */
export function applyDrag(yaw: number, pitch: number, dxPx: number, dyPx: number, heightPx: number, rate = 1.6): { yaw: number; pitch: number } {
  const scale = rate / Math.max(120, heightPx);
  return { yaw: wrapAngle(yaw - dxPx * scale), pitch: clampPitch(pitch + dyPx * scale) };
}

/**
 * 平移：把注视点（相机跟着走）沿相机右向 / 屏幕内方向挪动。右键或 Shift 拖拽用。
 * 左右与转视角同一套"画面跟手"（向右拖场景往右走 = 注视点往左移）；**上下保持原样**（向下拖 = 注视点往里推）。
 * 位移量按距离缩放，否则拉远之后鼠标就拖不动了。
 */
export function panTarget(
  targetX: number,
  targetZ: number,
  yaw: number,
  dxPx: number,
  dyPx: number,
  dist: number,
  heightPx: number,
): { x: number; z: number } {
  const scale = dist / Math.max(400, heightPx);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: targetX + (-dxPx * cos - dyPx * sin) * scale,
    z: targetZ + (dxPx * sin - dyPx * cos) * scale,
  };
}