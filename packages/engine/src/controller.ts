// packages/engine/src/controller.ts —— 控制器契约 + 本地控制器（无沙箱，直接调用脚本）
// 引擎只认这个接口：正式比赛用 QuickJsController（packages/sandbox），
// 仿真/测试用 LocalController（本文件），未来"每回合调 LLM"模式只需再写一个实现。
import type { Action, Ctx, GameMap, Ruleset, State } from "@ai-game/protocol";
import type { HostApi } from "./hostApi.ts";

export interface ControllerTurnResult {
  /** null 表示脚本没有返回合法数组 */
  actions: Action[] | null;
  kind?: "exception" | "timeout" | "bad_return";
  error?: string;
  logs?: string[];
}
export interface ScriptGlobals {
  MAP: GameMap;
  RULES: Ruleset;
}
export interface TurnController {
  /** 加载脚本（可只做语法解析，不做执行） */
  load(seat: number, scriptText: string): void;
  /** 引擎在开赛前调用：把宿主 API 与全局常量交给控制器注入脚本环境 */
  init(seat: number, ctx: Ctx, api: HostApi, globals: ScriptGlobals): void;
  onTurn(seat: number, state: State): ControllerTurnResult;
  stats?(seat: number): { calls: number; totalMs: number };
  dispose(): void;
}

interface LoadedScript {
  text: string;
  onTurn?: (state: State) => unknown;
  onInit?: (ctx: Ctx) => unknown;
  meta: unknown;
  calls: number;
  totalMs: number;
}

/** 本地控制器：new Function 直接执行（仅用于本地仿真与测试，无隔离，切勿用于不可信脚本） */
export class LocalController implements TurnController {
  private scripts = new Map<number, LoadedScript>();
  private logs = new Map<number, string[]>();

  load(seat: number, scriptText: string): void {
    // Function 构造器会立即解析函数体：语法错误在这里就会抛出，但不会执行脚本体
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("MAP", "RULES", "API", scriptText);
    this.scripts.set(seat, { text: scriptText, meta: null, calls: 0, totalMs: 0 });
  }

  init(seat: number, ctx: Ctx, api: HostApi, globals: ScriptGlobals): void {
    const rec = this.scripts.get(seat);
    if (!rec) throw new Error(`座位 ${seat} 未加载脚本`);
    const logs: string[] = [];
    this.logs.set(seat, logs);
    const sandboxApi = makeApiFacade(api, logs);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function("MAP", "RULES", "API", `${rec.text}\n;return { onInit: typeof onInit === "function" ? onInit : null, onTurn: typeof onTurn === "function" ? onTurn : null, META: typeof META !== "undefined" ? META : null };`);
    const mod = factory(globals.MAP, globals.RULES, sandboxApi) as {
      onInit: ((ctx: Ctx) => unknown) | null; onTurn: ((state: State) => unknown) | null; META: unknown;
    };
    rec.onInit = mod.onInit ?? undefined;
    rec.onTurn = mod.onTurn ?? undefined;
    rec.meta = mod.META;
    if (!rec.onTurn) throw new Error("脚本未定义 onTurn");
    rec.onInit?.(ctx);
  }

  onTurn(seat: number, state: State): ControllerTurnResult {
    const rec = this.scripts.get(seat);
    if (!rec || !rec.onTurn) return { actions: null, kind: "exception", error: "脚本未就绪" };
    const logs = this.logs.get(seat)!;
    logs.length = 0;
    const t0 = performance.now();
    try {
      const out = rec.onTurn(state);
      rec.calls += 1;
      rec.totalMs += performance.now() - t0;
      if (!Array.isArray(out)) return { actions: null, kind: "bad_return", error: `onTurn 返回了 ${typeof out}，应为数组`, logs: [...logs] };
      return { actions: out as Action[], logs: [...logs] };
    } catch (err) {
      rec.calls += 1;
      rec.totalMs += performance.now() - t0;
      return { actions: null, kind: "exception", error: err instanceof Error ? err.message : String(err), logs: [...logs] };
    }
  }

  stats(seat: number): { calls: number; totalMs: number } {
    const rec = this.scripts.get(seat);
    return { calls: rec?.calls ?? 0, totalMs: Math.round(rec?.totalMs ?? 0) };
  }

  meta(seat: number): unknown {
    return this.scripts.get(seat)?.meta;
  }

  dispose(): void {
    this.scripts.clear();
    this.logs.clear();
  }
}

/** 把宿主 API 包成脚本可见的门面，并执行日志配额 */
function makeApiFacade(api: HostApi, logs: string[]): Record<string, unknown> {
  const call = (name: string, args: unknown[]): unknown => api.call(name, args);
  const facade: Record<string, unknown> = {
    version: "1.0",
    chebyshev: (a: unknown, b: unknown) => call("chebyshev", [a, b]),
    euclid: (a: unknown, b: unknown) => call("euclid", [a, b]),
    dirTo: (a: unknown, b: unknown) => call("dirTo", [a, b]),
    step: (p: unknown, d: unknown) => call("step", [p, d]),
    isPassable: (x: unknown, y: unknown, o?: unknown) => call("isPassable", [x, y, o]),
    hasLOS: (a: unknown, b: unknown) => call("hasLOS", [a, b]),
    pathFind: (a: unknown, b: unknown, o?: unknown) => call("pathFind", [a, b, o]),
    neighbors: (x: unknown, y: unknown) => call("neighbors", [x, y]),
    isWall: (x: unknown, y: unknown) => call("isWall", [x, y]),
    isWater: (x: unknown, y: unknown) => call("isWater", [x, y]),
    isForest: (x: unknown, y: unknown) => call("isForest", [x, y]),
    isAmmo: (x: unknown, y: unknown) => call("isAmmo", [x, y]),
    isFuel: (x: unknown, y: unknown) => call("isFuel", [x, y]),
    isResource: (x: unknown, y: unknown) => call("isResource", [x, y]),
    isDeposit: (x: unknown, y: unknown) => call("isDeposit", [x, y]),
    isSpawn: (x: unknown, y: unknown) => call("isSpawn", [x, y]),
    random: () => call("random", []),
    randomInt: (min: unknown, max: unknown) => call("randomInt", [min, max]),
    log: (...args: unknown[]) => {
      if (logs.length >= 20) return null;
      const msg = args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
      logs.push(msg.slice(0, 200));
      return null;
    },
  };
  return Object.freeze(facade);
}