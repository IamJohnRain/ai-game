// apps/server/src/app.ts —— HTTP + WebSocket 路由（与进程监听解耦，便于用 app.inject 测试）
//
// 平台的对外形态只有一条链路：**外部 Agent 自助接入**（注册 → 任务书 → 上传 zip → 1v1 赛事）。
// 因此这里只有四类接口：地图/规则、Agent、赛事（含对局回放与战报）、观战 WebSocket。
// 历史上还有"平台自己配置 baseUrl/modelId/Key 去调用大模型生成脚本"的一整套接口，已按需求删除。
import Fastify, { type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAP_1V1, DEFAULT_RULESET, GameMapSchema, RULESET_VERSION, renderAscii, type GameMap } from "@ai-game/protocol";
import { SCRIPT_PROTOCOL_VERSION } from "@ai-game/prompt";
import type { ServerConfig } from "./config.ts";
import type { MapRegistry } from "./maps.ts";
import { Store } from "./store.ts";
import { registerExternalRoutes } from "./routesExternal.ts";
import { registerCohortRoutes } from "./routesCohorts.ts";
import type { CohortRunner } from "./cohorts.ts";
import { TournamentRunner } from "./tournaments.ts";
import {
  Auth,
  clearSessionCookieValue,
  isPublicRoute,
  parseCookies,
  safeNextPath,
  sessionCookieValue,
  SESSION_COOKIE,
} from "./auth.ts";
import { renderLoginPage } from "./loginPage.ts";
import { commentaryBusy, scheduleCommentary, type CommentaryDeps } from "./commentary.ts";
import { loadLlmSettings, readCommentaryConfig, saveCommentaryConfig } from "./commentarySettings.ts";
import { probe } from "./llmClient.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

export interface AppDeps {
  config: ServerConfig;
  store: Store;
  /** 地图注册表（内置 + 自定义）；测试里可注入一个指向临时目录的实例 */
  registry: MapRegistry;
  /** 赛事运行器（可选注入，便于测试观察） */
  tournamentRunners?: Map<string, TournamentRunner>;
  /** 评测批次运行器（可选注入，便于测试观察） */
  cohortRunners?: Map<string, CohortRunner>;
}

