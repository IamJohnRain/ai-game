// apps/web/src/scene3d/tankModel.ts —— 用低模素材搭一辆坦克：车体 / 炮塔 / 炮管按材质分类
//
// 素材（Quaternius，CC0）只有一个节点 + 4 个图元，但图元本身就分好了部件：
//   材质 Tank_Main  = 炮塔本体、Tank_Main2 = 炮管、Grey = 车体、Black.001 = 履带。
// 于是不必要求素材带骨骼或分节点，按材质名分类就能拿到"炮塔能独立转向"的坦克。
//
// 阵营配色也走材质：车体与炮塔染成座位色（保留素材的明暗层次），履带与炮管保持深色——
// 这样四辆车一眼能分清归属，又不至于把模型涂成一整块纯色。
//
// 车头朝向：**由素材声明**（assets.ts 的 `forward`），不再从包围盒"哪端伸得更远"去猜。
// 这一版素材的炮管端（+1.36）与尾部（−1.14）在居中之后几乎等长，"谁更远"会取到浮点上的
// 负端，结果整车被多转 180°：车头朝后、炮口画在车尾、炮弹从屁股飞出去。
import * as THREE from "three";
import type { ModelAsset, ModelPart } from "./models.ts";

/** 素材车头在模型坐标里的朝向（three 的 Y-up 系；渲染层统一以 +Z 为"车前"） */
export type TankForward = "z+" | "z-" | "x+" | "x-";

const FORWARD_VEC: Record<TankForward, THREE.Vector3> = {
  "z+": new THREE.Vector3(0, 0, 1),
  "z-": new THREE.Vector3(0, 0, -1),
  "x+": new THREE.Vector3(1, 0, 0),
  "x-": new THREE.Vector3(-1, 0, 0),
};

export interface TankModel {
  /** 车体部件（直接挂在车体组下） */
  bodyParts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[];
  /** 炮塔部件（挂在会转向的炮塔组下） */
  turretParts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[];
  /** 炮口位置（**rig 空间**：已经按 yawOffset 转到"车头 +Z"的坐标系里） */
  muzzle: THREE.Vector3;
  /** 把素材扳正到"车头 +Z"所需的额外旋转（弧度：0 / ±π/2 / π） */
  yawOffset: number;
  /** 素材原始尺寸（用于按"一格"归一化） */
  size: THREE.Vector3;
}

/** 按材质名判断部件归属 */
export function classifyPart(part: ModelPart): "body" | "turret" | "track" {
  const name = part.material.name.toLowerCase();
  if (/black|track|wheel/.test(name)) return "track";
  if (/grey|gray|hull|body/.test(name)) return "body";
  if (/gun|barrel|main2/.test(name)) return "turret";
  if (/main|turret|tower/.test(name)) return "turret";
  return "body";
}

/**
 * 从模型素材里搭出一辆坦克。
 * seatColor 决定染色；span 是"车长占几格"；forward 是素材自己的车头方向（默认 +Z）。
 */
export function buildTankModel(
  asset: ModelAsset,
  seatColor: number,
  span: number,
  forward: TankForward = "z+",
): TankModel {
  const maxSpan = Math.max(asset.size.x, asset.size.z, 0.0001);
  const k = span / maxSpan;
  const scale = new THREE.Matrix4().makeScale(k, k, k);
  const color = new THREE.Color(seatColor);
  const light = color.clone().lerp(new THREE.Color(0xffffff), 0.1);
  const dark = color.clone().multiplyScalar(0.5);

  // 把车头方向转到 +Z：R(θ) 的 x' = x·cosθ + z·sinθ、z' = −x·sinθ + z·cosθ，
  // 解 R(θ)·f = (0,0,1) 得 θ = atan2(−fx, fz)。
  const f = FORWARD_VEC[forward] ?? FORWARD_VEC["z+"];
  const yawOffset = Math.atan2(-f.x, f.z);
  const up = new THREE.Vector3(0, 1, 0);

  const bodyParts: TankModel["bodyParts"] = [];
  const turretParts: TankModel["turretParts"] = [];
  /**
   * 炮塔顶点（已经是归一化后的 rig 前坐标系）：炮口取"沿车头方向投影最远的一圈顶点"的中心。
   * 这样炮口正好落在炮管端面上、高度也在炮管轴线上，而不是整个图元包围盒的中点
   * （后者会被尾部的排气管/工具箱拉偏，还会把曳光弹的起点画到车顶上方）。
   */
  const along: { x: number; y: number; z: number; p: number }[] = [];
  let maxProj = -Infinity;
  const v = new THREE.Vector3();

  for (const part of asset.parts) {
    const kind = classifyPart(part);
    const material = part.material.clone() as THREE.MeshStandardMaterial;
    const tint = kind === "track" ? new THREE.Color(0x2b2e34) : kind === "turret" && /gun|barrel|main2/.test(material.name.toLowerCase()) ? new THREE.Color(0x33373d) : kind === "turret" ? light : dark;
    material.color.copy(tint);
    material.roughness = kind === "track" ? 0.95 : 0.6;
    material.metalness = 0.15;
    const matrix = part.matrix.clone().premultiply(scale);
    const entry = { geometry: part.geometry as THREE.BufferGeometry, material, matrix };
    if (kind === "turret") {
      turretParts.push(entry);
      const pos = (part.geometry as THREE.BufferGeometry).getAttribute("position");
      if (pos) {
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
          const p = v.dot(f);
          if (p > maxProj) maxProj = p;
          along.push({ x: v.x, y: v.y, z: v.z, p });
        }
      }
    } else {
      bodyParts.push(entry);
    }
  }

  // 炮口：最前缘一圈顶点的平均位置，再沿车头方向推到最前缘（保证在炮管端面上）
  const muzzle = new THREE.Vector3(0, 0.4, 0);
  if (along.length > 0) {
    const band = 0.02; // 归一化单位：约占一格的 2%，足够圈住炮管端面那一圈
    const ring = along.filter((p) => p.p >= maxProj - band);
    if (ring.length > 0) {
      // 先归零再累加：上面的 0.4 只是"素材没有几何"时的兜底，不能混进平均值
      muzzle.set(0, 0, 0);
      for (const r of ring) {
        muzzle.x += r.x;
        muzzle.y += r.y;
        muzzle.z += r.z;
      }
      muzzle.multiplyScalar(1 / ring.length);
      muzzle.addScaledVector(f, maxProj - muzzle.dot(f));
    } else {
      muzzle.set(0, 0.4, maxProj);
    }
  }
  // rig 空间 = 素材空间绕 Y 转 yawOffset（车体与炮塔在 useModel 里会被同样旋转）
  muzzle.applyAxisAngle(up, yawOffset);

  return {
    bodyParts,
    turretParts,
    muzzle,
    yawOffset,
    size: asset.size.clone(),
  };
}
