// apps/server/src/cohorts.ts —— 评测批次运行器（docs/08 §1/§2）
//
// 一次"批次"= 一组参赛者 + 一份 leg 计划 + 一份冻结的参赛版本快照；每条 leg = 一场现有语义的 1v1 循环赛。
// 三条不变式（实现时要一直守住）：
//   ① 快照冻结：批次开始时解析出每个 Agent 用哪个版本（scripts 传给 TournamentRunner），中途重新上传不影响本批次；
//   ② leg 独立：任何一条 leg 失败（图被删、Agent 被删）只标记该 leg，其余继续；
//   ③ 确定性：legSeed = deriveSeed(masterSeed, "cohort-leg:"+index)，同 masterSeed 可完整复现整批。
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveSeed } from "@ai-game/engine";
import {
  DEFAULT_MAP_1V1, DEFAULT_MAP_MULTI, resolveRulesVariant, type Ruleset,
} from "@ai-game/protocol";
import { SCRIPT_PROTOCOL_VERSION } from "@ai-game/prompt";
import { rateGames, type RatingGame, type RatingParticipant } from "@ai-game/orchestrator";
import type { MapRegistry } from "./maps.ts";
import type { CohortRow, CohortStatus, Store } from "./store.ts";
import { TournamentRunner } from "./tournaments.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const BASELINE_SCRIPT_PATH = join(repoRoot, "docs", "examples", "baseline-strategy.js");

/** 标尺对手：入库时 modelId 固定为 calibration，榜上单列，不当成参赛模型 */
export const CAL_IDLE = "cal-idle";
export const CAL_BASELINE = "cal-baseline";
const IDLE_SCRIPT = `function onInit() {}\nfunction onTurn() { return [{ type: "wait" }]; }\n`;

/** 考察图（docs/08 §5.1）：装到注册表里就自动进准入与图池；没装则默认计划自动跳过 */
export const EVAL_MAP_IDS = ["eval-tight-9", "eval-sprint-64", "eval-maze-33", "eval-camp-15", "eval-fortress-24"];

export interface CohortLegPlan {
  name: string;
  mapId: string;
  maxRounds: number;
  rulesVariant: string;
  /** 这份 leg 要跑几个种子（同一个 (图,回合,变体) 用不同种子重复）——它才是"样本量"的来源 */
  seeds?: number;
}

export interface LaunchCohortInput {
  agentIds: string[];
  name?: string;
  masterSeed?: number;
  gamesPerPair?: number;
  legs?: CohortLegPlan[];
  includeCalibration?: boolean;
  /** 版本解析策略：latest（默认）| best（标尺分最高）| pinned（显式指定 revisions） */
  revisionPolicy?: "latest" | "best" | "pinned";
  revisions?: Record<string, number>;
}

export const MAX_LEGS = 64;

/** 默认 leg 计划：按注册表里实际存在的地图拼装（考察图没装就自动少几条） */
export function defaultCohortLegs(registry: MapRegistry): CohortLegPlan[] {
  const has = (id: string) => Boolean(registry.get(id));
  const primary = has(DEFAULT_MAP_1V1) ? DEFAULT_MAP_1V1 : registry.ids()[0]!;
  const big = has(DEFAULT_MAP_MULTI) ? DEFAULT_MAP_MULTI : primary;
  const legs: CohortLegPlan[] = [
    { name: "主赛 150", mapId: primary, maxRounds: 150, rulesVariant: "default", seeds: 3 },
    { name: "短局 60", mapId: primary, maxRounds: 60, rulesVariant: "default", seeds: 2 },
    { name: "长局 300", mapId: big, maxRounds: 300, rulesVariant: "default", seeds: 2 },
    { name: "侦察压制", mapId: primary, maxRounds: 150, rulesVariant: "scout", seeds: 2 },
    { name: "物流压力", mapId: big, maxRounds: 150, rulesVariant: "logistics", seeds: 2 },
  ];
  for (const id of EVAL_MAP_IDS) {
    if (has(id)) legs.push({ name: `考察图 ${id}`, mapId: id, maxRounds: 150, rulesVariant: "default", seeds: 2 });
  }
  return legs;
}