/** 构建 Fastify 实例（与进程监听解耦，便于测试用 app.inject 直接打接口） */
export async function createApp(deps: AppDeps) {
  const config = deps.config;
  const store = deps.store;
  const registry = deps.registry;
  const tournamentRunners = deps.tournamentRunners ?? new Map<string, TournamentRunner>();
  const cohortRunners = deps.cohortRunners ?? new Map<string, CohortRunner>();
  const app = Fastify({ logger: deps.config.logger ?? { level: process.env.LOG_LEVEL ?? "info" } });
  const auth = new Auth(deps.config.auth);

  await app.register(websocket);

// ------------------------------------------------------------------ 会话守卫
// 白名单之外的一切（页面 / 静态资源 / /api / /ws）都要求登录：
//   - /api/* 与 /ws/* 回 401（前端拿到 401 会跳登录页；WebSocket 握手拿不到自定义头，靠 Cookie）
//   - 其余请求 302 到 /login?next=…（未登录时前端 bundle 不下发，见 loginPage.ts 的注释）
// 免登录的只有：任务书（外部 Agent 要读，GET /api/task-doc）、上传（改用一次性密钥把关，见 routesExternal.ts）、
// 登录页与登录/登出接口本身。守卫必须注册在**所有路由之前**，Fastify 的 hook 只对其后注册的路由生效。
app.addHook("onRequest", async (req, reply) => {
  if (isPublicRoute(req.method, req.url)) return;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (auth.authenticate(token)) return;
  const path = req.url.split("?")[0] ?? "";
  if (path.startsWith("/api/") || path.startsWith("/ws/")) {
    return reply.code(401).send({ ok: false, stage: "auth", error: "未登录或会话已过期，请先登录" });
  }
  return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
});

// ------------------------------------------------------------------ 登录 / 登出 / 我是谁
app.get("/login", async (req, reply) => {
  const next = safeNextPath((req.query as { next?: string }).next);
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (auth.authenticate(token)) return reply.redirect(next); // 已登录就别再看登录页
  reply.header("content-type", "text/html; charset=utf-8");
  reply.header("cache-control", "no-store");
  return renderLoginPage({ next });
});

app.post("/api/auth/login", async (req, reply) => {
  const body = (req.body ?? {}) as { user?: unknown; password?: unknown };
  const user = typeof body.user === "string" ? body.user : "";
  const password = typeof body.password === "string" ? body.password : "";
  const result = auth.login(user, password, req.ip);
  if (!result.ok) {
    if (result.status === 429) app.log.warn({ ip: req.ip }, "登录被限流");
    reply.code(result.status);
    return { ok: false, error: result.error };
  }
  reply.header("set-cookie", sessionCookieValue(result.token, auth.sessionTtlMs, auth.cookieSecure));
  app.log.info({ ip: req.ip, user: auth.user }, "登录成功");
  return { ok: true, user: auth.user, expiresAt: new Date(result.expiresAt).toISOString() };
});

app.post("/api/auth/logout", async (req, reply) => {
  auth.logout(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  reply.header("set-cookie", clearSessionCookieValue());
  return { ok: true };
});

app.get("/api/auth/me", async (req, reply) => {
  const session = auth.authenticate(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) return fail(reply, 401, "未登录或会话已过期");
  return { user: session.user, expiresAt: new Date(session.expiresAt).toISOString() };
});

// ------------------------------------------------------------------ 工具
function fail(reply: FastifyReply, code: number, message: string): undefined {
  void reply.code(code).send({ error: message });
  return undefined;
}
function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ------------------------------------------------------------------ 健康检查 / 规则 / 地图
app.get("/api/health", async () => ({
  ok: true,
  version: "0.1.0",
  rulesetVersion: RULESET_VERSION,
  scriptProtocolVersion: SCRIPT_PROTOCOL_VERSION,
  maps: registry.ids(),
  builtinMaps: registry.ids().filter((id) => registry.isBuiltin(id)),
  defaultMap1v1: DEFAULT_MAP_1V1,
}));

app.get("/api/rulesets/:version", async (req, reply) => {
  const version = (req.params as { version: string }).version;
  if (version !== RULESET_VERSION && version !== "latest") return fail(reply, 404, `未知规则版本 ${version}`);
  return DEFAULT_RULESET;
});

// 地图列表：带上审计摘要（错误/警告条数），前端一眼就能看出哪张图"还没打磨好"
app.get("/api/maps", async () => registry.list().map((m) => {
  const audit = registry.validate(m);
  return {
    mapId: m.mapId,
    version: m.version,
    width: m.width,
    height: m.height,
    hint: m.hint ?? "",
    is1v1Default: m.mapId === DEFAULT_MAP_1V1,
    custom: registry.isCustom(m.mapId),
    errorCount: audit.errors.length,
    warningCount: audit.warnings.length,
    spawns: m.spawns.length,
  };
}));

app.get("/api/maps/skipped", async () => ({ skipped: registry.skipped() }));

app.get("/api/maps/:mapId", async (req, reply) => {
  const mapId = (req.params as { mapId: string }).mapId;
  const map = registry.get(mapId);
  if (!map) return fail(reply, 404, `未知地图 ${mapId}（可用：${registry.ids().join(", ")}）`);
  return { map, ascii: renderAscii(map), audit: registry.validate(map), custom: registry.isCustom(mapId) };
});

// ------------------------------------------------------------------ 地图编辑器：校验 / 保存 / 试跑 / 删除
// 载荷形状校验交给 zod，玩法审计交给 engine.auditMap —— 与服务端保存、上传校验完全同一套判据。
function parseDraft(body: unknown): { map: GameMap } | { error: string } {
  const parsed = GameMapSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`);
    return { error: `地图字段不合法：${issues.join("; ")}` };
  }
  return { map: parsed.data };
}

/** 保存前的预览/校验（不落盘）。返回审计 + 1v1 出生点预览，前端据此实时提示。 */
app.post("/api/maps/validate", async (req, reply) => {
  const draft = parseDraft(req.body);
  if ("error" in draft) return fail(reply, 400, draft.error);
  const audit = registry.validate(draft.map);
  return { ok: audit.errors.length === 0, audit, mapId: draft.map.mapId };
});

app.post("/api/maps", async (req, reply) => {
  const draft = parseDraft(req.body);
  if ("error" in draft) return fail(reply, 400, draft.error);
  const result = registry.save(draft.map);
  if (!result.ok) return reply.code(400).send({ ok: false, error: result.detail ?? "地图未通过校验", audit: result.audit });
  return { ok: true, mapId: draft.map.mapId, audit: result.audit };
});

app.delete("/api/maps/:mapId", async (req, reply) => {
  const mapId = (req.params as { mapId: string }).mapId;
  const result = registry.remove(mapId);
  if (!result.ok) return fail(reply, 400, result.detail ?? "删除失败");
  return { ok: true };
});

/**
 * 试跑：用平台基线脚本在自己的地图上打一局（双方都是基线），把"能不能打起来"跑成数字。
 * 这是地图编辑器最后一步"可用性校验"——结构对不对由审计回答，打不打得起来由这一局回答。
 */
app.post("/api/maps/playtest", async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let map: GameMap | null = null;
  if (body.map !== undefined) {
    const draft = parseDraft(body.map);
    if ("error" in draft) return fail(reply, 400, draft.error);
    map = draft.map;
  } else if (typeof body.mapId === "string") {
    map = registry.get(body.mapId);
    if (!map) return fail(reply, 404, `未知地图 ${body.mapId}`);
  }
  if (!map) return fail(reply, 400, "需要提供 map（草稿对象）或 mapId");
  const seed = Number.isInteger(body.seed) ? Number(body.seed) : 20261019;
  const rules = Number.isFinite(Number(body.maxRounds))
    ? { ...DEFAULT_RULESET, maxRounds: Math.max(10, Number(body.maxRounds)) }
    : DEFAULT_RULESET;

  const { QuickJsController } = await import("@ai-game/sandbox");
  const { assignSpawns, runMatch } = await import("@ai-game/engine");
  const baseline = readFileSync(join(repoRoot, "docs", "examples", "baseline-strategy.js"), "utf8");
  const controller = await QuickJsController.create({});
  controller.load(1, baseline);
  controller.load(2, baseline);
  try {
    const result = runMatch({
      matchId: `playtest_${Date.now().toString(36)}`,
      map,
      rules,
      seed,
      seats: [
        { seat: 1, name: "基线脚本 A", scriptHash: "baseline" },
        { seat: 2, name: "基线脚本 B", scriptHash: "baseline" },
      ],
      spawns: assignSpawns(map, [1, 2], seed),
      controller,
    });
    let round = 0;
    let firstFireRound: number | null = null;
    let fires = 0;
    let hits = 0;
    for (const ev of result.events) {
      if (ev.t === "turn_begin") round = ev.round;
      else if (ev.t === "fire") {
        fires += 1;
        if (ev.hit) hits += 1;
        if (firstFireRound === null) firstFireRound = round;
      }
    }
    const kills = result.ranking.reduce((s, r) => s + r.kills, 0);
    const units = result.ranking.reduce((s, r) => s + r.unitsDeposited, 0);
    const invalid = result.ranking.reduce((s, r) => s + r.invalidActions, 0);
    const strikes = result.ranking.reduce((s, r) => s + r.strikes, 0);
    // 结论口径与 CLI simulate 的"交火"一致：只要双方开过火就算打起来了
    const verdicts: string[] = [];
    if (fires === 0) verdicts.push("⚠️ 整局没有发生任何交火：双方的搬运路线互不接触，容易打成僵尸局");
    if (kills === 0) verdicts.push("⚠️ 没有出现击杀：这张图的战斗压力偏低");
    if (units === 0) verdicts.push("❌ 双方都没有提交任何资源：得分链路是断的，请检查资源点与提交点是否可达");
    if (firstFireRound !== null && firstFireRound <= 8) verdicts.push(`✅ 第 ${firstFireRound} 轮就发生首次交火：地图会逼着双方碰面`);
    if (strikes > 0 || invalid > 4) verdicts.push(`⚠️ 无效动作 ${invalid} 次、strike ${strikes} 次：可能有出生点/设施贴在障碍旁，脚本容易撞墙`);
    return {
      ok: verdicts.every((v) => !v.startsWith("❌")),
      mapId: map.mapId,
      seed,
      rounds: result.turns,
      spawns: assignSpawns(map, [1, 2], seed).map((s) => ({ seat: s.seat, pos: s.pos })),
      combat: { fires, hits, kills, firstFireRound, turns: result.turns },
      economy: { unitsDeposited: units, invalidActions: invalid, strikes },
      ranking: result.ranking.map((r) => ({
        seat: r.seat, name: r.name, score: r.score, rank: r.rank,
        unitsDeposited: r.unitsDeposited, kills: r.kills, deaths: r.deaths, shotsFired: r.shotsFired, hits: r.hits,
        avgDecisionMs: r.avgDecisionMs,
      })),
      verdicts,
    };
  } finally {
    controller.dispose();
  }
});

// ------------------------------------------------------------------ 对局（由赛事产生，这里只读）
app.get("/api/matches", async () => store.listMatches(200));

app.get("/api/matches/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const match = store.getMatch(id);
  if (!match) return fail(reply, 404, "比赛不存在");
  return { match, players: store.listPlayers(id), ranking: match.ranking ?? [] };
});

app.get("/api/matches/:id/players", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!store.getMatch(id)) return fail(reply, 404, "比赛不存在");
  return store.listPlayers(id);
});

app.get("/api/matches/:id/replay", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const match = store.getMatch(id);
  if (!match) return fail(reply, 404, "比赛不存在");
  const replay = store.getReplay(id);
  return {
    match,
    players: store.listPlayers(id),
    ranking: replay?.ranking ?? match.ranking ?? [],
    events: replay?.events ?? [],
  };
});

app.get("/api/matches/:id/report", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const replay = store.getReplay(id);
  const match = store.getMatch(id);
  if (!match) return fail(reply, 404, "比赛不存在");
  const stored = store.getReport(id);
  if (stored) {
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    return stored;
  }
  if (!replay) return fail(reply, 409, "比赛尚未完成或没有回放数据");
  // 没有留档战报（例如更早版本产生的数据）时用存档重建一份简要战报
  const lines = [`# 坦克对战战报 · ${id}`, "", `- 地图：${match.mapId}@${match.mapVersion}　规则：ruleset-${match.rulesetVersion}　种子：${match.seed}`,
    `- 复现键：\`${match.reproducibilityKey}\``, "", "## 排名", "",
    "| 名次 | 座位 | Agent | 总分 | 提交单位 | 击杀 | 死亡 | 布雷 | 无效动作 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const st of replay.ranking) {
    lines.push(`| ${st.rank} | P${st.seat} | ${st.name} | **${st.score}** | ${st.unitsDeposited} | ${st.kills} | ${st.deaths} | ${st.minesDeployed}（踩响 ${st.mineKills}） | ${st.invalidActions} |`);
  }
  lines.push("", "> 本战报由存档重建，完整逐项明细请调用 /replay 查看事件流。");
  reply.header("Content-Type", "text/markdown; charset=utf-8");
  return lines.join("\n");
});

