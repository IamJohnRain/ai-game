// packages/orchestrator/src/rating.ts —— 对抗评级：Bradley–Terry 极大似然 + bootstrap 置信区间 + 胜负矩阵
//
// 为什么不用"平均分"排序：平均分取决于你跟谁打（对手越弱分越高），跨批次的均分不可比。
// BT 把"谁赢谁"折算成强度比，配合 bootstrap 置信区间，才能回答"这两个模型的差距是不是噪声"。
//
// 设计要点：
//   - 纯函数、无外部依赖、确定性：同样的输入（含 seed）永远给同样的评级与区间，测试可断言。
//   - MM 迭代 + ε 正则：即使出现"某 Agent 全胜/全败"（似然无界）也能收敛，不会 NaN。
//   - 平局按各得 0.5 计入。
//   - 展示分值 rating = 1500 + 400·log10(r)，Elo 量纲（差 200 分 ≈ 强度比 10 倍），便于人读。
import { deriveSeed, mulberry32 } from "@ai-game/engine";

/** 一场对局的胜负（一局 = 两位参赛者，可能是平局） */
export interface RatingGame {
  aId: string;
  bId: string;
  /** 胜者 agentId；平局为 null */
  winnerId: string | null;
  aScore: number;
  bScore: number;
  /** 属于哪个 leg（bootstrap 按 leg 重采样，保持"同一批条件下的多局"这一结构） */
  legIndex: number;
}

export interface RatingParticipant {
  id: string;
  agentName: string;
  modelName: string;
  /** true = 标尺（idle/baseline）：榜上单列，供读者当刻度看 */
  calibration?: boolean;
}

export interface RatingRow {
  agentId: string;
  agentName: string;
  modelName: string;
  calibration: boolean;
  /** Elo 量纲的强度值（1500 为中位） */
  rating: number;
  /** bootstrap 置信区间（2.5% / 97.5% 分位） */
  lo: number;
  hi: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** 净胜分差（本批内该 Agent 所有对局的 得分差 之和） */
  scoreDiff: number;
  avgScore: number;
  /** 参与局数不足（区间过宽）时为 true，榜上排到正式名次之后 */
  insufficient: boolean;
}

export interface PairMatrixCell {
  /** 字典序较小的那方（aId < bId），wins/losses/medianDiff 都从 aId 的视角记 */
  aId: string;
  bId: string;
  wins: number;
  draws: number;
  losses: number;
  /** 净胜分差中位数（aId 视角：正 = aId 更大），比均值抗极端局 */
  medianDiff: number;
  games: number;
}

export interface RatingResult {
  rows: RatingRow[];
  matrix: PairMatrixCell[];
  /** 参与评级的局数（= games.length） */
  games: number;
  bootstrapRounds: number;
  seed: number;
}

export interface RatingOptions {
  participants: RatingParticipant[];
  games: RatingGame[];
  /** bootstrap 重采样次数（0 = 不做区间，只给点估计） */
  bootstrapRounds?: number;
  seed?: number;
  /** 参与局数低于此值标记"样本不足" */
  minGames?: number;
}

const DEFAULT_BOOTSTRAP = 200;
const DEFAULT_MIN_GAMES = 12;
const EPS = 0.1;
const ITERATIONS = 100;

/** 强度 r → 展示分值（Elo 量纲） */
export function toRating(r: number): number {
  return Math.round((1500 + 400 * Math.log10(Math.max(r, 1e-9))) * 10) / 10;
}

/** BT 的 MM 迭代：r_i ← (w_i + ε) / Σ_j ( n_ij / (r_i + r_j) + ε ) */
function fitStrength(ids: string[], pair: Map<string, PairRecord>): Map<string, number> {
  const r = new Map<string, number>(ids.map((id) => [id, 1]));
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Map<string, number>();
    for (const id of ids) {
      let denom = EPS;
      let wins = 0;
      for (const other of ids) {
        if (other === id) continue;
        const rec = pair.get(pairKey(id, other));
        if (!rec || rec.n === 0) continue;
        const ri = r.get(id)!;
        const rj = r.get(other)!;
        denom += rec.n / (ri + rj);
        wins += winsOf(rec, id) + rec.draws * 0.5;
      }
      next.set(id, (wins + EPS) / Math.max(denom, 1e-9));
    }
    // 归一到几何均值 1，避免整体漂移
    let logSum = 0;
    for (const id of ids) logSum += Math.log(Math.max(next.get(id)!, 1e-12));
    const norm = Math.exp(logSum / Math.max(ids.length, 1));
    for (const id of ids) {
      const v = next.get(id)! / norm;
      r.set(id, Number.isFinite(v) && v > 0 ? v : 1e-9);
    }
  }
  return r;
}

