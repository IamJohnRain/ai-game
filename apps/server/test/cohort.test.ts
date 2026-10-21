// apps/server/test/cohort.test.ts —— 评测批次（docs/08 §2/§3/§5）的验收
//
// 覆盖：leg 展开与确定性、混合回合数真的生效、规则变体真的生效、
//       标尺对手入库、评级/矩阵/画像产出、版本快照冻结与三种 revisionPolicy、报告可读。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deriveSeed } from "@ai-game/engine";
import { createZip } from "@ai-game/zippack";
import { resolveRulesVariant, RULES_VARIANTS, RulesetSchema } from "@ai-game/protocol";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { MapRegistry } from "../src/maps.ts";
import { TournamentRunner } from "../src/tournaments.ts";
import { CohortRunner, expandLegs } from "../src/cohorts.ts";
import { createApp } from "../src/app.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readFileSync(join(repoRoot, "docs", "examples", "baseline-strategy.js"), "utf8");
const homeOnly = baseline.replace("const ALLOW_CENTER = true;", "const ALLOW_CENTER = false;");
const idleScript = `function onInit() {}\nfunction onTurn() { return [{ type: "wait" }]; }\n`;

async function boot(overrides: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-game-cohort-"));
  const base = loadConfig();
  const config: ServerConfig = {
    ...base,
    port: 0, dataDir: dir, dbPath: join(dir, "test.db"),
    masterKey: randomBytes(32), defaultTurnIntervalMs: 1, logger: false,
    auth: { ...base.auth, password: "test-password" },
    ...overrides,
  };
  const store = new Store(config.dbPath, config.masterKey);
  const registry = new MapRegistry(join(dir, "maps"));
  const tournamentRunners = new Map<string, TournamentRunner>();
  const cohortRunners = new Map<string, CohortRunner>();
  const { app } = await createApp({ config, store, registry, tournamentRunners, cohortRunners });
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { user: config.auth.user, password: config.auth.password },
  });
  const rawCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0]! : (rawCookie ?? "")).split(";")[0]!;
  type ReqOptions = { method: string; url: string; payload?: object | string | Buffer; headers?: Record<string, string>; query?: Record<string, string | string[]> };
  return {
    app, store, registry, config, cohortRunners,
    req: (opts: ReqOptions) => app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } }),
    close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Ctx = Awaited<ReturnType<typeof boot>>;

async function registerAndUpload(ctx: Ctx, name: string, script: string): Promise<string> {
  const reg = (await ctx.req({
    method: "POST", url: "/api/agents",
    payload: { modelName: `m-${name}`, agentName: name, thinkingLevel: "high", notes: "" },
  })).json() as { agent: { id: string }; key: string };
  const up = await ctx.req({
    method: "POST", url: "/api/upload",
    headers: { authorization: `Bearer ${reg.key}`, "content-type": "application/zip" },
    payload: createZip([{ name: "strategy.js", data: script }]),
  });
  assert.equal(up.statusCode, 200, `${name} 上传应成功：${up.body}`);
  return reg.agent.id;
}