app.get("/api/leaderboard", async () => ({ rows: store.leaderboard() }));

// ------------------------------------------------------------------ 观战解说（上帝视角解说员）
// 组织者填 baseUrl / modelId / apiKey 后，每场比赛可以生成一份"关键行为解说稿"：
// 稿子按事件流下标锚定，回放/观战按光标逐段露出（见 commentary.ts）。密钥只以掩码回显。
const commentaryDeps: CommentaryDeps = {
  store,
  masterKey: config.masterKey,
  getMap: (mapId: string) => registry.get(mapId),
  logger: app.log,
};

/** 生成中但明显卡死（服务重启过/调用被中断）的行：当场判失败，免得前端一直转圈 */
function settleStaleCommentary(matchId: string): void {
  const row = store.getCommentary(matchId);
  if (!row || row.status !== "generating") return;
  const started = Date.parse(row.createdAt);
  const budgetMs = 180_000 * 8 + 60_000; // 一次调用最多 180s × 最多 8 段（6 段 + 2 次拆批重问），再宽一点
  if (Number.isFinite(started) && Date.now() - started > budgetMs) {
    store.failCommentary(matchId, "生成中断（服务可能重启过），可以重新生成");
  }
}

app.get("/api/commentary/settings", async () => readCommentaryConfig(store, config.masterKey));

