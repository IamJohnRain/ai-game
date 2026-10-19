// apps/server/test/server.test.ts —— 服务端接口验收（不占端口：app.inject + 直接构造 Agent/赛事数据）
//
// 平台的唯一参赛链路是"外部 Agent 上传脚本 → 赛事"，所以这里的验收顺序也是：
//   地图/规则 → 地图编辑器（校验/保存/试跑）→ 赛事（Agent → 对局 → 回放/战报/复现键/排行榜）。
// 历史上还有"配置 baseUrl/modelId/Key 调模型"那一套接口，已随功能删除，这里不再覆盖。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_MAP_1V1, DEFAULT_RULESET } from "@ai-game/protocol";
import { SCRIPT_PROTOCOL_VERSION } from "@ai-game/prompt";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { MapRegistry } from "../src/maps.ts";
import { createApp } from "../src/app.ts";
import { TournamentRunner } from "../src/tournaments.ts";

const dirs: string[] = [];

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "ai-game-test-"));
  dirs.push(dir);
  const config: ServerConfig = {
    ...loadConfig(),
    port: 0,
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    masterKey: randomBytes(32),
    defaultTurnIntervalMs: 20,
    logger: false,
  };
  const store = new Store(config.dbPath, config.masterKey);
  const registry = new MapRegistry(join(dir, "maps"));
  const tournamentRunners = new Map<string, TournamentRunner>();
  const { app } = await createApp({ config, store, registry, tournamentRunners });
  await app.ready();
  return {
    app, store, registry, config, tournamentRunners,
    close: async () => {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
      const i = dirs.indexOf(dir);
      if (i >= 0) dirs.splice(i, 1);
    },
  };
}

type Ctx = Awaited<ReturnType<typeof boot>>;

/** 直接落库一个"已通过校验的 Agent"（不走 zip 上传：上传闸门由 external.test.ts 覆盖） */
function seedAgent(ctx: Ctx, agentName: string, modelName: string, script: string): string {
  const id = `ag_${Math.random().toString(36).slice(2, 10)}`;
  ctx.store.createAgent({
    id, modelName, agentName, thinkingLevel: "high", notes: "",
    keyHash: `hash_${id}`, keyMasked: "ag_****test", maxAttempts: 10,
  });
  ctx.store.markAgentUploaded(id, {
    script, scriptSha256: `sha_${id}`, zipSha256: `zip_${id}`, zipBytes: 1024,
    validation: [{ stage: "smoke", mapId: "duel-01", ok: true }],
  });
  return id;
}

