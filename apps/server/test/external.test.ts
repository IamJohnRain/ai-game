// apps/server/test/external.test.ts —— 外部 Agent 流程验收：注册、一次性密钥、上传闸门、1v1 赛事
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createZip } from "@ai-game/zippack";
import { DEFAULT_MAP_1V1, DEFAULT_MAP_MULTI, DEFAULT_RULESET, BUILTIN_MAPS, MAP_MIN_DIM, MAP_MAX_DIM, TileCharSchema, validateMap } from "@ai-game/protocol";
import { auditMap } from "@ai-game/engine";
import { MAP_SPEC_EXAMPLE } from "@ai-game/prompt";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { TournamentRunner } from "../src/tournaments.ts";
import { MapRegistry } from "../src/maps.ts";
import { createApp } from "../src/app.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readFileSync(join(repoRoot, "docs", "examples", "baseline-strategy.js"), "utf8");
const idle = `function onInit() {}\nfunction onTurn() { return [{ type: "wait" }]; }\n`;

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "ai-game-ext-"));
  const base = loadConfig();
  const config: ServerConfig = {
    ...base,
    port: 0,
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    masterKey: randomBytes(32),
    defaultTurnIntervalMs: 20,
    logger: false,
    // 仓库里没有默认密码：测试显式给一个
    auth: { ...base.auth, password: "test-password" },
  };
  const store = new Store(config.dbPath, config.masterKey);
  const registry = new MapRegistry(join(dir, "maps"));
  const tournamentRunners = new Map<string, TournamentRunner>();
  const { app } = await createApp({ config, store, registry, tournamentRunners });
  await app.ready();
  // 注册 Agent / 发起赛事都要登录（上传接口本身免登录、只验一次性密钥），先拿一个会话 Cookie
  const login = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { user: config.auth.user, password: config.auth.password },
  });
  const rawCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0]! : (rawCookie ?? "")).split(";")[0]!;
  /** 只需覆盖测试里实际用到的字段，省得依赖 light-my-request 的类型推导 */
  type ReqOptions = {
    method: string;
    url: string;
    payload?: object | string | Buffer;
    headers?: Record<string, string>;
    query?: Record<string, string | string[]>;
  };
  return {
    app, store, config, registry, tournamentRunners, dir, cookie,
    /** 已登录的 inject：自动带上会话 Cookie */
    req: (opts: ReqOptions) => app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } }),
    close: async () => {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Ctx = Awaited<ReturnType<typeof boot>>;

async function register(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  const res = await ctx.req({
    method: "POST", url: "/api/agents",
    payload: { modelName: "DeepSeek-V3", agentName: "玄武", thinkingLevel: "high", notes: "偏经济流", ...overrides },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as {
    agent: { id: string; keyMasked: string; status: string };
    key: string; taskDocUrl: string; uploadUrl: string; prompt: string;
    limits: { zipMaxBytes: number; maxUploadAttempts: number; maxEntries: number; maxRatio: number; maxScriptLines: number };
  };
}

function upload(ctx: Ctx, key: string, zip: Buffer, contentType = "application/zip") {
  return ctx.req({ method: "POST", url: "/api/upload", headers: { authorization: `Bearer ${key}`, "content-type": contentType }, payload: zip });
}

async function uploadScript(ctx: Ctx, agentKey: string, script: string, extra: { name: string; data: string }[] = []) {
  const zip = createZip([{ name: "strategy.js", data: script }, ...extra]);
  return upload(ctx, agentKey, zip);
}

async function waitTournament(ctx: Ctx, id: string, timeoutMs = 120_000) {
  const started = Date.now();
  for (;;) {
    const t = ctx.store.getTournament(id)!;
    if (t.status === "finished" || t.status === "failed") return t;
    if (Date.now() - started > timeoutMs) throw new Error(`等待赛事结束超时，当前状态 ${t.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("注册：字段齐全、密钥只回一次、库里不存明文、列表里只有掩码", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx);
    assert.ok(reg.key.startsWith("ag_") && reg.key.length === 35, `密钥格式应为 ag_ + 32 hex，实际 ${reg.key}`);
    assert.equal(reg.agent.status, "registered");
    assert.equal(reg.agent.keyMasked, `${reg.key.slice(0, 5)}****${reg.key.slice(-4)}`);
    assert.ok(reg.taskDocUrl.endsWith("/api/task-doc"), `任务书 URL 与地图无关，实际 ${reg.taskDocUrl}`);
    assert.equal((reg as unknown as Record<string, unknown>)["taskDocMapId"], undefined, "任务书不再绑定某张默认地图");
    assert.ok(reg.uploadUrl.endsWith("/api/upload"));
    assert.equal(reg.limits.zipMaxBytes, 200 * 1024);
    assert.equal(reg.limits.zipMaxBytes, 204800);

    // 启动 prompt：一句话任务 + 任务书地址 + 密钥 + 上传命令，组织者复制后可直接粘给目标 Agent
    assert.ok(reg.prompt.includes("strategy.js"), "prompt 应说明要交什么");
    assert.ok(reg.prompt.includes(reg.taskDocUrl), "prompt 应带任务书地址");
    assert.ok(reg.prompt.includes(reg.uploadUrl), "prompt 应带上传地址");
    assert.ok(reg.prompt.includes(`Bearer ${reg.key}`), "prompt 应带一次性密钥");
    assert.ok(reg.prompt.includes("API.pathFind") && reg.prompt.includes("§11"), "prompt 应点到'不挑图'与自查清单");
    assert.equal(reg.prompt.includes("xiaoyiwork"), false, "prompt 里不得出现任何密码");

    const list = (await ctx.req({ method: "GET", url: "/api/agents" })).json().agents as { keyMasked: string; key?: string; thinkingLevel: string; notes: string }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.key, undefined, "列表不得返回明文密钥");
    assert.equal(list[0]!.thinkingLevel, "high");
    assert.equal(list[0]!.notes, "偏经济流");

    // 数据库文件里不得出现明文密钥
    const raw = readFileSync(ctx.config.dbPath);
    assert.equal(raw.includes(Buffer.from(reg.key)), false, "数据库中不得出现明文注册密钥");

    // 参数校验
    const bad = await ctx.req({ method: "POST", url: "/api/agents", payload: { modelName: "", agentName: "x" } });
    assert.equal(bad.statusCode, 400);
    const badLevel = await ctx.req({ method: "POST", url: "/api/agents", payload: { modelName: "m", agentName: "a", thinkingLevel: "god" } });
    assert.equal(badLevel.statusCode, 400);
  } finally { await ctx.close(); }
});

test("上传成功：脚本入库、状态变为 uploaded、密钥随即失效（一次性）", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx);
    const res = await uploadScript(ctx, reg.key, baseline, [{ name: "meta.json", data: JSON.stringify({ name: "玄武", style: "economy" }) }]);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.agent.status, "uploaded");
    assert.equal(body.scriptSha256.length, 64);
    assert.equal((body.validation as { stage: string; ok: boolean }[]).every((v) => v.ok), true, JSON.stringify(body.validation));
    assert.ok(body.smoke && body.smoke.strikes === 0);
    // 校验覆盖全部内置地图（校验报告里带 mapId）
    assert.deepEqual(body.validatedMaps, Object.keys(BUILTIN_MAPS));
    const validatedMaps = new Set((body.validation as { mapId: string }[]).map((v) => v.mapId));
    assert.deepEqual([...validatedMaps].sort(), Object.keys(BUILTIN_MAPS).sort(), "每张内置地图都要有校验记录");

    // 同密钥再传 → 拒绝
    const again = await uploadScript(ctx, reg.key, baseline);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().stage, "auth");
    assert.match(again.json().error, /已成功使用过/);

    // 错误密钥 → 401
    const wrong = await uploadScript(ctx, "ag_" + "0".repeat(32), baseline);
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().stage, "auth");
  } finally { await ctx.close(); }
});

test("上传闸门①：体积超过 200KB 直接拒绝（不进入解包）", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx);
    // 用不可压缩数据，确保 zip 体积真的超限
    const big = createZip([{ name: "strategy.js", data: randomBytes(300 * 1024) }]);
    assert.ok(big.length > 200 * 1024);
    const res = await upload(ctx, reg.key, big);
    assert.ok([413, 400].includes(res.statusCode), `应被拒绝，实际 ${res.statusCode}`);
    assert.equal(res.json().stage, "size");
    assert.equal(ctx.store.getAgent(reg.agent.id)!.status, "registered", "体积失败不应消耗密钥");
  } finally { await ctx.close(); }
});

test("上传闸门②：压缩包结构攻击矩阵全部被拒（且不消耗密钥）", async () => {
  const ctx = await boot();
  try {
    const cases: { name: string; zip: Buffer; expect: RegExp }[] = [
      { name: "路径穿越", zip: createZip([{ name: "../strategy.js", data: baseline }]), expect: /PATH_TRAVERSAL|NOT_WHITELISTED/ },
      { name: "子目录（压缩过深）", zip: createZip([{ name: "a/b/c/d/e/strategy.js", data: baseline }]), expect: /NOT_WHITELISTED/ },
      { name: "嵌套压缩包", zip: createZip([{ name: "inner.zip", data: createZip([{ name: "strategy.js", data: baseline }]) }]), expect: /NOT_WHITELISTED|NESTED_ARCHIVE/ },
      { name: "白名单外文件", zip: createZip([{ name: "strategy.js", data: baseline }, { name: "run.sh", data: "rm -rf /" }]), expect: /NOT_WHITELISTED/ },
      { name: "条目洪水", zip: createZip(Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.js`, data: "x" }))), expect: /ENTRY_COUNT/ },
      { name: "压缩炸弹", zip: bombZip(), expect: /ENTRY_TOO_LARGE|RATIO_EXCEEDED|TOTAL_TOO_LARGE/ },
      { name: "垃圾字节", zip: Buffer.from("不是 zip".repeat(100)), expect: /BAD_CENTRAL_DIR|BAD_SIGNATURE/ },
      { name: "缺少 strategy.js", zip: createZip([{ name: "meta.json", data: "{}" }]), expect: /缺少 strategy\.js/ },
    ];
    // 每个攻击用例用一个全新 Agent，避免失败次数互相影响
    for (const c of cases) {
      const reg = await register(ctx, { agentName: `攻击用例-${c.name}`, modelName: "model-X" });
      const res = await upload(ctx, reg.key, c.zip);
      assert.ok(res.statusCode >= 400, `${c.name} 应被拒绝，实际 ${res.statusCode}`);
      const body = res.json();
      assert.ok(["zip", "content"].includes(body.stage), `${c.name} 阶段应为 zip/content，实际 ${body.stage}`);
      assert.match(body.error, c.expect, `${c.name} 错误信息不匹配：${body.error}`);
      const after = ctx.store.getAgent(reg.agent.id)!;
      assert.equal(after.status, "registered", `${c.name} 失败不应消耗密钥`);
      assert.equal(after.attempts, 1, `${c.name} 应计一次尝试`);
    }
  } finally { await ctx.close(); }
});

