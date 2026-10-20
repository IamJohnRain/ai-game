// apps/server/src/routesExternal.ts —— 对外能力路由：Agent 注册、脚本上传、任务书、1v1 赛事
// 这条链路处理的对象是**外部不可信输入**（外部 Agent 及其上传的压缩包），因此每个入口都做准入：
//   注册 → 一次性密钥；上传 → 体积/结构/白名单/脚本合法性四道闸；赛事 → 只允许已通过校验的 Agent。
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_MAP_1V1, DEFAULT_RULESET, type Ruleset } from "@ai-game/protocol";
import { checkScript } from "@ai-game/script-check";
import { DEFAULT_UPLOAD_LIMITS_PUBLIC, SCRIPT_PROTOCOL_VERSION, renderAgentPrompt, renderTaskDoc, TASK_DOC_VERSION } from "@ai-game/prompt";
import { createZip, DEFAULT_UPLOAD_LIMITS, readZip, type ZipRejectReason } from "@ai-game/zippack";
import type { ServerConfig } from "./config.ts";
import { bearerFrom, generateAgentKey, hashAgentKey, maskAgentKey } from "./agentKeys.ts";
import type { MapRegistry } from "./maps.ts";
import type { Store, AgentRow } from "./store.ts";
import { mapCheckStatusToStage, type UploadStage } from "./uploadStages.ts";
import { registerPracticeRoute } from "./practice.ts";
import { TournamentRunner } from "./tournaments.ts";

/** onRequest 里验过密钥后，把 agent 挂到请求上给处理器复用（不再查一次库） */
type UploadRequest = FastifyRequest & { uploadAgent?: AgentRow };

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const PROTOCOL_CORE = join(repoRoot, "docs", "prompts", "protocol-core.md");
const TASK_DOC_TEMPLATE = join(repoRoot, "docs", "prompts", "task-doc.template.md");
const BASELINE_SCRIPT = join(repoRoot, "docs", "examples", "baseline-strategy.js");

export interface ExternalRouteDeps {
  store: Store;
  config: ServerConfig;
  /** 地图注册表：任务书按图渲染、上传校验覆盖"内置 + 自定义"全部地图 */
  registry: MapRegistry;
  tournamentRunners: Map<string, TournamentRunner>;
}

const AgentInput = z.object({
  modelName: z.string().min(1).max(64),
  agentName: z.string().min(1).max(64),
  thinkingLevel: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  notes: z.string().max(2000).default(""),
});

const TournamentInput = z.object({
  agentIds: z.array(z.string()).min(2).max(16),
  gamesPerPair: z.number().int().min(1).max(10).optional(),
  name: z.string().max(80).optional(),
  seed: z.number().int().optional(),
  mapId: z.string().optional(),
  /** 总回合数（默认 150；调小可以让赛事更快出结果） */
  maxRounds: z.number().int().min(10).max(1000).optional(),
});