/** 两两战绩：键统一按字典序（`小|大`），胜负按 agentId 记，避免方向搞反 */
interface PairRecord {
  n: number;
  draws: number;
  /** agentId → 该 Agent 赢下的局数 */
  wins: Map<string, number>;
}
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function winsOf(rec: PairRecord, id: string): number {
  return rec.wins.get(id) ?? 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

export function rateGames(opts: RatingOptions): RatingResult {
  const bootstrapRounds = opts.bootstrapRounds ?? DEFAULT_BOOTSTRAP;
  const minGames = opts.minGames ?? DEFAULT_MIN_GAMES;
  const seed = opts.seed ?? 20261019;
  const ids = opts.participants.map((p) => p.id);

  /** 由一组对局统计两两战绩 */
  const tallyOf = (games: RatingGame[]): Map<string, PairRecord> => {
    const pair = new Map<string, PairRecord>();
    for (const g of games) {
      const key = pairKey(g.aId, g.bId);
      let rec = pair.get(key);
      if (!rec) { rec = { n: 0, draws: 0, wins: new Map() }; pair.set(key, rec); }
      rec.n += 1;
      if (g.winnerId === null) rec.draws += 1;
      else {
        const winner = g.winnerId === g.aId ? g.aId : g.bId;
        rec.wins.set(winner, (rec.wins.get(winner) ?? 0) + 1);
      }
    }
    return pair;
  };

  const allPair = tallyOf(opts.games);
  const strength = fitStrength(ids, allPair);

  // bootstrap：优先按 leg 重采样（保持"同一条件下的多局"成组出现）；
  // 只有 1 个 leg 时退化为按局重采样（近似），否则区间会退化成一点、看着像"零噪声"。
  const byLeg = new Map<number, RatingGame[]>();
  for (const g of opts.games) {
    const list = byLeg.get(g.legIndex) ?? [];
    list.push(g);
    byLeg.set(g.legIndex, list);
  }
  const legList = [...byLeg.values()];
  const samples = new Map<string, number[]>(ids.map((id) => [id, []]));
  if (bootstrapRounds > 0 && opts.games.length > 0) {
    const rng = mulberry32(deriveSeed(seed, "rating-bootstrap"));
    const resampleLegs = legList.length >= 2;
    for (let b = 0; b < bootstrapRounds; b++) {
      const resampled: RatingGame[] = [];
      if (resampleLegs) {
        for (let k = 0; k < legList.length; k++) resampled.push(...legList[Math.floor(rng() * legList.length)]!);
      } else {
        for (let k = 0; k < opts.games.length; k++) resampled.push(opts.games[Math.floor(rng() * opts.games.length)]!);
      }
      const r = fitStrength(ids, tallyOf(resampled));
      for (const id of ids) samples.get(id)!.push(toRating(r.get(id)!));
    }
  }
  const quantile = (xs: number[], q: number): number => {
    if (xs.length === 0) return NaN;
    const sorted = [...xs].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const v = lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
    return Math.round(v * 10) / 10;
  };

  const perAgent = new Map<string, { games: number; wins: number; draws: number; losses: number; diff: number; scoreSum: number }>(
    ids.map((id) => [id, { games: 0, wins: 0, draws: 0, losses: 0, diff: 0, scoreSum: 0 }]),
  );
  for (const g of opts.games) {
    const recA = perAgent.get(g.aId)!;
    const recB = perAgent.get(g.bId)!;
    recA.games += 1; recB.games += 1;
    recA.diff += g.aScore - g.bScore; recB.diff += g.bScore - g.aScore;
    recA.scoreSum += g.aScore; recB.scoreSum += g.bScore;
    if (g.winnerId === null) { recA.draws += 1; recB.draws += 1; }
    else if (g.winnerId === g.aId) { recA.wins += 1; recB.losses += 1; }
    else { recB.wins += 1; recA.losses += 1; }
  }

  const rows: RatingRow[] = opts.participants
    .filter((p) => (perAgent.get(p.id)?.games ?? 0) > 0)
    .map((p) => {
      const rec = perAgent.get(p.id)!;
      const point = toRating(strength.get(p.id)!);
      const s = samples.get(p.id) ?? [];
      return {
        agentId: p.id,
        agentName: p.agentName,
        modelName: p.modelName,
        calibration: p.calibration === true,
        rating: point,
        lo: quantile(s, 0.025),
        hi: quantile(s, 0.975),
        games: rec.games, wins: rec.wins, draws: rec.draws, losses: rec.losses,
        scoreDiff: rec.diff,
        avgScore: Math.round((rec.scoreSum / Math.max(rec.games, 1)) * 10) / 10,
        insufficient: rec.games < minGames,
      };
    })
    .sort((x, y) => {
      // 样本不足的排到最后，其次按 rating 降序
      if (x.insufficient !== y.insufficient) return x.insufficient ? 1 : -1;
      return y.rating - x.rating;
    });

const diffs = new Map<string, number[]>();
  for (const g of opts.games) {
    const key = pairKey(g.aId, g.bId);
    const list = diffs.get(key) ?? [];
    // 矩阵格子按字典序（aId < bId）排，所以分差也统一成"aId − bId"，避免方向随传入顺序漂移
    list.push(g.aId === key.split("|")[0] ? g.aScore - g.bScore : g.bScore - g.aScore);
    diffs.set(key, list);
  }
  const matrix: PairMatrixCell[] = [];
  for (const [key, rec] of allPair) {
    const [aId, bId] = key.split("|") as [string, string];
    matrix.push({
      aId, bId,
      wins: winsOf(rec, aId),
      losses: winsOf(rec, bId),
      draws: rec.draws,
      medianDiff: median(diffs.get(key) ?? []),
      games: rec.n,
    });
  }

  return { rows, matrix, games: opts.games.length, bootstrapRounds, seed };
}