test("尝试次数上限：连续失败达上限后拒绝，密钥仍未被消耗", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx);
    const max = reg.limits.maxUploadAttempts;
    assert.equal(max, 10);
    const badZip = createZip([{ name: "strategy.js", data: "function onTurn(){ retrun []; }" }]);
    for (let i = 0; i < max; i++) {
      const res = await upload(ctx, reg.key, badZip);
      assert.equal(res.statusCode, 400, `第 ${i + 1} 次应因脚本错误被拒`);
    }
    const blocked = await uploadScript(ctx, reg.key, baseline);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().stage, "attempts");
    assert.equal(ctx.store.getAgent(reg.agent.id)!.status, "rejected", "仍未被消耗（只是被限流）");
  } finally { await ctx.close(); }
});

test("上传闸门③：脚本本身不合法的四类失败都被正确归类", async () => {
  const ctx = await boot();
  try {
    const cases: { script: string; stage: string; name: string }[] = [
      { name: "静态违规（Math.random）", script: `function onInit(){}\nfunction onTurn(){ return [{ type: "wait", n: Math.random() }]; }`, stage: "static" },
      { name: "语法错误", script: `function onInit(){}\nfunction onTurn(){ return [; }`, stage: "compile" },
      { name: "onInit 抛错", script: `function onInit(){ null.x = 1; }\nfunction onTurn(){ return []; }`, stage: "compile" },
      { name: "onTurn 死循环（超时）", script: `function onInit(){}\nfunction onTurn(){ var t=0; for (var i=0;i<1e12;i++) t+=i; return []; }`, stage: "smoke" },
      { name: "返回非数组", script: `function onInit(){}\nfunction onTurn(){ return { type: "wait" }; }`, stage: "smoke" },
    ];
    for (const c of cases) {
      const reg = await register(ctx, { agentName: `agent-${c.name}` });
      const res = await uploadScript(ctx, reg.key, c.script);
      assert.equal(res.statusCode, 400, `${c.name} 应 400，实际 ${res.statusCode}：${res.body.slice(0, 200)}`);
      assert.equal(res.json().stage, c.stage, `${c.name} 期望阶段 ${c.stage}，实际 ${res.json().stage}`);
      assert.equal(ctx.store.getAgent(reg.agent.id)!.status, "rejected", "校验失败应标记 rejected（不代表密钥作废）");
      assert.ok((ctx.store.getAgent(reg.agent.id)!.rejectReason ?? "").length > 0);
    }
  } finally { await ctx.close(); }
});

