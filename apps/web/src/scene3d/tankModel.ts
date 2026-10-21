// apps/web/src/scene3d/tankModel.ts —— 用低模素材搭一辆坦克：车体 / 炮塔 / 炮管按材质分类
//
// 素材（Quaternius，CC0）只有一个节点 + 4 个图元，但图元本身就分好了部件：
//   材质 Tank_Main  = 炮塔本体、Tank_Main2 = 炮管、Grey = 车体、Black.001 = 履带。
// 于是不必要求素材带骨骼或分节点，按材质名分类就能拿到"炮塔能独立转向"的坦克。
//
// 阵营配色也走材质：车体与炮塔染成座位色（保留素材的明暗层次），履带与炮管保持深色——
// 这样四辆车一眼能分清归属，又不至于把模型涂成一整块纯色。
import * as THREE from "three";
import type { ModelAsset, ModelPart } from "./models.ts";

export interface TankModel {
  /** 车体部件（直接挂在车体组下） */
  bodyParts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[];
  /** 炮塔部件（挂在会转向的炮塔组下） */
  turretParts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[];
  /** 炮口位置（模型局部坐标，+Z 为车头方向） */
  muzzle: THREE.Vector3;
  /** 素材车头是否朝 -Z（是的话上层要把模型整体转 180°） */
  forwardFlip: boolean;
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
 * seatColor 决定染色；span 是"车长占几格"（一棵树、一辆坦克都按同一套归一化口径）。
 */
export function buildTankModel(asset: ModelAsset, seatColor: number, span: number): TankModel {
  const maxSpan = Math.max(asset.size.x, asset.size.z, 0.0001);
  const k = span / maxSpan;
  const scale = new THREE.Matrix4().makeScale(k, k, k);
  const color = new THREE.Color(seatColor);
  const light = color.clone().lerp(new THREE.Color(0xffffff), 0.1);
  const dark = color.clone().multiplyScalar(0.5);

  const bodyParts: TankModel["bodyParts"] = [];
  const turretParts: TankModel["turretParts"] = [];
  /** 炮管端点（用于推炮口位置）：在归一化后的模型坐标里取绝对值最大的那个 z */
  let tipZ = 0;
  let tipY = 0.3;
  const box = new THREE.Box3();
  let rawTip = 0;

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
      // 炮管图元的包围盒最远端就是炮口
      part.geometry.computeBoundingBox();
      box.copy(part.geometry.boundingBox!).applyMatrix4(matrix);
      if (Math.abs(box.max.z) > Math.abs(tipZ) || Math.abs(box.min.z) > Math.abs(tipZ)) {
        rawTip = Math.abs(box.max.z) > Math.abs(box.min.z) ? box.max.z : box.min.z;
        tipZ = Math.abs(rawTip);
        tipY = (box.max.y + box.min.y) / 2;
      }
    } else {
      bodyParts.push(entry);
    }
  }

  return {
    bodyParts,
    turretParts,
    muzzle: new THREE.Vector3(0, tipY, tipZ),
    forwardFlip: rawTip < 0,
    size: asset.size.clone(),
  };
}
