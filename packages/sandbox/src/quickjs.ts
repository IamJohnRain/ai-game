// packages/sandbox/src/quickjs.ts —— QuickJS(WASM) 隔离沙箱控制器
// 每个座位一个独立的 QuickJS Context，整场比赛复用（模块级变量即脚本的"记忆"）。
// 宿主桥只有一个函数 __hostApi；CPU 用 interrupt 精确中断；内存有硬上限。
// 调用脚本的方式：把 JSON 放进全局 __arg，再用 evalCode 调 __strategy.onTurn(JSON.parse(__arg))，
// 这样宿主与沙箱之间只流动 JSON 字符串，不传任何宿主对象。
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { Action, Ctx, State } from "@ai-game/protocol";
import type { ControllerTurnResult, HostApi, ScriptGlobals, TurnController } from "@ai-game/engine";
import { buildBootstrap, STRATEGY_ENTRY } from "./bootstrap.ts";

// QuickJS 类型从模块推断，避免依赖具体导出名
type QuickJSVm = Awaited<ReturnType<typeof getQuickJS>>;
type QuickJSContext = ReturnType<QuickJSVm["newContext"]>;
type QuickJSRuntime = ReturnType<QuickJSVm["newRuntime"]>;
type QuickJSHandle = Parameters<QuickJSContext["setProp"]>[2];

export interface SandboxOptions {
  /** onTurn 的 CPU 预算（毫秒） */
  cpuMs?: number;
  /** onInit 的 CPU 预算（毫秒） */
  initCpuMs?: number;
  /** onInit 期间的内存上限（MB） */
  initMemoryMB?: number;
  /** onTurn 期间的内存上限（MB） */
  memoryMB?: number;
  /** 单回合日志条数上限 */
  maxLogsPerTurn?: number;
}

const DEFAULTS: Required<SandboxOptions> = {
  cpuMs: 50,
  initCpuMs: 1000,
  initMemoryMB: 256,
  memoryMB: 64,
  maxLogsPerTurn: 20,
};

interface SeatInstance {
  vm: QuickJSContext;
  runtime: QuickJSRuntime;
  hasOnInit: boolean;
  poisoned: boolean;
  logs: string[];
  calls: number;
  totalMs: number;
  meta: unknown;
}

export class QuickJsController implements TurnController {
  private instances = new Map<number, SeatInstance>();
  private scripts = new Map<number, string>();
  private opts: Required<SandboxOptions>;
  private vmModule: QuickJSVm | null = null;

  private constructor(opts: Required<SandboxOptions>) { this.opts = opts; }

  /** 必须先 await 创建（加载 WASM 模块） */
  static async create(opts: SandboxOptions = {}): Promise<QuickJsController> {
    const ctrl = new QuickJsController({ ...DEFAULTS, ...opts });
    ctrl.vmModule = await getQuickJS();
    return ctrl;
  }

  load(seat: number, scriptText: string): void {
    this.scripts.set(seat, scriptText);
  }

  scriptText(seat: number): string | undefined { return this.scripts.get(seat); }

  init(seat: number, ctx: Ctx, api: HostApi, globals: ScriptGlobals): void {
    const text = this.scripts.get(seat);
    if (text === undefined) throw new Error(`座位 ${seat} 未加载脚本`);
    if (!this.vmModule) throw new Error("QuickJS 模块未初始化（请使用 QuickJsController.create）");

    const runtime = this.vmModule.newRuntime();
    runtime.setMemoryLimit(this.opts.initMemoryMB * 1024 * 1024);
    runtime.setMaxStackSize(1024 * 1024);
    const vm = runtime.newContext();
    const inst: SeatInstance = {
      vm, runtime, hasOnInit: false, poisoned: false,
      logs: [], calls: 0, totalMs: 0, meta: null,
    };
    this.instances.set(seat, inst);

    // 唯一宿主桥：日志在沙箱侧拦截（配额/长度），其余转发给宿主 API
    const hostFn = vm.newFunction("__hostApi", (nameH: QuickJSHandle, argsH: QuickJSHandle) => {
      const name = vm.getString(nameH);
      const argsJson = vm.getString(argsH);
      try {
        if (name === "log") {
          if (inst.logs.length < this.opts.maxLogsPerTurn) {
            const args = JSON.parse(argsJson || "[]") as unknown[];
            inst.logs.push(args.map((v) => (typeof v === "string" ? v : safeJson(v))).join(" ").slice(0, 200));
          }
          return vm.newString(JSON.stringify({ value: null }));
        }
        const args = argsJson ? (JSON.parse(argsJson) as unknown[]) : [];
        const value = api.call(name, args);
        return vm.newString(JSON.stringify({ value: value === undefined ? null : value }));
      } catch (err) {
        return vm.newString(JSON.stringify({ __error: err instanceof Error ? err.message : String(err) }));
      }
    });
    vm.setProp(vm.global, "__hostApi", hostFn);
    hostFn.dispose();

    // 1) 注入世界 + 脚本 + 入口收集
    const bootstrap = buildBootstrap(JSON.stringify(globals.MAP), JSON.stringify(globals.RULES));
    this.evalCode(inst, `${bootstrap}\n${text}\n${STRATEGY_ENTRY}`, "<strategy>", this.opts.initCpuMs);
    // 2) 检查 onTurn 是否存在（缺失即视为无效脚本）
    const kind = this.evalCode(inst, `typeof __strategy.onTurn === "function" ? "fn" : "missing"`, "<check>", this.opts.initCpuMs);
    if (kind !== "fn") throw new Error("脚本未定义 onTurn 函数");
    const hasInit = this.evalCode(inst, `typeof __strategy.onInit === "function" ? "fn" : "missing"`, "<check>", this.opts.initCpuMs);
    inst.hasOnInit = hasInit === "fn";
    try {
      const metaJson = this.evalCode(inst, `JSON.stringify(__strategy.meta === undefined ? null : __strategy.meta)`, "<meta>", this.opts.initCpuMs);
      inst.meta = metaJson ? JSON.parse(metaJson) : null;
    } catch { inst.meta = null; }

    // 3) onInit
    if (inst.hasOnInit) {
      const out = this.callWithJson(inst, `__strategy.onInit(JSON.parse(__arg))`, JSON.stringify(ctx), this.opts.initCpuMs);
      if (out.error) throw new Error(`onInit 执行失败: ${out.error}`);
    }
    // 4) onTurn 阶段收紧内存
    runtime.setMemoryLimit(this.opts.memoryMB * 1024 * 1024);
  }

