// apps/web/test/scene3d.test.ts —— 三维回放的"看不见但会错"的部分：事件→指令编排、相机数学、批次追踪
//
// 为什么这些值得测：
//   三维画面本身没法在 CI 里断言（没有 WebGL），但决定画面是否正确的三件事都是纯函数：
//     1) 一条 fire 事件到底发生在哪个格子（事件里没有坐标，要靠批次内重放推出来）；
//     2) 相机在某个角度下应该在哪儿（球坐标、钳制、跟随的角度回绕）；
//     3) "刚发生了什么"（归约器交给渲染层的事件批次，决定出不出声、出几次声）。
//   这里把它们钉死，剩下的交给浏览器实测。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMap, MatchEvent, Ruleset } from "@ai-game/protocol";
import { BattleAccumulator, MAX_FX_EVENTS } from "../src/battleState.ts";
import { impactSound, planFx, soundFor, type FxCommand } from "../src/scene3d/fxPlan.ts";
import {
  PITCH_MAX, applyDrag, clampPitch, damp, fitDistance, followCamera, gunnerCamera, lerpAngle,
  orbitPosition, tileToWorld, wrapAngle, yawOfDir, yawOfStep,
} from "../src/scene3d/cameraMath.ts";

// ---------------------------------------------------------------- 测试用最小地图/规则

const MAP = {
  mapId: "t", mapVersion: 1, width: 9, height: 9,
  grid: Array.from({ length: 9 }, () => ".".repeat(9)),
  spawns: [{ x: 1, y: 1 }, { x: 7, y: 7 }],
  ammoDepots: [{ x: 4, y: 1 }],
  fuelStations: [{ x: 1, y: 4 }],
  depositPoints: [{ x: 4, y: 7 }],
  resourceNodes: [],
} as unknown as GameMap;

const RULES = {
  version: "test", turnLimit: 4, visionRadius: 5, forestStealthRadius: 2, lastKnownMemoryRounds: 3,
  hpMax: 100, initial: { hp: 100, ammo: 5, fuel: 20, cargo: 0 },
  respawn: { hp: 100, ammo: 5, fuel: 20, cargo: 0 }, respawnRounds: 1, killReward: 10,
  emergencyMoveCost: 1, depositScorePerUnit: 1, ammoLoadRounds: 3, ammoLoadCost: 1,
  fuelLoadAmount: 10, fuelLoadCost: 1,
} as unknown as Ruleset;

const newAcc = (): BattleAccumulator => new BattleAccumulator(MAP, RULES);
const turnBegins = (count: number): MatchEvent[] =>
  Array.from({ length: count }, (_v, i) => ({ t: "turn_begin", round: i, turn: i, seat: 1, order: [1, 2] } as MatchEvent));

// ---------------------------------------------------------------- 事件 → 指令

const move = (seat: number, from: [number, number], to: [number, number], emergency = false): MatchEvent =>
  ({ t: "move", seat, from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] }, fuelAfter: 10, ...(emergency ? { emergency: true } : {}) });

const fire = (seat: number, target: [number, number], hit: boolean, targetSeat: number | null = null): MatchEvent =>
  ({ t: "fire", seat, target: { x: target[0], y: target[1] }, hit, damage: hit ? 20 : 0, targetSeat, ammoAfter: 3 });

test("planFx：位置按「当时」算——先移动后开火，弹道起点是移动之后的格子", () => {
  const batch: MatchEvent[] = [move(1, [1, 1], [2, 1]), fire(1, [3, 1], true, 2)];
  const cmds = planFx({ batch, seats: { 1: { x: 2, y: 1 }, 2: { x: 3, y: 1 } } });
  assert.deepEqual(cmds[0], { kind: "move", seat: 1, from: { x: 1, y: 1 }, to: { x: 2, y: 1 }, emergency: false });
  const f = cmds[1]!;
  assert.equal(f.kind, "fire");
  if (f.kind !== "fire") return;
  assert.deepEqual(f.from, { x: 2, y: 1 }, "开火位置应是批次内移动之后的格子");
  assert.deepEqual(f.to, { x: 3, y: 1 });
  assert.equal(f.hit, true);
});

