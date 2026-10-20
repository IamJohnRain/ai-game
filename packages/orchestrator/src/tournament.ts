// packages/orchestrator/src/tournament.ts —— 1v1 循环赛
// 公平性关键：同一对 Agent 打两局时使用**同一个 seed** 但互换座位，
// 因为 assignSpawns 由 seed 决定，互换座位等于让双方各拿一次同一个出生点，位置优势被完全抵消。
import { DEFAULT_RULESET, type GameMap, type MatchEvent, type MatchResult, type Ruleset } from "@ai-game/protocol";
import { assignSpawns, runMatch, type TurnController } from "@ai-game/engine";
import { QuickJsController } from "@ai-game/sandbox";

export interface TournamentAgent {
  id: string;
  agentName: string;
  modelName: string;
  script: string;
  scriptHash: string;
}

export interface TournamentOptions {
  tournamentId: string;
  map: GameMap;
  rules?: Ruleset;
  seed: number;
  agents: TournamentAgent[];
  /** 每一对打几局（默认 2 = 双方各一次先手/出生点） */
  gamesPerPair?: number;
  /** 每局结束后问一次：返回 true 则停止后续对局（已完成的照常计入）。用于"停止批次"与长批次的响应性 */
  shouldStop?: () => boolean;
  onMatchStart?: (info: { index: number; total: number; pairLabel: string; agents: { seat: number; id: string; agentName: string }[] }) => void;
  onMatchFinished?: (info: {
    index: number; matchId: string; result: MatchResult;
    agents: { seat: number; id: string; agentName: string }[];
  }) => void;
  onEvent?: (matchId: string, event: MatchEvent) => void;
  sandbox?: { cpuMs?: number; memoryMB?: number };
}

export interface Standing {
  rank: number;
  agentId: string;
  agentName: string;
  modelName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  scoreDiff: number;
  totalScore: number;
  totalUnitsDeposited: number;
  kills: number;
  deaths: number;
}

export interface TournamentMatchRecord {
  matchId: string;
  index: number;
  pairLabel: string;
  /** 按成绩排序的座位信息 */
  seats: { seat: number; agentId: string; agentName: string; score: number; rank: number }[];
  winnerAgentId: string | null;
  playedAt: string;
}

export interface TournamentOutcome {
  standings: Standing[];
  matches: TournamentMatchRecord[];
  /** 每局完整结果（含事件流），供落库与回放 */
  results: { matchId: string; index: number; result: MatchResult }[];
}

export function pairCombinations<T>(items: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i]!, items[j]!]);
  }
  return out;
}

