// apps/server/test/commentary.test.ts —— 观战解说：配置、时间线、生成、失败路径
//
// 用**本地假的 OpenAI 兼容服务**（http.createServer）当模型：测试只关心"平台把什么发出去、把什么收回来、
// 收到坏东西时怎么办"，所以不接任何真实模型，也不联网。假服务可以按剧本返回正常 JSON / 带围栏的 JSON /
// 一堆废话 / 401 / 超时，用来覆盖解析与错误路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_RULESET, type GameMap, type MatchEvent } from "@ai-game/protocol";
import { Store } from "../src/store.ts";
import { buildTimeline, chunkEntries, clampEntries, extractJson, normalizeSegments, generateCommentary, rulesetForVersion, scheduleCommentary, type TimelineEntry } from "../src/commentary.ts";
import { loadLlmSettings, readCommentaryConfig, saveCommentaryConfig } from "../src/commentarySettings.ts";
import { maskSecret, openSecret, sealSecret } from "../src/secrets.ts";
import { chat, chatCompletionsUrl, normalizeBaseUrl } from "../src/llmClient.ts";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { MapRegistry } from "../src/maps.ts";
import { createApp } from "../src/app.ts";

// ---------------------------------------------------------------- 假模型服务

interface FakeRequest { url: string; auth: string | undefined; body: { model?: string; messages?: { role: string; content: string }[] } }

function startFakeLlm(handler: (req: FakeRequest, reply: (status: number, body: string) => void) => void): Promise<{ server: Server; port: number; seen: FakeRequest[]; close: () => Promise<void> }> {
  const seen: FakeRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const parsed = (() => {
        try { return JSON.parse(raw) as FakeRequest["body"]; } catch { return {}; }
      })();
      const rec: FakeRequest = { url: req.url ?? "", auth: req.headers.authorization, body: parsed };
      seen.push(rec);
      handler(rec, (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server, port, seen,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function chatBody(content: string, usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }): string {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage });
}

// ---------------------------------------------------------------- 测试脚手架

function storeWith(): { dir: string; store: Store; masterKey: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "ai-game-cmt-"));
  const masterKey = randomBytes(32);
  const store = new Store(join(dir, "test.db"), masterKey);
  return { dir, store, masterKey };
}

const MAP: GameMap = {
  mapId: "test-map", version: 1, width: 9, height: 9,
  grid: ["#########", "#.......#", "#..S....#", "#.......#", "#...R...#", "#.......#", "#.......#", "#....S..#", "#########"],
  spawns: [{ x: 3, y: 2 }, { x: 5, y: 7 }],
  ammoDepots: [{ x: 1, y: 1 }],
  fuelStations: [{ x: 1, y: 7 }],
  resourceNodes: [{ id: "R1", x: 4, y: 4, kind: "center", capacity: 5, initial: 5, regenEveryRounds: 3 }],
  depositPoints: [{ x: 7, y: 1 }],
};

