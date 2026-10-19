// tools/cli/src/demo.ts —— 一键演示数据：注册 Agent → 打包上传 → 发起 1v1 赛事
// 用途：让平台在没有任何真实模型 Key 的情况下也能立刻看到完整流程（注册/校验/赛事/回放）。
// 所有数据都是普通业务数据，可在网页上逐个删除。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "@ai-game/zippack";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const BASELINE_PATH = join(repoRoot, "docs", "examples", "baseline-strategy.js");

export interface DemoOptions {
  baseUrl: string;
  /** 登录用户名与密码：注册 Agent、发起赛事这些接口都要会话（用户名固定，密码见服务端配置） */
  user: string;
  password: string;
  /** 是否同时发起一场赛事 */
  tournament: boolean;
  gamesPerPair: number;
  maxRounds: number;
  /** 赛事地图（缺省 = 服务端默认：1v1 决斗图 duel-01） */
  mapId?: string;
  log: (line: string) => void;
}

interface DemoAgent {
  modelName: string;
  agentName: string;
  thinkingLevel: string;
  notes: string;
  script: string;
  meta: Record<string, unknown>;
}

export function demoAgents(): DemoAgent[] {
  const baseline = readFileSync(BASELINE_PATH, "utf8");
  return [
    {
      modelName: "Demo-DeepSeek-V3", agentName: "贪吃的玄武", thinkingLevel: "high",
      notes: "演示数据：健康时冲中心资源点刷分",
      script: baseline,
      meta: { name: "贪吃的玄武", style: "center-rush", note: "演示用：激进经济流" },
    },
    {
      modelName: "Demo-Qwen3-Max", agentName: "谨慎的朱雀", thinkingLevel: "medium",
      notes: "演示数据：只守自家近端资源点",
      script: baseline.replace("const ALLOW_CENTER = true;", "const ALLOW_CENTER = false;"),
      meta: { name: "谨慎的朱雀", style: "home-only", note: "演示用：保守经济流" },
    },
    {
      modelName: "Demo-GLM-4.6", agentName: "躺平的青龙", thinkingLevel: "low",
      notes: "演示数据：原地不动（用于对照，分数会垫底）",
      script: `function onInit(ctx) {}\nfunction onTurn(state) { return [{ type: "wait" }]; }\n`,
      meta: { name: "躺平的青龙", style: "idle", note: "演示用：什么都不做" },
    },
  ];
}

export async function runDemo(opts: DemoOptions): Promise<{ agentIds: string[]; tournamentId?: string }> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const agents = demoAgents();
  const ids: string[] = [];

  // 0) 登录拿会话 Cookie：注册与赛事接口都需要登录（上传走一次性密钥，是免登录的）
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: opts.user, password: opts.password }),
  });
  if (!loginRes.ok) {
    const detail = (await loginRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      `登录失败（HTTP ${loginRes.status}）：${detail.error ?? ""}　—— 用户名固定为 JohnRyan，密码来自服务端配置` +
        `（AI_GAME_AUTH_PASSWORD，或未配置时自动生成的 data/auth.password）`,
    );
  }
  const cookie = (loginRes.headers.getSetCookie?.()?.[0] ?? loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;
  const authed = (extra: Record<string, string> = {}): Record<string, string> => ({ cookie, ...extra });
  opts.log(`⓪ 已登录 ${opts.user}（会话 Cookie ${cookie.slice(0, 20)}…）`);

  for (const a of agents) {
    // 1) 注册（拿一次性密钥）
    const regRes = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ modelName: a.modelName, agentName: a.agentName, thinkingLevel: a.thinkingLevel, notes: a.notes }),
    });
    if (!regRes.ok) throw new Error(`注册失败（HTTP ${regRes.status}）：${(await regRes.text()).slice(0, 200)}`);
    const reg = (await regRes.json()) as { agent: { id: string }; key: string };
    opts.log(`① 注册 ${a.agentName}（${a.modelName}）→ ${reg.agent.id}　密钥 ${reg.key.slice(0, 12)}…（仅本次可见）`);

    // 2) 打包上传（走真实的 zip 闸门与五阶段校验）
    const zip = createZip([
      { name: "strategy.js", data: a.script },
      { name: "meta.json", data: JSON.stringify(a.meta) },
    ]);
    const upRes = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Authorization: `Bearer ${reg.key}` },
      body: new Uint8Array(zip),
    });
    const upBody = (await upRes.json().catch(() => ({}))) as { ok?: boolean; stage?: string; error?: string; scriptLines?: number };
    if (!upRes.ok || !upBody.ok) {
      throw new Error(`上传失败（HTTP ${upRes.status} / stage=${upBody.stage ?? "?"}）：${upBody.error ?? ""}`);
    }
    opts.log(`② 上传成功：${zip.length} 字节 zip，脚本 ${upBody.scriptLines} 行，五阶段校验全部通过`);
    ids.push(reg.agent.id);
  }

  if (!opts.tournament) return { agentIds: ids };

  // 3) 发起 1v1 循环赛
  const tRes = await fetch(`${base}/api/tournaments`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ agentIds: ids, gamesPerPair: opts.gamesPerPair, name: "演示赛（自动生成）", maxRounds: opts.maxRounds, ...(opts.mapId ? { mapId: opts.mapId } : {}) }),
  });
  if (!tRes.ok) throw new Error(`创建赛事失败（HTTP ${tRes.status}）：${(await tRes.text()).slice(0, 200)}`);
  const created = (await tRes.json()) as { tournamentId: string; totalMatches: number; seed: number; mapId?: string };
  opts.log(`③ 赛事已创建：${created.tournamentId}（${ids.length} 个 Agent，共 ${created.totalMatches} 局，地图 ${created.mapId ?? "默认"}，seed=${created.seed}）`);

  // 4) 轮询到结束
  const started = Date.now();
  let last = "";
  for (;;) {
    const detail = (await (await fetch(`${base}/api/tournaments/${created.tournamentId}`, { headers: authed() })).json()) as {
      tournament: { status: string; finishedMatches: number; matchCount: number; error?: string };
      standings: { rank: number; agentName: string; modelName: string; played: number; wins: number; draws: number; losses: number; points: number; scoreDiff: number; totalScore: number; totalUnitsDeposited: number }[];
    };
    const t = detail.tournament;
    const progress = `${t.finishedMatches}/${t.matchCount}`;
    if (progress !== last) { opts.log(`④ 进度 ${progress}`); last = progress; }
    if (t.status === "finished" || t.status === "failed") {
      if (t.status === "failed") throw new Error(`赛事失败：${t.error ?? ""}`);
      opts.log(`⑤ 赛事结束，积分榜：`);
      for (const s of detail.standings) {
        opts.log(
          `   #${s.rank} ${s.agentName.padEnd(6, "　")}（${s.modelName}） 积分 ${s.points}｜${s.wins} 胜 ${s.draws} 平 ${s.losses} 负｜` +
          `净胜分差 ${s.scoreDiff >= 0 ? "+" : ""}${s.scoreDiff}｜总得分 ${s.totalScore}｜提交 ${s.totalUnitsDeposited} 单位`,
        );
      }
      return { agentIds: ids, tournamentId: created.tournamentId };
    }
    if (Date.now() - started > 15 * 60 * 1000) throw new Error("等待赛事结束超时");
    await new Promise((r) => setTimeout(r, 1000));
  }
}