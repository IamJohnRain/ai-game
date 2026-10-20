// apps/server/src/practice.ts —— 练习通道（docs/08 §6）：让外部 Agent 能"先自测再交卷"
//
// 四条不变式（测试逐条覆盖）：
//   ① 不消耗正式提交：不改 status、不加 attempts，密钥仍可用于正式上传；
//   ② 不计入任何成绩：练习不建 matches 行（榜单/回放/战报里都不会出现）；
//   ③ 只能打标尺：对手固定为 idle 与 baseline（都公开在仓库里），永不与其它参赛 Agent 对局；
//   ④ 配额与限流：每 Agent 默认 5 次（AI_GAME_PRACTICE_RUNS），耗尽 429；status=uploaded 后 409。
//
// 交付物不是"练习局本身"，而是**自测行为指标**：练了几次、第几次才过、失败在哪个阶段。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_MAP_1V1, DEFAULT_RULESET, type Ruleset } from "@ai-game/protocol";
import { QuickJsController } from "@ai-game/sandbox";
import { runMatch, assignSpawns, type TurnController } from "@ai-game/engine";
import { checkScript, type CheckStatus } from "@ai-game/script-check";
import { DEFAULT_UPLOAD_LIMITS, readZip } from "@ai-game/zippack";
import { DEFAULT_UPLOAD_LIMITS_PUBLIC } from "@ai-game/prompt";
import type { ServerConfig } from "./config.ts";
import { bearerFrom, hashAgentKey } from "./agentKeys.ts";
import type { MapRegistry } from "./maps.ts";
import type { AgentRow, Store } from "./store.ts";
import { mapCheckStatusToStage, type UploadStage } from "./uploadStages.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const BASELINE_SCRIPT_PATH = join(repoRoot, "docs", "examples", "baseline-strategy.js");

/** 练习回合数固定：短局能覆盖"启动 → 采集 → 提交 → 补给"一个完整循环，又不至于让自测变慢 */
export const PRACTICE_ROUNDS = 60;
/** 固定种子：同一份脚本多次练习的结果可比（这也是"改进斜率"的刻度来源） */
export const PRACTICE_SEED = 20261019;

type PracticeRequest = FastifyRequest & { practiceAgent?: AgentRow };

export interface PracticeDeps {
  store: Store;
  config: ServerConfig;
  registry: MapRegistry;
}

export function registerPracticeRoute(app: FastifyInstance, deps: PracticeDeps): void {
  const { store, config } = deps;

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = bearerFrom(req.headers.authorization);
    if (!key) return practiceFail(reply, 401, "auth", "缺少 Authorization: Bearer <注册时拿到的密钥>");
    const agent = store.findAgentByKeyHash(hashAgentKey(key, config.masterKey));
    if (!agent) return practiceFail(reply, 401, "auth", "密钥无效：该密钥不存在（先去 POST /api/agents 注册）");
    if (agent.status === "uploaded") {
      return practiceFail(reply, 409, "auth", "这份密钥已经用于正式提交：练习通道只在正式提交之前开放（要再练就重新签发密钥）");
    }
    if (agent.practiceRuns >= agent.maxPracticeRuns) {
      return practiceFail(reply, 429, "quota", `练习次数已用尽（${agent.practiceRuns}/${agent.maxPracticeRuns}）`);
    }
    (req as PracticeRequest).practiceAgent = agent;
    return undefined;
  };

  app.post("/api/practice", { onRequest: guard }, async (req, reply) => {
    const agent = (req as PracticeRequest).practiceAgent;
    if (!agent) return practiceFail(reply, 500, "auth", "内部错误：练习鉴权钩子未生效");

    // 与正式上传完全同一套闸门：体积 → 结构 → 内容 → 五阶段脚本校验（练习不该比正式提交更宽松）
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      return practiceFail(reply, 415, "zip", "请求体必须是原始 zip 字节流（Content-Type: application/zip）");
    }
    if (body.length > DEFAULT_UPLOAD_LIMITS.maxZipBytes) {
      return practiceFail(reply, 413, "size", `压缩包 ${body.length} 字节，超过上限 ${DEFAULT_UPLOAD_LIMITS.maxZipBytes} 字节（200KB）`);
    }
    const unzip = readZip(body, DEFAULT_UPLOAD_LIMITS);
    if (!unzip.ok) return recordAndFail(deps, agent, req, reply, 400, "zip", `压缩包被拒绝（${unzip.reason}）：${unzip.detail}`);
    const strategyEntry = unzip.entries.find((e) => e.name === "strategy.js");
    if (!strategyEntry) return recordAndFail(deps, agent, req, reply, 400, "content", "压缩包里缺少 strategy.js");
    const script = strategyEntry.data.toString("utf8");

    const validation: { stage: string; mapId: string; ok: boolean; detail?: string }[] = [];
    let scriptOk: string | null = null;
    let failure: { status: CheckStatus; stage: UploadStage; detail: string } | null = null;
    for (const map of deps.registry.list()) {
      const check = await checkScript({
        script,
        map,
        rules: DEFAULT_RULESET,
        maxLines: DEFAULT_UPLOAD_LIMITS_PUBLIC.maxScriptLines,
        fuzzCount: 200,
        smokeRounds: 30,
        smokeOpponentScript: readFileSync(BASELINE_SCRIPT_PATH, "utf8"),
      });
      for (const s of check.stages) {
        validation.push({ stage: s.stage, mapId: map.mapId, ok: s.ok, ...(s.detail !== undefined ? { detail: s.detail } : {}) });
      }
      if (check.script) scriptOk = check.script;
      if ((!check.ok || !check.script) && !failure) {
        const failedOn = check.stages.filter((s) => !s.ok).map((s) => `${s.stage}@${map.mapId}: ${s.detail ?? ""}`).join(" | ");
        failure = { status: check.status, stage: mapCheckStatusToStage(check.status), detail: failedOn || "脚本未通过校验" };
      }
    }

    if (failure || !scriptOk) {
      const stage = failure?.stage ?? "compile";
      const detail = failure?.detail ?? "脚本未通过校验";
      return recordAndFail(deps, agent, req, reply, 400, stage, detail, validation);
    }

    // 校验通过 → 打两局标尺对局（只读地图与固定脚本，不落库、不进榜单）
    const practice = await runPracticeMatches({
      script: scriptOk,
      mapId: DEFAULT_MAP_1V1,
      rounds: PRACTICE_ROUNDS,
      seed: PRACTICE_SEED,
      registry: deps.registry,
      rules: DEFAULT_RULESET,
    });

    store.recordPracticeRun({
      id: `pr_${randomUUID().slice(0, 8)}`,
      agentId: agent.id,
      ok: true,
      stages: validation,
      practice,
      sourceIp: req.ip,
    });
    const updated = store.getAgent(agent.id)!;
    return {
      ok: true,
      validation,
      validatedMaps: deps.registry.ids(),
      practice,
      quota: { used: updated.practiceRuns, max: updated.maxPracticeRuns },
      note: "练习结果不计入成绩、也不消耗正式提交；正式提交仍要用这同一把密钥走 POST /api/upload",
    };
  });
}