app.put("/api/commentary/settings", async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pickString = (key: string) => (typeof body[key] === "string" ? { [key]: body[key] as string } : {});
  const pickNumber = (key: string) => (typeof body[key] === "number" ? { [key]: body[key] as number } : {});
  try {
    const view = saveCommentaryConfig(store, config.masterKey, {
      ...pickString("baseUrl"),
      ...pickString("modelId"),
      ...pickString("apiKey"),
      ...(typeof body.auto === "boolean" ? { auto: body.auto } : {}),
      ...pickNumber("temperature"),
      ...pickNumber("maxTokens"),
      ...pickNumber("timeoutMs"),
    });
    return view;
  } catch (err) {
    return fail(reply, 400, err instanceof Error ? err.message : String(err));
  }
});

app.post("/api/commentary/test", async (req, reply) => {
  const settings = loadLlmSettings(store, config.masterKey);
  if (!settings) return fail(reply, 400, "还没配置完整：baseUrl / modelId / apiKey 三项都要填");
  return probe(settings);
});

app.get("/api/matches/:id/commentary", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!store.getMatch(id)) return fail(reply, 404, "比赛不存在");
  settleStaleCommentary(id);
  const row = store.getCommentary(id);
  return {
    status: row?.status ?? "none",
    segments: row?.segments ?? [],
    modelId: row?.modelId ?? "",
    baseUrl: row?.baseUrl ?? "",
    usage: row?.usage ?? null,
    error: row?.error ?? null,
    createdAt: row?.createdAt ?? null,
    finishedAt: row?.finishedAt ?? null,
    configured: Boolean(loadLlmSettings(store, config.masterKey)),
  };
});