/** 把 plan 展开成"一条条要跑的 leg"（同一份 leg 的多个种子 = 多条 leg，序号即结果归属） */
export function expandLegs(legs: CohortLegPlan[]): { index: number; plan: CohortLegPlan }[] {
  const out: { index: number; plan: CohortLegPlan }[] = [];
  for (const plan of legs) {
    const count = Math.max(1, plan.seeds ?? 1);
    for (let i = 0; i < count; i++) {
      out.push({
        index: out.length,
        plan: count > 1 ? { ...plan, name: `${plan.name}#${i + 1}` } : plan,
      });
    }
  }
  return out;
}

export interface CohortRunnerDeps {
  store: Store;
  registry: MapRegistry;
  /** 每条 leg 都是一个 TournamentRunner；登记进来让赛事页/观战页照样能看到实时进度 */
  tournamentRunners: Map<string, TournamentRunner>;
}

export class CohortRunner extends EventEmitter {
  status: CohortStatus = "pending";
  legs: { index: number; tournamentId: string; name: string; mapId: string; maxRounds: number; rulesVariant: string; status: string; error?: string }[] = [];
  currentLeg = 0;
  totalLegs = 0;
  error?: string;
  private stopRequested = false;
  private readonly expanded: { index: number; plan: CohortLegPlan }[];
  private readonly scripts: Record<string, { script: string; scriptHash: string; revision?: number }>;
  private readonly calibrators: { id: string; agentName: string; modelName: string; script: string }[];
  private readonly participants: RatingParticipant[];

  constructor(
    private deps: CohortRunnerDeps,
    private cohort: CohortRow,
    private input: LaunchCohortInput,
    prepared: {
      expanded: { index: number; plan: CohortLegPlan }[];
      scripts: Record<string, { script: string; scriptHash: string; revision?: number }>;
      calibrators: { id: string; agentName: string; modelName: string; script: string }[];
    },
  ) {
    super();
    this.expanded = prepared.expanded;
    this.scripts = prepared.scripts;
    this.calibrators = prepared.calibrators;
    this.totalLegs = prepared.expanded.length;
    // 参赛者名单直接来自快照（它里面已经包含标尺对手）——不要再拼一次 calibrators，否则标尺会被重复计入评级池
    this.participants = cohort.snapshot.map((s) => ({
      id: s.agentId, agentName: s.agentName, modelName: s.modelName,
      ...(s.calibration ? { calibration: true } : {}),
    }));
  }

  stop(): void {
    this.stopRequested = true;
  }

