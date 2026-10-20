// packages/protocol/src/rules-variants.ts —— 赛制参数变体（纯数据：引擎运行时读 RULES，因此不需要改引擎）
import { DEFAULT_RULESET, type Ruleset } from "./rules.ts";

export const RULES_VARIANTS: Record<string, Ruleset> = {
  default: DEFAULT_RULESET,
  // 侦察压制：视野砍半、森林更隐蔽、不再免费提供"最后已知位置"（逼脚本自己攒情报）
  scout: { ...DEFAULT_RULESET, version: "1.1-scout", visionRadius: 3, forestStealthRadius: 4, lastKnownMemoryRounds: 0 },
  // 物流压力：油箱更小、耗油更高、应急燃料更贵（逼补给规划）
  logistics: { ...DEFAULT_RULESET, version: "1.1-logistics", fuelMax: 60, moveFuelCost: 3, emergencyMoveCost: 4 },
};

/** 按名字取变体；未知名字返回 null（调用方负责报错） */
export function resolveRulesVariant(name: string): Ruleset | null {
  return RULES_VARIANTS[name] ?? null;
}