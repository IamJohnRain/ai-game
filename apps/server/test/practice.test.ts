// apps/server/test/practice.test.ts —— 练习通道（docs/08 §6）与版本化提交（§7）的验收
//
// 练习通道的四条不变式逐条验证：不消耗正式提交、不计分（不建 matches 行、不进榜单）、
// 只能打标尺（idle/baseline）、配额与限流；版本化提交验证 revision 计数、每版一把密钥、上限闸门。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createZip } from "@ai-game/zippack";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { MapRegistry } from "../src/maps.ts";
import { createApp } from "../src/app.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readFileSync(join(repoRoot, "docs", "examples", "baseline-strategy.js"), "utf8");
const brokenScript = "function onInit() {\nfunction onTurn(state) { return []; }\n"; // 语法错误：编译阶段就该被拦

async function boot(overrides: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-game-practice-"));
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
  const { app } = await createApp({ config, store, registry });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { user: config.auth.user, password: config.auth.password } });
  const rawCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0]! : (rawCookie ?? "")).split(";")[0]!;
  type ReqOptions = { method: string; url: string; payload?: object | string | Buffer; headers?: Record<string, string> };
  return {
    app, store, registry, config,
    req: (opts: ReqOptions) => app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } }),
    close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Ctx = Awaited<ReturnType<typeof boot>>;

async function register(ctx: Ctx, name = "玄武", modelName = "m-practice") {
  const res = await ctx.req({ method: "POST", url: "/api/agents", payload: { modelName, agentName: name, thinkingLevel: "high", notes: "" } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { agent: { id: string; status: string; attempts: number; revision: number; practiceRuns: number; maxPracticeRuns: number }; key: string };
}

// 注意：这里刻意用 app.inject（**不带会话 Cookie**）——练习通道是免登录入口，
// 测试必须能证明没有会话也能用密钥跑练习，否则会漏掉白名单问题。
function practice(ctx: Ctx, key: string, script: string) {
  return ctx.app.inject({
    method: "POST", url: "/api/practice",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/zip" },
    payload: createZip([{ name: "strategy.js", data: script }]),
  });
}

test("练习成功后：拿到准入结论 + 标尺对局比分；但状态/次数/榜单一个都没动", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx);
    const res = await practice(ctx, reg.key, baseline);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      ok: boolean;
      validation: { stage: string; mapId: string; ok: boolean }[];
      validatedMaps: string[];
      practice: { rounds: number; mapId: string; seed: number; opponents: { kind: string; myScore: number; oppScore: number; result: string; my: { unitsDeposited: number; strikes: number } }[] };
      quota: { used: number; max: number };
    };
    assert.equal(body.ok, true);
    assert.ok(body.validation.length > 0 && body.validation.every((v) => v.ok), "练习也要跑完整五阶段校验");
    assert.deepEqual(body.validatedMaps, ctx.registry.ids(), "校验覆盖每一张注册地图");
    assert.equal(body.practice.rounds, 60, "练习局固定 60 回合");
    assert.deepEqual(body.practice.opponents.map((o) => o.kind), ["idle", "baseline"]);
    const vsIdle = body.practice.opponents[0]!;
    const vsBase = body.practice.opponents[1]!;
    assert.ok(vsIdle.myScore > vsIdle.oppScore, "基线脚本打挂机者应当赢");
    assert.ok(vsBase.myScore > 0, "对基线也应产出得分（有可比刻度）");
    assert.equal(vsBase.my.strikes, 0);
    assert.deepEqual(body.quota, { used: 1, max: 5 });

    // 不变式①：不消耗正式提交
    const after = ctx.store.getAgent(reg.agent.id)!;
    assert.equal(after.status, "registered", "练习后状态仍是 registered（密钥仍可用于正式上传）");
    assert.equal(after.attempts, 0, "练习不消耗尝试次数");
    assert.equal(after.revision, 0, "练习不产生版本");
    // 不变式②：不计分 —— 没有 matches 行、榜单为空
    assert.equal(ctx.store.listMatches(10).length, 0, "练习不建 matches 行");
    assert.equal(ctx.store.leaderboard().length, 0, "练习不进排行榜");
    // 但留下"自测痕迹"（这正是练习通道要产出的指标）
    assert.equal(ctx.store.listPracticeRuns(reg.agent.id).length, 1);
    assert.equal(ctx.store.practiceProfile(reg.agent.id).firstPass, true, "第一次练习就通过");
    assert.deepEqual(body.quota, { used: 1, max: 5 });

    // 密钥仍然可以正式提交
    const up = await ctx.req({
      method: "POST", url: "/api/upload",
      headers: { authorization: `Bearer ${reg.key}`, "content-type": "application/zip" },
      payload: createZip([{ name: "strategy.js", data: baseline }]),
    });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal((up.json() as { revision: number }).revision, 1);
    // 提交之后再练习 → 409（不允许上传后继续探测环境）
    const afterUpload = await practice(ctx, reg.key, baseline);
    assert.equal(afterUpload.statusCode, 409);
  } finally { await ctx.close(); }
});

