// packages/protocol/src/rules.ts —— 数值权威（与 docs/02-游戏规则-v1.md §7 参数表一一对应）
import { z } from "zod";
import type { GameMap } from "./map.ts";

export const HitChanceBandSchema = z.object({
  maxDistance: z.number().int().positive(),
  chance: z.number().int().min(0).max(100),
});

/**
 * 开局 / 复活的补给量。`mines` 与弹药一样是"随身装备"：地雷不是消耗品之外的资源点物资，
 * 开局与复活都补满，之后只能在弹药补给点续（见 §5.5 的 loadAmmo）。
 */
export const SupplySchema = z.object({
  hp: z.number().int(),
  ammo: z.number().int(),
  fuel: z.number().int(),
  cargo: z.number().int(),
  mines: z.number().int().nonnegative(),
});
export type Supply = z.infer<typeof SupplySchema>;

export const RulesetSchema = z.object({
  version: z.string(),
  // 回合
  apPerTurn: z.number().int().positive(),
  maxRounds: z.number().int().positive(),
  // 坦克属性
  hpMax: z.number().int().positive(),
  ammoMax: z.number().int().positive(),
  fuelMax: z.number().int().positive(),
  cargoMax: z.number().int().positive(),
  initial: SupplySchema,
  respawn: SupplySchema,
  respawnRounds: z.number().int().nonnegative(),
  // 移动与经济
  moveFuelCost: z.number().int().nonnegative(),
  /** 燃油耗尽时的应急移动：不消耗燃油，但每格扣这么多分（防止"卡死在半路"的死局） */
  emergencyMoveCost: z.number().int().nonnegative(),
  ammoPrice: z.number().int().nonnegative(),
  fuelPricePer10: z.number().int().nonnegative(),
  loadAmmoPerAction: z.number().int().positive(),
  refuelPerAction: z.number().int().positive(),
  collectPerAction: z.number().int().positive(),
  depositScorePerUnit: z.number().int().nonnegative(),
  killReward: z.number().int().nonnegative(),
  deathPenalty: z.number().int().nonnegative(),
  // 防御
  /** 一次 defend 能保护自己多少轮（含发起的那一轮）：占满整回合的 AP，期间打不动 */
  defendRounds: z.number().int().positive(),
  // 地雷
  /** 随身携带地雷的上限（0 = 这张图没有地雷） */
  mineMax: z.number().int().nonnegative(),
  // 战斗
  fireRange: z.number().int().positive(),
  shellDamage: z.number().int().positive(),
  forestDamageMult: z.number().min(0).max(1),
  hitChanceBands: z.array(HitChanceBandSchema).min(1),
  forestHitPenalty: z.number().int().min(0).max(100),
  minHitChance: z.number().int().min(0).max(100),
  // 视野
  visionRadius: z.number().int().positive(),
  forestStealthRadius: z.number().int().positive(),
  // 0 = 不记敌人位置（"情报要自己攒"的变体，见 rules-variants.ts 的 scout）：引擎判据是 round - rec.round > 0 即过期
  lastKnownMemoryRounds: z.number().int().nonnegative(),
  // 观战
  turnIntervalMsDefault: z.number().int().positive(),
});
export type Ruleset = z.infer<typeof RulesetSchema>;

export const RULESET_VERSION = "1.2";

export const DEFAULT_RULESET: Ruleset = {
  version: RULESET_VERSION,
  apPerTurn: 2,
  maxRounds: 150,
  hpMax: 100,
  ammoMax: 20,
  fuelMax: 100,
  cargoMax: 5,
  initial: { hp: 100, ammo: 6, fuel: 40, cargo: 0, mines: 2 },
  respawn: { hp: 100, ammo: 6, fuel: 40, cargo: 0, mines: 2 },
  respawnRounds: 3,
  moveFuelCost: 2,
  emergencyMoveCost: 2,
  ammoPrice: 2,
  fuelPricePer10: 1,
  loadAmmoPerAction: 6,
  refuelPerAction: 30,
  collectPerAction: 3,
  depositScorePerUnit: 10,
  killReward: 20,
  deathPenalty: 20,
  defendRounds: 2,
  mineMax: 2,
  fireRange: 8,
  shellDamage: 20,
  forestDamageMult: 0.5,
  hitChanceBands: [
    { maxDistance: 2, chance: 90 },
    { maxDistance: 4, chance: 70 },
    { maxDistance: 6, chance: 50 },
    { maxDistance: 8, chance: 30 },
  ],
  forestHitPenalty: 20,
  minHitChance: 10,
  visionRadius: 6,
  forestStealthRadius: 3,
  lastKnownMemoryRounds: 12,
  turnIntervalMsDefault: 1200,
};

/** 不同人数使用的出生点下标（1 基，对应 map.spawns）。3 人局必然存在轻微不对称，见文档说明。 */
export const SPAWN_SETS: Record<number, number[]> = {
  2: [1, 3],
  3: [1, 2, 4],
  4: [1, 2, 3, 4],
};

/** 命中率计算（唯一实现，引擎与任务书正文共用） */
export function hitChance(rules: Ruleset, distance: number, targetInForest: boolean): number {
  let chance = rules.minHitChance;
  for (const band of rules.hitChanceBands) {
    if (distance <= band.maxDistance) { chance = band.chance; break; }
  }
  if (targetInForest) chance -= rules.forestHitPenalty;
  return Math.max(rules.minHitChance, chance);
}

export function damageOnHit(rules: Ruleset, targetInForest: boolean): number {
  return targetInForest ? Math.round(rules.shellDamage * rules.forestDamageMult) : rules.shellDamage;
}

/**
 * 地图参数叠加到规则上：把 `map.tuning` 里的上限并进 Ruleset，**并把 initial/respawn 夹进新上限之内**。
 * 夹这一步不能省：不然"载弹上限 0（禁止相互攻击）"的图里，坦克照样带着 RULES.initial.ammo 发出门 ——
 * 车体上限与出生补给必须一致，否则地图参数只是摆设。
 * 引擎只认 Ruleset，所以"地图能改玩法数值"这件事不需要引擎改一行代码。
 */
export function effectiveRules(rules: Ruleset, map: GameMap): Ruleset {
  const t = map.tuning;
  if (!t) return rules;
  const hpMax = t.hpMax ?? rules.hpMax;
  const ammoMax = t.ammoMax ?? rules.ammoMax;
  const cargoMax = t.cargoMax ?? rules.cargoMax;
  const mineMax = t.mineMax ?? rules.mineMax;
  const clamp = (v: Supply) => ({
    ...v,
    hp: Math.min(v.hp, hpMax),
    ammo: Math.min(v.ammo, ammoMax),
    cargo: Math.min(v.cargo, cargoMax),
    mines: Math.min(v.mines, mineMax),
  });
  return { ...rules, hpMax, ammoMax, cargoMax, mineMax, initial: clamp(rules.initial), respawn: clamp(rules.respawn) };
}