test("重新签发密钥：旧密钥失效、新密钥可用", async () => {
  const ctx = await boot();
  try {
    const reg = await register(ctx);
    const reissued = (await ctx.req({ method: "POST", url: `/api/agents/${reg.agent.id}/reissue` })).json() as {
      key: string; agent: { keyMasked: string }; prompt: string; taskDocUrl: string;
    };
    assert.ok(reissued.key.startsWith("ag_"));
    assert.notEqual(reissued.key, reg.key);
    // 重签返回的 prompt 必须换成新密钥（旧 prompt 从这一刻起就是废的，别让组织者粘错）
    assert.ok(reissued.prompt.includes(`Bearer ${reissued.key}`), "重签 prompt 应带新密钥");
    assert.equal(reissued.prompt.includes(reg.key), false, "重签 prompt 不得残留旧密钥");
    assert.ok(reissued.prompt.includes(reissued.taskDocUrl), "重签 prompt 应带任务书地址");
    const old = await uploadScript(ctx, reg.key, baseline);
    assert.equal(old.statusCode, 401, "旧密钥应失效");
    const fresh = await uploadScript(ctx, reissued.key, baseline);
    assert.equal(fresh.statusCode, 200, fresh.body);
  } finally { await ctx.close(); }
});

test("任务书：不指定具体地图（只给通用地图规范），Markdown 含协议/规范/数值/上传规范；JSON 形态给出端点与上限", async () => {
  const ctx = await boot();
  try {
    const md = await ctx.req({ method: "GET", url: "/api/task-doc" });
    assert.equal(md.statusCode, 200);
    assert.match(md.headers["content-type"] as string, /markdown/);
    const text = md.body;
    for (const probe of [
      "外部 Agent 任务书", "function onTurn(state)", "API.pathFind", "strategy.js", "200 KB", "ZIP", "自查清单", "1v1 循环赛",
      "地图规范", "字符表", "MAP.spawnsFor1v1", "不挑图",
    ]) {
      assert.ok(text.includes(probe), `任务书应包含：${probe}`);
    }
    assert.equal(/\{\{[A-Z_0-9]+\}\}/.test(text), false, "不得残留未替换的占位符");

    // 关键：正文里不得出现任何一张赛图（id 或地形），否则模型会去"背图"，与"不挑图"的设计意图相悖
    for (const [mapId, map] of Object.entries(BUILTIN_MAPS)) {
      assert.equal(text.includes(mapId), false, `任务书不应出现地图 id：${mapId}`);
      for (const row of map.grid.slice(0, 3)) {
        assert.equal(text.includes(row), false, `任务书不应出现 ${mapId} 的地形行：${row}`);
      }
    }

    // 通用规范必须真的写清楚，且尺寸/字符来自 protocol（改引擎就是改任务书）
    assert.ok(text.includes(`${MAP_MIN_DIM} ~ ${MAP_MAX_DIM}`), `任务书应写明尺寸范围 ${MAP_MIN_DIM} ~ ${MAP_MAX_DIM}`);
    for (const c of TileCharSchema.options) assert.ok(text.includes(`\`${c}\``), `字符表应列出字符 ${c}`);
    assert.ok(text.includes(MAP_SPEC_EXAMPLE.grid[2]!), "任务书应包含 MAP 结构示例（字段形状示意）");

    // 结构示例本身必须是合法地图：不能教用户一个过不了校验的形状
    assert.deepEqual(validateMap(MAP_SPEC_EXAMPLE), [], "任务书里的 MAP 结构示例必须是合法地图");
    assert.deepEqual(auditMap(MAP_SPEC_EXAMPLE, DEFAULT_RULESET).errors, [], "结构示例也应通过玩法审计的硬性判据");

    const json = (await ctx.req({ method: "GET", url: "/api/task-doc?format=json" })).json();
    assert.equal(json.version, "v1.1");
    assert.equal(json.mapId, undefined, "任务书 JSON 不应再带 mapId（任务书与地图无关）");
    assert.match(json.endpoints.upload, /\/api\/upload$/);
    assert.equal(json.limits.zipMaxBytes, 204800);
    assert.ok(json.markdown.length > 10_000);

    // 旧链接（?mapId=xxx）继续可用，但正文与指定哪张图无关：一字不差
    const legacy = await ctx.req({ method: "GET", url: `/api/task-doc?mapId=${DEFAULT_MAP_MULTI}` });
    assert.equal(legacy.statusCode, 200, "带 ?mapId= 的旧链接不应 404");
    assert.equal(legacy.body, text, "任务书与地图无关：换 mapId 拿到的正文必须完全相同");
  } finally { await ctx.close(); }
});