test("练习失败：阶段归类正确、消耗配额但不消耗正式尝试次数；配额用尽 429", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx, "朱雀");
    const bad = await practice(ctx, reg.key, brokenScript);
    assert.equal(bad.statusCode, 400, bad.body);
    const body = bad.json() as { stage: string; error: string; quota: { used: number; max: number } };
    assert.equal(body.stage, "compile", `语法错误应归到 compile，实际 ${body.stage}`);
    assert.equal(body.quota.used, 1);
    const agent = ctx.store.getAgent(reg.agent.id)!;
    assert.equal(agent.attempts, 0, "练习失败不消耗正式尝试次数");
    assert.equal(agent.status, "registered", "练习失败不影响状态");
    assert.equal(ctx.store.practiceProfile(reg.agent.id).firstPass, false, "首次练习失败要如实记录");

    // 用尽配额（默认 5 次）
    for (let i = 0; i < 4; i++) {
      const res = await practice(ctx, reg.key, brokenScript);
      assert.equal(res.statusCode, 400, res.body);
    }
    const sixth = await practice(ctx, reg.key, brokenScript);
    assert.equal(sixth.statusCode, 429);
    assert.equal((sixth.json() as { stage: string }).stage, "quota");
  } finally { await ctx.close(); }
});

test("练习闸门与上传一致：假密钥 401、超大包 413、结构攻击 400、缺 strategy.js 400", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx, "青龙");
    const noKey = await ctx.app.inject({ method: "POST", url: "/api/practice", headers: { "content-type": "application/zip" }, payload: createZip([{ name: "strategy.js", data: baseline }]) });
    assert.equal(noKey.statusCode, 401);
    // 免登录白名单：没带会话 Cookie 时也不该被会话守卫拦下，而应当落到练习自己的密钥闸门
    assert.match((noKey.json() as { error: string }).error, /Bearer/, "应由练习通道的密钥闸门回 401（而不是会话守卫）");
    const fake = await practice(ctx, "ag_" + "0".repeat(32), baseline);
    assert.equal(fake.statusCode, 401);
    const big = await ctx.app.inject({
      method: "POST", url: "/api/practice",
      headers: { authorization: `Bearer ${reg.key}`, "content-type": "application/zip" },
      payload: createZip([{ name: "strategy.js", data: randomBytes(300 * 1024) }]),
    });
    assert.equal(big.statusCode, 413);
    assert.equal((big.json() as { stage: string }).stage, "size");
    const traversal = await practice(ctx, reg.key, baseline);
    assert.equal(traversal.statusCode, 200, "正常包应通过（前面的失败不影响密钥）");
    const noScript = await ctx.app.inject({
      method: "POST", url: "/api/practice",
      headers: { authorization: `Bearer ${reg.key}`, "content-type": "application/zip" },
      payload: createZip([{ name: "meta.json", data: "{}" }]),
    });
    assert.equal(noScript.statusCode, 400);
    assert.equal((noScript.json() as { stage: string }).stage, "content");
  } finally { await ctx.close(); }
});

test("版本化提交：每版一把一次性密钥、revision 自增、历史留档、上限闸门、成绩按版本归因", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx, "玄武", "m-version");
    assert.equal(reg.agent.revision, 0, "新注册的 Agent 还没有版本");

    for (let v = 1 as number; v <= 3; v++) {
      const key = v === 1 ? reg.key : ((await ctx.req({ method: "POST", url: `/api/agents/${reg.agent.id}/reissue` })).json() as { key: string }).key;
      const up = await ctx.req({
        method: "POST", url: "/api/upload",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/zip" },
        payload: createZip([{ name: "strategy.js", data: `${baseline}\n// revision ${v}\n` }]),
      });
      assert.equal(up.statusCode, 200, up.body);
      assert.equal((up.json() as { revision: number }).revision, v, `第 ${v} 次提交应当是第 ${v} 版`);
    }

    const agent = ctx.store.getAgent(reg.agent.id)!;
    assert.equal(agent.revision, 3);
    const revisions = ctx.store.listAgentRevisions(reg.agent.id);
    assert.equal(revisions.length, 3, "每一版都要留档（改进斜率要用）");
    assert.deepEqual(revisions.map((r) => r.revision), [3, 2, 1], "新版本在前");
    // 版本内容真的不同：能按版本取回脚本
    assert.match(ctx.store.agentScriptAtRevision(reg.agent.id, 1)!.script, /revision 1/);
    assert.match(ctx.store.agentScriptAtRevision(reg.agent.id, 3)!.script, /revision 3/);

    // 上限闸门：默认 3 版；第 4 版要先改配置
    const key4 = ((await ctx.req({ method: "POST", url: `/api/agents/${reg.agent.id}/reissue` })).json() as { key: string }).key;
    const fourth = await ctx.req({
      method: "POST", url: "/api/upload",
      headers: { authorization: `Bearer ${key4}`, "content-type": "application/zip" },
      payload: createZip([{ name: "strategy.js", data: baseline }]),
    });
    assert.equal(fourth.statusCode, 409);
    assert.equal((fourth.json() as { stage: string }).stage, "revisions", "超版本上限要给出可区分的 stage");
  } finally { await ctx.close(); }
});

