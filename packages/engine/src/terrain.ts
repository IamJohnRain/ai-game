// packages/engine/src/terrain.ts —— 地形预处理（位图查询，O(1)，避免每次读字符串）
import type { GameMap } from "@ai-game/protocol";

export const T = {
  PLAIN: ".",
  WALL: "#",
  WATER: "~",
  FOREST: "f",
  SPAWN: "S",
  AMMO: "A",
  AMMO2: "B",
  FUEL: "G",
  RESOURCE: "R",
  DEPOSIT: "D",
} as const;

export interface Terrain {
  width: number;
  height: number;
  grid: string[];
  wall: Uint8Array;
  water: Uint8Array;
  forest: Uint8Array;
  ammo: Uint8Array;
  fuel: Uint8Array;
  deposit: Uint8Array;
  spawn: Uint8Array;
  /** 该格属于哪个资源点的下标（-1 = 不是资源点） */
  resourceIndex: Int32Array;
  index(x: number, y: number): number;
  inBounds(x: number, y: number): boolean;
  isWalkable(x: number, y: number): boolean;
  blocksSight(x: number, y: number): boolean;
}

export function buildTerrain(map: GameMap): Terrain {
  const { width: W, height: H } = map;
  const n = W * H;
  const wall = new Uint8Array(n);
  const water = new Uint8Array(n);
  const forest = new Uint8Array(n);
  const ammo = new Uint8Array(n);
  const fuel = new Uint8Array(n);
  const deposit = new Uint8Array(n);
  const spawn = new Uint8Array(n);
  const resourceIndex = new Int32Array(n).fill(-1);
  const idx = (x: number, y: number) => y * W + x;

  for (let y = 0; y < H; y++) {
    const row = map.grid[y]!;
    for (let x = 0; x < W; x++) {
      const c = row[x]!;
      const i = idx(x, y);
      if (c === T.WALL) wall[i] = 1;
      else if (c === T.WATER) water[i] = 1;
      else if (c === T.FOREST) forest[i] = 1;
      else if (c === T.AMMO || c === T.AMMO2) ammo[i] = 1;
      else if (c === T.FUEL) fuel[i] = 1;
      else if (c === T.DEPOSIT) deposit[i] = 1;
      else if (c === T.SPAWN) spawn[i] = 1;
    }
  }
  map.resourceNodes.forEach((node, i) => { resourceIndex[idx(node.x, node.y)] = i; });

  const terrain: Terrain = {
    width: W,
    height: H,
    grid: map.grid,
    wall, water, forest, ammo, fuel, deposit, spawn, resourceIndex,
    index: idx,
    inBounds(x, y) { return x >= 0 && y >= 0 && x < W && y < H; },
    isWalkable(x, y) { return x >= 0 && y >= 0 && x < W && y < H && !wall[idx(x, y)] && !water[idx(x, y)]; },
    blocksSight(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return true;
      const i = idx(x, y);
      return wall[i] === 1 || forest[i] === 1;
    },
  };
  return terrain;
}