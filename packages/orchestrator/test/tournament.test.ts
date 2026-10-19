// packages/orchestrator/test/tournament.test.ts —— 循环赛的公平性与确定性
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUILTIN_MAPS, DEFAULT_RULESET } from "@ai-game/protocol";
import { runTournament, pairCombinations, type TournamentAgent } from "../src/tournament.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readFileSync(join(repoRoot, "docs", "examples", "baseline-strategy.js"), "utf8");
// 一个明显更差的脚本：原地不动，用于验证排名方向
const idle = `function onInit() {}\nfunction onTurn() { return [{ type: "wait" }]; }\n`;

const agent = (id: string, script: string): TournamentAgent => ({
  id, agentName: `Agent-${id}`, modelName: `model-${id}`, script, scriptHash: `hash-${id}`,
});
const map = BUILTIN_MAPS["arena-01"]!;

test("配对组合数：3 个 Agent → 3 对（C(3,2)）", () => {
  assert.equal(pairCombinations([1, 2, 3]).length, 3);
  assert.equal(pairCombinations([1, 2, 3, 4]).length, 6);
});

test("1v1 循环赛：局数正确、积分正确、基线明显强于挂机脚本", async () => {
  const outcome = await runTournament({
    tournamentId: "t-test",
    map,
    rules: { ...DEFAULT_RULESET, maxRounds: 40 },
    seed: 20261019,
    agents: [agent("a", baseline), agent("b", idle), agent("c", baseline)],
    gamesPerPair: 2,
  });
  // 3 对 × 2 局 = 6 局
  assert.equal(outcome.matches.length, 6);
  assert.equal(outcome.results.length, 6);
  for (const s of outcome.standings) assert.equal(s.played, 4, "每个 Agent 应打 4 局");
  assert.equal(outcome.standings.reduce((sum, s) => sum + s.points, 0), 6, "总积分 = 局数 × 1 分");

  const idleStanding = outcome.standings.find((s) => s.agentId === "b")!;
  assert.equal(idleStanding.rank, 3, "挂机脚本应垫底");
  assert.equal(idleStanding.wins, 0);
  assert.ok(idleStanding.totalUnitsDeposited === 0);
  assert.ok(idleStanding.scoreDiff < 0);
  // 两个基线脚本实力相同：A/C 之间应各有胜负或打平，且名次靠前
  assert.ok(outcome.standings[0]!.agentId !== "b");
});

test("互换座位：同一对的两局里，双方各拿到过同一个出生点", async () => {
  const outcome = await runTournament({
    tournamentId: "t-swap",
    map,
    rules: { ...DEFAULT_RULESET, maxRounds: 20 },
    seed: 777,
    agents: [agent("x", baseline), agent("y", baseline)],
    gamesPerPair: 2,
  });
  assert.equal(outcome.matches.length, 2);
  // 事件流里记录的是座位→出生点；两局座位互换，因此各自拿到过两个出生点
  const spawnsBySeat = outcome.results.map((r) => {
    const start = r.result.events.find((e) => e.t === "match_start") as
      | { seats: { seat: number; name: string; spawn: { x: number; y: number } }[] }
      | undefined;
    return new Map(start!.seats.map((s) => [s.name, `${s.spawn.x},${s.spawn.y}`]));
  });
  const first = spawnsBySeat[0]!;
  const second = spawnsBySeat[1]!;
  assert.notEqual(first.get("Agent-x"), second.get("Agent-x"), "同一种子的两局应互换座位，Agent-x 获得不同出生点");
  assert.equal(first.get("Agent-x"), second.get("Agent-y"), "同一局里两个 Agent 的出生点必须不同");
});

test("确定性：同一赛事参数重复运行结果逐字节一致", async () => {
  const config = {
    tournamentId: "t-det",
    map,
    rules: { ...DEFAULT_RULESET, maxRounds: 30 },
    seed: 31337,
    agents: [agent("a", baseline), agent("b", idle)],
    gamesPerPair: 2,
  };
  const first = await runTournament(config);
  const second = await runTournament(config);
  assert.equal(JSON.stringify(first.standings), JSON.stringify(second.standings));
  assert.equal(
    JSON.stringify(first.results.map((r) => r.result.events)),
    JSON.stringify(second.results.map((r) => r.result.events)),
  );
});

test("拒绝非法输入：少于 2 个 Agent 时抛错", async () => {
  await assert.rejects(
    () => runTournament({ tournamentId: "t", map, seed: 1, agents: [agent("a", baseline)] }),
    /至少需要 2 个 Agent/,
  );
});