test("一次通过率与画像：失败过再成功 → attemptsAtUpload>0、firstTryRate=0、profile 里能看到自测次数", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx, "玄武", "m-firsttry");
    // 先练一次（失败）再正式提交，模拟"会调试的模型"
    await practice(ctx, reg.key, brokenScript);
    // 正式提交前先失败一次（体积/结构都算）：这里用坏脚本走上传，会累计 attempts
    const badUp = await ctx.req({
      method: "POST", url: "/api/upload",
      headers: { authorization: `Bearer ${reg.key}`, "content-type": "application/zip" },
      payload: createZip([{ name: "strategy.js", data: brokenScript }]),
    });
    assert.equal(badUp.statusCode, 400);
    const goodUp = await ctx.req({
      method: "POST", url: "/api/upload",
      headers: { authorization: `Bearer ${reg.key}`, "content-type": "application/zip" },
      payload: createZip([{ name: "strategy.js", data: baseline }]),
    });
    assert.equal(goodUp.statusCode, 200, goodUp.body);

    const agent = ctx.store.getAgent(reg.agent.id)!;
    assert.equal(agent.attemptsAtUpload, 1, "记录\"成功那次之前失败过几次\"");
    const profile = ctx.store.modelProfile("m-firsttry")!;
    assert.equal(profile.agents.length, 1);
    assert.equal(profile.agents[0]!.attemptsAtUpload, 1);
    assert.equal(profile.agents[0]!.practiceRuns, 1, "练习次数要进画像");
    assert.equal(profile.agents[0]!.practiceFirstPass, false, "首次练习是失败的");
    assert.equal(profile.agents[0]!.runsBeforeUpload, 1, "上传之前练了 1 次");
    // 该模型还没有对局：画像里的对局指标是空壳（0），但接口不能报错
    assert.equal(profile.metrics.matches, 0);

    const viaApi = await ctx.req({ method: "GET", url: `/api/models/${encodeURIComponent("m-firsttry")}/profile` });
    assert.equal(viaApi.statusCode, 200, viaApi.body);
    const missing = await ctx.req({ method: "GET", url: "/api/models/nope/profile" });
    assert.equal(missing.statusCode, 404);
  } finally { await ctx.close(); }
});

test("排行榜新字段：过程分按每回合归一，maxDecisionMs ≥ avgDecisionMs", async () => {
  const ctx = await boot();
  try {
    const a = await register(ctx, "玄武", "m-metrics");
    const b = await register(ctx, "朱雀", "m-metrics");
    for (const [key, script] of [[a.key, baseline], [b.key, baseline.replace("const ALLOW_CENTER = true;", "const ALLOW_CENTER = false;")]] as const) {
      const up = await ctx.req({
        method: "POST", url: "/api/upload",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/zip" },
        payload: createZip([{ name: "strategy.js", data: script }]),
      });
      assert.equal(up.statusCode, 200, up.body);
    }
    const t = await ctx.req({
      method: "POST", url: "/api/tournaments",
      payload: { agentIds: [a.agent.id, b.agent.id], gamesPerPair: 1, maxRounds: 40, seed: 11 },
    });
    assert.equal(t.statusCode, 200, t.body);
    const id = (t.json() as { tournamentId: string }).tournamentId;
    for (let i = 0; i < 200; i++) {
      if (ctx.store.getTournament(id)!.status === "finished") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(ctx.store.getTournament(id)!.status, "finished");

    const row = ctx.store.leaderboard().find((r) => r.modelId === "m-metrics")!;
    assert.ok(row.matches >= 2, "两名 Agent 各打一局");
    assert.ok(row.avgInvalidRate >= 0 && row.avgInvalidRate <= 1, `无效动作率应在 0~1，实际 ${row.avgInvalidRate}`);
    assert.ok(row.avgUnitsPer100 > 0, "40 回合里应当有提交");
    assert.ok(row.maxDecisionMs >= row.avgDecisionMs, `max(${row.maxDecisionMs}) 应 ≥ avg(${row.avgDecisionMs})`);
    assert.equal(row.firstTryRate, 1, "两个 Agent 都是一次过");
    assert.equal(row.avgRevisions, 1, "平均版本数 1");
    assert.ok(row.avgEmergencyRate >= 0 && row.avgSupplyShare >= 0);
  } finally { await ctx.close(); }
});