async function waitTournament(ctx: Ctx, id: string, timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    const t = ctx.store.getTournament(id)!;
    if (t.status === "finished" || t.status === "failed") return t;
    if (Date.now() - started > timeoutMs) throw new Error(`等待赛事结束超时，当前 ${t.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("健康检查、地图、规则接口", async () => {
  const ctx = await boot();
  try {
    const health = (await ctx.app.inject({ method: "GET", url: "/api/health" })).json();
    assert.equal(health.ok, true);
    assert.ok(health.maps.includes("arena-01"));
    assert.ok(health.maps.includes("duel-01"));
    assert.deepEqual(health.builtinMaps.sort(), ["arena-01", "duel-01"]);
    assert.equal(health.defaultMap1v1, DEFAULT_MAP_1V1);
    assert.equal(health.scriptProtocolVersion, SCRIPT_PROTOCOL_VERSION);
    assert.equal(health.rulesetVersion, "1.1");
    // 模型接入相关的字段不该再出现在健康检查里
    assert.equal(health.presets, undefined);

    const maps = (await ctx.app.inject({ method: "GET", url: "/api/maps" })).json();
    assert.equal(maps.length, 2);
    const arena = maps.find((m: { mapId: string }) => m.mapId === "arena-01");
    assert.equal(arena.version, 2, "地图已升到 @2（中心加油点）");
    assert.equal(arena.custom, false);
    assert.equal(arena.errorCount, 0);
    assert.ok(arena.warningCount >= 0);

    const map = (await ctx.app.inject({ method: "GET", url: "/api/maps/arena-01" })).json();
    assert.ok(map.ascii.split("\n").length === 24);
    assert.equal(map.map.fuelStations.length, 12);
    assert.equal(map.audit.errors.length, 0, JSON.stringify(map.audit.errors));
    assert.ok(map.audit.distances.spawn_to_deposit > 0, "审计应给出实测距离参考");

    const rules = (await ctx.app.inject({ method: "GET", url: "/api/rulesets/latest" })).json();
    assert.equal(rules.shellDamage, 20);
    assert.equal(rules.deathPenalty, 20);
  } finally { await ctx.close(); }
});

test("地图编辑器接口：草稿校验 → 保存 → 注册表可见 → 删除", async () => {
  const ctx = await boot();
  try {
    // 用 1v1 决斗图当起点改一张四向对称的小图（比 32×24 好数格子）
    const duel = ctx.registry.get("duel-01")!;
    const draft = {
      ...duel,
      mapId: "custom-test",
      version: 1,
      hint: "测试图",
      distanceReference_P1: undefined,
    };

    // 1) 校验（不落盘）
    const validated = (await ctx.app.inject({ method: "POST", url: "/api/maps/validate", payload: draft })).json();
    assert.equal(validated.ok, true, JSON.stringify(validated.audit?.errors));
    assert.equal(validated.audit.stats.width, duel.width);

    // 2) 内置地图 id 不许占用
    const clash = await ctx.app.inject({ method: "POST", url: "/api/maps", payload: { ...draft, mapId: "duel-01" } });
    assert.equal(clash.statusCode, 400);
    assert.match(clash.json().error, /内置地图/);

    // 3) 非法 id
    const badId = await ctx.app.inject({ method: "POST", url: "/api/maps", payload: { ...draft, mapId: "Bad_ID" } });
    assert.equal(badId.statusCode, 400);

    // 4) 破坏对称（只在左上角凿一格墙）→ 校验必须报出来
    const rows = [...draft.grid];
    rows[1] = "." + rows[1]!.slice(1);
    const asymmetric = (await ctx.app.inject({ method: "POST", url: "/api/maps/validate", payload: { ...draft, grid: rows } })).json();
    assert.equal(asymmetric.ok, false);
    assert.ok(asymmetric.audit.errors.some((e: string) => e.includes("镜像")), JSON.stringify(asymmetric.audit.errors));

    // 5) 保存：服务端会重算距离参考
    const saved = (await ctx.app.inject({ method: "POST", url: "/api/maps", payload: draft })).json();
    assert.equal(saved.ok, true, JSON.stringify(saved.audit?.errors));
    assert.equal(saved.mapId, "custom-test");
    assert.ok(saved.audit.distances.spawn_to_deposit > 0);

    const list = (await ctx.app.inject({ method: "GET", url: "/api/maps" })).json();
    assert.equal(list.length, 3);
    assert.equal(list.find((m: { mapId: string }) => m.mapId === "custom-test").custom, true);

    // 6) 落盘了、能再次读出来，并且距离参考是按实测写进文件的
    const again = (await ctx.app.inject({ method: "GET", url: "/api/maps/custom-test" })).json();
    assert.equal(again.custom, true);
    assert.ok(again.map.distanceReference_P1.spawn_to_deposit > 0);
    const onDisk = JSON.parse(readFileSync(join(ctx.config.dataDir, "maps", "custom-test.json"), "utf8"));
    assert.equal(onDisk.mapId, "custom-test");
    assert.equal(onDisk.distanceReference_P1.spawn_to_deposit, again.map.distanceReference_P1.spawn_to_deposit);

    // 7) 新实例（模拟服务重启）能把它加载回来
    const reloaded = new MapRegistry(join(ctx.config.dataDir, "maps"));
    assert.ok(reloaded.get("custom-test"), "重启后自定义地图应仍在注册表里");

    // 8) 删除：内置的删不掉，自定义的可以
    const delBuiltin = await ctx.app.inject({ method: "DELETE", url: "/api/maps/duel-01" });
    assert.equal(delBuiltin.statusCode, 400);
    const del = await ctx.app.inject({ method: "DELETE", url: "/api/maps/custom-test" });
    assert.equal(del.statusCode, 200);
    assert.equal((await ctx.app.inject({ method: "GET", url: "/api/maps" })).json().length, 2);
  } finally { await ctx.close(); }
});

test("地图编辑器：坏图必须被拦住（不可达设施 / 缺设施 / 越界出生点）", async () => {
  const ctx = await boot();
  try {
    const duel = ctx.registry.get("duel-01")!;
    // 把唯一提交点用墙围起来 → 从出生点不可达
    const grid = [...duel.grid];
    const ring = (x: number, y: number) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (ny < 0 || ny >= duel.height) continue;
        grid[ny] = grid[ny]!.slice(0, nx) + "#" + grid[ny]!.slice(nx + 1);
      }
    };
    const [dx0, dy0] = [duel.depositPoints[0]!.x, duel.depositPoints[0]!.y];
    // 围一圈并把镜像位置也围上，保证"对称但不可达"，这样错误一定来自可达性而不是对称性
    ring(dx0, dy0);
    ring(duel.width - 1 - dx0, duel.height - 1 - dy0);
    for (let y = 0; y < duel.height; y++) {
      for (let x = 0; x < Math.floor(duel.width / 2); x++) {
        // 用镜像复制的方式保证对称：以 (x,y) 为准覆盖三个镜像点
        const ch = grid[y]![x]!;
        const set = (px: number, py: number) => { grid[py] = grid[py]!.slice(0, px) + ch + grid[py]!.slice(px + 1); };
        set(duel.width - 1 - x, y);
        set(x, duel.height - 1 - y);
        set(duel.width - 1 - x, duel.height - 1 - y);
      }
    }
    const res = (await ctx.app.inject({
      method: "POST", url: "/api/maps/validate",
      payload: { ...duel, mapId: "walled", grid },
    })).json();
    assert.equal(res.ok, false);
    assert.ok(res.audit.errors.length > 0);

    // 去掉所有弹药补给点：审计必须报"缺设施"
    const noAmmo = (await ctx.app.inject({
      method: "POST", url: "/api/maps/validate",
      payload: {
        ...duel,
        mapId: "no-ammo",
        ammoDepots: [],
        grid: duel.grid.map((row: string) => row.replace(/B/g, ".").replace(/A/g, ".")),
      },
    })).json();
    assert.equal(noAmmo.ok, false);
    assert.ok(noAmmo.audit.errors.some((e: string) => e.includes("弹药")), JSON.stringify(noAmmo.audit.errors));

    // spawnsFor1v1 指向不存在的出生点
    const badPair = (await ctx.app.inject({
      method: "POST", url: "/api/maps/validate",
      payload: { ...duel, mapId: "bad-pair", spawnsFor1v1: [1, 9] },
    })).json();
    assert.equal(badPair.ok, false);
    assert.ok(badPair.audit.errors.some((e: string) => e.includes("spawnsFor1v1")));

    // 尺寸越界
    const huge = (await ctx.app.inject({
      method: "POST", url: "/api/maps/validate",
      payload: { ...duel, mapId: "huge", width: 80, height: 80 },
    })).json();
    assert.equal(huge.ok, false);

    // 落盘也要拦住：坏图不进注册表
    const saveBad = await ctx.app.inject({
      method: "POST", url: "/api/maps",
      payload: { ...duel, mapId: "walled", grid },
    });
    assert.equal(saveBad.statusCode, 400);
    assert.ok(!ctx.registry.get("walled"));
  } finally { await ctx.close(); }
});

test("试跑：在草稿图上用基线脚本跑一局，给出交火与经济的结论", async () => {
  const ctx = await boot();
  try {
    // 用 duel-01 的草稿（未保存）直接试跑
    const duel = ctx.registry.get("duel-01")!;
    const res = (await ctx.app.inject({
      method: "POST", url: "/api/maps/playtest",
      payload: { map: duel, seed: 20261019, maxRounds: 60 },
    })).json();
    assert.equal(res.ok, true, JSON.stringify(res.verdicts));
    assert.equal(res.mapId, "duel-01");
    assert.equal(res.ranking.length, 2);
    assert.equal(res.spawns.length, 2);
    assert.ok(res.combat.fires > 0, "决斗图必须打起来");
    assert.ok(res.combat.firstFireRound !== null && res.combat.firstFireRound <= 12, `首次交火过早/过晚：${res.combat.firstFireRound}`);
    assert.ok(res.economy.unitsDeposited > 0, "基线脚本应当有提交收入");
    assert.ok(res.verdicts.some((v: string) => v.startsWith("✅")), JSON.stringify(res.verdicts));

    // 用 mapId 引用已注册地图也行；未知 mapId 要 404
    const byId = (await ctx.app.inject({ method: "POST", url: "/api/maps/playtest", payload: { mapId: "duel-01", maxRounds: 20 } })).json();
    assert.equal(byId.mapId, "duel-01");
    const notFound = await ctx.app.inject({ method: "POST", url: "/api/maps/playtest", payload: { mapId: "nope" } });
    assert.equal(notFound.statusCode, 404);
    const noTarget = await ctx.app.inject({ method: "POST", url: "/api/maps/playtest", payload: {} });
    assert.equal(noTarget.statusCode, 400);
  } finally { await ctx.close(); }
});

test("赛事全链路：Agent → 1v1 循环赛 → 回放/战报/复现键/排行榜/WebSocket 快照", async () => {
  const ctx = await boot();
  try {
    const baseline = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "examples", "baseline-strategy.js"), "utf8");
    const a = seedAgent(ctx, "玄武", "DeepSeek-V3", baseline);
    const b = seedAgent(ctx, "朱雀", "GPT-X", baseline);

    const created = (await ctx.app.inject({
      method: "POST", url: "/api/tournaments",
      payload: { agentIds: [a, b], gamesPerPair: 2, mapId: "duel-01", seed: 4242, maxRounds: 40, name: "验收赛" },
    })).json();
    assert.ok(created.tournamentId);
    assert.equal(created.mapId, "duel-01");
    assert.equal(created.totalMatches, 2);

    // 参数校验：不存在的地图 / 未入库的 Agent
    const badMap = await ctx.app.inject({ method: "POST", url: "/api/tournaments", payload: { agentIds: [a, b], mapId: "nope" } });
    assert.equal(badMap.statusCode, 400);
    const notUploaded = seedAgent(ctx, "待上传", "m", baseline);
    ctx.store.deleteAgent(notUploaded); // 删掉后即"不存在"
    const badAgent = await ctx.app.inject({ method: "POST", url: "/api/tournaments", payload: { agentIds: [a, notUploaded] } });
    assert.equal(badAgent.statusCode, 400);

    const t = await waitTournament(ctx, created.tournamentId);
    assert.equal(t.status, "finished", t.error ?? "");
    assert.equal(t.scriptProtocolVersion, SCRIPT_PROTOCOL_VERSION);
    assert.equal(t.mapId, "duel-01");
    assert.equal(t.matchIds.length, 2);

    const detail = (await ctx.app.inject({ method: "GET", url: `/api/tournaments/${created.tournamentId}` })).json();
    assert.equal(detail.standings.length, 2);
    assert.equal(detail.matches.length, 2);
    assert.equal(detail.tournament.mapId, "duel-01");
    for (const m of detail.matches) {
      assert.equal(m.seats.length, 2);
      assert.ok(m.seats.every((s: { agentId: string }) => s.agentId === a || s.agentId === b), "agentId 应逐局落库（不依赖内存）");
      assert.equal(m.status, "finished");
    }
    // 每一对打 2 局且种子相同 → 双方各占一次出生点，总分差应当收敛（位置优势被抵消）
    const totals = new Map<string, number>();
    for (const m of detail.matches) {
      for (const s of m.seats) totals.set(s.agentId, (totals.get(s.agentId) ?? 0) + s.score);
    }
    assert.equal(totals.size, 2);

    // 逐局检查回放/战报/复现键
    for (const matchId of t.matchIds) {
      const replay = (await ctx.app.inject({ method: "GET", url: `/api/matches/${matchId}/replay` })).json();
      assert.ok(replay.events.length > 50);
      assert.equal(replay.events[0].t, "match_start");
      assert.equal(replay.events[replay.events.length - 1].t, "match_end");
      assert.equal(replay.match.mapId, "duel-01");
      assert.equal(replay.match.scriptProtocolVersion, SCRIPT_PROTOCOL_VERSION);
      assert.match(replay.match.reproducibilityKey, /^[0-9a-f]{64}$/, "复现键必须落库（64 位 hex）");
      assert.equal(replay.ranking.length, 2);
      assert.ok(replay.ranking[0].score >= replay.ranking[1].score, "排名按分数降序");
      for (const st of replay.ranking) {
        const bd = st.scoreBreakdown;
        assert.equal(st.score, bd.deposit + bd.kill + bd.death + bd.ammo + bd.fuel, "总分必须等于明细之和");
      }
      const players = replay.players;
      assert.equal(players.length, 2);
      for (const p of players) {
        assert.equal(p.status, "OK");
        assert.ok(p.script && p.script.includes("function onTurn"));
        assert.ok(p.agentId === a || p.agentId === b);
      }

      const report = await ctx.app.inject({ method: "GET", url: `/api/matches/${matchId}/report` });
      assert.equal(report.statusCode, 200);
      assert.match(report.headers["content-type"] as string, /markdown/);
      assert.match(report.body, /# 坦克对战战报/);
      assert.match(report.body, /## 排名/);
      assert.match(report.body, /得分明细/);
      assert.match(report.body, /复现键/);
      assert.match(report.body, /脚本与准入校验/);
      // 战报里不该再出现"模型接入"那一套字段
      assert.doesNotMatch(report.body, /token（入\/出）|finish_reason|修复轮/);
    }

    // 赛事战报（Markdown）
    const tReport = await ctx.app.inject({ method: "GET", url: `/api/tournaments/${created.tournamentId}/report` });
    assert.equal(tReport.statusCode, 200);
    assert.match(tReport.body, /## 积分榜/);
    assert.match(tReport.body, /duel-01/);

    // 复现键口径：同图同种子同脚本 → 同一把键；换种子 → 换键
    const firstId = t.matchIds[0]!;
    const again = ctx.store.getMatch(firstId)!;
    assert.equal(again.reproducibilityKey, ctx.store.getMatch(firstId)!.reproducibilityKey);
    const other = ctx.store.getMatch(t.matchIds[1]!);
    assert.notEqual(again.reproducibilityKey, other!.reproducibilityKey, "不同种子/座位顺序应产生不同复现键");

    // 排行榜：按 Agent 声明的模型名聚合
    const board = (await ctx.app.inject({ method: "GET", url: "/api/leaderboard" })).json();
    assert.equal(board.rows.length, 2);
    assert.deepEqual(board.rows.map((r: { modelId: string }) => r.modelId).sort(), ["DeepSeek-V3", "GPT-X"]);
    assert.ok(board.rows.every((r: { matches: number }) => r.matches === 2));

    // 赛事列表
    const list = (await ctx.app.inject({ method: "GET", url: "/api/tournaments" })).json();
    const row = list.tournaments.find((x: { id: string }) => x.id === created.tournamentId)!;
    assert.equal(row.status, "finished");
    assert.equal(row.mapId, "duel-01");
    assert.equal(row.scriptProtocolVersion, SCRIPT_PROTOCOL_VERSION);

    // 同配置再战：新种子 + 同一张图 + 同一对 Agent
    const rematch = (await ctx.app.inject({ method: "POST", url: `/api/matches/${firstId}/rematch` })).json();
    assert.ok(rematch.tournamentId && rematch.tournamentId !== created.tournamentId);
    assert.equal(rematch.mapId, "duel-01");
    const t2 = await waitTournament(ctx, rematch.tournamentId);
    assert.equal(t2.status, "finished", t2.error ?? "");
    assert.deepEqual([...t2.agentIds].sort(), [a, b].sort());
    assert.notEqual(t2.seed, t.seed, "复赛必须换种子");

    // WebSocket：用真实 ws 客户端连本进程监听的端口（观战页走的就是这条路）
    const addr = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const wsUrl = addr.replace(/^http/, "ws");
    type WsFrame = { type: string; data: { match?: { id: string }; events?: unknown[]; players?: unknown[]; ranking?: unknown[]; phase?: string } };
    const collect = async (path: string, until: (frames: WsFrame[]) => boolean, timeoutMs = 8000): Promise<WsFrame[]> => {
      const socket = new WebSocket(`${wsUrl}${path}`);
      const frames: WsFrame[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 WS 消息超时：${JSON.stringify(frames)}`)), timeoutMs);
        socket.addEventListener("message", (ev: MessageEvent) => {
          frames.push(JSON.parse(String((ev as { data: unknown }).data)) as WsFrame);
          if (until(frames)) { clearTimeout(timer); resolve(); }
        });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS 连接出错")); });
      });
      socket.close();
      return frames;
    };

    const frames = await collect(`/ws/matches/${firstId}`, (f) => f.some((x) => x.type === "end"));
    const snapshot = frames.find((f) => f.type === "snapshot")!;
    assert.ok(snapshot, JSON.stringify(frames));
    assert.equal(snapshot.data.match!.id, firstId);
    assert.equal(snapshot.data.players!.length, 2);
    assert.ok(snapshot.data.events!.length > 50);
    assert.equal(snapshot.data.ranking!.length, 2);
    assert.ok(frames.some((f) => f.type === "end"));

    // 未知比赛：快照带 failed 阶段（而不是静默断开）
    const badFrames = await collect("/ws/matches/does-not-exist", (f) => f.some((x) => x.type === "phase"), 3000);
    assert.equal(badFrames.find((f) => f.type === "phase")!.data.phase, "failed");
  } finally { await ctx.close(); }
});

