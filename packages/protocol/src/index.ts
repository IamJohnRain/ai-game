// packages/protocol/src/index.ts —— 协议单一真相源：引擎校验、任务书渲染、前端展示都从这里取
export * from "./pos.ts";
export * from "./map.ts";
export * from "./rules.ts";
export * from "./types.ts";

import mapV1 from "../maps/arena-01.json" with { type: "json" };
import mapDuel from "../maps/duel-01.json" with { type: "json" };
import { parseMap, type GameMap } from "./map.ts";

/** 内置地图（权威数据在 packages/protocol/maps/*.json，docs 中的 ASCII 由 check-docs 校验一致） */
export const BUILTIN_MAPS: Record<string, GameMap> = {
  "arena-01": parseMap(mapV1),
  "duel-01": parseMap(mapDuel),
};

/** 1v1 默认图：小图 + 中央唯一提交点，双方必然为资源开战 */
export const DEFAULT_MAP_1V1 = "duel-01";
/** 3~4 人默认图：四角对称的大图 */
export const DEFAULT_MAP_MULTI = "arena-01";

/** 按人数取默认地图（2 人 → 1v1 专用图） */
export function defaultMapId(seatCount: number): string {
  return seatCount === 2 ? DEFAULT_MAP_1V1 : DEFAULT_MAP_MULTI;
}

export function getMap(mapId: string): GameMap {
  const map = BUILTIN_MAPS[mapId];
  if (!map) throw new Error(`未知地图: ${mapId}（可用: ${Object.keys(BUILTIN_MAPS).join(", ")}）`);
  return map;
}

export function mapVersionTag(map: GameMap): string {
  return `${map.mapId}@${map.version}`;
}