export function registerExternalRoutes(app: FastifyInstance, deps: ExternalRouteDeps): void {
  const { store, config, registry } = deps;

  // zip 用原始字节流上传：为二进制注册解析器，并在解析层就设体积上限（超限由错误处理器转成结构化响应）
  app.addContentTypeParser(
    ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: DEFAULT_UPLOAD_LIMITS.maxZipBytes + 1024 },
    (_req, body, done) => done(null, body),
  );

  // ---------------- 练习通道（不消耗正式提交、不计分、只打标尺） ----------------
  registerPracticeRoute(app, { store, config, registry });

  // ---------------- 任务书 ----------------
  // 任务书**不绑定地图**：赛图由组织者在开赛时从注册表里选（内置 + 自定义），
  // 而任务书只给"通用地图规范"（尺寸范围、元素与字符表、MAP 结构、资源点语义）。
  // 因此各张地图拿到的是同一份正文 —— 这正是"脚本必须按 MAP 现算"的前提，
  // 也与我们"对每张注册地图各跑一遍校验"的准入策略一致。
  type TaskDoc = { version: string; protocolVersion: string; markdown: string; limits: unknown; endpoints: unknown };
  const taskDocCache = new Map<string, TaskDoc>();
  const taskDoc = (baseUrl: string): TaskDoc => {
    const hit = taskDocCache.get(baseUrl);
    if (hit) return hit;
    const doc = renderTaskDoc({
      rules: DEFAULT_RULESET,
      protocolCorePath: PROTOCOL_CORE,
      taskDocTemplatePath: TASK_DOC_TEMPLATE,
      baselineScript: readFileSync(BASELINE_SCRIPT, "utf8"),
      serverBaseUrl: baseUrl,
      limits: publicLimits(),
      gamesPerPair: 2,
      turnBudgetMs: 50,
    });
    const entry: TaskDoc = {
      version: doc.version, protocolVersion: doc.protocolVersion,
      markdown: doc.markdown, limits: doc.limits, endpoints: doc.endpoints,
    };
    taskDocCache.set(baseUrl, entry);
    return entry;
  };

  // 对外地址：配了 AI_GAME_PUBLIC_URL 就一律用它（组织者自己可能走隧道/内网，但外部 Agent 得拿到它够得着的地址），
  // 否则按请求头推断（反代场景认 X-Forwarded-Proto/Host）
  /** 对外公布的限额：把部署时用环境变量调过的"版本上限 / 练习配额"如实告诉 Agent */
  const publicLimits = (): typeof DEFAULT_UPLOAD_LIMITS_PUBLIC => ({
    ...DEFAULT_UPLOAD_LIMITS_PUBLIC,
    maxRevisions: config.maxRevisions,
    practiceRuns: config.practiceRuns,
  });

  const baseUrlOf = (req: FastifyRequest): string => {
    if (config.publicUrl) return config.publicUrl;
    const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
    const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? `127.0.0.1:${config.port}`;
    return `${proto}://${host}`;
  };

  app.get("/api/task-doc", async (req, reply) => {
    const doc = taskDoc(baseUrlOf(req));
    if ((req.query as { format?: string }).format === "json") {
      return {
        version: doc.version, protocolVersion: doc.protocolVersion,
        markdown: doc.markdown, endpoints: doc.endpoints, limits: doc.limits,
      };
    }
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `inline; filename="ai-game-task-doc-${doc.version}.md"`);
    return doc.markdown;
  });

  // ---------------- Agent 注册 ----------------
  app.post("/api/agents", async (req, reply) => {
    const parsed = AgentInput.safeParse(req.body);
    if (!parsed.success) {
      return fail(reply, 400, `参数不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const key = generateAgentKey();
    const agent = store.createAgent({
      id: `ag_${randomUUID().slice(0, 8)}`,
      modelName: parsed.data.modelName,
      agentName: parsed.data.agentName,
      thinkingLevel: parsed.data.thinkingLevel,
      notes: parsed.data.notes,
      keyHash: hashAgentKey(key, config.masterKey),
      keyMasked: maskAgentKey(key),
      maxAttempts: DEFAULT_UPLOAD_LIMITS_PUBLIC.maxUploadAttempts,
      maxPracticeRuns: config.practiceRuns,
    });
    const base = baseUrlOf(req);
    const taskDocUrl = `${base}/api/task-doc`;
    const uploadUrl = `${base}/api/upload`;
    const practiceUrl = `${base}/api/practice`;
    const limits = publicLimits();
    return {
      agent,
      key, // 仅此一次返回明文；库里只存哈希
      protocolVersion: SCRIPT_PROTOCOL_VERSION,
      // 任务书与地图无关（赛图开赛时才定），给的是一条固定 URL，读到的就是最新版
      taskDocUrl,
      uploadUrl,
      practiceUrl,
      limits,
      // 组织者可以直接把这段 prompt 粘给目标 Agent：任务描述 + 任务书地址 + 密钥 + 自测/上传命令
      prompt: renderAgentPrompt({
        taskDocUrl, uploadUrl, practiceUrl, practiceQuota: limits.practiceRuns, key,
        agentName: agent.agentName, modelName: agent.modelName,
        limits,
      }),
    };
  });

  app.get("/api/agents", async () => ({ agents: store.listAgents() }));

  app.post("/api/agents/:id/reissue", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getAgent(id)) return fail(reply, 404, "Agent 不存在");
    const key = generateAgentKey();
    const agent = store.reissueAgentKey(id, hashAgentKey(key, config.masterKey), maskAgentKey(key));
    if (!agent) return fail(reply, 404, "Agent 不存在"); // 与上面那次查询之间的竞态兜底（例如刚被并发删除）
    // 与首次注册同一套回复：新密钥 + 可直接粘贴的启动 prompt（旧 prompt 里的密钥已作废）
    const base = baseUrlOf(req);
    const taskDocUrl = `${base}/api/task-doc`;
    const uploadUrl = `${base}/api/upload`;
    const practiceUrl = `${base}/api/practice`;
    const limits = publicLimits();
    return {
      agent,
      key,
      taskDocUrl,
      uploadUrl,
      practiceUrl,
      limits,
      prompt: renderAgentPrompt({
        taskDocUrl, uploadUrl, practiceUrl, practiceQuota: limits.practiceRuns, key,
        agentName: agent.agentName, modelName: agent.modelName,
        limits,
      }),
    };
  });

  app.delete("/api/agents/:id", async (req) => {
    store.deleteAgent((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---------------- 脚本上传 ----------------
  // 鉴权放在 onRequest：**先验一次性密钥、再收文件**。密钥缺失 / 不存在 / 已用过 / 次数用尽，
  // 都在 Fastify 解析 body 之前就拒绝（onRequest 早于 body 解析），所以伪造密钥的请求即使带
  // 300KB 的包也不会被接收，更不会进入解包与五阶段校验。校验通过才把 agent 挂到请求上给处理器用。
  const uploadKeyGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = bearerFrom(req.headers.authorization);
    if (!key) {
      uploadFail(reply, 401, "auth", "缺少 Authorization: Bearer <一次性密钥>");
      return reply;
    }
    const agent = store.findAgentByKeyHash(hashAgentKey(key, config.masterKey));
    if (!agent) {
      uploadFail(reply, 401, "auth", "密钥无效：该一次性密钥不存在（先去 POST /api/agents 注册）");
      return reply;
    }
    if (agent.status === "uploaded") {
      uploadFail(reply, 409, "auth", "该密钥已成功使用过（一次性）；如需重新提交请让组织者重新签发密钥");
      return reply;
    }
    if (agent.attempts >= agent.maxAttempts) {
      uploadFail(reply, 429, "attempts", `尝试次数已用尽（${agent.attempts}/${agent.maxAttempts}）`);
      return reply;
    }
    if (agent.revision >= config.maxRevisions) {
      uploadFail(reply, 409, "revisions", `版本数已达上限（${agent.revision}/${config.maxRevisions}）：本 Agent 不能再提交新版本（AI_GAME_MAX_REVISIONS 可调）`);
      return reply;
    }
    (req as UploadRequest).uploadAgent = agent;
    return undefined;
  };

  app.post("/api/upload", { onRequest: uploadKeyGuard }, async (req, reply) => {
    // 1) 鉴权已在 onRequest 完成：能走到这里说明密钥有效且未使用（body 也已经按闸门收下）
    const agent = (req as UploadRequest).uploadAgent;
    if (!agent) return uploadFail(reply, 500, "auth", "内部错误：上传鉴权钩子未生效");

    // 2) 体积：zip 包 ≤ 200KB
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      return uploadFail(reply, 415, "zip", "请求体必须是原始 zip 字节流（Content-Type: application/zip）");
    }
    if (body.length > DEFAULT_UPLOAD_LIMITS.maxZipBytes) {
      return uploadFail(reply, 413, "size", `压缩包 ${body.length} 字节，超过上限 ${DEFAULT_UPLOAD_LIMITS.maxZipBytes} 字节（200KB）`);
    }

    // 3) 结构：加固解包（炸弹/穿越/嵌套/符号链接/伪造头都在这里被拒；不递归，不存在解压死循环）
    const unzip = readZip(body, DEFAULT_UPLOAD_LIMITS);
    if (!unzip.ok) {
      const attempts = store.bumpAgentAttempts(agent.id);
      return uploadFail(reply, 400, "zip", `压缩包被拒绝（${unzip.reason}）：${unzip.detail}`, { attempts });
    }
    const strategyEntry = unzip.entries.find((e) => e.name === "strategy.js");
    if (!strategyEntry) {
      const attempts = store.bumpAgentAttempts(agent.id);
      return uploadFail(reply, 400, "content", "压缩包里缺少 strategy.js", { attempts });
    }
    const metaEntry = unzip.entries.find((e) => e.name === "meta.json");
    let meta: unknown = null;
    if (metaEntry) {
      try { meta = JSON.parse(metaEntry.data.toString("utf8")); } catch { meta = null; }
    }
    const script = strategyEntry.data.toString("utf8");

    // 4) 合法性：静态扫描 → 编译 → 模糊测试 → 冒烟对局（与平台内部流程同一套流水线）
    //    对**注册表里的每一张地图**各跑一遍（内置 + 组织者用编辑器保存的自定义地图）：
    //    赛事可能换图，只在一张图上通过不算通过。
    const validation: { stage: string; mapId: string; ok: boolean; detail?: string }[] = [];
    let scriptOk: string | null = null;
    let scriptSha256 = "";
    let avgDecisionMs = 0;
    let smoke: unknown = null;
    let firstFailure: { status: string; stage: UploadStage; detail: string } | null = null;
    for (const map of registry.list()) {
      const check = await checkScript({
        script,
        map,
        rules: DEFAULT_RULESET,
        maxLines: DEFAULT_UPLOAD_LIMITS_PUBLIC.maxScriptLines,
        fuzzCount: 200,
        smokeRounds: 30,
        smokeOpponentScript: readFileSync(BASELINE_SCRIPT, "utf8"),
      });
      for (const s of check.stages) {
        validation.push({ stage: s.stage, mapId: map.mapId, ok: s.ok, ...(s.detail !== undefined ? { detail: s.detail } : {}) });
      }
      if (check.script) scriptOk = check.script;
      if (check.scriptSha256) scriptSha256 = check.scriptSha256;
      avgDecisionMs = Math.max(avgDecisionMs, check.avgDecisionMs);
      if (smoke === null && check.smoke) smoke = check.smoke;
      if ((!check.ok || !check.script) && !firstFailure) {
        const failedOn = check.stages.filter((s) => !s.ok).map((s) => `${s.stage}@${map.mapId}: ${s.detail ?? ""}`).join(" | ");
        firstFailure = { status: check.status, stage: mapCheckStatusToStage(check.status), detail: failedOn || "脚本未通过校验" };
      }
    }
    if (firstFailure || !scriptOk) {
      const { stage, detail } = firstFailure ?? { stage: "compile" as UploadStage, detail: "脚本未通过校验" };
      const attempts = store.bumpAgentAttempts(agent.id);
      store.markAgentRejected(agent.id, `[${stage}] ${detail}`.slice(0, 1000), validation);
      return uploadFail(reply, 400, stage, detail, { validation, attempts });
    }

    // 5) 通过：入库（密钥随成功而失效）
    const zipSha256 = createHash("sha256").update(body).digest("hex");
    const updated = store.markAgentUploaded(agent.id, {
      script: scriptOk,
      scriptSha256,
      zipSha256,
      zipBytes: body.length,
      meta,
      validation,
    });
    return {
      ok: true,
      agent: updated,
      revision: updated?.revision ?? 1,
      scriptSha256,
      scriptLines: scriptOk.split(/\r?\n/).length,
      avgDecisionMs,
      smoke,
      validation,
      validatedMaps: registry.ids(),
    };
  });

  // ---------------- 1v1 赛事 ----------------
  /**
   * 建一场 1v1 循环赛（发起赛事的唯一入口，"同配置再战"也走这里）。
   * 校验：Agent 必须存在且已入库（status=uploaded）；赛图必须在注册表里。
   */
  const launchTournament = (
    body: { agentIds: string[]; gamesPerPair?: number; name?: string; seed?: number; mapId?: string; maxRounds?: number },
  ): { ok: true; tournamentId: string; seed: number; mapId: string; agentCount: number; totalMatches: number }
    | { ok: false; code: number; error: string } => {
    const agentIds = [...new Set(body.agentIds)];
    if (agentIds.length < 2) return { ok: false, code: 400, error: "去重后至少需要 2 个不同 Agent" };
    for (const id of agentIds) {
      const agent = store.getAgent(id);
      if (!agent) return { ok: false, code: 400, error: `Agent ${id} 不存在` };
      if (agent.status !== "uploaded") {
        return { ok: false, code: 400, error: `Agent ${agent.agentName} 尚未通过校验（当前状态 ${agent.status}）` };
      }
    }
    if (body.mapId !== undefined && !registry.get(body.mapId)) {
      return { ok: false, code: 400, error: `未知地图 ${body.mapId}（可用：${registry.ids().join(", ")}）` };
    }
    const mapId = body.mapId ?? DEFAULT_MAP_1V1;
    const gamesPerPair = body.gamesPerPair ?? 2;
    const seed = body.seed ?? Math.floor(Math.random() * 2 ** 31);
    const id = `t_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
    const name = body.name?.trim() || `赛事 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

    store.createTournament({
      id, name, seed, gamesPerPair, mapId, rulesetVersion: DEFAULT_RULESET.version,
      scriptProtocolVersion: SCRIPT_PROTOCOL_VERSION, agentIds,
    });
    const rules: Ruleset = body.maxRounds
      ? { ...DEFAULT_RULESET, maxRounds: body.maxRounds }
      : DEFAULT_RULESET;
    const runner = new TournamentRunner({ store, registry }, {
      tournamentId: id, agentIds, gamesPerPair, seed, mapId, rules,
      scriptProtocolVersion: SCRIPT_PROTOCOL_VERSION,
    });
    deps.tournamentRunners.set(id, runner);
    void runner.start().finally(() => {
      // 保留结果一段时间供前端查看（定时器 unref，不阻止进程退出）
      const timer = setTimeout(() => deps.tournamentRunners.delete(id), 60 * 60 * 1000);
      timer.unref();
    });
    return {
      ok: true, tournamentId: id, seed, mapId,
      agentCount: agentIds.length,
      totalMatches: (agentIds.length * (agentIds.length - 1) / 2) * gamesPerPair,
    };
  };

  app.post("/api/tournaments", async (req, reply) => {
    const parsed = TournamentInput.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "参数不合法：agentIds 至少 2 个");
    const result = launchTournament(parsed.data);
    if (!result.ok) return fail(reply, result.code, result.error);
    return {
      tournamentId: result.tournamentId, seed: result.seed, mapId: result.mapId,
      agentCount: result.agentCount, totalMatches: result.totalMatches,
    };
  });

  /**
   * 同配置再战：把这场对局的双方（agent_id 已落库）用一个**新种子**再打一组（默认 2 局，攻守互换）。
   * 返回新赛事的 id：前端可以直接跳到赛事详情看进度。
   */
  app.post("/api/matches/:id/rematch", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const match = store.getMatch(id);
    if (!match) return fail(reply, 404, "比赛不存在");
    const players = store.listPlayers(id);
    const agentIds = players.map((p) => p.agentId).filter((x): x is string => Boolean(x));
    if (agentIds.length < 2) {
      return fail(reply, 409, "这场对局没有记录参赛 Agent（可能是旧版本数据的比赛），无法自动复赛；请到赛事页手动勾选 Agent 发起");
    }
    const result = launchTournament({
      agentIds,
      gamesPerPair: 2,
      mapId: match.mapId,
      name: `复赛（源于 ${id}）`,
    });
    if (!result.ok) return fail(reply, result.code, result.error);
    return { tournamentId: result.tournamentId, matchIds: [], seed: result.seed, mapId: result.mapId };
  });

  app.get("/api/tournaments", async () => {
    const rows = store.listTournaments(100);
    return {
      tournaments: rows.map((t) => {
        const runner = deps.tournamentRunners.get(t.id);
        const expected = (t.agentIds.length * (t.agentIds.length - 1) / 2) * t.gamesPerPair;
        return {
          id: t.id, name: t.name, status: t.status, agentCount: t.agentIds.length,
          gamesPerPair: t.gamesPerPair, mapId: t.mapId,
          scriptProtocolVersion: t.scriptProtocolVersion, matchCount: expected,
          finishedMatches: runner ? runner.finishedMatches : (t.status === "finished" ? expected : 0),
          createdAt: t.createdAt,
          ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
          ...(t.error ? { error: t.error } : {}),
        };
      }),
    };
  });

  app.get("/api/tournaments/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const tournament = store.getTournament(id);
    if (!tournament) return fail(reply, 404, "赛事不存在");
    const runner = deps.tournamentRunners.get(id);
    const standings = runner?.standings.length ? runner.standings : ((tournament.standings as unknown[]) ?? []);
    // 对局列表：优先用内存里的记录（含 agentId 映射）；进程重启后用库里的 match_players 还原（agentId 已落库）
    const matchRows = store.tournamentMatchRows(id);
    const matches = matchRows.map((m, i) => {
      const inMemory = runner?.matches.find((x) => x.matchId === m.matchId);
      const ranking = m.ranking;
      const players = store.listPlayers(m.matchId);
      const seatsFromDb = players.map((p) => {
        const stat = ranking.find((r) => r.seat === p.seat);
        return {
          seat: p.seat,
          agentId: p.agentId ?? "",
          agentName: p.name || stat?.name || `P${p.seat}`,
          score: stat?.score ?? p.finalScore ?? 0,
          rank: stat?.rank ?? p.rank ?? p.seat,
        };
      });
      const seats = inMemory?.seats ?? (seatsFromDb.length > 0 ? seatsFromDb : ranking.map((r) => ({ seat: r.seat, agentId: "", agentName: r.name, score: r.score, rank: r.rank })));
      const sorted = [...seats].sort((a, b) => a.rank - b.rank);
      const winnerAgentId = inMemory?.winnerAgentId
        ?? (sorted.length === 2 && sorted[0]!.score !== sorted[1]!.score ? sorted[0]!.agentId || null : null);
      return {
        matchId: m.matchId,
        index: i + 1,
        pairLabel: inMemory?.pairLabel ?? `对局 ${i + 1}`,
        seats,
        winnerAgentId,
        replayUrl: `/api/matches/${m.matchId}/replay`,
        reportUrl: `/api/matches/${m.matchId}/report`,
        status: m.status,
      };
    });
    const expected = (tournament.agentIds.length * (tournament.agentIds.length - 1) / 2) * tournament.gamesPerPair;
    return {
      tournament: {
        id: tournament.id, name: tournament.name, status: tournament.status,
        agentCount: tournament.agentIds.length, gamesPerPair: tournament.gamesPerPair,
        matchCount: expected, finishedMatches: runner ? runner.finishedMatches : matches.filter((m) => m.status === "finished").length,
        seed: tournament.seed, mapId: tournament.mapId, rulesetVersion: tournament.rulesetVersion,
        scriptProtocolVersion: tournament.scriptProtocolVersion,
        createdAt: tournament.createdAt,
        ...(tournament.finishedAt ? { finishedAt: tournament.finishedAt } : {}),
        ...(tournament.error ? { error: tournament.error } : {}),
      },
      standings,
      matches,
    };
  });

  app.get("/api/tournaments/:id/report", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const tournament = store.getTournament(id);
    if (!tournament) return fail(reply, 404, "赛事不存在");
    const runner = deps.tournamentRunners.get(id);
    const standings = (runner?.standings ?? (tournament.standings as unknown[])) as
      | { rank: number; agentName: string; modelName: string; played: number; wins: number; draws: number; losses: number; points: number; scoreDiff: number; totalScore: number; totalUnitsDeposited: number; kills: number; deaths: number }[]
      | null;
    const lines = [`# 赛事战报 · ${tournament.name}`, "", `- 赛事 ID：\`${tournament.id}\``,
      `- 地图：${tournament.mapId}　规则：ruleset-${tournament.rulesetVersion}　每对局数：${tournament.gamesPerPair}　种子：\`${tournament.seed}\``,
      `- 参赛 Agent：${tournament.agentIds.length} 个　状态：${tournament.status}`, ""];
    if (standings?.length) {
      lines.push("## 积分榜", "", "| 名次 | Agent | 模型 | 已赛 | 胜 | 平 | 负 | 积分 | 净胜分差 | 总得分 | 总提交 | 击杀 | 死亡 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const s of standings) {
        lines.push(`| ${s.rank} | ${s.agentName} | ${s.modelName} | ${s.played} | ${s.wins} | ${s.draws} | ${s.losses} | **${s.points}** | ${s.scoreDiff >= 0 ? "+" : ""}${s.scoreDiff} | ${s.totalScore} | ${s.totalUnitsDeposited} | ${s.kills} | ${s.deaths} |`);
      }
      lines.push("");
    }
    const matchRows = store.tournamentMatchRows(id);
    if (matchRows.length) {
      lines.push("## 对局明细", "");
      for (const m of matchRows) {
        const r = m.ranking;
        lines.push(`- \`${m.matchId}\`：${r.map((x) => `${x.name} ${x.score}`).join(" vs ")}（状态 ${m.status}）`);
      }
      lines.push("");
    }
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    return lines.join("\n");
  });

  /** 后台工具：把 zip 打成规范包（供 CLI 演示与自查；不对外暴露为公开接口） */
  void createZip;
}

function fail(reply: FastifyReply, code: number, message: string): undefined {
  void reply.code(code).send({ error: message });
  return undefined;
}

function uploadFail(
  reply: FastifyReply,
  code: number,
  stage: UploadStage,
  error: string,
  extra: Record<string, unknown> = {},
): undefined {
  void reply.code(code).send({ ok: false, stage, error, ...extra });
  return undefined;
}

export { TASK_DOC_VERSION };
export type { UploadStage };
export type { ZipRejectReason };