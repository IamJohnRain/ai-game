// apps/server/src/routesCohorts.ts —— 评测批次接口（docs/08 §2.4）
//
// 与赛事接口的分工：`POST /api/tournaments` 是"打一场"（单 leg，组织者手动选图选回合数）；
// `POST /api/cohorts` 是"做一次评测"——多条 leg（多种子/多图/多规则变体）+ 标尺对手 + 评级与画像。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerConfig } from "./config.ts";
import {
  CAL_BASELINE, CAL_IDLE, MAX_LEGS, CohortRunner, benchScoreOf, calibratorScripts, defaultCohortLegs, expandLegs,
  type CohortLegPlan,
} from "./cohorts.ts";
import type { MapRegistry } from "./maps.ts";
import type { Store } from "./store.ts";
import type { TournamentRunner } from "./tournaments.ts";

export interface CohortRouteDeps {
  store: Store;
  config: ServerConfig;
  registry: MapRegistry;
  tournamentRunners: Map<string, TournamentRunner>;
  cohortRunners: Map<string, CohortRunner>;
}

const LegInput = z.object({
  name: z.string().max(60).optional(),
  mapId: z.string().min(1),
  maxRounds: z.number().int().min(10).max(1000),
  rulesVariant: z.string().min(1).default("default"),
  seeds: z.number().int().min(1).max(10).default(1),
});

const CohortInput = z.object({
  agentIds: z.array(z.string()).min(1).max(16),
  name: z.string().max(80).optional(),
  masterSeed: z.number().int().optional(),
  gamesPerPair: z.number().int().min(1).max(10).optional(),
  legs: z.array(LegInput).min(1).max(32).optional(),
  includeCalibration: z.boolean().optional(),
  revisionPolicy: z.enum(["latest", "best", "pinned"]).optional(),
  revisions: z.record(z.string(), z.number().int().min(1)).optional(),
});

/**
 * "best" 策略的实现：练习通道记录在**上传之前**，所以第 N 版的练习 = 上一次上传之后、这次上传之前的那些练习局；
 * 取窗口里最后一次练习的"标尺分"（对 baseline 的得分）作为该版的分数，选最高的一版。
 */
