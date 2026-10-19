// packages/engine/src/setup.ts —— 开赛准备：座次抽签（决定谁用哪个出生点）
import { SPAWN_SETS, type GameMap, type Pos } from "@ai-game/protocol";
import { deriveSeed, mulberry32 } from "./rng.ts";

/**
 * 按人数取出对应出生点集合，用种子做 Fisher-Yates 洗牌后依次分配给座位（升序）。
 * 结果只由 (seed, playerCount) 决定，因此战报里的 seed 足以完整复现座次。
 * 2 人局优先使用地图自己声明的 spawnsFor1v1（例如决斗图取南北对峙），未声明则用 SPAWN_SETS。
 */
export function assignSpawns(map: GameMap, seats: number[], seed: number): { seat: number; pos: Pos }[] {
  const sorted = [...seats].sort((a, b) => a - b);
  if (sorted.length < 2 || sorted.length > 4) throw new Error(`参战座位数必须在 2~4，当前 ${sorted.length}`);
  const indices = (sorted.length === 2 && map.spawnsFor1v1?.length === 2 ? map.spawnsFor1v1 : SPAWN_SETS[sorted.length]);
  if (!indices) throw new Error(`不支持 ${sorted.length} 人局`);
  const pool = indices.map((i) => {
    const sp = map.spawns[i - 1];
    if (!sp) throw new Error(`地图 ${map.mapId} 缺少第 ${i} 个出生点（该图最多支持 ${map.spawns.length} 人）`);
    return { ...sp };
  });
  const rng = mulberry32(deriveSeed(seed, `spawns:${sorted.length}`));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i]!; pool[i] = pool[j]!; pool[j] = tmp;
  }
  return sorted.map((seat, i) => ({ seat, pos: pool[i]! }));
}