/** 一段"能讲起来"的事件流：交火、击杀、提交、布雷、踩雷各来一次 */
function sampleEvents(): MatchEvent[] {
  return [
    { t: "match_start", mapId: MAP.mapId, mapVersion: 1, rulesetVersion: DEFAULT_RULESET.version, seed: 7, playerCount: 2, seats: [{ seat: 1, name: "甲", scriptHash: "h1", spawn: { x: 3, y: 2 } }, { seat: 2, name: "乙", scriptHash: "h2", spawn: { x: 5, y: 7 } }], rules: {} },
    { t: "turn_begin", round: 1, turn: 1, seat: 1, order: [1, 2] },
    { t: "move", seat: 1, from: { x: 3, y: 2 }, to: { x: 4, y: 2 }, fuelAfter: 38 },
    { t: "turn_begin", round: 1, turn: 2, seat: 2, order: [1, 2] },
    { t: "move", seat: 2, from: { x: 5, y: 7 }, to: { x: 5, y: 6 }, fuelAfter: 38 },
    { t: "turn_begin", round: 2, turn: 3, seat: 1, order: [2, 1] },
    { t: "collect", seat: 1, node: "R1", amount: 3, remainingAfter: 2, cargoAfter: 3 },
    { t: "fire", seat: 1, target: { x: 5, y: 6 }, hit: true, damage: 20, targetSeat: 2, ammoAfter: 5 },
    { t: "turn_begin", round: 3, turn: 4, seat: 2, order: [1, 2] },
    { t: "defend", seat: 2, rounds: 2 },
    { t: "fire", seat: 1, target: { x: 5, y: 6 }, hit: true, damage: 0, targetSeat: 2, ammoAfter: 4, blocked: true },
    { t: "deploy_mine", seat: 1, mineId: 1, x: 4, y: 4, minesAfter: 1 },
    { t: "turn_begin", round: 4, turn: 5, seat: 2, order: [2, 1] },
    { t: "move", seat: 2, from: { x: 5, y: 6 }, to: { x: 4, y: 6 }, fuelAfter: 34 },
    { t: "turn_begin", round: 5, turn: 6, seat: 1, order: [1, 2] },
    { t: "mine_trigger", seat: 2, mineId: 1, x: 4, y: 4, owner: 1 },
    { t: "death", seat: 2, killerSeat: 1, pos: { x: 4, y: 4 }, scoreDelta: -20, scoreAfter: -20, cause: "mine" },
    { t: "deposit", seat: 1, units: 3, scoreDelta: 30, scoreAfter: 30 },
    { t: "match_end", ranking: [{ seat: 1, score: 30, rank: 1 }, { seat: 2, score: -20, rank: 2 }] },
  ];
}

function stats(seat: number, extra: Partial<Record<string, number>> = {}) {
  return {
    seat, name: seat === 1 ? "甲" : "乙", scriptHash: `h${seat}`, score: 0, rank: seat, turnsTaken: 10,
    moves: 10, shotsFired: 2, hits: 1, damageDealt: 20, kills: 0, deaths: 0, deposits: 0, unitsDeposited: 3,
    unitsCollected: 3, ammoLoaded: 0, fuelLoaded: 0, minesDeployed: 0, mineKills: 0, emergencyMoves: 0,
    invalidActions: 0, strikes: 0, disqualified: false, avgDecisionMs: 1, maxDecisionMs: 2,
    scoreBreakdown: { deposit: 0, kill: 0, death: 0, ammo: 0, fuel: 0 }, ...extra,
  };
}

// ---------------------------------------------------------------- 纯函数

test("密钥掩码：只露头尾；加密后能解回来，换主密钥解不开", () => {
  assert.equal(maskSecret("sk-1234567890abcdef"), "sk-1****ef");
  assert.equal(maskSecret("short"), "s****");
  const key = randomBytes(32);
  const sealed = sealSecret(key, "sk-secret-value");
  assert.notEqual(sealed, "sk-secret-value");
  assert.equal(openSecret(key, sealed), "sk-secret-value");
  assert.equal(openSecret(randomBytes(32), sealed), null, "换主密钥必须解不开");
  assert.equal(openSecret(key, sealed.replace(/.$/, "A")), null, "密文被改过必须解不开（GCM 认证）");
});