async function waitCohort(ctx: Ctx, id: string, timeoutMs = 120_000) {
  const started = Date.now();
  for (;;) {
    const c = ctx.store.getCohort(id)!;
    if (c.status === "finished" || c.status === "finished_with_errors" || c.status === "failed" || c.status === "stopped") return c;
    if (Date.now() - started > timeoutMs) throw new Error(`等待批次超时，当前 ${c.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("规则变体表：字段合法、版本号可区分、scout 的参数确实生效（数据驱动）", () => {
  for (const [name, variant] of Object.entries(RULES_VARIANTS)) {
    assert.equal(RulesetSchema.safeParse(variant).success, true, `变体 ${name} 应通过 RulesetSchema`);
  }
  const scout = resolveRulesVariant("scout")!;
  assert.equal(scout.visionRadius, 3);
  assert.equal(scout.lastKnownMemoryRounds, 0, "0 = 不免费提供敌人记忆（引擎判据 round - rec.round > 0 即过期）");
  assert.notEqual(scout.version, RULES_VARIANTS["default"]!.version, "变体版本号必须可与默认区分（成绩要能归因）");
  assert.equal(resolveRulesVariant("nope"), null);
});

test("leg 展开：seeds 展开成多条、序号连续、同 masterSeed 可复现", () => {
  const plan = [
    { name: "A", mapId: "duel-01", maxRounds: 60, rulesVariant: "default", seeds: 3 },
    { name: "B", mapId: "arena-01", maxRounds: 150, rulesVariant: "scout" },
  ];
  const legs = expandLegs(plan);
  assert.equal(legs.length, 4, "3 + 1 条 leg");
  assert.deepEqual(legs.map((l) => l.index), [0, 1, 2, 3]);
  assert.deepEqual(legs.slice(0, 3).map((l) => l.plan.name), ["A#1", "A#2", "A#3"], "多种子要带 #n 后缀便于看结果");
  assert.equal(legs[3]!.plan.rulesVariant, "scout");
  // legSeed 派生：同一 masterSeed 两次派生一致、不同 leg 不同
  const s0 = deriveSeed(20261019, "cohort-leg:0");
  assert.equal(deriveSeed(20261019, "cohort-leg:0"), s0);
  assert.notEqual(deriveSeed(20261019, "cohort-leg:1"), s0);
});

test("批次：混合回合数 + 规则变体 + 标尺对手 → 评级/矩阵/画像齐备且可复现", async () => {
  const ctx = await boot();
  try {
    const a = await registerAndUpload(ctx, "玄武", baseline);
    const b = await registerAndUpload(ctx, "朱雀", homeOnly);
    const c = await registerAndUpload(ctx, "青龙", idleScript);

    const res = await ctx.req({
      method: "POST", url: "/api/cohorts",
      payload: {
        agentIds: [a, b, c],
        name: "冒烟批次",
        masterSeed: 12345,
        gamesPerPair: 1,
        includeCalibration: true,
        legs: [
          { name: "短局", mapId: "duel-01", maxRounds: 12, rulesVariant: "default", seeds: 2 },
          { name: "侦察", mapId: "duel-01", maxRounds: 12, rulesVariant: "scout", seeds: 1 },
        ],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const launched = res.json() as { cohortId: string; legs: number; totalMatches: number; participants: number };
    assert.equal(launched.legs, 3, "2+1 条 leg");
    assert.equal(launched.participants, 5, "3 个参赛者 + 2 个标尺");

    const cohort = await waitCohort(ctx, launched.cohortId);
    assert.equal(cohort.status, "finished", cohort.error ?? "");

    // leg 真的按计划跑：落库的 leg 带 cohort_id/leg_index/leg_json，且种子按 masterSeed 派生
    const legs = ctx.store.cohortLegs(launched.cohortId);
    assert.equal(legs.length, 3);
    assert.deepEqual(legs.map((l) => l.leg?.rulesVariant), ["default", "default", "scout"]);
    assert.deepEqual(legs.map((l) => l.legIndex), [0, 1, 2]);
    assert.equal(legs[0]!.seed, deriveSeed(12345, "cohort-leg:0"), "leg 种子必须由 masterSeed 派生（可复现）");

    // 规则变体真的进了引擎：对局的 rulesetVersion 必须是变体版本
    const cohortMatches = ctx.store.cohortMatchRows(launched.cohortId);
    assert.equal(cohortMatches.length, (5 * 4 / 2) * 1 * 3, "C(5,2)×gamesPerPair×legs");
    const scoutMatch = cohortMatches.find((m) => m.legIndex === 2)!;
    assert.equal(ctx.store.getMatch(scoutMatch.matchId)!.rulesetVersion, "1.2-scout");
    // 混合回合数真的生效：回放里的回合数不超过该 leg 的 maxRounds
    for (const m of cohortMatches.slice(0, 3)) {
      const replay = ctx.store.getReplay(m.matchId)!;
      const rounds = Math.max(...replay.events.filter((e) => e.t === "turn_begin").map((e) => (e as { round: number }).round));
      assert.ok(rounds <= 12, `${m.matchId} 的回合数 ${rounds} 应 ≤ 12`);
    }

    // 标尺对手以 calibration 身份入库（不会被误当成参赛模型）
    const calRows = ctx.store.cohortMatchRows(launched.cohortId)
      .flatMap((m) => m.seats).filter((s) => s.agentId.startsWith("cal-"));
    assert.ok(calRows.length > 0);
    assert.equal(calRows.every((s) => s.modelId === "calibration"), true);

    // 评级：3 个参赛者 + 2 个标尺都在榜上；矩阵格子 = C(5,2)
    const detail = (await ctx.req({ method: "GET", url: `/api/cohorts/${launched.cohortId}` })).json() as {
      ratings: { rows: { agentId: string; rating: number; lo: number; hi: number; calibration: boolean; games: number; insufficient: boolean }[]; games: number } | null;
      matrix: { aId: string; bId: string; wins: number; draws: number; losses: number; games: number }[] | null;
      metrics: { rows: { agentId: string; unitsPer100: number; apUtilization: number; adaptivity: number; avgScore: number }[]; games: number } | null;
      snapshot: { agentId: string; revision: number; scriptSha256: string; calibration?: boolean }[];
    };
    assert.ok(detail.ratings, "应有评级");
    assert.equal(detail.ratings!.rows.length, 5);
    assert.equal(detail.ratings!.rows.filter((r) => r.calibration).length, 2);
    assert.equal(detail.matrix!.length, 10);
    // 挂机脚本（青龙）应当排在做事的脚本之后
    const idleRow = detail.ratings!.rows.find((r) => r.agentId === c)!;
    const baseRow = detail.ratings!.rows.find((r) => r.agentId === a)!;
    assert.ok(baseRow.rating > idleRow.rating, `基线脚本(${baseRow.rating}) 应强于挂机(${idleRow.rating})`);
    assert.ok(detail.metrics!.rows.every((r) => r.apUtilization >= 0 && r.apUtilization <= 1), "AP 利用率必须落在 0~1");
    assert.ok(detail.metrics!.rows.find((r) => r.agentId === a)!.unitsPer100 > 0, "基线脚本每百回合应有提交");

    // 报告：Markdown 里要有评级表与画像表
    const report = await ctx.req({ method: "GET", url: `/api/cohorts/${launched.cohortId}/report` });
    assert.match(report.body, /评级（Bradley–Terry/);
    assert.match(report.body, /过程分画像/);
    assert.match(report.body, /胜负矩阵/);
  } finally { await ctx.close(); }
});

test("批次快照冻结 + revisionPolicy：latest 用新版、pinned 锁旧版，成绩按版本归因", async () => {
  const ctx = await boot();
  try {
    const agentId = await registerAndUpload(ctx, "玄武", idleScript); // v1：挂机
    // 第二版：换成基线脚本（reissue → 新密钥 → 再传）
    const reissued = (await ctx.req({ method: "POST", url: `/api/agents/${agentId}/reissue` })).json() as { key: string };
    const up2 = await ctx.req({
      method: "POST", url: "/api/upload",
      headers: { authorization: `Bearer ${reissued.key}`, "content-type": "application/zip" },
      payload: createZip([{ name: "strategy.js", data: baseline }]),
    });
    assert.equal(up2.statusCode, 200, up2.body);
    assert.equal((up2.json() as { revision: number }).revision, 2, "第二次上传就是第 2 版");
    assert.equal(ctx.store.listAgentRevisions(agentId).length, 2, "两版都要留档");

    const opponent = await registerAndUpload(ctx, "朱雀", baseline);

    // latest：用 v2（基线脚本）
    const latestRes = await ctx.req({
      method: "POST", url: "/api/cohorts",
      payload: { agentIds: [agentId, opponent], masterSeed: 7, gamesPerPair: 1, includeCalibration: false,
        legs: [{ name: "L", mapId: "duel-01", maxRounds: 40, rulesVariant: "default" }] },
    });
    assert.equal(latestRes.statusCode, 200, latestRes.body);
    const latest = latestRes.json() as { cohortId: string };
    const c1 = await waitCohort(ctx, latest.cohortId);
    const snapLatest = c1.snapshot.find((s) => s.agentId === agentId)!;
    assert.equal(snapLatest.revision, 2);
    assert.equal(snapLatest.resolvedBy, "latest");
    const matches1 = ctx.store.cohortMatchRows(latest.cohortId);
    const seatV2 = matches1.flatMap((m) => m.seats).find((s) => s.agentId === agentId)!;
    assert.equal(seatV2.revision, 2, "成绩要能归因到用的是第几版");

    // pinned：锁 v1（挂机版）→ 应该明显更弱
    const pinnedRes = await ctx.req({
      method: "POST", url: "/api/cohorts",
      payload: { agentIds: [agentId, opponent], masterSeed: 7, gamesPerPair: 1, includeCalibration: false,
        revisionPolicy: "pinned", revisions: { [agentId]: 1 },
        legs: [{ name: "P", mapId: "duel-01", maxRounds: 40, rulesVariant: "default" }] },
    });
    assert.equal(pinnedRes.statusCode, 200, pinnedRes.body);
    const pinned = pinnedRes.json() as { cohortId: string };
    const c2 = await waitCohort(ctx, pinned.cohortId);
    const snapPinned = c2.snapshot.find((s) => s.agentId === agentId)!;
    assert.equal(snapPinned.revision, 1);
    assert.equal(snapPinned.resolvedBy, "pinned");
    const seatV1 = ctx.store.cohortMatchRows(pinned.cohortId).flatMap((m) => m.seats).find((s) => s.agentId === agentId)!;
    assert.equal(seatV1.revision, 1);
    // 用"有没有提交过资源"判定用的是哪份脚本，比比分稳：10~40 回合的短局里，双方都可能因为交火而负分
    const units = (s: { stats?: Record<string, unknown> }) => Number((s.stats as { unitsDeposited?: number } | undefined)?.unitsDeposited ?? 0);
    assert.ok(units(seatV2) > 0, "latest 用的是 v2（基线脚本），40 回合内应当提交过资源");
    assert.equal(units(seatV1), 0, "pinned 锁的是 v1（挂机脚本），不可能提交资源");
  } finally { await ctx.close(); }
});

test("批次参数校验：未知地图 / 未知变体 / Agent 不够 / 并发上限", async () => {
  const ctx = await boot();
  try {
    const a = await registerAndUpload(ctx, "玄武", baseline);
    const b = await registerAndUpload(ctx, "朱雀", baseline);
    const bad1 = await ctx.req({
      method: "POST", url: "/api/cohorts",
      payload: { agentIds: [a, b], legs: [{ name: "x", mapId: "no-such-map", maxRounds: 10 }] },
    });
    assert.equal(bad1.statusCode, 400, bad1.body);
    assert.match(bad1.body, /未知地图/);
    const bad2 = await ctx.req({
      method: "POST", url: "/api/cohorts",
      payload: { agentIds: [a, b], legs: [{ name: "x", mapId: "duel-01", maxRounds: 10, rulesVariant: "no-such-variant" }] },
    });
    assert.equal(bad2.statusCode, 200, "启动时不认识的变体会被记成 leg 失败，而不是拒绝整批"); // 见下一条断言
    const c = await waitCohort(ctx, (bad2.json() as { cohortId: string }).cohortId);
    assert.equal(c.status, "failed", "只有一条 leg 且失败 → 整批 failed");
    assert.match(c.error ?? "", /未知规则变体/);

    const bad3 = await ctx.req({ method: "POST", url: "/api/cohorts", payload: { agentIds: [a], includeCalibration: false } });
    assert.equal(bad3.statusCode, 400, bad3.body);
    const bad4 = await ctx.req({ method: "POST", url: "/api/cohorts", payload: { agentIds: [a, b, "ag_nope"] } });
    assert.equal(bad4.statusCode, 400);
    assert.match(bad4.body, /不存在/);
  } finally { await ctx.close(); }
});

test("发起批次必须立刻返回：跑对局不能堵住事件循环（线上曾阻塞 251s）", async () => {
  const ctx = await boot();
  try {
    const a = await registerAndUpload(ctx, "玄武", baseline);
    const b = await registerAndUpload(ctx, "朱雀", homeOnly);
    const c = await registerAndUpload(ctx, "青龙", idleScript);
    const t0 = Date.now();
    const res = await ctx.req({
      method: "POST", url: "/api/cohorts",
      payload: {
        agentIds: [a, b, c], masterSeed: 3, gamesPerPair: 1, includeCalibration: false,
        legs: [
          { name: "L1", mapId: "duel-01", maxRounds: 20, rulesVariant: "default", seeds: 1 },
          { name: "L2", mapId: "duel-01", maxRounds: 20, rulesVariant: "default", seeds: 1 },
          { name: "L3", mapId: "arena-01", maxRounds: 20, rulesVariant: "default", seeds: 1 },
        ],
      },
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, res.body);
    // 关键：响应必须在批次还在跑的时候就回来（不是等整批跑完）
    assert.ok(elapsed < 2000, `发起批次应在 2s 内返回，实际 ${elapsed}ms`);
    const id = (res.json() as { cohortId: string }).cohortId;
    const running = ctx.store.getCohort(id)!;
    assert.ok(["pending", "running"].includes(running.status), `响应回来时批次应还在跑，实际 ${running.status}`);
    await waitCohort(ctx, id);
  } finally { await ctx.close(); }
});

test("停止批次：当前 leg 跑完即止，状态 stopped，剩余 leg 不再启动", async () => {
  const ctx = await boot();
  try {
    const a = await registerAndUpload(ctx, "玄武", baseline);
    const b = await registerAndUpload(ctx, "朱雀", homeOnly);
    const res = await ctx.req({
      method: "POST", url: "/api/cohorts",
      payload: {
        agentIds: [a, b], masterSeed: 5, gamesPerPair: 1, includeCalibration: false,
        legs: Array.from({ length: 6 }, (_, i) => ({ name: `L${i}`, mapId: "duel-01", maxRounds: 40, rulesVariant: "default", seeds: 1 })),
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const id = (res.json() as { cohortId: string }).cohortId;
    const stop = await ctx.req({ method: "POST", url: `/api/cohorts/${id}/stop` });
    assert.equal(stop.statusCode, 200, stop.body);
    const cohort = await waitCohort(ctx, id);
    assert.equal(cohort.status, "stopped", cohort.error ?? "");
    const legs = ctx.store.cohortLegs(id);
    assert.ok(legs.length < 6, `停止后不该把 6 条 leg 全跑完，实际跑了 ${legs.length} 条`);
    // 已跑完的 leg 结果照常在（停不是白停）
    assert.ok(legs.some((l) => l.status === "finished"), "至少有一条 leg 跑完了");
  } finally { await ctx.close(); }
});

test("批次并发上限：已有批次在跑时再发起 → 429", async () => {
  const ctx = await boot();
  try {
    const a = await registerAndUpload(ctx, "玄武", baseline);
    const b = await registerAndUpload(ctx, "朱雀", baseline);
    // 塞一个假 runner 占住并发位（真跑一条长 leg 太慢，这个测试只关心闸门）
    ctx.cohortRunners.set("c_fake", { status: "running" } as CohortRunner);
    const res = await ctx.req({ method: "POST", url: "/api/cohorts", payload: { agentIds: [a, b] } });
    assert.equal(res.statusCode, 429);
    assert.match(res.body, /已有批次在跑/);
  } finally { await ctx.close(); }
});