  async start(): Promise<void> {
    const { store } = this.deps;
    store.updateCohort(this.cohort.id, { status: "running" });
    this.status = "running";
    this.emit("progress", { phase: "running", leg: 0, totalLegs: this.totalLegs });

    for (const leg of this.expanded) {
      if (this.stopRequested) break;
      const variant = resolveRulesVariant(leg.plan.rulesVariant);
      if (!variant) {
        this.legs.push({ ...legBase(leg), tournamentId: "", status: "failed", error: `未知规则变体 ${leg.plan.rulesVariant}` });
        continue;
      }
      const map = this.deps.registry.get(leg.plan.mapId);
      if (!map) {
        this.legs.push({ ...legBase(leg), tournamentId: "", status: "failed", error: `地图 ${leg.plan.mapId} 不在注册表里` });
        continue;
      }
      const legSeed = deriveSeed(this.cohort.masterSeed, `cohort-leg:${leg.index}`);
      const tournamentId = `${this.cohort.id}-leg${String(leg.index).padStart(2, "0")}`;
      const rules: Ruleset = leg.plan.maxRounds === variant.maxRounds ? variant : { ...variant, maxRounds: leg.plan.maxRounds };
      store.createTournament({
        id: tournamentId,
        name: `${this.cohort.name} · ${leg.plan.name}`,
        seed: legSeed,
        gamesPerPair: this.input.gamesPerPair ?? 2,
        mapId: leg.plan.mapId,
        rulesetVersion: rules.version,
        scriptProtocolVersion: SCRIPT_PROTOCOL_VERSION,
        agentIds: this.cohort.agentIds,
        cohortId: this.cohort.id,
        legIndex: leg.index,
        leg: { name: leg.plan.name, mapId: leg.plan.mapId, maxRounds: leg.plan.maxRounds, rulesVariant: leg.plan.rulesVariant },
      });
      const runner = new TournamentRunner({ store, registry: this.deps.registry }, {
        tournamentId,
        agentIds: this.cohort.agentIds,
        gamesPerPair: this.input.gamesPerPair ?? 2,
        seed: legSeed,
        mapId: leg.plan.mapId,
        rules,
        scriptProtocolVersion: SCRIPT_PROTOCOL_VERSION,
        scripts: this.scripts,
        ...(this.calibrators.length > 0 ? { calibrators: this.calibrators } : {}),
      });
      this.deps.tournamentRunners.set(tournamentId, runner);
      this.currentLeg = leg.index + 1;
      this.emit("progress", { phase: "leg_start", leg: this.currentLeg, totalLegs: this.totalLegs, tournamentId });
      await runner.start();
      const failed = runner.status === "failed";
      this.legs.push({
        ...legBase(leg), tournamentId, status: failed ? "failed" : "finished",
        ...(failed && runner.error ? { error: runner.error } : {}),
      });
      this.emit("progress", { phase: "leg_finished", leg: this.currentLeg, totalLegs: this.totalLegs, tournamentId, ok: !failed });
      // 赛事 runner 保留一段时间供前端看；批次只保留引用，避免长期占内存
      const timer = setTimeout(() => this.deps.tournamentRunners.delete(tournamentId), 60 * 60 * 1000);
      timer.unref();
    }

    try {
      this.aggregate();
      const failedLegs = this.legs.filter((l) => l.status === "failed");
      const status: CohortStatus = this.stopRequested
        ? "stopped"
        : failedLegs.length === 0 ? "finished"
          : failedLegs.length === this.legs.length ? "failed" : "finished_with_errors";
      this.status = status;
      store.updateCohort(this.cohort.id, {
        status,
        finishedAt: new Date().toISOString(),
        ...(failedLegs.length > 0 ? { error: `${failedLegs.length} 条 leg 失败：${failedLegs.map((l) => `${l.name}(${l.error ?? "?"})`).join("；")}` } : {}),
      });
      this.emit("progress", { phase: "finished", status });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      store.updateCohort(this.cohort.id, { status: "failed", error: this.error, finishedAt: new Date().toISOString() });
      this.emit("progress", { phase: "failed", error: this.error });
    }
  }

  /** 汇总：评级（±CI）+ 胜负矩阵 + 过程分画像 */
  private aggregate(): void {
    const { store } = this.deps;
    const matchRows = store.cohortMatchRows(this.cohort.id).filter((m) => m.status === "finished" && m.seats.length === 2);
    const games: RatingGame[] = [];
    for (const m of matchRows) {
      const a = m.seats[0]!;
      const b = m.seats[1]!;
      if (!a.agentId || !b.agentId) continue;
      games.push({
        aId: a.agentId, bId: b.agentId,
        winnerId: a.score === b.score ? null : (a.score > b.score ? a.agentId : b.agentId),
        aScore: a.score, bScore: b.score, legIndex: m.legIndex,
      });
    }
    const rated = rateGames({
      participants: this.participants,
      games,
      seed: deriveSeed(this.cohort.masterSeed, "rating"),
    });
    const metrics = this.buildMetrics(matchRows, games);
    store.updateCohort(this.cohort.id, { ratings: rated, matrix: rated.matrix, metrics });
  }

