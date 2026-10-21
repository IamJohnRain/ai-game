// packages/protocol/test/rules.tuning.test.ts —— 地图级车辆参数（map.tuning）与有效规则的合并
//
// 这件事值得单独测，因为它是"地图能改玩法数值"的唯一入口：
//   1) 不写 tuning 的地图必须**一个字节都不变**（老图行为不能被新特性悄悄改掉）；
//   2) 写了上限就必须把 initial/respawn 一起夹住 —— 否则"载弹上限 0 = 禁止相互攻击"的图里，
//      坦克照样带着 RULES.initial.ammo 发出门打人，地图参数就成了摆设。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_MAPS, DEFAULT_RULESET, effectiveRules, parseMap, validateMap, type GameMap,
} from "@ai-game/protocol";

const base = BUILTIN_MAPS["arena-01"]!;

function withTuning(tuning: GameMap["tuning"]): GameMap {
  return { ...base, tuning };
}

test("没有 tuning 的地图：规则原封不动返回（连对象都不换）", () => {
  const rules = effectiveRules(DEFAULT_RULESET, base);
  assert.equal(rules, DEFAULT_RULESET, "应当直接返回同一个对象，避免调用方误判'规则被改过'");
});

test("车辆参数覆盖上限：载弹/载货/血量都随地图走", () => {
  const rules = effectiveRules(DEFAULT_RULESET, withTuning({ hpMax: 60, ammoMax: 5, cargoMax: 3 }));
  assert.equal(rules.hpMax, 60);
  assert.equal(rules.ammoMax, 5);
  assert.equal(rules.cargoMax, 3);
  // 只写一项时其余沿用 RULES
  const only = effectiveRules(DEFAULT_RULESET, withTuning({ ammoMax: 5 }));
  assert.equal(only.hpMax, DEFAULT_RULESET.hpMax);
  assert.equal(only.cargoMax, DEFAULT_RULESET.cargoMax);
  // 原规则对象不能被改坏（合并是纯函数）
  assert.equal(DEFAULT_RULESET.ammoMax, 20);
});

test("上限调低后出生/复活补给被夹住：载弹上限 0 的图，出门就没有炮弹", () => {
  const rules = effectiveRules(DEFAULT_RULESET, withTuning({ ammoMax: 0, cargoMax: 2, hpMax: 50 }));
  assert.equal(rules.initial.ammo, 0, "上限 0 → 出生弹药 0（否则还能开炮）");
  assert.equal(rules.respawn.ammo, 0, "复活同理");
  assert.equal(rules.initial.cargo, Math.min(DEFAULT_RULESET.initial.cargo, 2));
  assert.equal(rules.initial.hp, 50);
  assert.equal(rules.respawn.hp, 50);
  // 上限没被调低的项不受影响
  assert.equal(rules.initial.fuel, DEFAULT_RULESET.initial.fuel);
});

test("上限调高不改变初始补给（0 载货起步这类设定不该被覆盖）", () => {
  const rules = effectiveRules(DEFAULT_RULESET, withTuning({ hpMax: 150, ammoMax: 30, cargoMax: 5 }));
  assert.equal(rules.hpMax, 150);
  assert.equal(rules.initial.ammo, DEFAULT_RULESET.initial.ammo);
  assert.equal(rules.initial.hp, DEFAULT_RULESET.initial.hp);
});

// ---------------------------------------------------------------- 地图 schema 与校验
// 测试图必须保持 grid 与坐标数组一致（parseMap 会连结构一起校验），所以只改"某一个点"的参数

const withAmmo = (patch: Record<string, unknown>): GameMap => ({
  ...base,
  ammoDepots: base.ammoDepots.map((p, i) => (i === 0 ? { ...p, ...patch } : p)),
});
const withFuel = (patch: Record<string, unknown>): GameMap => ({
  ...base,
  fuelStations: base.fuelStations.map((p, i) => (i === 0 ? { ...p, ...patch } : p)),
});

test("补给点：不写容量 = 无限供给；写了容量必须配刷新间隔，初始量不能超容量", () => {
  const ok = parseMap(withAmmo({ capacity: 6, initial: 2, regenEveryRounds: 3 }));
  assert.equal(ok.ammoDepots[0]!.capacity, 6);
  assert.equal(ok.ammoDepots[1]!.capacity, undefined, "其余点不受影响，仍是无限供给");

  const missingRegen = validateMap(withAmmo({ capacity: 6 }));
  assert.ok(missingRegen.some((e) => e.includes("regenEveryRounds")), `应当报缺刷新间隔：${missingRegen.join(" / ")}`);

  const overCapacity = validateMap(withAmmo({ capacity: 2, initial: 5, regenEveryRounds: 3 }));
  assert.ok(overCapacity.some((e) => e.includes("超过容量")), `应当报初始量超容量：${overCapacity.join(" / ")}`);

  const dangling = validateMap(withFuel({ initial: 3, regenEveryRounds: 2 }));
  assert.ok(dangling.some((e) => e.includes("没写 capacity")), `应当报"没容量却写了初始/刷新"：${dangling.join(" / ")}`);
});

test("几何参数：capacity 可以等于 initial（满库存开局），刷新间隔必须是正整数", () => {
  const full = parseMap(withFuel({ capacity: 30, initial: 30, regenEveryRounds: 5 }));
  assert.equal(full.fuelStations[0]!.initial, 30);
  // schema 层面挡住 0 / 负数：这类值一旦进库，引擎里 round % 0 就是 NaN
  assert.throws(() => parseMap(withFuel({ capacity: 30, regenEveryRounds: 0 })), "regenEveryRounds=0 应当被拒绝");
  assert.throws(() => parseMap(withFuel({ capacity: 0, regenEveryRounds: 5 })), "capacity=0 应当被拒绝");
  assert.throws(() => parseMap(withFuel({ capacity: 30, initial: -1, regenEveryRounds: 5 })), "负初始量应当被拒绝");
});