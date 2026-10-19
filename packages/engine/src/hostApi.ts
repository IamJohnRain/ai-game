// packages/engine/src/hostApi.ts —— 脚本可见 API 的宿主实现
// 同一份实现同时服务 QuickJS 沙箱（通过 __hostApi 桥）与本地控制器（直接调用）。
// 所有入参都来自不可信脚本，必须严格校验，绝不能因为奇怪参数让宿主崩掉。
import { chebyshev, dirTo, DIRS, euclid, isDir, step, type Dir, type Pos, type Ruleset, type GameMap } from "@ai-game/protocol";
import type { Terrain } from "./terrain.ts";
import { hasLOS } from "./los.ts";
import { buildBlockedMask, PathFinder } from "./pathfind.ts";

export interface HostApiContext {
  map: GameMap;
  rules: Ruleset;
  terrain: Terrain;
  pathFinder: PathFinder;
  /** 当前不可通行的格（其他坦克） */
  occupied: () => Pos[];
  /** 本座位号 */
  seat: number;
  /** 本座位的确定性随机流 */
  rng: () => number;
  /** 调试日志（配额由控制器执行） */
  onLog: (msg: string) => void;
}

function asInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} 必须是数字`);
  return Math.trunc(v);
}
function asPos(v: unknown, name: string): Pos {
  if (typeof v !== "object" || v === null) throw new Error(`${name} 必须是 {x,y}`);
  const o = v as Record<string, unknown>;
  return { x: asInt(o.x, `${name}.x`), y: asInt(o.y, `${name}.y`) };
}
function asDir(v: unknown, name: string): Dir {
  if (!isDir(v)) throw new Error(`${name} 必须是 N/E/S/W`);
  return v;
}

export interface HostApi {
  call(name: string, args: unknown[]): unknown;
}

export const API_METHODS = [
  "chebyshev", "euclid", "dirTo", "step", "isPassable", "hasLOS", "pathFind", "neighbors",
  "isWall", "isWater", "isForest", "isAmmo", "isFuel", "isResource", "isDeposit", "isSpawn",
  "random", "randomInt", "log", "version",
] as const;

const MAX_LOG_LEN = 200;

export function createHostApi(ctx: HostApiContext): HostApi {
  const { terrain: t, pathFinder, rules } = ctx;

  const blockedNow = (ignoreUnits: boolean): Uint8Array | null => {
    if (ignoreUnits) return null;
    const occ = ctx.occupied().filter((p) => !(p.x === -1));
    return occ.length ? buildBlockedMask(t.width, t.height, occ) : null;
  };

  const methods: Record<string, (args: unknown[]) => unknown> = {
    version: () => "1.0",
    chebyshev: (a) => chebyshev(asPos(a[0], "a"), asPos(a[1], "b")),
    euclid: (a) => euclid(asPos(a[0], "a"), asPos(a[1], "b")),
    dirTo: (a) => dirTo(asPos(a[0], "from"), asPos(a[1], "to")),
    step: (a) => step(asPos(a[0], "pos"), asDir(a[1], "dir")),
    isPassable: (a) => {
      const x = asInt(a[0], "x"), y = asInt(a[1], "y");
      if (!t.isWalkable(x, y)) return false;
      const opts = (a[2] ?? {}) as Record<string, unknown>;
      if (opts.ignoreUnits === true) return true;
      const i = t.index(x, y);
      return !ctx.occupied().some((p) => p.y * t.width + p.x === i);
    },
    hasLOS: (a) => hasLOS(t, asPos(a[0], "a"), asPos(a[1], "b")),
    pathFind: (a) => {
      const from = asPos(a[0], "from"), to = asPos(a[1], "to");
      const opts = (a[2] ?? {}) as Record<string, unknown>;
      const avoidUnits = opts.avoidUnits !== false;
      const maxNodes = typeof opts.maxNodes === "number" ? Math.min(20000, Math.max(16, opts.maxNodes)) : 4000;
      return pathFinder.find(from, to, blockedNow(!avoidUnits), maxNodes);
    },
    neighbors: (a) => {
      const x = asInt(a[0], "x"), y = asInt(a[1], "y");
      return DIRS.map((d) => {
        const p = step({ x, y }, d);
        return { dir: d, x: p.x, y: p.y, passable: methods.isPassable!([p.x, p.y, {}]) };
      });
    },
    isWall: (a) => flag(t.wall, t, asInt(a[0], "x"), asInt(a[1], "y")),
    isWater: (a) => flag(t.water, t, asInt(a[0], "x"), asInt(a[1], "y")),
    isForest: (a) => flag(t.forest, t, asInt(a[0], "x"), asInt(a[1], "y")),
    isAmmo: (a) => flag(t.ammo, t, asInt(a[0], "x"), asInt(a[1], "y")),
    isFuel: (a) => flag(t.fuel, t, asInt(a[0], "x"), asInt(a[1], "y")),
    isResource: (a) => flag(t.resourceIndex, t, asInt(a[0], "x"), asInt(a[1], "y"), true),
    isDeposit: (a) => flag(t.deposit, t, asInt(a[0], "x"), asInt(a[1], "y")),
    isSpawn: (a) => flag(t.spawn, t, asInt(a[0], "x"), asInt(a[1], "y")),
    random: () => ctx.rng(),
    randomInt: (a) => {
      const min = asInt(a[0], "min"), max = asInt(a[1], "max");
      if (max < min) throw new Error("randomInt: max < min");
      return min + Math.floor(ctx.rng() * (max - min + 1));
    },
    log: (a) => {
      const msg = a.map((v) => (typeof v === "string" ? v : safeStringify(v))).join(" ");
      ctx.onLog(msg.slice(0, MAX_LOG_LEN));
      return null;
    },
    fireRange: () => rules.fireRange,
  };

  return {
    call(name: string, args: unknown[]): unknown {
      const fn = methods[name];
      if (!fn) throw new Error(`未知 API 方法: ${name}`);
      return fn(args) ?? null;
    },
  };
}

function flag(arr: Uint8Array | Int32Array, t: Terrain, x: number, y: number, intMode = false): boolean {
  if (!t.inBounds(x, y)) return false;
  const v = arr[t.index(x, y)]!;
  return intMode ? v >= 0 : v === 1;
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}