  /** 过程分：全部按每回合/每单位归一（docs/08 §4.1），并给出"适应力"（跨 leg 离散度） */
  private buildMetrics(matchRows: ReturnType<Store["cohortMatchRows"]>, games: RatingGame[]): unknown {
    type Acc = {
      agentId: string; agentName: string; modelId: string; calibration: boolean;
      matches: number; turns: number; invalid: number; moves: number; emergency: number;
      units: number; deposits: number; kills: number; deaths: number; strikes: number; dq: number;
      decisionMsSum: number; maxDecisionMs: number; ammoSpend: number; fuelSpend: number; depositScore: number; killScore: number;
      endgameUnits: number; totalUnits: number;
      byLeg: Map<number, { scoreSum: number; games: number }>;
    };
    const acc = new Map<string, Acc>();
    const nameOf = new Map(this.participants.map((p) => [p.id, p.agentName]));
    const ensure = (id: string, name: string, modelId: string): Acc => {
      let a = acc.get(id);
      if (!a) {
        a = {
          agentId: id, agentName: name, modelId, calibration: id.startsWith("cal-"),
          matches: 0, turns: 0, invalid: 0, moves: 0, emergency: 0, units: 0, deposits: 0,
          kills: 0, deaths: 0, strikes: 0, dq: 0, decisionMsSum: 0, maxDecisionMs: 0,
          ammoSpend: 0, fuelSpend: 0, depositScore: 0, killScore: 0,
          endgameUnits: 0, totalUnits: 0, byLeg: new Map(),
        };
        acc.set(id, a);
      }
      return a;
    };
    for (const p of this.participants) ensure(p.id, p.agentName, p.modelName);

    for (const m of matchRows) {
      // 终局利用率：最后 20% 回合内提交的单位占比（读事件流；读失败就跳过，不让它拖死聚合）。
      // 引擎的 deposit 事件不带 round，所以用 turn_begin 事件里的 round 跟踪"当前是第几回合"。
      const maxRoundsOfLeg = this.expanded[m.legIndex]?.plan.maxRounds ?? 150;
      const endgameFrom = Math.max(1, Math.floor(maxRoundsOfLeg * 0.8));
      const endgameUnits = new Map<number, { last: number; total: number }>();
      try {
        const replay = this.deps.store.getReplay(m.matchId);
        if (replay) {
          let currentRound = 0;
          for (const ev of replay.events) {
            if (ev.t === "turn_begin") { currentRound = ev.round; continue; }
            if (ev.t !== "deposit") continue;
            const rec = endgameUnits.get(ev.seat) ?? { last: 0, total: 0 };
            rec.total += ev.units;
            if (currentRound >= endgameFrom) rec.last += ev.units;
            endgameUnits.set(ev.seat, rec);
          }
        }
      } catch { /* 回放读不到就不算这一项 */ }

      for (const seat of m.seats) {
        if (!seat.agentId) continue;
        const a = ensure(seat.agentId, nameOf.get(seat.agentId) ?? seat.agentId, seat.modelId);
        const st = (seat.stats ?? {}) as Record<string, number | undefined>;
        const breakdown = (st["scoreBreakdown"] ?? {}) as Record<string, number | undefined>;
        a.matches += 1;
        a.turns += st["turnsTaken"] ?? 0;
        a.invalid += st["invalidActions"] ?? 0;
        a.moves += st["moves"] ?? 0;
        a.emergency += st["emergencyMoves"] ?? 0;
        a.units += st["unitsDeposited"] ?? 0;
        a.deposits += st["deposits"] ?? 0;
        a.kills += st["kills"] ?? 0;
        a.deaths += st["deaths"] ?? 0;
        a.strikes += st["strikes"] ?? 0;
        a.dq += st["disqualified"] ? 1 : 0;
        a.decisionMsSum += st["avgDecisionMs"] ?? 0;
        a.maxDecisionMs = Math.max(a.maxDecisionMs, st["maxDecisionMs"] ?? 0);
        a.ammoSpend += Math.abs(breakdown["ammo"] ?? 0);
        a.fuelSpend += Math.abs(breakdown["fuel"] ?? 0);
        a.depositScore += breakdown["deposit"] ?? 0;
        a.killScore += breakdown["kill"] ?? 0;
        a.totalUnits += st["unitsDeposited"] ?? 0;
        a.endgameUnits += endgameUnits.get(seat.seat)?.last ?? 0;
        const leg = a.byLeg.get(m.legIndex) ?? { scoreSum: 0, games: 0 };
        leg.scoreSum += seat.score;
        leg.games += 1;
        a.byLeg.set(m.legIndex, leg);
      }
    }

    const rows = [...acc.values()].map((a) => {
      const perLegAvg = [...a.byLeg.values()].map((l) => l.scoreSum / Math.max(1, l.games));
      const mean = perLegAvg.reduce((s, x) => s + x, 0) / Math.max(1, perLegAvg.length);
      const variance = perLegAvg.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, perLegAvg.length);
      const apTotal = Math.max(1, a.turns * 2); // apPerTurn = 2（ruleset 1.1）
      return {
        agentId: a.agentId, agentName: a.agentName, modelId: a.modelId, calibration: a.calibration,
        matches: a.matches,
        invalidRate: round(a.invalid / apTotal, 4),
        apUtilization: round(1 - a.invalid / apTotal, 4),
        emergencyRate: round(a.emergency / Math.max(1, a.moves), 4),
        unitsPer100: round((a.units * 100) / Math.max(1, a.turns), 2),
        endgameShare: round(a.endgameUnits / Math.max(1, a.totalUnits), 3),
        supplyShare: round((a.ammoSpend + a.fuelSpend) / Math.max(1, a.depositScore + a.killScore), 3),
        killDeathDiff: a.kills - a.deaths,
        strikes: a.strikes,
        disqualifiedRate: round(a.dq / Math.max(1, a.matches), 3),
        avgDecisionMs: round(a.decisionMsSum / Math.max(1, a.matches), 3),
        maxDecisionMs: round(a.maxDecisionMs, 3),
        // 适应力：各 leg 平均分的标准差（越小越"换个环境也稳"）
        adaptivity: round(Math.sqrt(variance), 2),
        avgScore: round(mean, 1),
      };
    }).sort((x, y) => y.unitsPer100 - x.unitsPer100);

