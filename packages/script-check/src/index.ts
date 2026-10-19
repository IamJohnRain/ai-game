// packages/script-check/src/index.ts —— 脚本准入流水线（协议 §5）
// L0 提取 → L1 静态扫描 → L2 编译/加载/onInit → L3 模糊测试 + 真实短对局冒烟
import { createHash } from "node:crypto";
import { ActionSchema, type GameMap, type Ruleset } from "@ai-game/protocol";
import {
  createHostApi, deriveSeed, mulberry32, PathFinder, buildTerrain, assignSpawns, runMatch,
  type TurnController,
} from "@ai-game/engine";
import { QuickJsController, type SandboxOptions } from "@ai-game/sandbox";
import { extractScript, type ExtractResult } from "@ai-game/script-extract";
import { staticScan, type StaticScanResult } from "./static-scan.ts";
import { generateFuzzStates } from "./fuzz.ts";

export * from "./static-scan.ts";
export * from "./fuzz.ts";

export type CheckStatus =
  | "OK" | "EXTRACT_FAILED" | "STATIC_REJECT" | "COMPILE_ERROR" | "INIT_ERROR" | "SMOKE_FAILED";

export interface CheckStage {
  stage: "extract" | "static" | "compile" | "fuzz" | "smoke";
  ok: boolean;
  detail?: string;
}

export interface CheckInput {
  /** 模型回复原文（与 script 二选一，优先使用 script） */
  response?: string;
  script?: string;
  map: GameMap;
  rules: Ruleset;
  maxLines?: number;
  /** 模糊测试样本数 */
  fuzzCount?: number;
  /** 冒烟对局回合数 */
  smokeRounds?: number;
  /** 冒烟对局的对手脚本（默认用一个"只等待"的无害脚本；外部上传场景建议传入基线脚本，交互更真实） */
  smokeOpponentScript?: string;
  sandbox?: SandboxOptions;
}

export interface CheckResult {
  ok: boolean;
  status: CheckStatus;
  script: string | null;
  scriptSha256: string | null;
  extraction: ExtractResult | null;
  staticScan: StaticScanResult | null;
  stages: CheckStage[];
  meta: unknown;
  avgDecisionMs: number;
  maxDecisionMs: number;
  smoke: { turns: number; strikes: number; moves: number; deposits: number; score: number } | null;
  fuzzFailures: { index: number; error: string }[];
}