test("赛事用的自定义地图：保存后可直接当赛图，且距离参考按实测写进地图", async () => {
  const ctx = await boot();
  try {
    const baseline = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "examples", "baseline-strategy.js"), "utf8");
    const a = seedAgent(ctx, "A", "M1", baseline);
    const b = seedAgent(ctx, "B", "M2", baseline);

    const duel = ctx.registry.get("duel-01")!;
    const saved = (await ctx.app.inject({
      method: "POST", url: "/api/maps",
      payload: { ...duel, mapId: "mini-duel", version: 1, hint: "赛事用自定义图", distanceReference_P1: undefined },
    })).json();
    assert.equal(saved.ok, true, JSON.stringify(saved.audit?.errors));

    const created = (await ctx.app.inject({
      method: "POST", url: "/api/tournaments",
      payload: { agentIds: [a, b], gamesPerPair: 2, mapId: "mini-duel", seed: 7, maxRounds: 30 },
    })).json();
    assert.equal(created.mapId, "mini-duel");
    const t = await waitTournament(ctx, created.tournamentId);
    assert.equal(t.status, "finished", t.error ?? "");
    assert.equal(t.mapId, "mini-duel");
    const replay = (await ctx.app.inject({ method: "GET", url: `/api/matches/${t.matchIds[0]}/replay` })).json();
    assert.equal(replay.match.mapId, "mini-duel");
    assert.ok(replay.events.length > 20);
  } finally { await ctx.close(); }
});

test("对局查询接口的边界", async () => {
  const ctx = await boot();
  try {
    const notFound = await ctx.app.inject({ method: "GET", url: "/api/matches/nope" });
    assert.equal(notFound.statusCode, 404);
    const noReplay = await ctx.app.inject({ method: "GET", url: "/api/matches/nope/replay" });
    assert.equal(noReplay.statusCode, 404);
    // 不存在的地图
    const noMap = await ctx.app.inject({ method: "GET", url: "/api/maps/nope" });
    assert.equal(noMap.statusCode, 404);
    const noRules = await ctx.app.inject({ method: "GET", url: "/api/rulesets/9.9" });
    assert.equal(noRules.statusCode, 404);
    assert.equal(DEFAULT_RULESET.version, "1.1");
  } finally { await ctx.close(); }
});