test("1v1 赛事：积分榜排名正确、每局可回放可看战报、未校验 Agent 被拒", async () => {
  const ctx = await boot();
  try {
    // 三个 Agent：两个用基线脚本、一个挂机。分段上传避免单次测试过长
    const a = await register(ctx, { agentName: "玄武", modelName: "model-A" });
    const b = await register(ctx, { agentName: "朱雀", modelName: "model-B" });
    const c = await register(ctx, { agentName: "挂机者", modelName: "model-C" });
    assert.equal((await uploadScript(ctx, a.key, baseline)).statusCode, 200);
    assert.equal((await uploadScript(ctx, b.key, baseline)).statusCode, 200);
    assert.equal((await uploadScript(ctx, c.key, idle)).statusCode, 200);

    // 未上传的 Agent 不能参赛
    const reg4 = await register(ctx, { agentName: "没交作业" });
    const rejected = await ctx.req({
      method: "POST", url: "/api/tournaments",
      payload: { agentIds: [a.agent.id, reg4.agent.id], gamesPerPair: 1, maxRounds: 30 },
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().error, /尚未通过校验/);

    // 未知地图被拒；指定 arena-01 则赛事记录该地图
    const badMap = await ctx.req({
      method: "POST", url: "/api/tournaments",
      payload: { agentIds: [a.agent.id, b.agent.id], mapId: "no-such-map" },
    });
    assert.equal(badMap.statusCode, 400);
    assert.match(badMap.json().error, /未知地图/);
    const onArena = (await ctx.req({
      method: "POST", url: "/api/tournaments",
      payload: { agentIds: [a.agent.id, b.agent.id], gamesPerPair: 1, maxRounds: 20, mapId: DEFAULT_MAP_MULTI, seed: 5 },
    })).json();
    assert.equal(onArena.mapId, DEFAULT_MAP_MULTI);
    await waitTournament(ctx, onArena.tournamentId);

    const created = (await ctx.req({
      method: "POST", url: "/api/tournaments",
      payload: { agentIds: [a.agent.id, b.agent.id, c.agent.id], gamesPerPair: 2, name: "回归测试赛", seed: 20261019, maxRounds: 60 },
    })).json();
    assert.ok(created.tournamentId);
    assert.equal(created.totalMatches, 6, "3 个 Agent 两两配对 3 对 × 每对 2 局 = 6 局");
    assert.equal(created.mapId, DEFAULT_MAP_1V1, "赛事默认在 1v1 决斗图上打");

    const finished = await waitTournament(ctx, created.tournamentId);
    assert.equal(finished.status, "finished", finished.error ?? "");

    const detail = (await ctx.req({ method: "GET", url: `/api/tournaments/${created.tournamentId}` })).json();
    const standings = detail.standings as { rank: number; agentName: string; played: number; points: number; scoreDiff: number; totalUnitsDeposited: number }[];
    assert.equal(standings.length, 3);
    for (const s of standings) assert.equal(s.played, 4, "每个 Agent 应打 4 局");
    assert.equal(standings.reduce((sum, s) => sum + s.points, 0), 6, "总积分应等于局数");
    assert.equal(standings.find((s) => s.agentName === "挂机者")!.rank, 3, "挂机 Agent 应垫底");
    assert.equal(standings.find((s) => s.agentName === "挂机者")!.totalUnitsDeposited, 0);
    assert.ok(standings.find((s) => s.agentName === "挂机者")!.scoreDiff < 0);

    assert.equal(detail.matches.length, 6);
    for (const m of detail.matches) {
      assert.equal(m.status, "finished");
      // 每局都能回放与看战报（与平台内部流程同权）
      const replay = (await ctx.req({ method: "GET", url: `/api/matches/${m.matchId}/replay` })).json();
      assert.ok(replay.events.length > 20, `对局 ${m.matchId} 应有事件流`);
      assert.equal(replay.ranking.length, 2);
      const report = await ctx.req({ method: "GET", url: `/api/matches/${m.matchId}/report` });
      assert.equal(report.statusCode, 200);
      assert.match(report.body, /赛事对局/);
      assert.match(report.body, /得分明细/);
    }

    // 赛事战报
    const tReport = await ctx.req({ method: "GET", url: `/api/tournaments/${created.tournamentId}/report` });
    assert.equal(tReport.statusCode, 200);
    assert.match(tReport.body, /赛事战报/);
    assert.match(tReport.body, /积分榜/);

    // 列表接口
    const list = (await ctx.req({ method: "GET", url: "/api/tournaments" })).json().tournaments as { id: string; status: string; finishedMatches: number; matchCount: number; mapId?: string }[];
    assert.equal(list.length, 2, "本用例创建了两场赛事（默认图 + 显式 arena-01）");
    const main = list.find((t) => t.id === created.tournamentId)!;
    assert.equal(main.status, "finished");
    assert.equal(main.finishedMatches, 6);
    assert.equal(main.matchCount, 6);
    assert.equal(main.mapId, DEFAULT_MAP_1V1, "列表也要带地图");

    // 排行榜把外部 Agent 也统计进去（按 modelName 聚合）
    const board = (await ctx.req({ method: "GET", url: "/api/leaderboard" })).json().rows as { modelId: string; matches: number }[];
    assert.ok(board.some((r) => r.modelId === "model-A"), "排行榜应包含外部 Agent 的模型");
  } finally { await ctx.close(); }
});

/** 构造一个"高度可压缩"的炸弹样本：10MB 全零压成几 KB，但声明尺寸很大 */
function bombZip(): Buffer {
  const payload = deflateRawSync(Buffer.alloc(10 * 1024 * 1024), { level: 9 });
  const name = Buffer.from("strategy.js");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(10 * 1024 * 1024, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(10 * 1024 * 1024, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const body = Buffer.concat([local, name, payload]);
  const cd = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}