function pickBestRevision(store: Store, agentId: string): number | null {
  const revs = store.listAgentRevisions(agentId).slice().sort((a, b) => a.revision - b.revision);
  if (revs.length === 0) return null;
  const runs = store.listPracticeRuns(agentId, 200)
    .map((r) => ({ at: r.createdAt, bench: benchScoreOf(r.practice) }))
    .filter((r): r is { at: string; bench: number } => r.bench !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (runs.length === 0) return null;
  let best: { revision: number; bench: number } | null = null;
  for (let i = 0; i < revs.length; i++) {
    const from = i > 0 ? revs[i - 1]!.uploadedAt : "";
    const to = revs[i]!.uploadedAt;
    const inWindow = runs.filter((r) => r.at > from && r.at <= to);
    const bench = inWindow.length > 0 ? inWindow[inWindow.length - 1]!.bench : null;
    if (bench !== null && (best === null || bench > best.bench)) best = { revision: revs[i]!.revision, bench };
  }
  return best?.revision ?? null;
}

export function registerCohortRoutes(app: FastifyInstance, deps: CohortRouteDeps): void {
  const { store, registry, config } = deps;

  const launch = (body: z.infer<typeof CohortInput>): { ok: true; cohortId: string; legs: number; totalMatches: number; participants: number } | { ok: false; code: number; error: string } => {
    const agentIds = [...new Set(body.agentIds)];
    if (agentIds.length < 2) return { ok: false, code: 400, error: "去重后至少需要 2 个不同 Agent" };
    // 只统计"正在跑"的批次：跑完的 runner 会在 map 里留一段时间供前端看结果，不该继续占并发位
    const activeCohorts = [...deps.cohortRunners.values()].filter((r) => r.status === "pending" || r.status === "running").length;
    if (activeCohorts >= (Number(process.env.AI_GAME_MAX_CONCURRENT_COHORTS) || 1)) {
      return { ok: false, code: 429, error: "已有批次在跑（AI_GAME_MAX_CONCURRENT_COHORTS=1）：等它跑完再发起" };
    }

    const includeCalibrationEarly = body.includeCalibration ?? true;
    const participantCount = agentIds.length + (includeCalibrationEarly ? 2 : 0);
    const plan = body.legs ?? defaultCohortLegs(registry, participantCount);
    for (const leg of plan) {
      if (!registry.get(leg.mapId)) return { ok: false, code: 400, error: `未知地图 ${leg.mapId}（可用：${registry.ids().join(", ")}）` };
    }
    const expanded = expandLegs(plan as CohortLegPlan[]);
    if (expanded.length > MAX_LEGS) return { ok: false, code: 400, error: `leg 展开后有 ${expanded.length} 条，超过上限 ${MAX_LEGS}` };
    const pairs = (agentIds.length + (includeCalibrationEarly ? 2 : 0)) * (agentIds.length + (includeCalibrationEarly ? 2 : 0) - 1) / 2;
    const plannedMatches = pairs * (body.gamesPerPair ?? 2) * expanded.length;
    const maxMatches = Number(process.env.AI_GAME_MAX_COHORT_MATCHES ?? 1200);
    if (plannedMatches > maxMatches) {
      return {
        ok: false, code: 400,
        error: `这个计划要跑 ${plannedMatches} 局，超过单批上限 ${maxMatches}（AI_GAME_MAX_COHORT_MATCHES 可调）：减少 seeds / leg 数或每对局数`,
      };
    }

    // 快照：解析版本（latest / best / pinned）→ 冻结脚本，批次中途重新上传不影响本批次
    const policy = body.revisionPolicy ?? "latest";
    const snapshot: { agentId: string; agentName: string; modelName: string; revision: number; scriptSha256: string; resolvedBy: string }[] = [];
    const scripts: Record<string, { script: string; scriptHash: string; revision?: number }> = {};
    for (const id of agentIds) {
      const agent = store.getAgent(id);
      if (!agent) return { ok: false, code: 400, error: `Agent ${id} 不存在` };
      let revision = agent.revision > 0 ? agent.revision : 1;
      let resolvedBy = "latest";
      if (policy === "pinned" && body.revisions?.[id] !== undefined) {
        revision = body.revisions[id]!;
        resolvedBy = "pinned";
      } else if (policy === "best") {
        const best = pickBestRevision(store, id);
        if (best !== null) { revision = best; resolvedBy = "best"; } else resolvedBy = "latest-fallback";
      }
      const script = store.agentScriptAtRevision(id, revision);
      if (!script) return { ok: false, code: 409, error: `Agent ${agent.agentName} 没有第 ${revision} 版脚本（重新签发密钥后再提交一版）` };
      scripts[id] = { script: script.script, scriptHash: script.scriptSha256, revision };
      snapshot.push({
        agentId: id, agentName: agent.agentName, modelName: agent.modelName,
        revision, scriptSha256: script.scriptSha256, resolvedBy,
      });
    }

    const gamesPerPair = body.gamesPerPair ?? 2;
    const includeCalibration = body.includeCalibration ?? true;
    const calibrators = includeCalibration
      ? [
          { id: CAL_IDLE, agentName: "标尺·挂机", modelName: "calibration", script: calibratorScripts().idle },
          { id: CAL_BASELINE, agentName: "标尺·基线", modelName: "calibration", script: calibratorScripts().baseline },
        ]
      : [];

    const id = `c_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
    const name = body.name?.trim() || `评测批次 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const masterSeed = body.masterSeed ?? Math.floor(Math.random() * 2 ** 31);
    const planDoc = { gamesPerPair, legs: plan as CohortLegPlan[] };
    const cohort = store.createCohort({
      id, name, masterSeed, gamesPerPair, agentIds,
      plan: planDoc,
      snapshot: [
        ...snapshot,
        ...calibrators.map((c) => ({
          agentId: c.id, agentName: c.agentName, modelName: c.modelName,
          revision: 0, scriptSha256: `calibration:${c.id}`, calibration: true, resolvedBy: "calibration",
        })),
      ],
    });

    const runner = new CohortRunner({ store, registry, tournamentRunners: deps.tournamentRunners, masterKey: config.masterKey, logger: app.log }, cohort, {
      agentIds, name, masterSeed, gamesPerPair,
      legs: plan as CohortLegPlan[],
      includeCalibration,
      revisionPolicy: policy,
      ...(body.revisions ? { revisions: body.revisions } : {}),
    }, { expanded, scripts, calibrators });
    deps.cohortRunners.set(id, runner);
    void runner.start().finally(() => {
      const timer = setTimeout(() => deps.cohortRunners.delete(id), 6 * 60 * 60 * 1000);
      timer.unref();
    });

    return {
      ok: true, cohortId: id, legs: expanded.length,
      totalMatches: plannedMatches,
      participants: agentIds.length + calibrators.length,
    };
  };

  app.post("/api/cohorts", async (req, reply) => {
    const parsed = CohortInput.safeParse(req.body);
    if (!parsed.success) {
      return fail(reply, 400, `参数不合法：${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const result = launch(parsed.data);
    if (!result.ok) return fail(reply, result.code, result.error);
    return {
      cohortId: result.cohortId, legs: result.legs, totalMatches: result.totalMatches, participants: result.participants,
      detailUrl: `/api/cohorts/${result.cohortId}`,
    };
  });

  app.get("/api/cohorts", async () => {
    return {
      cohorts: store.listCohorts(50).map((c) => {
        const runner = deps.cohortRunners.get(c.id);
        return {
          id: c.id, name: c.name, status: c.status,
          agentCount: c.agentIds.length, legs: runner?.totalLegs ?? c.plan.legs.reduce((sum, l) => sum + Math.max(1, l.seeds ?? 1), 0),
          finishedLegs: runner ? runner.legs.filter((l) => l.status === "finished").length : undefined,
          gamesPerPair: c.gamesPerPair, createdAt: c.createdAt,
          ...(c.finishedAt ? { finishedAt: c.finishedAt } : {}),
          ...(c.error ? { error: c.error } : {}),
        };
      }),
    };
  });

  app.get("/api/cohorts/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cohort = store.getCohort(id);
    if (!cohort) return fail(reply, 404, "批次不存在");
    const runner = deps.cohortRunners.get(id);
    const legsFromRunner = runner?.legs ?? [];
    const legsFromDb = store.cohortLegs(id).map((t) => ({
      index: t.legIndex ?? 0,
      name: t.leg?.name ?? t.name,
      mapId: t.leg?.mapId ?? t.mapId,
      maxRounds: t.leg?.maxRounds ?? 0,
      rulesVariant: t.leg?.rulesVariant ?? "default",
      status: t.status,
      tournamentId: t.id,
    }));
    return {
      cohort: {
        id: cohort.id, name: cohort.name, status: cohort.status,
        masterSeed: cohort.masterSeed, gamesPerPair: cohort.gamesPerPair,
        agentCount: cohort.agentIds.length,
        createdAt: cohort.createdAt,
        ...(cohort.finishedAt ? { finishedAt: cohort.finishedAt } : {}),
        ...(cohort.error ? { error: cohort.error } : {}),
      },
      legs: legsFromRunner.length > 0
        ? legsFromRunner.map((l) => ({
          index: l.index, name: l.name, mapId: l.mapId, maxRounds: l.maxRounds, rulesVariant: l.rulesVariant,
          status: l.status, ...(l.tournamentId ? { tournamentId: l.tournamentId } : {}),
          ...(l.error ? { error: l.error } : {}),
        }))
        : legsFromDb,
      progress: runner ? { leg: runner.currentLeg, totalLegs: runner.totalLegs } : undefined,
      // 参赛版本快照：这一批用的是谁的哪一版（批次中途重新上传不会改变它）
      snapshot: cohort.snapshot,
      ratings: cohort.ratings ?? null,
      matrix: cohort.matrix ?? null,
      metrics: cohort.metrics ?? null,
    };
  });

  app.post("/api/cohorts/:id/stop", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const runner = deps.cohortRunners.get(id);
    if (!runner) return fail(reply, 404, "批次不存在或已不在运行（跑完的批次不能停）");
    runner.stop();
    return { ok: true, note: "已请求停止：当前 leg 跑完即止，已完成的结果会照常汇总" };
  });

  app.get("/api/cohorts/:id/report", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cohort = store.getCohort(id);
    if (!cohort) return fail(reply, 404, "批次不存在");
    const lines: string[] = [];
    lines.push(`# 评测批次战报 · ${cohort.name}`, "");
    lines.push(`- 批次 ID：\`${cohort.id}\`　状态：**${cohort.status}**　种子：\`${cohort.masterSeed}\``);
    lines.push(`- 参赛者：${cohort.snapshot.filter((s) => !s.calibration).length} 个 Agent（含 ${cohort.snapshot.filter((s) => s.calibration).length} 个标尺对手）　每对局数：${cohort.gamesPerPair}`);
    lines.push(`- 参赛版本：${cohort.snapshot.filter((s) => !s.calibration).map((s) => `${s.agentName} v${s.revision}(${s.resolvedBy})`).join("、") || "-"}`);
    lines.push("");

    const ratings = cohort.ratings as { rows?: { agentName: string; modelName: string; calibration: boolean; rating: number; lo: number; hi: number; games: number; wins: number; draws: number; losses: number; scoreDiff: number; insufficient: boolean }[]; games?: number; bootstrapRounds?: number } | null;
    const rows = ratings?.rows ?? [];
    if (rows.length > 0) {
      lines.push("## 评级（Bradley–Terry，1500 = 全场几何均值；区间为按 leg 重采样的 95% 置信区间）", "");
      lines.push("| 名次 | 参赛者 | 模型 | rating | 95% CI | 局数 | 胜-平-负 | 净胜分差 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
      rows.forEach((r, i) => {
        const ci = Number.isFinite(r.lo) ? `${r.lo} ~ ${r.hi}` : "—";
        lines.push(`| ${r.insufficient ? "—" : i + 1} | ${r.agentName}${r.calibration ? "（标尺）" : ""} | ${r.modelName} | **${r.rating}** | ${ci} | ${r.games}${r.insufficient ? "（样本不足）" : ""} | ${r.wins}-${r.draws}-${r.losses} | ${r.scoreDiff >= 0 ? "+" : ""}${r.scoreDiff} |`);
      });
      lines.push("", `> 共 ${ratings?.games ?? 0} 局，bootstrap ${ratings?.bootstrapRounds ?? 0} 次。`, "");
    }

    const metrics = cohort.metrics as { rows?: Record<string, unknown>[]; games?: number } | null;
    if (metrics?.rows?.length) {
      lines.push("## 过程分画像（按每回合/每单位归一，docs/08 §4）", "");
      lines.push("| 参赛者 | 局数 | AP 利用率 | 应急移动率 | 每百回合提交 | 终局利用率 | 补给占比 | 无产出局 | 死杀差 | 平均决策 | 最慢决策 | 适应力(σ) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const r of metrics.rows) {
        const f = (k: string) => String(r[k] ?? "-");
        lines.push(`| ${f("agentName")} | ${f("matches")} | ${f("apUtilization")} | ${f("emergencyRate")} | ${f("unitsPer100")} | ${f("endgameShare")} | ${r["supplyShare"] ?? "—"} | ${f("zeroOutputRate")} | ${f("killDeathDiff")} | ${f("avgDecisionMs")}ms | ${f("maxDecisionMs")}ms | ${f("adaptivity")} |`);
      }
      lines.push("");
    }

    const matrix = cohort.matrix as { aId: string; bId: string; wins: number; draws: number; losses: number; games: number }[] | null;
    if (matrix?.length) {
      const nameOf = (id: string) => cohort.snapshot.find((s) => s.agentId === id)?.agentName ?? id;
      lines.push("## 胜负矩阵（行视角：胜-平-负）", "");
      for (const cell of matrix) {
        lines.push(`- ${nameOf(cell.aId)} vs ${nameOf(cell.bId)}：${cell.wins}-${cell.draws}-${cell.losses}（${cell.games} 局）`);
      }
      lines.push("");
    }
    const legs = store.cohortLegs(id);
    if (legs.length > 0) {
      lines.push("## 轮次（leg）", "");
      for (const t of legs) {
        lines.push(`- #${t.legIndex} ${t.leg?.name ?? t.name}：${t.mapId} · ${t.leg?.maxRounds ?? "-"} 回合 · 规则变体 ${t.leg?.rulesVariant ?? "default"}（ruleset-${t.rulesetVersion}） · 状态 ${t.status} · 赛事 \`${t.id}\``);
      }
      lines.push("");
    }
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    return lines.join("\n");
  });
}

function fail(reply: FastifyReply, code: number, message: string): undefined {
  void reply.code(code).send({ error: message });
  return undefined;
}