  onTurn(seat: number, state: State): ControllerTurnResult {
    const inst = this.instances.get(seat);
    if (!inst) return { actions: null, kind: "exception", error: "沙箱实例不存在" };
    if (inst.poisoned) return { actions: null, kind: "timeout", error: "沙箱在此前超时/内存溢出后已停用" };
    inst.logs = [];
    const started = performance.now();
    const out = this.callWithJson(inst, `JSON.stringify(__strategy.onTurn(JSON.parse(__arg)))`, JSON.stringify(state), this.opts.cpuMs);
    inst.calls += 1;
    inst.totalMs += performance.now() - started;
    const logs = inst.logs.slice();

    if (out.timedOut) {
      inst.poisoned = true;
      return { actions: null, kind: "timeout", error: `onTurn 超过 ${this.opts.cpuMs}ms 预算`, logs };
    }
    if (out.error) return { actions: null, kind: "exception", error: out.error, logs };
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.text ?? "null");
    } catch {
      return { actions: null, kind: "bad_return", error: "返回值无法序列化（请返回动作数组）", logs };
    }
    if (!Array.isArray(parsed)) {
      return { actions: null, kind: "bad_return", error: `onTurn 返回了 ${typeof parsed}，应为数组`, logs };
    }
    return { actions: parsed as Action[], logs };
  }

  stats(seat: number): { calls: number; totalMs: number } {
    const inst = this.instances.get(seat);
    return { calls: inst?.calls ?? 0, totalMs: Math.round(inst?.totalMs ?? 0) };
  }

  metaOf(seat: number): unknown { return this.instances.get(seat)?.meta ?? null; }

  dispose(): void {
    for (const inst of this.instances.values()) {
      try { inst.vm.dispose(); } catch { /* ignore */ }
      try { inst.runtime.dispose(); } catch { /* ignore */ }
    }
    this.instances.clear();
    this.scripts.clear();
  }

  // ---------- 内部 ----------
  /** 执行一段代码并取回字符串结果（出错抛异常） */
  private evalCode(inst: SeatInstance, code: string, filename: string, cpuMs: number): string | null {
    inst.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + cpuMs));
    try {
      const res = inst.vm.evalCode(code, filename);
      if (res.error) {
        const dumped = inst.vm.dump(res.error);
        res.error.dispose();
        throw new Error(dumpMessage(dumped));
      }
      const value = inst.vm.dump(res.value);
      res.value.dispose();
      return value === undefined || value === null ? null : String(value);
    } finally {
      inst.runtime.removeInterruptHandler();
    }
  }

  /** 把 JSON 放进全局 __arg，再执行表达式并取回字符串结果 */
  private callWithJson(
    inst: SeatInstance, expr: string, json: string, cpuMs: number,
  ): { text?: string; error?: string; timedOut?: boolean } {
    const arg = inst.vm.newString(json);
    inst.vm.setProp(inst.vm.global, "__arg", arg);
    arg.dispose();
    inst.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + cpuMs));
    try {
      const res = inst.vm.evalCode(expr, "<call>");
      if (res.error) {
        const dumped = inst.vm.dump(res.error);
        res.error.dispose();
        const message = dumpMessage(dumped);
        return { error: message, timedOut: /interrupted|out of memory/i.test(message) };
      }
      const value = inst.vm.dump(res.value);
      res.value.dispose();
      return { text: value === undefined || value === null ? "null" : String(value) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg, timedOut: /interrupt/i.test(msg) };
    } finally {
      inst.runtime.removeInterruptHandler();
    }
  }
}

function dumpMessage(dumped: unknown): string {
  if (typeof dumped === "string") return dumped;
  if (dumped && typeof dumped === "object") {
    const obj = dumped as { message?: unknown; name?: unknown; stack?: unknown };
    if (obj.message !== undefined) return `${obj.name ?? "Error"}: ${String(obj.message)}`.slice(0, 500);
  }
  return safeJson(dumped).slice(0, 500);
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}