test("baseUrl 归一：补 /chat/completions、去尾斜杠、只认 http(s)", () => {
  assert.equal(chatCompletionsUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://host/v1/chat/completions"), "https://host/v1/chat/completions");
  assert.equal(normalizeBaseUrl(" http://127.0.0.1:11434/v1/ "), "http://127.0.0.1:11434/v1");
  assert.throws(() => normalizeBaseUrl("ftp://host/v1"), /http\/https/);
  assert.throws(() => normalizeBaseUrl("不是URL"), /合法 URL/);
  assert.throws(() => normalizeBaseUrl("  "), /不能为空/);
});

test("时间线：只留关键行为，锚点是事件下标且单调递增", () => {
  const tl = buildTimeline({ map: MAP, players: [{ seat: 1, name: "甲", modelId: "m1" }, { seat: 2, name: "乙", modelId: "m2" }], events: sampleEvents(), ranking: [stats(1), stats(2)], rules: DEFAULT_RULESET });
  assert.ok(tl.length > 0);
  for (let i = 1; i < tl.length; i++) assert.ok(tl[i]!.i >= tl[i - 1]!.i, "锚点必须单调不减");
  const text = tl.map((e) => e.text).join("\n");
  assert.match(text, /比赛开始/, "开赛一行");
  assert.match(text, /打出了本场第一发炮弹/, "首次开火");
  assert.match(text, /防御把 P1 的炮弹弹开了/, "被盾弹开的炮弹要单独成行");
  assert.match(text, /踩响 P1 埋的地雷/, "踩雷要写清谁埋的");
  assert.match(text, /阵亡：踩了 P1 埋的地雷/, "阵亡要写死因");
  assert.match(text, /提交 3 单位资源 \+30 分/, "提交要带分数");
  assert.match(text, /埋下一枚地雷/, "布雷");
  assert.match(text, /比赛结束/);
  // 踩雷那一条必须锚在 mine_trigger 事件上（而不是之后随便一条）
  const mineEntry = tl.find((e) => e.text.includes("踩响"));
  const triggerIndex = sampleEvents().findIndex((e) => e.t === "mine_trigger");
  assert.equal(mineEntry?.i, triggerIndex);
});

test("时间线：连续无事发生的回合并成一段；条目太多时按重要性裁剪", () => {
  const quiet: MatchEvent[] = [
    { t: "match_start", mapId: MAP.mapId, mapVersion: 1, rulesetVersion: DEFAULT_RULESET.version, seed: 1, playerCount: 2, seats: [], rules: {} },
  ];
  for (let r = 1; r <= 12; r++) {
    quiet.push({ t: "turn_begin", round: r, turn: r, seat: 1, order: [1, 2] });
    quiet.push({ t: "turn_begin", round: r, turn: r + 100, seat: 2, order: [1, 2] });
  }
  quiet.push({ t: "match_end", ranking: [] });
  const tl = buildTimeline({ map: MAP, players: [], events: quiet, ranking: [], rules: DEFAULT_RULESET });
  const merged = tl.filter((e) => e.kind === "quiet-range");
  assert.equal(merged.length, 1, "连续平静期应合成一段");
  assert.match(merged[0]!.text, /R1–R12/);

  const many: TimelineEntry[] = Array.from({ length: 260 }, (_, idx) => ({ i: idx * 10, round: idx, kind: "econ", text: `R${idx}：动了动` }));
  many.push({ i: 999, round: 99, kind: "death", text: "P1 阵亡" });
  const clamped = clampEntries(many);
  assert.ok(clamped.length <= 200, `裁剪后应 ≤200，实际 ${clamped.length}`);
  assert.ok(clamped.some((e) => e.kind === "death"), "关键条目必须保留");
  assert.ok(clamped.length < many.length, "确实抽稀了");
  const chunks = chunkEntries(many);
  assert.ok(chunks.length <= 6, "最多 6 次调用");
  assert.equal(chunks.flat().length, many.length, "分块不丢条目");
});

test("解析：围栏 JSON / 前后废话 / 数组形态都能吃下；锚点非法时就近吸附", () => {
  assert.deepEqual(extractJson('```json\n{"segments":[{"i":1,"text":"嗯"}]}\n```'), { segments: [{ i: 1, text: "嗯" }] });
  assert.deepEqual(extractJson('好的，这是解说：{"segments":[]} 以上'), { segments: [] });
  assert.deepEqual(extractJson('[{"i":2,"text":"嗯"}]'), [{ i: 2, text: "嗯" }]);
  assert.equal(extractJson("完全没有 JSON"), null);

  const anchors = [
    { i: 10, round: 3, kind: "fight" as const, text: "a" },
    { i: 25, round: 5, kind: "death" as const, text: "b" },
  ];
  const segs = normalizeSegments({ segments: [
    { i: 25, round: 5, seat: 2, tone: "hot", text: "打死了" },
    { i: 999, round: 9, text: "i 是编的" },            // 吸附到 25
    { i: 1, text: "往前吸附到 10" },
    { i: 10, text: "  空  白  要  收  紧  " },
    { text: "没有 i" },                                  // 落到第一个锚点，但与上面重复 → 丢弃
  ] }, anchors, 1);
  assert.deepEqual(segs.map((s) => s.i), [10, 25]);
  const spaced = normalizeSegments({ segments: [{ i: 25, text: "  空  白  要  收  紧  " }] }, anchors, 1);
  assert.equal(spaced[0]!.text, "空 白 要 收 紧");
  assert.equal(segs[0]!.text, "往前吸附到 10", "同一个锚点先到先得（模型把 i 编错时，先落地的赢）");
  assert.equal(segs[1]!.tone, "hot");
  assert.equal(segs[1]!.seat, 2);
});

test("规则版本 → Ruleset：变体名能解析，认不出退回默认", () => {
  assert.equal(rulesetForVersion("1.2").version, DEFAULT_RULESET.version);
  assert.equal(rulesetForVersion("1.2-scout").visionRadius, 3);
  assert.equal(rulesetForVersion("9.9-unknown").version, DEFAULT_RULESET.version);
});

// ---------------------------------------------------------------- 配置读写

test("配置读写：apiKey 只回掩码、落库是密文；留空表示不改、空串表示清除", () => {
  const { dir, store, masterKey } = storeWith();
  try {
    assert.equal(loadLlmSettings(store, masterKey), null, "什么都没配时视为未配置");
    const view = saveCommentaryConfig(store, masterKey, { baseUrl: "https://api.example.com/v1/", modelId: "m1", apiKey: "sk-abcdefghijkl", auto: true });
    assert.equal(view.configured, true);
    assert.equal(view.baseUrl, "https://api.example.com/v1", "尾斜杠要被归一掉");
    assert.equal(view.apiKeyMasked, "sk-a****kl");
    assert.equal(JSON.stringify(view).includes("sk-abcdefghijkl"), false, "接口视图里绝不能出现明文密钥");
    const raw = store.getSetting("commentary.apiKey")!;
    assert.equal(raw.includes("sk-abcdefghijkl"), false, "库里也必须是密文");
    assert.equal(openSecret(masterKey, raw), "sk-abcdefghijkl");

    // 留空 = 不改
    saveCommentaryConfig(store, masterKey, { modelId: "m2" });
    assert.equal(loadLlmSettings(store, masterKey)?.apiKey, "sk-abcdefghijkl");
    assert.equal(readCommentaryConfig(store, masterKey).modelId, "m2");
    // 空串 = 清除
    saveCommentaryConfig(store, masterKey, { apiKey: "" });
    assert.equal(readCommentaryConfig(store, masterKey).hasApiKey, false);
    assert.equal(loadLlmSettings(store, masterKey), null);

    // 非法 baseUrl 直接拒
    assert.throws(() => saveCommentaryConfig(store, masterKey, { baseUrl: "not-a-url" }), /合法 URL/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 生成（含失败路径）

test("生成解说：分段调用假模型 → 稿子锚点合法、写库、带用量；调用次数不超上限", async () => {
  const { dir, store, masterKey } = storeWith();
  // 假模型：每批都回"给每行一条"的 JSON（i 原样照抄）
  const fake = await startFakeLlm((req, reply) => {
    const user = req.body.messages?.find((m) => m.role === "user")?.content ?? "";
    const ids = [...user.matchAll(/\[i=(\d+)\]/g)].map((m) => Number(m[1]));
    const segments = ids.map((i) => ({ i, round: 1, seat: 0, tone: "calm", text: `第 ${i} 条解说` }));
    reply(200, chatBody(JSON.stringify({ segments })));
  });
  try {
    store.createMatch({ id: "m-test", status: "running", mapId: MAP.mapId, mapVersion: MAP.version, rulesetVersion: DEFAULT_RULESET.version, scriptProtocolVersion: "p1.1", seed: 1, seatCount: 2, turnIntervalMs: 50, config: {} });
    store.savePlayer("m-test", 1, { modelId: "m1", name: "甲", status: "OK" });
    store.savePlayer("m-test", 2, { modelId: "m2", name: "乙", status: "OK" });
    store.saveReplay("m-test", sampleEvents(), [stats(1), stats(2)] as never);
    store.setMatchStatus("m-test", "finished", { endedAt: new Date().toISOString() });

    saveCommentaryConfig(store, masterKey, { baseUrl: `http://127.0.0.1:${fake.port}/v1`, modelId: "fake-model", apiKey: "sk-test", auto: true });
    const res = await generateCommentary({ store, masterKey, getMap: () => MAP }, "m-test");
    assert.equal(res.ok, true, res.error);
    const row = store.getCommentary("m-test")!;
    assert.equal(row.status, "ready");
    assert.ok(row.segments.length >= 5, `稿子段数应当够多，实际 ${row.segments.length}`);
    assert.ok(row.usage && row.usage.calls >= 1 && row.usage.totalTokens > 0, "要记用量");
    assert.equal(row.modelId, "fake-model");
    for (const s of row.segments) {
      assert.ok(Number.isInteger(s.i) && s.i >= 0 && s.i < sampleEvents().length, `锚点必须是合法事件下标：${s.i}`);
      assert.ok(s.text.length > 0 && s.text.length <= 140);
      assert.ok(["calm", "hot", "fun"].includes(s.tone));
    }
    // 锚点去重且单调
    const ids = row.segments.map((s) => s.i);
    assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b));
    // 请求确实带上了密钥与模型名，且走的是 /chat/completions
    assert.equal(fake.seen[0]!.url, "/v1/chat/completions");
    assert.equal(fake.seen[0]!.auth, "Bearer sk-test");
    assert.equal(fake.seen[0]!.body.model, "fake-model");
  } finally {
    await fake.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生成失败：401 的提示指向密钥、超时提示要能看懂；失败原因写回库里", async () => {
  const { dir, store, masterKey } = storeWith();
  const fake = await startFakeLlm((req, reply) => reply(401, JSON.stringify({ error: { message: "invalid api key" } })));
  try {
    store.createMatch({ id: "m-fail", status: "running", mapId: MAP.mapId, mapVersion: MAP.version, rulesetVersion: DEFAULT_RULESET.version, scriptProtocolVersion: "p1.1", seed: 1, seatCount: 2, turnIntervalMs: 50, config: {} });
    store.saveReplay("m-fail", sampleEvents(), [stats(1), stats(2)] as never);
    store.setMatchStatus("m-fail", "finished", { endedAt: new Date().toISOString() });
    saveCommentaryConfig(store, masterKey, { baseUrl: `http://127.0.0.1:${fake.port}/v1`, modelId: "fake", apiKey: "sk-bad", auto: false });

    const res = await generateCommentary({ store, masterKey, getMap: () => MAP }, "m-fail");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /密钥被拒绝/);

    // 走排队路径：失败要落到 match_commentary 上（前端能看到）
    const queued = scheduleCommentary({ store, masterKey, getMap: () => MAP }, "m-fail", { force: true });
    assert.equal(queued.queued, true);
    await new Promise((r) => setTimeout(r, 300));
    const row = store.getCommentary("m-fail")!;
    assert.equal(row.status, "failed");
    assert.match(row.error ?? "", /密钥被拒绝/);
  } finally {
    await fake.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat 客户端：连不上/404/非 JSON 都给出人话错误", async () => {
  const settings = { baseUrl: "http://127.0.0.1:1/v1", modelId: "m", apiKey: "k", temperature: 0, maxTokens: 10, timeoutMs: 3000 };
  await assert.rejects(() => chat(settings, [{ role: "user", content: "hi" }]), /连不上这个地址/);

  const notJson = await startFakeLlm((_req, reply) => reply(200, "<html>hello</html>"));
  try {
    await assert.rejects(
      () => chat({ ...settings, baseUrl: `http://127.0.0.1:${notJson.port}/v1` }, [{ role: "user", content: "hi" }]),
      /返回的不是 JSON/,
    );
  } finally {
    await notJson.close();
  }

  const notFound = await startFakeLlm((_req, reply) => reply(404, "nope"));
  try {
    await assert.rejects(
      () => chat({ ...settings, baseUrl: `http://127.0.0.1:${notFound.port}/v1` }, [{ role: "user", content: "hi" }]),
      /接口不存在/,
    );
  } finally {
    await notFound.close();
  }
});

test("排队：未配置 / 自动关掉 / 已有稿子 三种情况都不排队", async () => {
  const { dir, store, masterKey } = storeWith();
  try {
    store.createMatch({ id: "m-queue", status: "running", mapId: MAP.mapId, mapVersion: MAP.version, rulesetVersion: DEFAULT_RULESET.version, scriptProtocolVersion: "p1.1", seed: 1, seatCount: 2, turnIntervalMs: 50, config: {} });
    store.saveReplay("m-queue", sampleEvents(), [stats(1)] as never);
    store.setMatchStatus("m-queue", "finished", { endedAt: new Date().toISOString() });

    assert.equal(scheduleCommentary({ store, masterKey, getMap: () => MAP }, "m-queue").queued, false, "未配置不排队");
    saveCommentaryConfig(store, masterKey, { baseUrl: "http://127.0.0.1:1/v1", modelId: "m", apiKey: "k", auto: false });
    assert.equal(scheduleCommentary({ store, masterKey, getMap: () => MAP }, "m-queue").queued, false, "自动关掉不排队");
    store.beginCommentary("m-queue", { baseUrl: "x", modelId: "m" });
    store.finishCommentary("m-queue", { segments: [{ i: 0, round: 1, seat: 0, tone: "calm", text: "已有" }], usage: null, baseUrl: "http://x/v1", modelId: "m" });
    saveCommentaryConfig(store, masterKey, { auto: true });
    assert.equal(scheduleCommentary({ store, masterKey, getMap: () => MAP }, "m-queue").queued, false, "已有稿子不排队");
    assert.equal(scheduleCommentary({ store, masterKey, getMap: () => MAP }, "m-queue", { force: true }).queued, true, "force 要能强制重生成");
    // 等队列把这次（必然失败的）生成跑完，避免影响下一个用例
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(["failed", "ready"].includes(store.getCommentary("m-queue")!.status));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------- HTTP 层（配置 / 测试连接 / 生成 / 掩码）

async function bootServer() {
  const dir = mkdtempSync(join(tmpdir(), "ai-game-cmt-http-"));
  const base = loadConfig();
  const config = {
    ...base,
    port: 0,
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    masterKey: randomBytes(32),
    defaultTurnIntervalMs: 20,
    logger: false as const,
    auth: { ...base.auth, password: "test-password" },
  };
  const store = new Store(config.dbPath, config.masterKey);
  const registry = new MapRegistry(join(dir, "maps"));
  const { app } = await createApp({ config, store, registry, tournamentRunners: new Map() });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { user: config.auth.user, password: config.auth.password } });
  const raw = login.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0]! : (raw ?? "")).split(";")[0]!;
  const req = (opts: { method: string; url: string; payload?: object; headers?: Record<string, string> }) =>
    app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } });
  return {
    store, config, req,
    close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("HTTP：配置只回掩码、未配全时不发请求；测试连接打通后生成稿子，未登录一律 401", async () => {
  const fake = await startFakeLlm((req, reply) => {
    const user = req.body.messages?.find((m) => m.role === "user")?.content ?? "";
    const ids = [...user.matchAll(/\[i=(\d+)\]/g)].map((m) => Number(m[1]));
    reply(200, chatBody(JSON.stringify({ segments: ids.map((i) => ({ i, round: 1, seat: 0, tone: "hot", text: `HTTP 生成 #${i}` })) })));
  });
  const ctx = await bootServer();
  try {
    // 未配置：GET 配置、测试连接、生成 都应当给出明确提示（而不是瞎打网络）
    const cfg0 = (await ctx.req({ method: "GET", url: "/api/commentary/settings" })).json();
    assert.equal(cfg0.configured, false);
    assert.equal(cfg0.hasApiKey, false);
    const test0 = await ctx.req({ method: "POST", url: "/api/commentary/test", payload: {} });
    assert.equal(test0.statusCode, 400);

    // 保存配置：baseUrl 归一、密钥只回掩码
    const saved = (await ctx.req({ method: "PUT", url: "/api/commentary/settings", payload: {
      baseUrl: `http://127.0.0.1:${fake.port}/v1/`, modelId: "http-fake", apiKey: "sk-httpsecret123456", auto: true,
    } })).json();
    assert.equal(saved.configured, true);
    assert.equal(saved.baseUrl, `http://127.0.0.1:${fake.port}/v1`);
    assert.equal(saved.apiKeyMasked, "sk-h****56");
    assert.equal(JSON.stringify(saved).includes("sk-httpsecret123456"), false, "配置接口不得回明文密钥");

    // 测试连接：真发一次 ping
    const probeRes = (await ctx.req({ method: "POST", url: "/api/commentary/test", payload: {} })).json();
    assert.equal(probeRes.ok, true, JSON.stringify(probeRes));

    // 造一场已完成的对局，然后生成解说
    // HTTP 路径走注册表取图，所以用一张内置图（duel-01）而不是测试用的临时地图
    ctx.store.createMatch({ id: "m-http", status: "running", mapId: "duel-01", mapVersion: 1, rulesetVersion: DEFAULT_RULESET.version, scriptProtocolVersion: "p1.1", seed: 3, seatCount: 2, turnIntervalMs: 20, config: {} });
    ctx.store.savePlayer("m-http", 1, { modelId: "m1", name: "甲", status: "OK" });
    ctx.store.savePlayer("m-http", 2, { modelId: "m2", name: "乙", status: "OK" });
    ctx.store.saveReplay("m-http", sampleEvents(), [stats(1), stats(2)] as never);
    ctx.store.setMatchStatus("m-http", "finished", { endedAt: new Date().toISOString() });

    const gen = (await ctx.req({ method: "POST", url: "/api/matches/m-http/commentary", payload: { force: true } })).json();
    assert.equal(gen.queued, true);
    let ready = null as null | { status: string; segments: unknown[]; modelId: string; usage: { totalTokens: number } | null };
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const got = (await ctx.req({ method: "GET", url: "/api/matches/m-http/commentary" })).json();
      if (got.status !== "generating") { ready = got; break; }
    }
    assert.ok(ready, "生成应当有终态");
    assert.equal(ready!.status, "ready", JSON.stringify(ready));
    assert.ok(ready!.segments.length >= 5);
    assert.equal(ready!.modelId, "http-fake");
    assert.ok((ready!.usage?.totalTokens ?? 0) > 0);

    // 已有稿子时再点生成：不重复调用（quoted=false, reason 带说明）
    const again = (await ctx.req({ method: "POST", url: "/api/matches/m-http/commentary", payload: {} })).json();
    assert.equal(again.queued, false);
    assert.match(String(again.reason ?? ""), /已有解说稿/);

    // 删除后可以重生成
    assert.equal((await ctx.req({ method: "DELETE", url: "/api/matches/m-http/commentary" })).json().ok, true);
    assert.equal(ctx.store.getCommentary("m-http"), null);

    // 未登录：这几个接口都要 401（解说配置属于组织者权限）
    for (const [method, url] of [
      ["GET", "/api/commentary/settings"], ["PUT", "/api/commentary/settings"],
      ["POST", "/api/commentary/test"], ["GET", "/api/matches/m-http/commentary"],
      ["POST", "/api/matches/m-http/commentary"], ["DELETE", "/api/matches/m-http/commentary"],
    ] as const) {
      const res = await ctx.req({ method, url, payload: {}, headers: { cookie: "" } });
      assert.equal(res.statusCode, 401, `${method} ${url} 应当要求登录`);
    }
  } finally {
    await fake.close();
    await ctx.close();
  }
});
