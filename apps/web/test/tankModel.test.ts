// apps/web/test/tankModel.test.ts —— 坦克素材的"车头朝向 / 炮口"换算
//
// 为什么值得单测：这两件事只在三维画面里才看得见，错了也不会报错——
//   1) 素材的车头不是 +Z 时要整车扳正（否则车往东开、炮口朝西，炮弹从车尾飞出去）；
//   2) 炮口必须取"沿车头方向最远的一圈顶点"，不能取整个图元包围盒的中点
//      （炮管图元里还包含尾部的排气管，包围盒中点会落在车顶上方）。
// 这一版 Quaternius 素材的炮管端与尾部几乎等长，"包围盒哪端更远"会取到浮点负端，
// 所以车头方向改成素材显式声明，这里把这套换算钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildTankModel, classifyPart, type TankForward } from "../src/scene3d/tankModel.ts";
import type { ModelAsset, ModelPart } from "../src/scene3d/models.ts";

/** 造一个"炮管沿 axis 方向伸出 tip"的假素材：车体/履带在底部，炮塔在上层 */
function fakeTank(axis: TankForward, tip = 1): ModelAsset {
  const box = (name: string, size: [number, number, number], pos: [number, number, number]): ModelPart => {
    const geometry = new THREE.BoxGeometry(...size);
    geometry.translate(...pos);
    return {
      geometry,
      material: new THREE.MeshStandardMaterial({ name }),
      matrix: new THREE.Matrix4(),
    };
  };
  const [dx, dz] = axis === "x+" ? [1, 0] : axis === "x-" ? [-1, 0] : axis === "z+" ? [0, 1] : [0, -1];
  const alongX = axis.startsWith("x");
  const barrelSize: [number, number, number] = alongX ? [0.9, 0.2, 0.2] : [0.2, 0.2, 0.9];
  const stubSize: [number, number, number] = alongX ? [0.4, 0.2, 0.2] : [0.2, 0.2, 0.4];
  const parts: ModelPart[] = [
    // 车体（Grey）与履带（Black.001）都在底部
    box("Grey", [1.8, 0.3, 1.2], [0, 0.15, 0]),
    box("Black.001", [2.0, 0.3, 1.6], [0, 0.15, 0]),
    // 炮塔本体（Tank_Main）在上层
    box("Tank_Main", [1.2, 0.5, 0.9], [0, 0.65, 0]),
    // 炮管（Tank_Main2）：从炮塔中心沿 axis 伸出到 tip（端面正好在 tip）
    box("Tank_Main2", barrelSize, [dx * (tip - barrelSize[0] / 2), 0.65, dz * (tip - barrelSize[2] / 2)]),
    // 尾部再带一小段"排气管"：与真实素材一样低一截、方向相反，专门用来检验"包围盒中点"式的错误实现
    box("Tank_Main2", stubSize, [-dx * 0.75, 0.5, -dz * 0.75]),
  ];
  const group = new THREE.Group();
  const size = new THREE.Vector3(2, 1, 2);
  return { url: "fake.glb", template: group, parts, size };
}

const near = (a: number, b: number, eps = 0.03) => Math.abs(a - b) <= eps;
/** 归一化之后炮管轴线的高度：0.65（素材单位）× 0.98/2 */
const BARREL_Y = 0.65 * (0.98 / 2);

test("车头声明 +Z：不额外旋转，炮口落在 +Z 的炮管端面上、高度在炮管轴线上", () => {
  const model = buildTankModel(fakeTank("z+", 1), 0xffffff, 0.98, "z+");
  assert.ok(near(model.yawOffset, 0, 1e-6), `yawOffset 应为 0，实际 ${model.yawOffset}`);
  assert.ok(model.muzzle.z > 0.4, `炮口应在 +Z 端，实际 z=${model.muzzle.z}`);
  assert.ok(near(model.muzzle.y, BARREL_Y), `炮口高度应贴着炮管（${BARREL_Y.toFixed(3)}），实际 ${model.muzzle.y}`);
  assert.ok(near(model.muzzle.x, 0, 0.02), `炮口应居中，实际 x=${model.muzzle.x}`);
});

test("车头声明 -Z：整车转 180°，炮口仍落在 rig 空间的 +Z", () => {
  const model = buildTankModel(fakeTank("z-", 1), 0xffffff, 0.98, "z-");
  assert.ok(near(Math.abs(model.yawOffset), Math.PI, 1e-6), `yawOffset 应为 π，实际 ${model.yawOffset}`);
  assert.ok(model.muzzle.z > 0.4, `扳正后炮口应在 +Z，实际 z=${model.muzzle.z}`);
  assert.ok(near(model.muzzle.y, BARREL_Y), `炮口高度 ${model.muzzle.y}`);
});

test("车头声明 +X：转 -90°，炮口落在 rig 空间的 +Z 端", () => {
  const model = buildTankModel(fakeTank("x+", 1), 0xffffff, 0.98, "x+");
  assert.ok(near(model.yawOffset, -Math.PI / 2, 1e-6), `yawOffset 应为 -π/2，实际 ${model.yawOffset}`);
  assert.ok(model.muzzle.z > 0.4, `扳正后炮口应在 +Z，实际 z=${model.muzzle.z}`);
  assert.ok(near(model.muzzle.x, 0, 0.02), `炮口在 rig 空间应居中，实际 x=${model.muzzle.x}`);
});

test("部件分类：炮塔/炮管/车体/履带按材质名分开", () => {
  const mk = (name: string) => ({ geometry: new THREE.BufferGeometry(), material: new THREE.MeshStandardMaterial({ name }), matrix: new THREE.Matrix4() });
  assert.equal(classifyPart(mk("Tank_Main")), "turret");
  assert.equal(classifyPart(mk("Tank_Main2")), "turret");
  assert.equal(classifyPart(mk("Grey")), "body");
  assert.equal(classifyPart(mk("Black.001")), "track");
});
