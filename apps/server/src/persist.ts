// apps/server/src/persist.ts —— 把一场已完成的对局落库（回放 + 战报 + 成绩），并生成复现键
import { buildReport, reproducibilityKey, type ReportSeat } from "@ai-game/orchestrator";
import type { GameMap, MatchResult, Ruleset } from "@ai-game/protocol";
import type { Store } from "./store.ts";

export interface StoredSeat {
  seat: number;
  name: string;
  /** Agent 声明的模型名 */
  modelId: string;
  agentId?: string;
  scriptHash?: string;
  script?: string;
  validation?: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
}

export interface PersistInput {
  matchId: string;
  map: GameMap;
  rules: Ruleset;
  seed: number;
  scriptProtocolVersion: string;
  result: MatchResult;
  seats: StoredSeat[];
  tournamentId?: string;
  startedAt?: string;
}

/** 写入回放、各座位成绩、复现键与战报，并返回战报 Markdown */
export function persistMatchResult(store: Store, input: PersistInput): string {
  const { matchId, result, seats } = input;
  const key = reproducibilityKey({
    scriptProtocolVersion: input.scriptProtocolVersion,
    rules: input.rules,
    map: input.map,
    seed: input.seed,
    seats: seats.map((s) => ({ seat: s.seat, ...(s.scriptHash ? { scriptHash: s.scriptHash } : {}) })),
  });

  store.saveReplay(matchId, result.events, result.ranking);
  store.setMatchStatus(matchId, "finished", {
    endedAt: new Date().toISOString(),
    ranking: result.ranking,
    reproducibilityKey: key,
  });

  for (const st of result.ranking) {
    const seat = seats.find((s) => s.seat === st.seat);
    if (!seat) continue;
    store.savePlayer(matchId, st.seat, {
      modelId: seat.modelId,
      name: seat.name,
      status: "OK",
      ...(seat.agentId ? { agentId: seat.agentId } : {}),
      validation: seat.validation ?? [],
      // 脚本与哈希逐场留档：赛事结束后仍可回答"这一局跑的是哪份脚本"
      ...(seat.script ? { script: seat.script } : {}),
      ...(seat.scriptHash ? { scriptSha256: seat.scriptHash } : {}),
      finalScore: st.score,
      rank: st.rank,
      stats: { ...st } as unknown as Record<string, unknown>,
    });
  }

  const reportSeats: ReportSeat[] = seats.map((s) => ({
    seat: s.seat,
    name: s.name,
    modelId: s.modelId,
    ...(s.agentId ? { agentId: s.agentId } : {}),
    ...(s.scriptHash ? { scriptHash: s.scriptHash } : {}),
    ...(s.validation ? { validation: s.validation } : {}),
  }));

  const report = buildReport({
    matchId,
    map: input.map,
    rules: input.rules,
    seed: input.seed,
    result,
    seats: reportSeats,
    reproducibilityKey: key,
    scriptProtocolVersion: input.scriptProtocolVersion,
    ...(input.tournamentId ? { tournamentId: input.tournamentId } : {}),
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
  });
  store.saveReport(matchId, report);
  return report;
}