/**
 * 标尺对局：同一份脚本分别对 idle（挂机）与 baseline（平台基线）打 PRACTICE_ROUNDS 回合。
 * 固定图/固定种子 → 同一脚本重复练习的分数可比，跨版本就是"改进斜率"的刻度。
 */
export async function runPracticeMatches(input: {
  script: string;
  mapId: string;
  rounds: number;
  seed: number;
  registry: MapRegistry;
  rules: Ruleset;
  opponentScripts?: { idle: string; baseline: string };
}): Promise<{
  rounds: number; mapId: string; seed: number;
  opponents: {
    kind: string; myScore: number; oppScore: number; result: "win" | "draw" | "loss";
    my: { unitsDeposited: number; deposits: number; invalidActions: number; strikes: number; avgDecisionMs: number; maxDecisionMs: number; kills: number; deaths: number };
  }[];
}> {
  const map = input.registry.get(input.mapId);
  if (!map) throw new Error(`练习用图 ${input.mapId} 不在注册表里`);
  const rules: Ruleset = { ...input.rules, maxRounds: input.rounds };
  const idle = input.opponentScripts?.idle ?? `function onInit() {}\nfunction onTurn() { return [{ type: "wait" }]; }\n`;
  const baseline = input.opponentScripts?.baseline ?? readFileSync(BASELINE_SCRIPT_PATH, "utf8");

  const opponents: Awaited<ReturnType<typeof runPracticeMatches>>["opponents"] = [];
  for (const [kind, script] of [["idle", idle], ["baseline", baseline]] as const) {
    const controller = await QuickJsController.create();
    try {
      controller.load(1, input.script);
      controller.load(2, script);
      const result = runMatch({
      matchId: `practice-${kind}`,
      map,
      rules,
      seed: input.seed,
      seats: [
        { seat: 1, name: "candidate", scriptHash: "practice" },
        { seat: 2, name: `calibration:${kind}`, scriptHash: `calibration:${kind}` },
      ],
      spawns: assignSpawns(map, [1, 2], input.seed),
      controller: controller as TurnController,
    });
      const me = result.stats[1]!;
      const opp = result.stats[2]!;
      opponents.push({
        kind,
        myScore: me.score,
        oppScore: opp.score,
        result: me.score === opp.score ? "draw" : (me.score > opp.score ? "win" : "loss"),
        my: {
          unitsDeposited: me.unitsDeposited,
          deposits: me.deposits,
          invalidActions: me.invalidActions,
          strikes: me.strikes,
          avgDecisionMs: me.avgDecisionMs,
          maxDecisionMs: me.maxDecisionMs,
          kills: me.kills,
          deaths: me.deaths,
        },
      });
    } finally {
      controller.dispose();
    }
  }
  return { rounds: input.rounds, mapId: input.mapId, seed: input.seed, opponents };
}

function recordAndFail(
  deps: PracticeDeps,
  agent: AgentRow,
  req: FastifyRequest,
  reply: FastifyReply,
  code: number,
  stage: UploadStage,
  error: string,
  validation?: { stage: string; mapId: string; ok: boolean; detail?: string }[],
): undefined {
  deps.store.recordPracticeRun({
    id: `pr_${randomUUID().slice(0, 8)}`,
    agentId: agent.id,
    ok: false,
    stage,
    detail: error.slice(0, 500),
    ...(validation ? { stages: validation } : {}),
    sourceIp: req.ip,
  });
  const updated = deps.store.getAgent(agent.id);
  return practiceFail(reply, code, stage, error, {
    ...(validation ? { validation } : {}),
    ...(updated ? { quota: { used: updated.practiceRuns, max: updated.maxPracticeRuns } } : {}),
  });
}

function practiceFail(
  reply: FastifyReply,
  code: number,
  stage: UploadStage,
  error: string,
  extra: Record<string, unknown> = {},
): undefined {
  void reply.code(code).send({ ok: false, stage, error, ...extra });
  return undefined;
}