test("planFx：采集/提交/加油/装弹都用行动者那一刻的格子（这些事件里没有坐标）", () => {
  const batch: MatchEvent[] = [
    move(2, [0, 0], [0, 1]),
    { t: "collect", seat: 2, node: "n1", amount: 6, remainingAfter: 14, cargoAfter: 6 },
    { t: "deposit", seat: 2, units: 6, scoreDelta: 6, scoreAfter: 6 },
    { t: "load_ammo", seat: 2, rounds: 3, scoreDelta: -3, ammoAfter: 6, scoreAfter: 3 },
    { t: "refuel", seat: 2, fuelAdded: 12, scoreDelta: -2, fuelAfter: 20, scoreAfter: 1 },
  ];
  const cmds = planFx({ batch, seats: { 2: { x: 0, y: 1 } } });
  const after = cmds.slice(1) as Extract<FxCommand, { kind: "collect" | "deposit" | "loadAmmo" | "refuel" }>[];
  assert.equal(after.length, 4);
  for (const c of after) assert.deepEqual(c.at, { x: 0, y: 1 }, `${c.kind} 应落在移动后的格子上`);
  assert.equal(after[0]!.kind, "collect");
  assert.equal((after[0] as Extract<FxCommand, { kind: "collect" }>).amount, 6);
});

test("planFx：复活会纠正位置（否则复活后的事件会落在死亡地点）", () => {
  const batch: MatchEvent[] = [
    { t: "death", seat: 1, killerSeat: 2, pos: { x: 5, y: 5 }, scoreDelta: -5, scoreAfter: 0 },
    { t: "respawn", seat: 1, pos: { x: 1, y: 1 } },
    fire(1, [2, 1], false),
  ];
  const cmds = planFx({ batch, seats: { 1: { x: 1, y: 1 }, 2: { x: 2, y: 1 } } });
  const f = cmds.find((c) => c.kind === "fire");
  assert.ok(f && f.kind === "fire");
  assert.deepEqual(f.from, { x: 1, y: 1 }, "复活后开火，起点应是出生点");
});

test("planFx：不认识的事件不产出指令；match_end 只给一声收尾", () => {
  const batch: MatchEvent[] = [
    { t: "match_start", mapId: "m", mapVersion: 1, rulesetVersion: "1.1", seed: 1, playerCount: 2, seats: [], rules: {} },
    { t: "turn_begin", round: 1, turn: 1, seat: 1, order: [1, 2] },
    { t: "match_end", ranking: [] },
  ];
  assert.deepEqual(planFx({ batch, seats: {} }).map((c) => c.kind), ["end"]);
});

test("planFx：node_regen 需要资源点坐标表；给不出来就安静丢弃而不是落到 (0,0)", () => {
  const batch: MatchEvent[] = [{ t: "node_regen", node: "n2", remainingAfter: 20 }];
  assert.deepEqual(planFx({ batch, seats: {} }), []);
  const cmds = planFx({ batch, seats: {}, nodes: { n2: { x: 4, y: 7 } } });
  assert.equal(cmds.length, 1);
  assert.deepEqual((cmds[0] as Extract<FxCommand, { kind: "regen" }>).at, { x: 4, y: 7 });
});

test("指令 → 音效：命中/脱靶分开、普通移动不发声、阵亡记在凶手身上", () => {
  const shot = planFx({ batch: [fire(1, [3, 3], true, 2)], seats: { 1: { x: 1, y: 1 }, 2: { x: 3, y: 3 } } })[0]!;
  assert.equal(soundFor(shot)?.kind, "fire");
  assert.equal(impactSound(true), "hit");
  assert.equal(impactSound(false), "miss");
  assert.equal(
    soundFor({ kind: "move", seat: 1, from: { x: 0, y: 0 }, to: { x: 0, y: 1 }, emergency: false }),
    null,
    "普通移动不发声（每秒 20 次会变成噪音）",
  );
  assert.equal(soundFor({ kind: "move", seat: 1, from: { x: 0, y: 0 }, to: { x: 0, y: 1 }, emergency: true })?.kind, "tread");
  assert.equal(soundFor({ kind: "death", seat: 1, at: { x: 0, y: 0 }, killerSeat: 2 })?.seat, 2);
  assert.equal(soundFor({ kind: "end" })?.kind, "end");
});

