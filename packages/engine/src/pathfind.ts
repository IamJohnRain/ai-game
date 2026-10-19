// packages/engine/src/pathfind.ts —— A* 寻路（4 邻格，曼哈顿启发），静态路径带缓存
import { DIRS, manhattan, type Dir, type Pos } from "@ai-game/protocol";
import type { Terrain } from "./terrain.ts";

const DX = [0, 1, 0, -1] as const; // 与 DIRS 顺序一致：N E S W
const DY = [-1, 0, 1, 0] as const;

class MinHeap {
  private heap: number[] = []; // 存节点下标，按 f 排序
  private f: Float64Array;
  constructor(f: Float64Array) { this.f = f; }
  get size(): number { return this.heap.length; }
  push(i: number): void {
    const h = this.heap;
    h.push(i);
    let c = h.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.f[h[p]!]! <= this.f[h[c]!]!) break;
      const t = h[p]!; h[p] = h[c]!; h[c] = t;
      c = p;
    }
  }
  pop(): number {
    const h = this.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < h.length && this.f[h[l]!]! < this.f[h[m]!]!) m = l;
        if (r < h.length && this.f[h[r]!]! < this.f[h[m]!]!) m = r;
        if (m === p) break;
        const t = h[p]!; h[p] = h[m]!; h[m] = t;
        p = m;
      }
    }
    return top;
  }
}

export interface PathFinderStats { computed: number; cached: number; failures: number }

export class PathFinder {
  private terrain: Terrain;
  private W: number;
  private open: Int32Array;
  private g: Int32Array;
  private f: Float64Array;
  private parent: Int32Array;
  private parentDir: Int8Array;
  private closed: Uint8Array;
  private stamp: Int32Array;
  private generation = 0;
  private cache = new Map<string, Dir[] | null>();
  readonly stats: PathFinderStats = { computed: 0, cached: 0, failures: 0 };

  constructor(terrain: Terrain, cacheLimit = 4096) {
    this.terrain = terrain;
    this.W = terrain.width;
    this.cacheLimit = cacheLimit;
    const n = terrain.width * terrain.height;
    this.open = new Int32Array(n);
    this.g = new Int32Array(n);
    this.f = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.parentDir = new Int8Array(n);
    this.closed = new Uint8Array(n);
    this.stamp = new Int32Array(n);
  }
  private cacheLimit: number;

  /**
   * @param blocked 可选：本次查询中不可通行的格（例如被坦克占住）；不传则只按地形判定
   */
  find(from: Pos, to: Pos, blocked?: Uint8Array | null, maxNodes = 4000): Dir[] | null {
    const W = this.W;
    const t = this.terrain;
    if (!t.inBounds(from.x, from.y) || !t.inBounds(to.x, to.y)) return null;
    const start = from.y * W + from.x;
    const goal = to.y * W + to.x;
    if (start === goal) return [];
    if (!t.isWalkable(to.x, to.y)) return null;
    if (blocked && blocked[goal]) return null;

    const cacheable = !blocked;
    const key = cacheable ? `${from.x},${from.y}>${to.x},${to.y}` : "";
    if (cacheable) {
      const hit = this.cache.get(key);
      if (hit !== undefined) { this.stats.cached++; return hit ? hit.slice() : null; }
    }

    const gen = ++this.generation;
    const { g, f, parent, parentDir, closed, stamp, open } = this;
    const heap = new MinHeap(f);
    stamp[start] = gen;
    g[start] = 0;
    f[start] = manhattan(from, to);
    parent[start] = -1;
    parentDir[start] = -1;
    closed[start] = 0;
    heap.push(start);
    let expanded = 0;
    let found = false;

    while (heap.size > 0) {
      const cur = heap.pop()!;
      if (closed[cur] === 1 && stamp[cur] === gen) continue;
      closed[cur] = 1;
      if (++expanded > maxNodes) break;
      if (cur === goal) { found = true; break; }
      const cx = cur % W, cy = (cur - (cur % W)) / W;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d]!, ny = cy + DY[d]!;
        if (!t.isWalkable(nx, ny)) continue;
        const ni = ny * W + nx;
        if (blocked && blocked[ni]) continue;
        if (stamp[ni] === gen && closed[ni] === 1) continue;
        const tentative = g[cur]! + 1;
        if (stamp[ni] === gen && tentative >= g[ni]!) continue;
        stamp[ni] = gen;
        closed[ni] = 0;
        g[ni] = tentative;
        f[ni] = tentative + manhattan({ x: nx, y: ny }, to);
        parent[ni] = cur;
        parentDir[ni] = d;
        heap.push(ni);
      }
    }

    let result: Dir[] | null = null;
    if (found) {
      const dirs: Dir[] = [];
      let cur = goal;
      while (parent[cur] !== -1) {
        dirs.push(DIRS[parentDir[cur]!]!);
        cur = parent[cur]!;
      }
      dirs.reverse();
      result = dirs;
    } else {
      this.stats.failures++;
    }
    if (cacheable) {
      if (this.cache.size >= this.cacheLimit) this.cache.clear();
      this.cache.set(key, result);
      this.stats.computed++;
    }
    return result ? result.slice() : null;
  }
}

/** 把一组占位格打包成 blocked 位图（供寻路使用） */
export function buildBlockedMask(width: number, height: number, occupied: Pos[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const p of occupied) {
    if (p.x >= 0 && p.y >= 0 && p.x < width && p.y < height) mask[p.y * width + p.x] = 1;
  }
  return mask;
}