// packages/prompt/src/rules-table.ts —— 从 Ruleset 生成任务书里的数值表（保证与引擎同源，不会漂移）
import type { Ruleset } from "@ai-game/protocol";

const DESCRIPTIONS: Record<string, string> = {
  apPerTurn: "每回合行动力（= 每回合最多执行的动作数）",
  maxRounds: "比赛总轮数",
  hpMax: "结构值上限",
  ammoMax: "弹药上限（发）",
  fuelMax: "燃油上限",
  cargoMax: "载货上限（单位）",
  initial: "开局状态 {hp, ammo, fuel, cargo}",
  respawn: "复活状态",
  respawnRounds: "死亡后跳过自己的回合数",
  moveFuelCost: "每格移动耗油",
  emergencyMoveCost: "燃油耗尽后应急移动的每格扣分",
  ammoPrice: "每发弹药价格（分）",
  fuelPricePer10: "每 10 点燃油价格（分，按实际加入量向上取整）",
  loadAmmoPerAction: "单次装填发数上限",
  refuelPerAction: "单次加油量上限",
  collectPerAction: "单次采集单位数上限",
  depositScorePerUnit: "每提交 1 单位资源得分",
  killReward: "击杀奖励（分）",
  deathPenalty: "死亡扣分",
  fireRange: "射程（切比雪夫距离，格）",
  shellDamage: "命中基础伤害",
  forestDamageMult: "目标在森林时的伤害倍率",
  hitChanceBands: "命中率分档（距离 ≤ maxDistance 时为 chance%）",
  forestHitPenalty: "目标在森林时的命中率惩罚（百分点）",
  minHitChance: "命中率下限（%）",
  visionRadius: "视野半径（切比雪夫距离，格）",
  forestStealthRadius: "位于森林中的坦克只有此距离内才会被看见",
  lastKnownMemoryRounds: "lastKnownEnemies 记忆保留轮数",
  turnIntervalMsDefault: "观战默认节奏（毫秒/回合，与决策无关）",
};

export function rulesetToMarkdownTable(rules: Ruleset): string {
  const lines: string[] = ["| 参数 | 值 | 说明 |", "| --- | --- | --- |"];
  for (const [key, value] of Object.entries(rules)) {
    const v = key === "hitChanceBands"
      ? (value as { maxDistance: number; chance: number }[]).map((b) => `距离≤${b.maxDistance}→${b.chance}%`).join("；")
      : JSON.stringify(value);
    lines.push(`| \`${key}\` | \`${v}\` | ${DESCRIPTIONS[key] ?? ""} |`);
  }
  return lines.join("\n");
}

/** 任务书里的紧凑地图 JSON（去掉图例等面向人阅读的重复字段，减小体积） */
export function compactMapJson(map: unknown): string {
  const m = map as Record<string, unknown>;
  const keep = [
    "mapId", "version", "width", "height", "grid", "spawns", "spawnsFor1v1",
    "ammoDepots", "fuelStations", "resourceNodes", "depositPoints", "distanceReference_P1",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (m[k] !== undefined) out[k] = m[k];
  return JSON.stringify(out, null, 1);
}