// ---------------------------------------------------------------- 归约器的「刚刚发生了什么」

test("归约器：lastApplied 给出本帧应用的完整批次", () => {
  const acc = newAcc();
  acc.reset(turnBegins(10));
  assert.equal(acc.total, 10);
  acc.advance(3);
  assert.equal(acc.lastAppliedCount, 3);
  assert.equal(acc.lastApplied.length, 3, "没超过上限时批次应完整");
  acc.advance(0);
  assert.equal(acc.lastAppliedCount, 0, "没有推进时不应留下上一次的批次（否则会重复出声）");
  assert.equal(acc.lastApplied.length, 0);
});

test("归约器：一次跳转几千条时只保留末尾 64 条，且如实报告总数", () => {
  const acc = newAcc();
  acc.reset(turnBegins(5000));
  acc.seekTo(4000);
  assert.equal(acc.lastAppliedCount, 4000, "总数用于判断「这是一次跳转」");
  assert.equal(acc.lastApplied.length, MAX_FX_EVENTS, "批次要截断，否则会一次点几千个音效");
  assert.equal(acc.applied, 4000);
  acc.reset(turnBegins(3));
  assert.equal(acc.lastAppliedCount, 0, "重置（换比赛/重连）后不应残留上局的批次");
  assert.equal(acc.lastApplied.length, 0);
});

// ---------------------------------------------------------------- 相机数学

test("格子 → 世界坐标：棋盘中心为原点，每格一个世界单位", () => {
  assert.deepEqual(tileToWorld(4, 4, 9, 9), { x: 0, z: 0 });
  assert.deepEqual(tileToWorld(0, 0, 9, 9), { x: -4, z: -4 });
  assert.deepEqual(tileToWorld(8, 8, 9, 9), { x: 4, z: 4 });
  assert.deepEqual(tileToWorld(0, 0, 2, 2), { x: -0.5, z: -0.5 });
});

