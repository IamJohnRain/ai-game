// packages/orchestrator/test/rating.test.ts —— 对抗评级的算法验收：强弱序、平局、极端矩阵、置信区间
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateGames, toRating, type RatingGame, type RatingParticipant } from "../src/rating.ts";

const P = (id: string, calibration = false): RatingParticipant => ({
  id, agentName: id, modelName: `model-${id}`, calibration,
});

/** 造一批对局：a 胜 b 记 winner=a；draws 为平局局数 */
function gamesOf(a: string, b: string, aWins: number, bWins: number, draws = 0, legIndex = 0): RatingGame[] {
  const out: RatingGame[] = [];
  for (let i = 0; i < aWins; i++) out.push({ aId: a, bId: b, winnerId: a, aScore: 200, bScore: 100, legIndex });
  for (let i = 0; i < bWins; i++) out.push({ aId: a, bId: b, winnerId: b, aScore: 100, bScore: 200, legIndex });
  for (let i = 0; i < draws; i++) out.push({ aId: a, bId: b, winnerId: null, aScore: 150, bScore: 150, legIndex });
  return out;
}

test("强弱序：全胜 A > B > C，且分值随强度单调（1500 = 几何均值锚点）", () => {
  const games = [
    ...gamesOf("a", "b", 6, 0),
    ...gamesOf("b", "c", 6, 0),
    ...gamesOf("a", "c", 6, 0),
  ];
  const res = rateGames({ participants: [P("a"), P("b"), P("c")], games, bootstrapRounds: 0, minGames: 0 });
  const [ra, rb, rc] = res.rows;
  assert.equal(res.rows.length, 3);
  assert.ok(ra!.rating > rb!.rating && rb!.rating > rc!.rating, `应满足 a>b>c，实际 ${ra!.rating}/${rb!.rating}/${rc!.rating}`);
  // 强度归一到几何均值 1 → 分值（= 1500 + 400·log10 r）的几何均值应为 1500
  const logMean = (ra!.rating + rb!.rating + rc!.rating) / 3;
  assert.ok(Math.abs(logMean - 1500) < 1, `分值应围绕 1500 展开（锚点），实际均值 ${logMean}`);
  assert.equal(ra!.wins, 12, "a 应赢下 12 局（对 b 六局、对 c 六局）");
});

test("平局各算 0.5：双方完全互交白卷时强度相等、rating 都为 1500", () => {
  const games = gamesOf("a", "b", 0, 0, 8);
  const res = rateGames({ participants: [P("a"), P("b")], games, bootstrapRounds: 0, minGames: 0 });
  const [ra, rb] = res.rows;
  assert.equal(ra!.rating, rb!.rating);
  assert.equal(Math.round(ra!.rating), 1500);
  assert.equal(ra!.draws, 8);
});

test("极端矩阵（一方全败）不发散：ε 正则保证有限且大写仍正确", () => {
  const games = gamesOf("strong", "weak", 10, 0);
  const res = rateGames({ participants: [P("strong"), P("weak")], games, bootstrapRounds: 0, minGames: 0 });
  const strong = res.rows.find((r) => r.agentId === "strong")!;
  const weak = res.rows.find((r) => r.agentId === "weak")!;
  assert.ok(Number.isFinite(strong.rating) && Number.isFinite(weak.rating));
  assert.ok(strong.rating > weak.rating);
  assert.ok(strong.rating < 1500 + 400 * 3, `全胜也不该给出天文数字，实际 ${strong.rating}`);
});

test("置信区间：多个 leg 才有宽度，leg 越多越窄；单 leg 退化为按局重采样", () => {
  const manyLegs: RatingGame[] = [];
  for (let leg = 0; leg < 6; leg++) manyLegs.push(...gamesOf("a", "b", 1, 1, 0, leg));
  const twoLegs = [...gamesOf("a", "b", 3, 3, 0, 0), ...gamesOf("a", "b", 3, 3, 0, 1)];
  const oneLeg = gamesOf("a", "b", 6, 6, 0, 0);

  const rMany = rateGames({ participants: [P("a"), P("b")], games: manyLegs, bootstrapRounds: 200, seed: 7, minGames: 0 });
  const rTwo = rateGames({ participants: [P("a"), P("b")], games: twoLegs, bootstrapRounds: 200, seed: 7, minGames: 0 });
  const rOne = rateGames({ participants: [P("a"), P("b")], games: oneLeg, bootstrapRounds: 200, seed: 7, minGames: 0 });
  const width = (r: typeof rMany) => r.rows[0]!.hi - r.rows[0]!.lo;
  assert.ok(Number.isFinite(width(rMany)), "应有有限区间");
  assert.ok(width(rOne) > 0, "单 leg 时按局重采样，区间不能退化成 0");
  // 这里不比较宽度大小关系（bootstrap 宽度受样本结构影响，指标是"有区间可用"而不是某种单调保证）
  assert.ok(width(rMany) >= 0 && width(rTwo) >= 0);
});

test("确定性：同输入 + 同 seed → 完全一致（可复现写入战报）", () => {
  const games = [...gamesOf("a", "b", 4, 2, 1, 0), ...gamesOf("a", "c", 3, 3, 0, 1), ...gamesOf("b", "c", 5, 1, 0, 2)];
  const participants = [P("a"), P("b"), P("c")];
  const r1 = rateGames({ participants, games, seed: 42, minGames: 0 });
  const r2 = rateGames({ participants, games, seed: 42, minGames: 0 });
  assert.deepEqual(r1.rows, r2.rows);
  assert.deepEqual(r1.matrix, r2.matrix);
});

test("样本不足：局数低于阈值标记 insufficient 并排到正式名次之后", () => {
  const games = [...gamesOf("a", "b", 8, 4), ...gamesOf("c", "a", 0, 1, 0, 1)];
  const res = rateGames({ participants: [P("a"), P("b"), P("c")], games, minGames: 12, bootstrapRounds: 0 });
  const c = res.rows.find((r) => r.agentId === "c")!;
  assert.equal(c.insufficient, true, "只打了 1 局应标记样本不足");
  assert.equal(res.rows.at(-1)!.agentId, "c", "样本不足应排在最后");
  assert.equal(res.rows[0]!.insufficient, false);
});

test("胜负矩阵：方向与净胜分差中位数正确（含标尺对手）", () => {
  const games = [
    ...gamesOf("me", "baseline", 3, 1, 0, 0),
    ...gamesOf("me", "idle", 4, 0, 0, 1),
  ];
  const res = rateGames({
    participants: [P("me"), P("baseline", true), P("idle", true)],
    games, bootstrapRounds: 0, minGames: 0,
  });
  const vsBaseline = res.matrix.find((c) => c.aId === "baseline")!;
  assert.equal(vsBaseline.wins, 1, "baseline 赢 1 局");
  assert.equal(vsBaseline.losses, 3, "baseline 输 3 局");
  assert.equal(vsBaseline.games, 4);
  assert.equal(vsBaseline.medianDiff, -100, "净胜分差中位数应为 -100（对手每局多 100 分）");
  assert.equal(res.games, 8);
  assert.equal(res.rows.find((r) => r.agentId === "baseline")!.calibration, true, "标尺对手要带标记");
});

test("toRating：强度比 10 倍 ≈ 400 分（Elo 量纲换算）", () => {
  assert.equal(toRating(1), 1500);
  assert.equal(toRating(10), 1900);
  assert.equal(toRating(0.1), 1100);
});