export async function runTournament(opts: TournamentOptions): Promise<TournamentOutcome> {
  const rules = opts.rules ?? DEFAULT_RULESET;
  const gamesPerPair = Math.max(1, opts.gamesPerPair ?? 2);
  if (opts.agents.length < 2) throw new Error("循环赛至少需要 2 个 Agent");

  const standings = new Map<string, Standing>();
  for (const a of opts.agents) {
    standings.set(a.id, {
      rank: 0, agentId: a.id, agentName: a.agentName, modelName: a.modelName,
      played: 0, wins: 0, draws: 0, losses: 0, points: 0, scoreDiff: 0,
      totalScore: 0, totalUnitsDeposited: 0, kills: 0, deaths: 0,
    });
  }

  const pairs = pairCombinations(opts.agents);
  const total = pairs.length * gamesPerPair;
  const records: TournamentMatchRecord[] = [];
  const results: TournamentOutcome["results"] = [];
  let index = 0;

  for (const [a, b] of pairs) {
    // 同一对的两局用同一个 seed，只互换座位 → 双方各拿一次同样的出生点
    const pairSeed = derivePairSeed(opts.seed, a.id, b.id);
    for (let g = 0; g < gamesPerPair; g++) {
      index += 1;
      // 偶数局 a 坐 1 号位，奇数局 b 坐 1 号位（gamesPerPair=2 时正好一人一局）
      const firstAgent = g % 2 === 0 ? a : b;
      const secondAgent = g % 2 === 0 ? b : a;
      const matchId = `${opts.tournamentId}-${String(index).padStart(3, "0")}`;
      const pairLabel = `${firstAgent.agentName} vs ${secondAgent.agentName}`;
      const seatAgents = [
        { seat: 1, id: firstAgent.id, agentName: firstAgent.agentName },
        { seat: 2, id: secondAgent.id, agentName: secondAgent.agentName },
      ];
      opts.onMatchStart?.({ index, total, pairLabel, agents: seatAgents });

      const controller: TurnController = await QuickJsController.create(opts.sandbox ?? {});
      controller.load(1, firstAgent.script);
      controller.load(2, secondAgent.script);
      const result = runMatch({
        matchId,
        map: opts.map,
        rules,
        seed: pairSeed,
        seats: [
          { seat: 1, name: firstAgent.agentName, scriptHash: firstAgent.scriptHash },
          { seat: 2, name: secondAgent.agentName, scriptHash: secondAgent.scriptHash },
        ],
        spawns: assignSpawns(opts.map, [1, 2], pairSeed),
        controller,
        ...(opts.onEvent ? { onEvent: (e: MatchEvent) => opts.onEvent!(matchId, e) } : {}),
      });
      controller.dispose();
      // 让出宏任务队列：一次批次可能上百局，若不让出，HTTP 请求（进度轮询/观战）会被整体阻塞，
      // 发起批次的响应也要等整批跑完才发得出去。
      await new Promise((resolve) => setImmediate(resolve));
      if (opts.shouldStop?.()) {
        return { standings: [...standings.values()].map((s) => ({ ...s, rank: 0 })), matches: records, results };
      }

      const agentOfSeat = new Map<number, TournamentAgent>([[1, firstAgent], [2, secondAgent]]);
      const st1 = result.stats[1]!;
      const st2 = result.stats[2]!;
      const s1 = standings.get(firstAgent.id)!;
      const s2 = standings.get(secondAgent.id)!;
      accumulate(s1, st1, st2);
      accumulate(s2, st2, st1);
      let winnerAgentId: string | null = null;
      if (st1.score > st2.score) { s1.wins += 1; s1.points += 1; s2.losses += 1; winnerAgentId = firstAgent.id; }
      else if (st2.score > st1.score) { s2.wins += 1; s2.points += 1; s1.losses += 1; winnerAgentId = secondAgent.id; }
      else { s1.draws += 1; s2.draws += 1; s1.points += 0.5; s2.points += 0.5; }

      records.push({
        matchId, index, pairLabel,
        seats: result.ranking.map((r) => ({
          seat: r.seat,
          agentId: agentOfSeat.get(r.seat)!.id,
          agentName: agentOfSeat.get(r.seat)!.agentName,
          score: r.score,
          rank: r.rank,
        })),
        winnerAgentId,
        playedAt: new Date().toISOString(),
      });
      results.push({ matchId, index, result });
      opts.onMatchFinished?.({ index, matchId, result, agents: seatAgents });
    }
  }

  const ordered = [...standings.values()].sort(
    (x, y) =>
      y.points - x.points ||
      y.scoreDiff - x.scoreDiff ||
      y.totalScore - x.totalScore ||
      y.totalUnitsDeposited - x.totalUnitsDeposited ||
      x.agentName.localeCompare(y.agentName),
  );
  ordered.forEach((s, i) => { s.rank = i + 1; });
  // 完全同分同净胜分则同名次
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (prev.points === cur.points && prev.scoreDiff === cur.scoreDiff && prev.totalScore === cur.totalScore) cur.rank = prev.rank;
  }

  return { standings: ordered, matches: records, results };
}

function accumulate(self: Standing, mine: MatchResult["stats"][number], theirs: MatchResult["stats"][number]): void {
  self.played += 1;
  self.totalScore += mine.score;
  self.scoreDiff += mine.score - theirs.score;
  self.totalUnitsDeposited += mine.unitsDeposited;
  self.kills += mine.kills;
  self.deaths += mine.deaths;
}

/** 由赛事种子与两个 agent id 派生稳定的对局种子（同一场赛事可复现） */
function derivePairSeed(seed: number, aId: string, bId: string): number {
  const [x, y] = [aId, bId].sort();
  let h = seed >>> 0;
  const key = `${x}|${y}`;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}