/** 冒烟对局里给对手用的无害脚本（不做任何事，只保证比赛能跑） */
const PASSIVE_SCRIPT = `function onInit() {}
function onTurn() { return [{ type: "wait" }]; }`;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function checkScript(input: CheckInput): Promise<CheckResult> {
  const stages: CheckStage[] = [];
  const finish = (status: CheckStatus, partial: Partial<CheckResult> = {}): CheckResult => ({
    ok: status === "OK",
    status,
    script: null,
    scriptSha256: null,
    extraction: null,
    staticScan: null,
    stages,
    meta: null,
    avgDecisionMs: 0,
    maxDecisionMs: 0,
    smoke: null,
    fuzzFailures: [],
    ...partial,
  });

  // ---------- L0 提取 ----------
  let script = input.script ?? null;
  let extraction: ExtractResult | null = null;
  if (script === null) {
    extraction = extractScript(input.response ?? "");
    if (!extraction.code) {
      stages.push({ stage: "extract", ok: false, detail: extraction.error });
      return finish("EXTRACT_FAILED", { extraction });
    }
    script = extraction.code;
    stages.push({
      stage: "extract",
      ok: true,
      detail: `method=${extraction.method}, blocks=${extraction.blockCount}, ${script.split(/\r?\n/).length} 行`,
    });
  } else {
    stages.push({ stage: "extract", ok: true, detail: "直接提供了脚本，跳过提取" });
  }
  const scriptSha = sha256(script);

  // ---------- L1 静态扫描 ----------
  const scan = staticScan(script, { maxLines: input.maxLines });
  if (!scan.ok) {
    stages.push({
      stage: "static",
      ok: false,
      detail: scan.issues.map((i) => `${i.rule}@行${i.line}: ${i.snippet}`).join(" | "),
    });
    return finish("STATIC_REJECT", { extraction, script, scriptSha256: scriptSha, staticScan: scan });
  }
  stages.push({ stage: "static", ok: true, detail: `${scan.lines} 行；onTurn=${scan.hasOnTurn}；onInit=${scan.hasOnInit}` });

  // ---------- L2 编译 / 加载 / onInit ----------
  const terrain = buildTerrain(input.map);
  const pathFinder = new PathFinder(terrain);
  const ctrl = await QuickJsController.create(input.sandbox ?? {});
  try {
    try {
      ctrl.load(1, script);
      const api = createHostApi({
        map: input.map, rules: input.rules, terrain, pathFinder, seat: 1,
        occupied: () => [], rng: mulberry32(deriveSeed(1, "check")), onLog: () => {},
      });
      ctrl.init(1, {
        apiVersion: "1.0", rulesetVersion: input.rules.version, mapVersion: `${input.map.mapId}@${input.map.version}`,
        matchId: "check", seat: 1, playerName: "candidate", seed: 1,
        mySpawn: { ...input.map.spawns[0]! }, playerCount: 4,
      }, api, { MAP: input.map, RULES: input.rules });
      stages.push({ stage: "compile", ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isSyntax = /SyntaxError|unexpected token|unexpected end|invalid|not a function|未定义 onTurn/i.test(message);
      stages.push({ stage: "compile", ok: false, detail: message });
      return finish(isSyntax ? "COMPILE_ERROR" : "INIT_ERROR", {
        extraction, script, scriptSha256: scriptSha, staticScan: scan,
        meta: ctrl.metaOf(1),
      });
    }

    // ---------- L3a 模糊测试 ----------
    const fuzzStates = generateFuzzStates(input.map, input.rules, input.fuzzCount ?? 200);
    const fuzzFailures: { index: number; error: string }[] = [];
    let totalMs = 0;
    let maxMs = 0;
    for (let i = 0; i < fuzzStates.length; i++) {
      const t0 = performance.now();
      const out = ctrl.onTurn(1, fuzzStates[i]!);
      const ms = performance.now() - t0;
      totalMs += ms;
      if (ms > maxMs) maxMs = ms;
      if (out.kind) {
        fuzzFailures.push({ index: i, error: `${out.kind}: ${out.error ?? ""}` });
        if (fuzzFailures.length >= 5) break;
      } else if (out.actions) {
        for (const a of out.actions) {
          if (!ActionSchema.safeParse(a).success) {
            fuzzFailures.push({ index: i, error: `返回了非法动作结构: ${JSON.stringify(a)?.slice(0, 120)}` });
            break;
          }
        }
        if (fuzzFailures.length >= 5) break;
      }
    }
    const avgMs = fuzzStates.length > 0 ? totalMs / fuzzStates.length : 0;
    if (fuzzFailures.length > 0) {
      stages.push({ stage: "fuzz", ok: false, detail: fuzzFailures.map((f) => `#${f.index} ${f.error}`).join(" | ") });
      return finish("SMOKE_FAILED", {
        extraction, script, scriptSha256: scriptSha, staticScan: scan, meta: ctrl.metaOf(1),
        avgDecisionMs: round3(avgMs), maxDecisionMs: round3(maxMs), fuzzFailures,
      });
    }
    stages.push({
      stage: "fuzz", ok: true,
      detail: `${fuzzStates.length} 个极端状态全部通过；平均决策 ${round3(avgMs)}ms，最慢 ${round3(maxMs)}ms`,
    });

    // ---------- L3b 真实短对局冒烟 ----------
    const seats = [1, 2];
    const smokeCtrl = await QuickJsController.create(input.sandbox ?? {});
    smokeCtrl.load(1, script);
    smokeCtrl.load(2, input.smokeOpponentScript ?? PASSIVE_SCRIPT);
    const smokeRounds = input.smokeRounds ?? 40;
    const res = runMatch({
      matchId: "smoke",
      map: input.map,
      rules: { ...input.rules, maxRounds: smokeRounds },
      seed: 424242,
      seats: seats.map((seat) => ({ seat, name: `P${seat}`, scriptHash: seat === 1 ? scriptSha.slice(0, 12) : "passive" })),
      spawns: assignSpawns(input.map, seats, 424242),
      controller: smokeCtrl as TurnController,
    });
    smokeCtrl.dispose();
    const stats = res.stats[1]!;
    const smokeSummary = {
      turns: stats.turnsTaken,
      strikes: stats.strikes,
      moves: stats.moves,
      deposits: stats.deposits,
      score: stats.score,
    };
    if (stats.strikes > 0) {
      const strikeEvents = res.events.filter((e) => e.t === "strike" && (e as { seat: number }).seat === 1);
      stages.push({
        stage: "smoke", ok: false,
        detail: `真实对局中出现 ${stats.strikes} 次异常/超时：` + JSON.stringify(strikeEvents.slice(0, 2)),
      });
      return finish("SMOKE_FAILED", {
        extraction, script, scriptSha256: scriptSha, staticScan: scan, meta: ctrl.metaOf(1),
        avgDecisionMs: round3(avgMs), maxDecisionMs: round3(maxMs), fuzzFailures, smoke: smokeSummary,
      });
    }
    stages.push({
      stage: "smoke", ok: true,
      detail: `对局 ${stats.turnsTaken} 回合：移动 ${stats.moves} 步、提交 ${stats.deposits} 次、得分 ${stats.score}，无异常`,
    });

    return finish("OK", {
      extraction, script, scriptSha256: scriptSha, staticScan: scan, meta: ctrl.metaOf(1),
      avgDecisionMs: round3(avgMs), maxDecisionMs: round3(maxMs), fuzzFailures, smoke: smokeSummary,
    });
  } finally {
    ctrl.dispose();
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}