app.post("/api/matches/:id/commentary", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!store.getMatch(id)) return fail(reply, 404, "比赛不存在");
  if (!store.getReplay(id)) return fail(reply, 409, "这场比赛还没有回放事件流，没法解说");
  const body = (req.body ?? {}) as { force?: unknown };
  const res = scheduleCommentary(commentaryDeps, id, { force: body.force === true });
  if (!res.queued) {
    const row = store.getCommentary(id);
    return { ok: true, queued: false, reason: res.reason ?? "未排队", status: row?.status ?? "none", segments: row?.segments ?? [] };
  }
  return { ok: true, queued: true, status: "generating" };
});

app.delete("/api/matches/:id/commentary", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!store.getMatch(id)) return fail(reply, 404, "比赛不存在");
  if (commentaryBusy() && store.getCommentary(id)?.status === "generating") {
    return fail(reply, 409, "正在生成中，等它跑完再删");
  }
  store.deleteCommentary(id);
  return { ok: true };
});

// 单模型画像（docs/08 §4.3）：过程分 + 它名下每个 Agent 的版本数与自测痕迹
app.get("/api/models/:model/profile", async (req, reply) => {
  const model = decodeURIComponent((req.params as { model: string }).model);
  const profile = store.modelProfile(model);
  if (!profile) return reply.code(404).send({ error: `没有找到模型 ${model} 的任何记录` });
  return profile;
});

// ------------------------------------------------------------------ WebSocket 观战
const channels = new Map<string, Set<{ send: (data: string) => void }>>();