test("方向 → 朝向角：南 = 0（+Z）、东 = π/2（+X），与「物体默认朝 +Z」一致", () => {
  assert.equal(yawOfDir("S"), 0);
  assert.ok(Math.abs(yawOfDir("N") - Math.PI) < 1e-9);
  assert.ok(Math.abs(yawOfDir("E") - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(yawOfDir("W") + Math.PI / 2) < 1e-9);
  assert.equal(yawOfStep(0, 1), 0);
  assert.ok(Math.abs(yawOfStep(1, 0)! - Math.PI / 2) < 1e-9);
  assert.equal(yawOfStep(0, 0), null, "没移动就不该改朝向");
});

test("角度：回绕到 (-π, π]，插值走最短弧（179° 到 -179° 不该绕一圈）", () => {
  assert.ok(Math.abs(wrapAngle((3 * Math.PI) / 2) + Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(wrapAngle((-3 * Math.PI) / 2) - Math.PI / 2) < 1e-9);
  const mid = lerpAngle(3.1, -3.1, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 0.01, `应绕过 ±π 而不是穿过 0（得到 ${mid}）`);
  assert.equal(lerpAngle(0, 1, 0.5), 0.5);
  assert.equal(lerpAngle(0, 1, 5), 1, "t 要夹到 [0,1]");
});

test("damp：帧率无关（30fps 走一步 ≈ 120fps 走四步），且单帧步长有上限", () => {
  assert.equal(damp(10, 0), 0);
  const step30 = damp(10, 1 / 30);
  const step120 = damp(10, 1 / 120);
  const fourSteps = 1 - (1 - step120) ** 4;
  assert.ok(Math.abs(step30 - fourSteps) < 1e-6, `${step30} 与 ${fourSteps} 应几乎相同`);
  assert.equal(damp(10, 99), damp(10, 0.25), "切后台再回来不能一帧瞬移");
});

test("俯仰钳制：不允许相机钻到地平线以下", () => {
  assert.equal(clampPitch(-5), -0.04);
  assert.equal(clampPitch(99), PITCH_MAX);
});

test("球坐标：pitch=0 时相机与目标同高，pitch 拉满时接近正上方（并被钳制）", () => {
  const target = { x: 2, y: 0, z: -1 };
  const flat = orbitPosition(target, 0, 0, 10);
  assert.equal(flat.y, 0);
  assert.ok(Math.abs(flat.z - (target.z + 10)) < 1e-9, "yaw=0 时相机在目标的 +Z 侧");
  const top = orbitPosition(target, 0, Math.PI / 2, 10);
  assert.equal(clampPitch(Math.PI / 2), PITCH_MAX, "90° 会被钳到上限");
  assert.ok(top.y > 9.5, "几乎在正上方");
  assert.ok(Math.abs(top.z - target.z) < 1.5, "钳制后不会退化成「相机与注视点几乎重合」");
});

test("取景距离：地图越大越远；视口越窄越要往后退", () => {
  const near = fitDistance(9, 9, 50, 1.6);
  const far = fitDistance(64, 64, 50, 1.6);
  assert.ok(far > near, `${far} 应大于 ${near}`);
  assert.ok(near >= 4);
  const portrait = fitDistance(64, 64, 50, 0.5);
  const wide = fitDistance(64, 64, 50, 2);
  assert.ok(portrait > wide, `竖屏（${portrait}）要比宽屏（${wide}）退得更远，否则左右会被切掉`);
});

test("跟随视角：相机在车后上方、视线落在车头前方；yawOffset 只是绕车转", () => {
  const tank = { x: 0, y: 0, z: 0 };
  const cam = followCamera(tank, 0, 0, 0.32, 6); // 车头朝 +Z
  assert.ok(cam.pos.z < 0, "相机应在车后（-Z 侧）");
  assert.ok(cam.pos.y > 0.5, "相机应在车上方");
  assert.ok(cam.look.z > 0, "视线落点在车头方向");
  const side = followCamera(tank, 0, Math.PI / 2, 0.32, 6);
  const back = Math.cos(0.32) * 6;
  assert.ok(Math.abs(side.pos.x + back) < 1e-6, "yawOffset=π/2 时相机绕到车的 -X 侧");
  assert.ok(Math.abs(side.pos.z) < 1e-6);
});

test("炮手视角：眼睛在炮塔上方、朝炮口看（炮塔朝向决定视线）", () => {
  const cam = gunnerCamera({ x: 1, y: 0, z: 2 }, Math.PI / 2, 0, 0);
  assert.equal(cam.pos.x, 1);
  assert.equal(cam.pos.z, 2);
  assert.ok(cam.pos.y > 0.5 && cam.pos.y < 0.8);
  assert.ok(cam.look.x > cam.pos.x, "炮塔朝 +X 时应看向 +X");
  const back = gunnerCamera({ x: 0, y: 0, z: 0 }, 0, Math.PI, 0);
  assert.ok(back.look.z < 0, "再转 180° 应看向 -Z");
});

test("拖拽灵敏度：按视口高度归一（大小屏手感一致），并同样受俯仰钳制", () => {
  const small = applyDrag(0, 0.5, 100, 0, 800);
  const big = applyDrag(0, 0.5, 100, 0, 400);
  assert.ok(Math.abs(big.yaw - 2 * small.yaw) < 1e-9, "高度减半、同样像素位移 → 转角翻倍");
  assert.equal(applyDrag(0, 0.5, 0, 10_000, 800).pitch, PITCH_MAX, "一直往下拖也不能翻到地平面以下");
});