    const byLeg = this.legs.map((l) => {
      const legGames = games.filter((g) => g.legIndex === l.index);
      return {
        index: l.index, name: l.name, mapId: l.mapId, maxRounds: l.maxRounds, rulesVariant: l.rulesVariant,
        status: l.status, games: legGames.length,
        ...(l.error ? { error: l.error } : {}),
        ...(l.tournamentId ? { tournamentId: l.tournamentId } : {}),
      };
    });
    return { rows, byLeg, games: games.length };
  }
}

function legBase(leg: { index: number; plan: CohortLegPlan }): { index: number; name: string; mapId: string; maxRounds: number; rulesVariant: string } {
  return {
    index: leg.index, name: leg.plan.name, mapId: leg.plan.mapId,
    maxRounds: leg.plan.maxRounds, rulesVariant: leg.plan.rulesVariant,
  };
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** 练习局里的"标尺分"：优先看对 baseline 的得分，没有就看对 idle 的 */
export function benchScoreOf(practice: unknown): number | null {
  const p = practice as { opponents?: { kind: string; myScore: number }[] } | null;
  if (!p?.opponents?.length) return null;
  const baseline = p.opponents.find((o) => o.kind === "baseline");
  const idle = p.opponents.find((o) => o.kind === "idle");
  const pick = baseline ?? idle;
  return pick ? pick.myScore : null;
}

/** 标尺脚本（idle/baseline）：练习通道与批次都用同一套，保证"标尺"口径一致 */
export function calibratorScripts(): { idle: string; baseline: string } {
  return { idle: IDLE_SCRIPT, baseline: readFileSync(BASELINE_SCRIPT_PATH, "utf8") };
}