function broadcast(matchId: string, message: unknown): void {
  const set = channels.get(matchId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(message);
  for (const client of set) {
    try { client.send(data); } catch { /* 忽略单点发送失败 */ }
  }
}

app.register(async (instance) => {
  instance.get("/ws/matches/:id", { websocket: true }, (socket, req) => {
    const matchId = (req.params as { id: string }).id;
    const client = { send: (data: string) => socket.send(data) };
    if (!channels.has(matchId)) channels.set(matchId, new Set());
    channels.get(matchId)!.add(client);

    const send = (msg: unknown) => { try { client.send(JSON.stringify(msg)); } catch { /* ignore */ } };

    // 赛事对局全部是"跑完即落库"，因此观战实质上是读存档：一次快照 + 结束信号
    const match = store.getMatch(matchId);
    if (!match) {
      send({ type: "phase", data: { phase: "failed", detail: "比赛不存在" } });
    } else {
      const replay = store.getReplay(matchId);
      send({
        type: "snapshot",
        data: {
          match,
          players: store.listPlayers(matchId),
          ranking: replay?.ranking ?? match.ranking ?? [],
          events: replay?.events ?? [],
          status: match.status,
        },
      });
      if (match.status === "finished") send({ type: "end", data: { ranking: replay?.ranking ?? [] } });
    }

    socket.on("close", () => {
      channels.get(matchId)?.delete(client);
    });
  });
});

// ------------------------------------------------------------------ 对外能力（Agent 注册 / 脚本上传 / 任务书 / 1v1 赛事）
  registerExternalRoutes(app, { store, config, registry, tournamentRunners });
  // 评测批次（docs/08）：多条 leg 的汇总评测 + 标尺对手 + 评级/画像
  registerCohortRoutes(app, { store, config, registry, tournamentRunners, cohortRunners });

// ------------------------------------------------------------------ 静态前端（构建产物存在时）
const webDist = join(repoRoot, "apps", "web", "dist");
// 浏览器会自动请求它；没有图标文件就回 204，避免这次请求落到下面的 SPA 回落（index.html 应当登录后才下发）
app.get("/favicon.ico", async (_req, reply) => {
  const icon = join(webDist, "favicon.ico");
  if (existsSync(icon)) {
    reply.header("content-type", "image/x-icon");
    return reply.send(createReadStream(icon));
  }
  return reply.code(204).send();
});
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
app.get("/*", async (req, reply) => {
  const url = (req.params as Record<string, string>)["*"] ?? "";
  if (!existsSync(webDist)) {
    reply.code(200).header("Content-Type", "text/html; charset=utf-8");
    return `<!doctype html><meta charset="utf-8"><title>AI 坦克对战平台</title>
<body style="font-family:system-ui;padding:2rem;line-height:1.7">
<h1>AI 坦克对战平台 · API 已就绪</h1>
<p>前端尚未构建。开发时请在另一个终端运行：<code>pnpm dev:web</code>（默认 http://127.0.0.1:5173，已配置 /api 与 /ws 代理到本服务）。</p>
<p>或先构建：<code>pnpm build:web</code>，再刷新本页。</p>
<p>接口自检：<a href="/api/health">/api/health</a>　地图：<a href="/api/maps">/api/maps</a>　排行榜：<a href="/api/leaderboard">/api/leaderboard</a></p>
</body>`;
  }
  const rel = normalize(url).replace(/^([/\\])+/, "");
  let filePath = join(webDist, rel);
  if (!filePath.startsWith(webDist)) return fail(reply, 403, "非法路径");
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(webDist, "index.html");
  reply.header("Content-Type", MIME[extname(filePath)] ?? "application/octet-stream");
  return reply.send(createReadStream(filePath));
});


  // 体积超限（Fastify 在解析层就拒绝）转成结构化响应，与手写的 uploadFail 保持一致
  app.setErrorHandler((err: unknown, _req, reply) => {
    const error = err as { code?: string; statusCode?: number; message: string };
    const code = error.code ?? "";
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH") {
      void reply.code(413).send({ ok: false, stage: "size", error: "请求体超过上限（zip 包最大 200KB）" });
      return;
    }
    if (code === "FST_ERR_CTP_EMPTY_JSON_BODY" || code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      void reply.code(415).send({ ok: false, stage: "zip", error: "不支持的请求体格式：请用 Content-Type: application/zip 上传原始 zip 字节流" });
      return;
    }
    app.log.error({ err: error }, "未处理的请求错误");
    void reply.code(error.statusCode ?? 500).send({ error: error.message });
  });

  return { app, store, registry, tournamentRunners, cohortRunners, auth };
}