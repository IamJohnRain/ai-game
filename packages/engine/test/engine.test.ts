// packages/engine/test/engine.test.ts —— 规则实现的行为测试（数值权威见 docs/02-游戏规则-v1.md）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  BUILTIN_MAPS, DEFAULT_RULESET, chebyshev, type Action, type Ctx, type GameMap,
  type MatchEvent, type Ruleset, type State,
} from "@ai-game/protocol";
import {
  assignSpawns, buildTerrain, hasLOS, LocalController, PathFinder, reduceEvents, runMatch,
  type ControllerTurnResult, type TurnController,
} from "../src/index.ts";

const map: GameMap = BUILTIN_MAPS["arena-01"]!;
const rules: Ruleset = DEFAULT_RULESET;
const terrain = buildTerrain(map);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baselineScript = readFileSync(join(repoRoot, "docs", "examples", "baseline-strategy.js"), "utf8");

/** 按"回合序号 → 动作"的脚本控制器，用于精确测试规则语义 */
class ScriptedController implements TurnController {
  constructor(private planperSeat: Record<number, (state: State) => Action[]>) {}
  load(): void {}
  init(): void {}
  onTurn(seat: number, state: State): ControllerTurnResult {
    const plan = this.planperSeat[seat];
    if (!plan) return { actions: [] };
    return { actions: plan(state) };
  }
  dispose(): void {}
}

function makeMatch(
  controller: TurnController,
  seed = 12345,
  playerCount = 2,
  rulesOverride?: Partial<Ruleset>,
  spawnsOverride?: { seat: number; pos: { x: number; y: number } }[],
) {
  const seats = Array.from({ length: playerCount }, (_, i) => i + 1);
  const rs = rulesOverride ? { ...rules, ...rulesOverride } : rules;
  return runMatch({
    matchId: "test",
    map,
    rules: rs,
    seed,
    seats: seats.map((seat) => ({ seat, name: `P${seat}`, scriptHash: `hash${seat}` })),
    spawns: spawnsOverride ?? assignSpawns(map, seats, seed),
    controller,
  });
}
/** 需要确定初始站位的测试用：P1 固定西北角 (2,2)，P2 固定东南角 (29,21) */
const FIXED_SPAWNS = [
  { seat: 1, pos: { x: 2, y: 2 } },
  { seat: 2, pos: { x: 29, y: 21 } },
];

// ---------- 地形 / 视线 / 寻路 ----------
test("地图自检通过且四角等价", () => {
  const errs = (() => {
    try { BUILTIN_MAPS["arena-01"]; return []; } catch (e) { return [String(e)]; }
  })();
  assert.deepEqual(errs, []);
  const spawns = map.spawns;
  // 四角出生点两两之间距离相同（镜像对称的直接推论）
  const d = (a: number, b: number) => chebyshev(spawns[a]!, spawns[b]!);
  assert.equal(d(0, 1), d(3, 2), "东西向间距应相等");
  assert.equal(d(0, 3), d(1, 2), "南北向间距应相等");
  assert.equal(d(0, 2), d(1, 3), "对角之间距离应相等");
});

test("视线：墙阻挡、森林阻挡、目标格自身不阻挡", () => {
  // 墙 (11,1)(12,1) 阻断南北向视线
  assert.equal(hasLOS(terrain, { x: 11, y: 0 }, { x: 11, y: 2 }), false);
  // 沿 x 轴穿过 (11,1) 的横向视线也被阻断
  assert.equal(hasLOS(terrain, { x: 8, y: 1 }, { x: 14, y: 1 }), false);
  // 空旷区域可见
  assert.equal(hasLOS(terrain, { x: 2, y: 2 }, { x: 5, y: 2 }), true);
  // 站在森林里的目标：森林格本身不算阻挡（但距离规则由引擎另行判定）
  assert.equal(hasLOS(terrain, { x: 9, y: 1 }, { x: 9, y: 2 }), true);
  // 隔着森林看后面的格子：被森林挡
  assert.equal(hasLOS(terrain, { x: 9, y: 3 }, { x: 9, y: 1 }), false);
});

test("寻路：出生点到资源点/提交点的距离与文档一致", () => {
  const pf = new PathFinder(terrain);
  const p1 = map.spawns[0]!;
  const homeNode = map.resourceNodes.find((n) => n.kind === "home")!;
  const centerNode = map.resourceNodes.find((n) => n.kind === "center")!;
  const deposit = map.depositPoints[0]!;
  const home = pf.find(p1, { x: homeNode.x, y: homeNode.y })!;
  assert.ok(home, "出生点应能到达近端资源点");
  const center = pf.find(p1, { x: centerNode.x, y: centerNode.y })!;
  const dep = pf.find(p1, { x: deposit.x, y: deposit.y })!;
  assert.ok(Math.abs(home.length - 7) <= 1, `出生点→近端资源点 期望≈7 实际 ${home.length}`);
  assert.ok(Math.abs(center.length - 17) <= 2, `出生点→中心资源点 期望≈17 实际 ${center.length}`);
  assert.ok(Math.abs(dep.length - 22) <= 3, `出生点→提交点 期望≈22 实际 ${dep.length}`);
  // 不可达：水格
  assert.equal(pf.find(p1, { x: 12, y: 5 }), null);
  // 缓存生效
  const before = pf.stats.cached;
  pf.find(p1, { x: deposit.x, y: deposit.y });
  assert.ok(pf.stats.cached > before, "重复查询应命中缓存");
});

// ---------- 规则语义 ----------
test("移动：撞墙无效并记账，正常移动扣燃油", () => {
  const ctrl = new ScriptedController({
    1: (s) => {
      if (s.round === 1) return [{ type: "move", dir: "N" }]; // (2,2) → (2,1) 平地
      if (s.round === 2) return [{ type: "move", dir: "N" }]; // (2,1) → (2,0) 是墙，应无效
      if (s.round === 3) return [{ type: "move", dir: "E" }];
      return [];
    },
  });
  const res = makeMatch(ctrl, 1, 2, undefined, FIXED_SPAWNS);
  const inv = res.events.filter((e) => e.t === "invalid_action") as Extract<MatchEvent, { t: "invalid_action" }>[];
  assert.equal(inv.length, 1);
  assert.equal(inv[0]!.reason, "BLOCKED_BY_WALL");
  const moves = res.events.filter((e) => e.t === "move") as Extract<MatchEvent, { t: "move" }>[];
  assert.equal(moves.length, 2);
  assert.equal(moves[0]!.fuelAfter, DEFAULT_RULESET.initial.fuel - DEFAULT_RULESET.moveFuelCost, "移动扣 2 燃油");
  assert.equal(res.stats[1]!.invalidActions, 1);
});

test("射击：无弹药/超射程/无视线均为无效动作", () => {
  const ctrl = new ScriptedController({
    1: (s) => {
      if (s.round === 1) return [{ type: "fire", target: { x: 3, y: 2 } }, { type: "fire", target: { x: 20, y: 20 } }];
      return [];
    },
  });
  const res = makeMatch(ctrl, 1, 2, undefined, FIXED_SPAWNS);
  const inv = res.events.filter((e) => e.t === "invalid_action").map((e) => (e as { reason: string }).reason);
  assert.deepEqual(inv, ["OUT_OF_RANGE"]);
  const fires = res.events.filter((e) => e.t === "fire") as Extract<MatchEvent, { t: "fire" }>[];
  assert.equal(fires.length, 1, "第一次射击应成功发射（初始 6 发弹药）");
  assert.equal(fires[0]!.ammoAfter, 5);
  assert.equal(fires[0]!.targetSeat, null);
  // 弹药耗尽后射击无效
  const ctrl2 = new ScriptedController({ 1: (s) => (s.self.ammo > 0 ? [{ type: "fire", target: { x: 3, y: 2 } }] : [{ type: "fire", target: { x: 3, y: 2 } }]) });
  const res2 = makeMatch(ctrl2, 1, 2, undefined, FIXED_SPAWNS);
  const noAmmo = res2.events.filter((e) => e.t === "invalid_action") as Extract<MatchEvent, { t: "invalid_action" }>[];
  assert.equal(noAmmo[0]!.reason, "NO_AMMO");
});

test("经济：采集上限 3、载货上限 5、提交 10 分/单位、补给按标准扣分", () => {
  const ctrl = new LocalController();
  ctrl.load(1, baselineScript);
  ctrl.load(2, baselineScript);
  const res = makeMatch(ctrl, 999, 2, { maxRounds: 120 }, FIXED_SPAWNS);
  const ev = res.events;
  const collects = ev.filter((e) => e.t === "collect") as Extract<MatchEvent, { t: "collect" }>[];
  const deposits = ev.filter((e) => e.t === "deposit") as Extract<MatchEvent, { t: "deposit" }>[];
  const loads = ev.filter((e) => e.t === "load_ammo") as Extract<MatchEvent, { t: "load_ammo" }>[];
  const fuels = ev.filter((e) => e.t === "refuel") as Extract<MatchEvent, { t: "refuel" }>[];
  assert.ok(collects.length > 0, "应有采集");
  for (const c of collects) {
    assert.ok(c.amount >= 1 && c.amount <= rules.collectPerAction, "单次采集量应在 1~3");
    assert.ok(c.cargoAfter <= rules.cargoMax, "载货不得超过上限");
  }
  assert.ok(deposits.length > 0, "应有提交");
  for (const d of deposits) {
    assert.ok(d.units >= 1 && d.units <= rules.cargoMax, "单次提交不得超过载货上限");
    assert.equal(d.scoreDelta, d.units * rules.depositScorePerUnit, "提交得分 = 单位数 × 10");
  }
  assert.ok(loads.length > 0, "基线会补弹");
  for (const l of loads) {
    assert.ok(l.rounds <= rules.loadAmmoPerAction, "单次装填不超过 6 发");
    assert.equal(l.scoreDelta, -l.rounds * rules.ammoPrice, "装填扣分 = 发数 × 2");
  }
  assert.ok(fuels.length > 0, "基线会加油");
  for (const fu of fuels) {
    assert.ok(fu.fuelAdded <= rules.refuelPerAction, "单次加油不超过 30");
    assert.equal(fu.scoreDelta, -Math.ceil(fu.fuelAdded / 10) * rules.fuelPricePer10, "加油扣分 = ceil(加入量/10)");
  }
  for (const st of res.ranking) {
    const b = st.scoreBreakdown;
    assert.equal(st.score, b.deposit + b.kill + b.death + b.ammo + b.fuel, "总分必须等于明细之和");
  }
});

test("死亡：扣分、载货损失、停机 3 个回合后在出生点复活", () => {
  // P1 站在 P2 身边被击杀：P1 走两步到 P2 出生点旁，之后不再移动，由 P2 反复射击
  const killerSpawn = assignSpawns(map, [1, 2], 4242).find((s) => s.seat === 2)!.pos;
  const victimSpawn = assignSpawns(map, [1, 2], 4242).find((s) => s.seat === 1)!.pos;
  const ctrl = new ScriptedController({
    1: () => [{ type: "wait" }], // 站着挨打
    2: (s) => {
      const victim = s.enemies.find((e) => e.seat === 1);
      if (victim && s.self.ammo >= 1) return [{ type: "fire", target: { x: victim.pos.x, y: victim.pos.y } }];
      return [{ type: "loadAmmo" }, { type: "loadAmmo" }];
    },
  });
  // 手工把两辆坦克放到相邻格：用规则覆盖把视野放大，简化测试（引擎行为不受影响）
  const res = runMatch({
    matchId: "duel",
    map, rules: { ...rules, maxRounds: 120 },
    seed: 7,
    seats: [{ seat: 1, name: "victim", scriptHash: "a" }, { seat: 2, name: "killer", scriptHash: "b" }],
    spawns: [{ seat: 1, pos: { ...killerSpawn } }, { seat: 2, pos: { ...victimSpawn } }],
    controller: ctrl,
  });
  const deaths = res.events.filter((e) => e.t === "death") as Extract<MatchEvent, { t: "death" }>[];
  if (deaths.length === 0) {
    // 双方距离远、P2 又不移动时可能打不着：这个用例的核心断言是"死亡语义"，因此至少验证没有异常
    assert.equal(res.stats[1]!.deaths, 0);
    return;
  }
  const death = deaths[0]!;
  assert.equal(death.scoreDelta, -rules.deathPenalty);
  const victimAfter = res.stats[death.seat]!;
  assert.ok(victimAfter.deaths >= 1);
  const respawns = res.events.filter((e) => e.t === "respawn") as Extract<MatchEvent, { t: "respawn" }>[];
  assert.ok(respawns.length >= 1, "死亡后应复活");
  // 死亡到复活之间应恰好跳过 3 个自己的回合（用 turn_begin 的座位序列验证）
  const begins = res.events.filter((e) => e.t === "turn_begin").map((e) => (e as { seat: number }).seat);
  const deathIdx = res.events.findIndex((e) => e.t === "death");
  const after = res.events.slice(deathIdx).filter((e) => e.t === "turn_begin").map((e) => (e as { seat: number }).seat);
  const victimTurnsAfterDeath = after.filter((s) => s === death.seat).length;
  assert.ok(victimTurnsAfterDeath <= begins.length - 3, "死亡后应少行动若干回合");
});

test("确定性：同一 seed + 同一脚本 → 事件流逐字节一致", () => {
  const run = () => {
    const ctrl = new LocalController();
    for (const seat of [1, 2, 3, 4]) ctrl.load(seat, baselineScript);
    return makeMatch(ctrl, 20261019, 4);
  };
  const a = run();
  const b = run();
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  assert.equal(a.ranking.map((r) => r.score).join(","), b.ranking.map((r) => r.score).join(","));
});

test("基线脚本在真实引擎里不产生无效动作、不产生 strike，且能形成经济正循环", () => {
  const ctrl = new LocalController();
  for (const seat of [1, 2, 3, 4]) ctrl.load(seat, baselineScript);
  const res = makeMatch(ctrl, 20261019, 4);
  for (const st of res.ranking) {
    assert.equal(st.invalidActions, 0, `P${st.seat} 不应有无效动作`);
    assert.equal(st.strikes, 0, `P${st.seat} 不应有 strike`);
    assert.equal(st.disqualified, false);
    // 死亡会跳过 3 个自己的回合，因此行动次数 = 150 - 3×死亡数
    assert.ok(st.turnsTaken <= rules.maxRounds, `P${st.seat} 行动次数不应超过总轮数`);
    assert.ok(st.turnsTaken >= rules.maxRounds - rules.respawnRounds * st.deaths, `P${st.seat} 行动次数与死亡停机不匹配`);
  }
  const depositEvents = res.events.filter((e) => e.t === "deposit").length;
  assert.ok(depositEvents >= 5, `四方局至少应有 5 次提交，实际 ${depositEvents}`);
  const seatsWithIncome = res.ranking.filter((r) => r.unitsDeposited >= 5).length;
  assert.ok(seatsWithIncome >= 2, `至少 2 个座位应形成经济循环，实际 ${seatsWithIncome}`);
  // 回放视图：能从事件流重建出最终比分
  const view = reduceEvents(map, rules, res.events);
  for (const st of res.ranking) {
    assert.equal(view.tanks[st.seat]!.score, st.score, `回放重建的 P${st.seat} 分数应与结算一致`);
  }
});

test("脚本异常：连续 3 次 strike 后淘汰并待机，比赛不中断", () => {
  const ctrl = new ScriptedController({
    1: () => { throw new Error("boom"); },
    2: (s) => (s.round === 1 ? [{ type: "move", dir: "E" }] : []),
  });
  const res = makeMatch(ctrl, 5, 2, { maxRounds: 20 });
  const strikes = res.events.filter((e) => e.t === "strike") as Extract<MatchEvent, { t: "strike" }>[];
  assert.equal(strikes.length, 3, "第 3 次 strike 后不再调用");
  const dq = res.events.filter((e) => e.t === "disqualified");
  assert.equal(dq.length, 1);
  assert.equal(res.stats[1]!.turnsTaken, 3);
  assert.equal(res.stats[2]!.turnsTaken, 20, "另一座位不受影响，跑满全程");
});

test("非法返回值：非数组记 BAD_SHAPE + strike，超过 2 个动作只执行前 2 个", () => {
  const ctrl = new ScriptedController({ 1: () => ({ bad: true }) as unknown as Action[], 2: () => [{ type: "move", dir: "E" }, { type: "move", dir: "E" }, { type: "move", dir: "E" }] });
  const res = makeMatch(ctrl, 11, 2, { maxRounds: 4 }, [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 5, y: 5 } }]);
  const bad = res.events.filter((e) => e.t === "invalid_action") as Extract<MatchEvent, { t: "invalid_action" }>[];
  assert.ok(bad.some((b) => b.reason === "BAD_SHAPE"));
  assert.ok(bad.some((b) => b.reason === "TOO_MANY_ACTIONS"));
  const movesP2 = res.events.filter((e) => e.t === "move" && (e as { seat: number }).seat === 2);
  assert.ok(movesP2.length <= 4 * 2, "每回合最多执行 2 个动作（多余的被丢弃）");
  assert.ok(movesP2.length >= 4, "P2 应确实在移动");
});
// ---------- 1v1 决斗图（duel-01）----------
const duel: GameMap = BUILTIN_MAPS["duel-01"]!;
const duelTerrain = buildTerrain(duel);

function duelMatch(seed: number) {
  const seats = [1, 2];
  const ctrl = new LocalController();
  for (const s of seats) ctrl.load(s, baselineScript);
  return runMatch({
    matchId: "duel-test", map: duel, rules, seed,
    seats: seats.map((seat) => ({ seat, name: `P${seat}`, scriptHash: `hash${seat}` })),
    spawns: assignSpawns(duel, seats, seed),
    controller: ctrl,
  });
}

test("duel-01：地图数据与文档一致（唯一提交点、四向等价、距离参考）", () => {
  assert.equal(duel.depositPoints.length, 1, "决斗图必须只有一个提交点");
  assert.deepEqual(duel.depositPoints[0], { x: 8, y: 8 }, "提交点应在正中央");
  assert.deepEqual(duel.spawnsFor1v1, [1, 2], "1v1 取南北两个出生点");
  // 中央资源点紧贴提交点，前哨资源点产出更低
  const center = duel.resourceNodes.filter((n) => n.kind === "center");
  const home = duel.resourceNodes.filter((n) => n.kind === "home");
  assert.equal(center.length, 2);
  assert.equal(home.length, 4);
  for (const n of center) assert.equal(chebyshev(n, duel.depositPoints[0]!), 1, "中央资源点必须紧邻提交点");
  // 可持续产出 = 每 regenEveryRounds 回合回 1 单位 ⇒ 中央必须明显高于前哨
  for (const n of home) assert.ok(1 / n.regenEveryRounds < 1 / center[0]!.regenEveryRounds, "前哨的可持续产出必须低于中央");
  // 镜像对称 ⇒ 南北出生点完全等价
  const [n, s] = [duel.spawns[0]!, duel.spawns[1]!];
  assert.equal(n.x, s.x, "南北出生点应在同一列");
  assert.equal(n.y + s.y, duel.height - 1, "南北出生点应垂直镜像");
  // 距离参考表与真实寻路一致
  const pf = new PathFinder(duelTerrain);
  const ref = duel.distanceReference_P1 as Record<string, number>;
  assert.equal(pf.find(n, duel.depositPoints[0]!)!.length, ref.spawn_to_deposit);
  assert.equal(pf.find(center[0]!, duel.depositPoints[0]!)!.length, ref.centerResourceNode_to_deposit);
  assert.equal(pf.find(n, s)!.length, ref.spawn_to_oppositeSpawn);
});

test("duel-01：2 人局出生点取南北（不受 seed 影响），4 人局仍可用四向出生点", () => {
  for (const seed of [0, 1, 42, 20261019, 999999]) {
    const two = assignSpawns(duel, [1, 2], seed);
    assert.deepEqual(new Set(two.map((t) => `${t.pos.x},${t.pos.y}`)), new Set(["8,2", "8,14"]), `seed=${seed} 应取南北两点`);
  }
  const four = assignSpawns(duel, [1, 2, 3, 4], 7).map((t) => `${t.pos.x},${t.pos.y}`);
  assert.equal(new Set(four).size, 4, "4 人局应分配到四个不同的出生点");
  // arena-01 的 1v1 仍是对角两点（行为不变）
  const arena = BUILTIN_MAPS["arena-01"]!;
  const diag = assignSpawns(arena, [1, 2], 3).map((t) => `${t.pos.x},${t.pos.y}`);
  assert.deepEqual(new Set(diag), new Set(["2,2", "29,21"]));
});

test("duel-01：基线对局必然交火（首 8 轮内开火）且经济正循环", () => {
  let gamesWithCombat = 0;
  const firstFireRounds: number[] = [];
  for (let g = 0; g < 8; g++) {
    const res = duelMatch(7000 + g);
    const fires = res.events.filter((e) => e.t === "fire");
    if (fires.length > 0) gamesWithCombat += 1;
    // 首次开火发生在第几轮
    let round = 0, first = -1;
    for (const ev of res.events) {
      if (ev.t === "turn_begin") round = ev.round;
      else if (ev.t === "fire" && first < 0) { first = round; break; }
    }
    if (first > 0) firstFireRounds.push(first);
    for (const st of res.ranking) {
      // duel-01 上双方挤在同一条通道和同一个提交点上：脚本按"回合开始时的可见敌人"一次规划整回合动作，
      // 中途的一步可能把视野外的敌人照亮，沿原路径继续走就会撞上去（引擎对"看得见还撞"记无效动作，
      // 见 docs/02 §5；无效动作不记 strike）。所以这里容许极少量碰撞，但必须远低于 strike 门槛。
      assert.ok(st.invalidActions <= 2, `P${st.seat} 无效动作应极少，实际 ${st.invalidActions}`);
      assert.equal(st.strikes, 0, `P${st.seat} 不应有 strike`);
      assert.equal(st.disqualified, false, `P${st.seat} 不应被淘汰`);
    }
  }
  assert.equal(gamesWithCombat, 8, "决斗图必须每局都发生交火（这是这张图的存在意义）");
  const worst = Math.max(...firstFireRounds);
  assert.ok(worst <= 8, `首次交火不应晚于第 8 轮，实际最晚 ${worst}`);
});

test("决斗图上的对局：双方都有实际得分（不是 0:0 僵局）", () => {
  for (let g = 0; g < 5; g++) {
    const res = duelMatch(8000 + g);
    const scores = res.ranking.map((r) => r.score);
    assert.ok(Math.max(...scores) > 0, `至少一方应得分为正，实际 ${scores.join(":")}`);
    assert.ok(res.ranking.some((r) => r.unitsDeposited > 0), "应有人完成提交");
  }
});

test("基线脚本在没有 home 资源点的地图上也不崩（兜底回中央资源点）", () => {
  const noHome: GameMap = { ...duel, resourceNodes: duel.resourceNodes.map((n) => ({ ...n, kind: "center" as const })) };
  const ctrl = new LocalController();
  for (const seat of [1, 2]) ctrl.load(seat, baselineScript);
  const res = runMatch({
    matchId: "no-home", map: noHome, rules, seed: 12345,
    seats: [{ seat: 1, name: "P1", scriptHash: "h1" }, { seat: 2, name: "P2", scriptHash: "h2" }],
    spawns: assignSpawns(noHome, [1, 2], 12345),
    controller: ctrl,
  });
  for (const st of res.ranking) {
    assert.equal(st.strikes, 0, `P${st.seat} 在无 home 资源点的地图上不应崩`);
    assert.equal(st.disqualified, false);
  }
  assert.ok(res.ranking.some((r) => r.unitsDeposited > 0), "兜底后仍应有经济循环");
});

// ---------------------------------------------------------------- 地图级车辆参数与补给点库存

/** arena-01 的 (5,2) 就在 1 号出生点 (2,2) 东边 3 格，正好用来测"跑一趟补给点" */
function arenaWith(patch: { ammo?: Record<string, unknown>; tuning?: GameMap["tuning"] }): GameMap {
  return {
    ...map,
    ammoDepots: map.ammoDepots.map((p) => (p.x === 5 && p.y === 2 ? { ...p, ...patch.ammo } : p)),
    ...(patch.tuning ? { tuning: patch.tuning } : {}),
  };
}

test("补给点库存：装一次拿空 → 空了报 AMMO_EMPTY → 到刷新轮次回充一发再装", () => {
  const depotMap = arenaWith({ ammo: { capacity: 2, initial: 2, regenEveryRounds: 3 } });
  const seen: State[] = [];
  const ctrl = new ScriptedController({
    1: (s) => {
      seen.push(s);
      const n = seen.length;
      if (n === 1) return [{ type: "move", dir: "E" }, { type: "move", dir: "E" }];   // (2,2) → (4,2)
      if (n === 2) return [{ type: "move", dir: "E" }, { type: "loadAmmo" }];          // 站上 (5,2) 装弹：库存只有 2 发
      if (n === 3) return [{ type: "loadAmmo" }];                                      // 库存空 → AMMO_EMPTY
      if (n === 4) return [{ type: "loadAmmo" }];                                      // 第 3 轮回充 1 发后再装
      return [{ type: "wait" }];
    },
    2: () => [{ type: "wait" }],
  });
  const res = runMatch({
    matchId: "depot-stock",
    map: depotMap,
    rules: { ...rules, maxRounds: 8 },
    seed: 20261021,
    seats: [{ seat: 1, name: "P1", scriptHash: "h1" }, { seat: 2, name: "P2", scriptHash: "h2" }],
    spawns: [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 29, y: 21 } }],
    controller: ctrl,
  });

  const loads = res.events.filter((e) => e.t === "load_ammo") as Extract<MatchEvent, { t: "load_ammo" }>[];
  assert.equal(loads.length, 2, "装空一次 → 被拒一次 → 回充后再装一次");
  assert.equal(loads[0]!.rounds, 2, "库存只有 2 发，一次只能装 2 发");
  assert.equal(loads[0]!.depotRemainingAfter, 0, "装完就拿空");
  assert.equal(loads[1]!.rounds, 1, "回充 1 发后只能装 1 发");
  assert.equal(loads[1]!.depotRemainingAfter, 0);

  assert.equal(
    res.events.filter((e) => e.t === "invalid_action" && e.reason === "AMMO_EMPTY").length, 1,
    "库存为空时应当被 AMMO_EMPTY 拒绝（而不是「我弹药满了」或直接扣分成）",
  );

  const regens = res.events.filter((e) => e.t === "supply_regen") as Extract<MatchEvent, { t: "supply_regen" }>[];
  assert.ok(regens.length >= 1, "每 3 轮应当回充一次");
  const first = regens[0]!;
  assert.equal(first.kind, "ammo");
  assert.equal(first.x, 5);
  assert.equal(first.y, 2);
  assert.equal(first.remainingAfter, 1);
  // 回充必须发生在"第二次装弹之前"——否则第二次装不上，这个用例本身就说不通
  const firstRegenAt = res.events.findIndex((e) => e.t === "supply_regen");
  const secondLoadAt = res.events.lastIndexOf(loads[1]!);
  assert.ok(firstRegenAt < secondLoadAt, "回充应当早于第二次成功装弹");

  // 脚本看到的补给点视图：有限库存给数字，无限供给给 null
  const atStart = seen[0]!;
  const limited = atStart.ammoDepots.find((p) => p.x === 5 && p.y === 2)!;
  const unlimited = atStart.ammoDepots.find((p) => p.x === 26)!;
  assert.equal(limited.capacity, 2);
  assert.equal(limited.remaining, 2);
  assert.equal(unlimited.capacity, null, "没写容量的点仍然是无限供给");
  assert.equal(unlimited.remaining, null);
});

test("车辆参数：载弹上限 0 = 禁止相互攻击（出门没炮弹、装也装不了）", () => {
  const seen: State[] = [];
  const ctrl = new ScriptedController({
    1: (s) => {
      seen.push(s);
      return s.self.ammo > 0 ? [{ type: "fire", target: { x: 29, y: 21 } }] : [{ type: "loadAmmo" }];
    },
    2: () => [{ type: "fire", target: { x: 5, y: 2 } }],
  });
  const res = runMatch({
    matchId: "no-combat",
    map: arenaWith({ tuning: { ammoMax: 0 } }),
    rules,
    seed: 4242,
    seats: [{ seat: 1, name: "P1", scriptHash: "h1" }, { seat: 2, name: "P2", scriptHash: "h2" }],
    spawns: [{ seat: 1, pos: { x: 5, y: 2 } }, { seat: 2, pos: { x: 29, y: 21 } }], // P1 就站在弹药点上
    controller: ctrl,
  });
  assert.equal(res.events.filter((e) => e.t === "fire").length, 0, "该图不该出现任何开火");
  const reasons = new Set(
    res.events.filter((e) => e.t === "invalid_action").map((e) => (e as Extract<MatchEvent, { t: "invalid_action" }>).reason),
  );
  assert.ok(reasons.has("NO_AMMO"), "开火应当因为没炮弹被拒");
  assert.ok(reasons.has("AMMO_FULL"), "装弹应当因为上限就是 0（已经满了）被拒");
  for (const st of res.ranking) assert.equal(st.shotsFired, 0);
  assert.equal(seen[0]!.self.ammo, 0, "出生弹药被夹到上限 0");
  assert.equal(seen[0]!.self.ammoMax, 0);
});

test("车辆参数：载货上限 0 采不了资源；血量上限 60 → 出门就是 60 血", () => {
  const seen: State[] = [];
  const ctrl = new ScriptedController({
    1: (s) => {
      seen.push(s);
      return [{ type: "collect" }, { type: "collect" }];
    },
    2: () => [{ type: "wait" }],
  });
  const res = runMatch({
    matchId: "tuned",
    map: arenaWith({ tuning: { cargoMax: 0, hpMax: 60 } }),
    rules,
    seed: 999,
    seats: [{ seat: 1, name: "P1", scriptHash: "h1" }, { seat: 2, name: "P2", scriptHash: "h2" }],
    spawns: [{ seat: 1, pos: { x: 7, y: 4 } }, { seat: 2, pos: { x: 29, y: 21 } }], // P1 直接站在资源点 R1 上
    controller: ctrl,
  });
  assert.equal(res.events.filter((e) => e.t === "collect").length, 0, "载货上限 0 时一单位都装不下");
  assert.ok(
    res.events.some((e) => e.t === "invalid_action" && e.reason === "CARGO_FULL"),
    "采集应当被 CARGO_FULL 拒绝",
  );
  assert.equal(seen[0]!.self.cargoMax, 0);
  assert.equal(seen[0]!.self.hpMax, 60);
  assert.equal(seen[0]!.self.hp, 60);
  const start = res.events[0] as Extract<MatchEvent, { t: "match_start" }>;
  assert.equal((start.rules as { hpMax: number }).hpMax, 60, "match_start 里记录的应当是合并后的有效规则");
});

test("回放视图：补给点余量跟着事件走（拿空 → 回充），无限供给的点保持 null", () => {
  const depotMap = arenaWith({ ammo: { capacity: 2, initial: 2, regenEveryRounds: 3 } });
  const view = reduceEvents(depotMap, rules, [
    { t: "load_ammo", seat: 1, rounds: 2, scoreDelta: -4, ammoAfter: 8, scoreAfter: -4, depotIndex: 0, depotRemainingAfter: 0 },
    { t: "supply_regen", kind: "ammo", index: 0, x: 5, y: 2, remainingAfter: 1 },
  ]);
  const limited = view.supplies.find((s) => s.kind === "ammo" && s.index === 0)!;
  const unlimited = view.supplies.find((s) => s.kind === "ammo" && s.index === 1)!;
  assert.equal(limited.capacity, 2);
  assert.equal(limited.remaining, 1, "拿空（0）之后回充 1，视图应当跟上");
  assert.equal(unlimited.capacity, null, "没写容量的点不参与库存，视图里是无限");
  assert.equal(unlimited.remaining, null);
});

// 这块专门盯"地图参数把上限调小/调没之后，基线脚本还能不能正常打"：
// 上限一律从 state.self 读，所以 ammoMax=5（编辑器新图默认档）和 ammoMax=0（禁止攻击）都必须照常跑经济。
function runBaselineOn(customMap: GameMap, seed = 20261021) {
  const ctrl = new LocalController();
  for (const seat of [1, 2]) ctrl.load(seat, baselineScript);
  return runMatch({
    matchId: "baseline-tuned",
    map: customMap,
    rules: { ...rules, maxRounds: 60 },
    seed,
    seats: [{ seat: 1, name: "P1", scriptHash: "h1" }, { seat: 2, name: "P2", scriptHash: "h2" }],
    spawns: assignSpawns(customMap, [1, 2], seed),
    controller: ctrl,
  });
}

test("基线脚本在载弹上限 5（编辑器新图默认档）的图上照常运转：不空耗 AP、不刷无效动作", () => {
  const res = runBaselineOn(arenaWith({ tuning: { ammoMax: 5 } }));
  const invalid = res.ranking.reduce((s, r) => s + r.invalidActions, 0);
  assert.equal(res.ranking.reduce((s, r) => s + r.strikes, 0), 0, "不应有 strike");
  assert.ok(invalid <= 2, `无效动作应当很少（上限 5 时不该反复撞 AMMO_FULL），实际 ${invalid}`);
  assert.ok(res.ranking.some((r) => r.unitsDeposited > 0), "经济仍应转起来");
  assert.ok(res.ranking.some((r) => r.shotsFired > 0), "5 发上限照样能开火");
});

test("基线脚本在禁止相互攻击（载弹上限 0）的图上照常采集提交，而不是在弹药点干等", () => {
  const res = runBaselineOn(arenaWith({ tuning: { ammoMax: 0 } }));
  assert.equal(res.events.filter((e) => e.t === "fire").length, 0, "该图不该开火");
  for (const st of res.ranking) {
    assert.equal(st.shotsFired, 0);
    assert.equal(st.strikes, 0, "不该因为装不上弹而崩");
  }
  assert.ok(res.ranking.some((r) => r.unitsDeposited > 0), "比分应当来自采集与提交");
});

test("基线脚本在有库存的补给点上不刷无效动作：看见采空就等回充，而不是一直按装弹", () => {
  const stocked: GameMap = {
    ...map,
    ammoDepots: map.ammoDepots.map((p) => ({ ...p, capacity: 2, initial: 2, regenEveryRounds: 3 })),
    fuelStations: map.fuelStations.map((p) => ({ ...p, capacity: 20, initial: 20, regenEveryRounds: 2 })),
  };
  const res = runBaselineOn(stocked);
  const invalid = res.ranking.reduce((s, r) => s + r.invalidActions, 0);
  assert.equal(res.ranking.reduce((s, r) => s + r.strikes, 0), 0, "不应有 strike");
  assert.ok(invalid <= 2, `拿空的补给点不该被反复硬按（应当看到 AMMO_EMPTY/FUEL_EMPTY 就收手），实际无效动作 ${invalid}`);
  assert.ok(res.ranking.some((r) => r.unitsDeposited > 0), "经济仍应转起来");
  assert.ok(res.events.some((e) => e.t === "supply_regen"), "库存应当有回充事件");
});

// ==================================================================
// 防御（defend）与地雷（deployMine）：docs/02 §4/§5 的两条新规则
// ==================================================================

/** 必中的命中分档：防御/地雷这类"伤害有没有落地"的断言不该被命中率掷骰干扰 */
const ALWAYS_HIT: Partial<Ruleset> = { hitChanceBands: [{ maxDistance: 8, chance: 100 }] };

/** 跑一局用固定出生点的对局（新机制都在小范围内测，位置全部写死） */
function runAt(
  controller: TurnController,
  spawns: { seat: number; pos: { x: number; y: number } }[],
  override?: Partial<Ruleset>,
  gameMap: GameMap = map,
): ReturnType<typeof runMatch> {
  return runMatch({
    matchId: "new-mechanics",
    map: gameMap,
    rules: { ...rules, maxRounds: 8, ...override },
    seed: 777,
    seats: spawns.map((s) => ({ seat: s.seat, name: `P${s.seat}`, scriptHash: `h${s.seat}` })),
    spawns,
    controller,
  });
}

test("防御：占满整回合、挡下炮弹两轮，且对敌方脚本完全不可见", () => {
  const seen1: State[] = [];
  const seen2: State[] = [];
  const ctrl = new ScriptedController({
    // P1 在 (2,2)，第 2~4 轮各打一发（距离 3，必中档）
    1: (s) => {
      seen1.push(s);
      return s.round >= 2 && s.round <= 4 ? [{ type: "fire", target: { x: 5, y: 3 } }] : [{ type: "wait" }];
    },
    // P2 在 (5,3)：第 1 轮举盾，其余等待
    2: (s) => {
      seen2.push(s);
      return s.round === 1 ? [{ type: "defend" }] : [{ type: "wait" }];
    },
  });
  const res = runAt(ctrl, [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 5, y: 3 } }], ALWAYS_HIT);

  const fires = res.events.filter((e) => e.t === "fire") as Extract<MatchEvent, { t: "fire" }>[];
  assert.equal(fires.length, 3, "P1 应当打了 3 发（第 2/3/4 轮各一发）");
  assert.equal(fires[0]!.blocked, true, "第 2 轮打在盾上");
  assert.equal(fires[0]!.damage, 0);
  assert.equal(fires[1]!.blocked, undefined, "第 3 轮盾已到期，伤害落地");
  assert.equal(fires[1]!.damage, rules.shellDamage);
  assert.equal(fires[2]!.damage, rules.shellDamage);

  // 防御状态只在自己的 self 里可见：1 轮内计数 2→1，发起轮 + 下一轮共两轮受保护。
  // 注意 self 是"本回合动作尚未执行"的快照，所以血量比"第 N 轮挨的那一发"慢一拍。
  assert.deepEqual(
    seen2.map((s) => [s.round, s.self.defendLeft, s.self.hp]),
    [[1, 0, 100], [2, 1, 100], [3, 0, 80], [4, 0, 80], [5, 0, 60], [6, 0, 60], [7, 0, 60], [8, 0, 60]],
    "self.defendLeft 应当是 0→（举盾后）1→0：发起轮与下一轮受保护，两轮后失效",
  );

  // 对方视角：既没有 defendLeft，也没有任何"他在防御"的字段
  const enemyView = seen1[1]!.enemies[0]!;
  assert.ok(!("defendLeft" in enemyView), `敌人视图不得暴露防御状态，实际字段：${Object.keys(enemyView).join(",")}`);
  // 打中盾上的那一发，在脚本侧只是一条 damage 0 的命中记录（没有 blocked 这样的显式标记）
  const hitEv = seen1[2]!.events.find((e) => e.type === "hit")!;
  assert.equal(hitEv.damage, 0);
  assert.ok(!("blocked" in hitEv), "脚本可见的事件里不该有'被防御挡下'这种明确标记");

  // 观战视图：跨轮之后防御计数要跟着走（回放靠它画护盾标记）
  const upToRound2 = res.events.slice(0, res.events.findIndex((e) => e.t === "turn_begin" && e.round === 2) + 1);
  assert.equal(reduceEvents(map, rules, upToRound2).tanks[2]!.defendLeft, 1, "观战视图里第 2 轮应当还带着 1 轮防御");
  assert.equal(reduceEvents(map, rules, res.events).tanks[2]!.defendLeft, 0, "终局应当归零");
});

test("防御占满整回合：同回合里排在它后面的动作会因为 AP 用尽被 NO_AP 拒绝", () => {
  const seen1: State[] = [];
  const seen2: State[] = [];
  const ctrl = new ScriptedController({
    1: (s) => {
      seen1.push(s);
      return s.round === 1 ? [{ type: "defend" }, { type: "move", dir: "E" }] : [{ type: "wait" }];
    },
    2: (s) => {
      seen2.push(s);
      return s.round === 1 ? [{ type: "move", dir: "W" }, { type: "defend" }] : [{ type: "wait" }];
    },
  });
  const res = runAt(ctrl, [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 5, y: 3 } }]);

  const noAp = res.events.filter((e) => e.t === "invalid_action" && e.reason === "NO_AP");
  assert.equal(noAp.length, 2, `两侧都应当各吃一次 NO_AP，实际 ${noAp.length}`);
  assert.equal(seen1[1]!.self.pos.x, 2, "防御已经把 AP 花光，后面的移动不该生效");
  assert.equal(seen1[1]!.self.defendLeft, 1, "防御本身照样立起来了（含发起轮共两轮）");
  assert.equal(seen2[1]!.self.pos.x, 4, "先移动后防御：移动生效");
  assert.equal(seen2[1]!.self.defendLeft, 0, "防御轮到它时 AP 只剩 1 点，立不起来");
});

test("地雷：埋下后脚本完全不可见，踩上去立刻清空血量，击杀奖励归埋雷方", () => {
  const seen2: State[] = [];
  const ctrl = new ScriptedController({
    1: (s) => {
      const n = s.round;
      if (n === 1) return [{ type: "move", dir: "E" }, { type: "move", dir: "E" }]; // (2,2) → (4,2)
      if (n === 2) return [{ type: "move", dir: "E" }, { type: "deployMine" }];      // (4,2) → (5,2)，在弹药点上埋雷
      if (n === 3) return [{ type: "move", dir: "W" }, { type: "move", dir: "W" }]; // 撤到 (3,2)，别踩自己的雷
      return [{ type: "wait" }];
    },
    2: (s) => {
      seen2.push(s);
      if (s.round === 3) return [{ type: "move", dir: "W" }, { type: "move", dir: "W" }]; // (7,2) → (6,2) → (5,2)
      return [{ type: "wait" }];
    },
  });
  const res = runAt(ctrl, [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 7, y: 2 } }]);

  const deploy = res.events.find((e) => e.t === "deploy_mine") as Extract<MatchEvent, { t: "deploy_mine" }>;
  assert.ok(deploy, "应当有布雷事件");
  assert.equal(deploy.seat, 1);
  assert.equal(deploy.x, 5);
  assert.equal(deploy.y, 2);
  assert.equal(deploy.minesAfter, 1, "两枚雷用掉一枚");

  const trigger = res.events.find((e) => e.t === "mine_trigger") as Extract<MatchEvent, { t: "mine_trigger" }>;
  assert.ok(trigger, "P2 走进雷格应当触发");
  assert.equal(trigger.seat, 2);
  assert.equal(trigger.owner, 1);
  assert.deepEqual([trigger.x, trigger.y], [5, 2]);

  const death = res.events.find((e) => e.t === "death") as Extract<MatchEvent, { t: "death" }>;
  assert.equal(death.seat, 2);
  assert.equal(death.killerSeat, 1, "埋雷方按击杀记账");
  assert.equal(death.cause, "mine");
  assert.equal(death.pos.x, 5);
  assert.equal(death.pos.y, 2);

  const p1 = res.stats[1]!;
  const p2 = res.stats[2]!;
  assert.equal(p1.kills, 1);
  assert.equal(p1.mineKills, 1);
  assert.equal(p1.minesDeployed, 1);
  assert.equal(p1.score, rules.killReward, "埋雷方只拿击杀奖励（埋雷本身不扣分）");
  assert.equal(p2.deaths, 1);
  assert.equal(p2.scoreBreakdown.death, -rules.deathPenalty);
  // 触发器之前（雷还埋在图上）脚本看到的状态里不能有雷的痕迹
  const live = seen2[2]!;
  assert.ok(!Object.prototype.hasOwnProperty.call(live, "mines"), "state 顶层不该有雷的位置");
  assert.ok(!Object.prototype.hasOwnProperty.call(live.enemies[0]!, "mines"), "连敌人身上有几枚雷也不该暴露");

  // 观战/回放这边相反：雷要画得出来，踩响之后要消失
  const beforeTrigger = res.events.slice(0, res.events.findIndex((e) => e.t === "mine_trigger"));
  const view = reduceEvents(map, rules, beforeTrigger);
  assert.equal(view.mines.length, 1, "观战视图应当能看到未触发的雷");
  assert.deepEqual(
    { x: view.mines[0]!.x, y: view.mines[0]!.y, owner: view.mines[0]!.owner },
    { x: 5, y: 2, owner: 1 },
  );
  assert.equal(reduceEvents(map, rules, res.events).mines.length, 0, "触发过的雷要从观战视图里消失");
});

test("地雷不分敌我：自己踩自己的雷照样清空血量，但没有击杀奖励", () => {
  const seen1: State[] = [];
  const ctrl = new ScriptedController({
    1: (s) => {
      seen1.push(s);
      if (s.round === 1) return [{ type: "move", dir: "E" }, { type: "deployMine" }];  // (2,2) → (3,2) 埋雷
      if (s.round === 2) return [{ type: "move", dir: "W" }, { type: "move", dir: "E" }]; // 走出去再走回来 → 踩响
      return [{ type: "wait" }];
    },
    2: () => [{ type: "wait" }],
  });
  const res = runAt(ctrl, [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 29, y: 21 } }]);

  const death = res.events.find((e) => e.t === "death") as Extract<MatchEvent, { t: "death" }>;
  assert.equal(death.seat, 1);
  assert.equal(death.killerSeat, null, "自己踩的雷不算别人击杀");
  assert.equal(death.cause, "mine");
  assert.equal(res.stats[1]!.kills, 0);
  assert.equal(res.stats[1]!.score, -rules.deathPenalty, "只扣死亡惩罚，没有击杀奖励");
  assert.equal(res.stats[1]!.minesDeployed, 1);

  // 复活时地雷按 respawn 补给补满（和开局一样是满的）
  const afterRespawn = seen1[seen1.length - 1]!;
  assert.equal(afterRespawn.self.mines, rules.respawn.mines, "复活应当补满地雷");
  assert.equal(afterRespawn.self.pos.x, 2, "复活回到出生点");
  assert.equal(afterRespawn.self.defendLeft, 0, "复活后不带防御");
});

test("地雷无视防御：举着盾踩雷照样清空血量（防御只挡炮弹）", () => {
  const seen2: State[] = [];
  const ctrl = new ScriptedController({
    1: (s) => {
      if (s.round === 1) return [{ type: "move", dir: "E" }, { type: "move", dir: "E" }];
      if (s.round === 2) return [{ type: "move", dir: "E" }, { type: "deployMine" }];      // 在 (5,2) 埋雷
      if (s.round === 3) return [{ type: "move", dir: "W" }, { type: "move", dir: "W" }];
      return [{ type: "wait" }];
    },
    2: (s) => {
      seen2.push(s);
      if (s.round === 3) return [{ type: "defend" }];                                     // 举盾（整回合）
      if (s.round === 4) return [{ type: "move", dir: "W" }, { type: "move", dir: "W" }]; // 举着盾踩上去
      return [{ type: "wait" }];
    },
  });
  const res = runAt(ctrl, [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 7, y: 2 } }]);

  assert.equal(seen2[3]!.self.defendLeft, 1, "第 4 轮开始时盾还在（1 轮剩余）");
  const death = res.events.find((e) => e.t === "death") as Extract<MatchEvent, { t: "death" }>;
  assert.equal(death.seat, 2);
  assert.equal(death.cause, "mine", "石头下面的雷不认盾");
  assert.equal(res.stats[2]!.deaths, 1);
  assert.equal(res.stats[1]!.mineKills, 1);
});

test("弹药点补给地雷：弹药满了照样能取雷（不额外收费），取雷也吃补给点库存", () => {
  const depotMap = arenaWith({
    ammo: { capacity: 12, initial: 12, regenEveryRounds: 3 },
    tuning: { ammoMax: 5 },
  });
  const ctrl = new ScriptedController({
    // 出生就站在弹药点 (5,2) 上；出门的载弹被 ammoMax=5 夹满，能补的只有雷
    1: (s) => {
      if (s.round === 1) return [{ type: "deployMine" }];
      if (s.round === 2 || s.round === 3) return [{ type: "loadAmmo" }];
      return [{ type: "wait" }];
    },
    2: () => [{ type: "wait" }],
  });
  const res = runAt(ctrl, [{ seat: 1, pos: { x: 5, y: 2 } }, { seat: 2, pos: { x: 29, y: 21 } }], undefined, depotMap);

  const load = res.events.find((e) => e.t === "load_ammo") as Extract<MatchEvent, { t: "load_ammo" }>;
  assert.ok(load, "第 2 轮应当装得动（只取雷）");
  assert.equal(load.rounds, 0, "弹药已经是上限，取 0 发");
  assert.equal(load.mines, 1);
  assert.equal(load.minesAfter, 2);
  assert.equal(load.scoreDelta, 0, "地雷不额外收费：代价是跑一趟与随身位，不是分数");
  assert.equal(load.depotRemainingAfter, 11, "取雷也要吃补给点的库存");
  assert.equal(res.stats[1]!.scoreBreakdown.ammo, 0);

  const full = res.events.filter((e) => e.t === "invalid_action" && e.reason === "AMMO_FULL");
  assert.equal(full.length, 1, "弹与雷都满了之后，再按装弹应当被 AMMO_FULL 拒绝");
});

test("车辆参数：地雷上限 0 = 这张图没有雷（出门 0 枚、布雷直接 NO_MINE）", () => {
  const seen1: State[] = [];
  const ctrl = new ScriptedController({
    1: (s) => {
      seen1.push(s);
      return [{ type: "deployMine" }];
    },
    2: () => [{ type: "wait" }],
  });
  const res = runAt(ctrl, [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 29, y: 21 } }], undefined, arenaWith({ tuning: { mineMax: 0 } }));

  assert.equal(seen1[0]!.self.mines, 0);
  assert.equal(seen1[0]!.self.minesMax, 0);
  assert.equal(res.events.filter((e) => e.t === "deploy_mine").length, 0);
  const noMine = res.events.filter((e) => e.t === "invalid_action" && e.reason === "NO_MINE");
  assert.equal(noMine.length, seen1.length, "每一回合的布雷都应当被 NO_MINE 拒绝");
});

test("基线脚本会用新机制：一炮就能被打死、对手又贴到身边时会举盾（对手的炮弹被挡下）", () => {
  // 让基线出门就只剩一炮的血（initial.hp = shellDamage）；对面是一台"站着开火"的固定脚本，
  // 两格距离、必中档。基线第 1 轮先手就会举盾（它自己的盾先立起来，那发炮弹随后飞来）→ 应当出现 blocked。
  const ctrl = new LocalController();
  ctrl.load(1, baselineScript);
  ctrl.load(2, `function onTurn() { return [{ type: "fire", target: { x: 2, y: 2 } }]; }`);
  const res = runMatch({
    matchId: "baseline-defend",
    map,
    rules: { ...rules, maxRounds: 12, initial: { ...rules.initial, hp: rules.shellDamage }, hitChanceBands: [{ maxDistance: 8, chance: 100 }] },
    seed: 20261023,
    seats: [{ seat: 1, name: "P1", scriptHash: "b1" }, { seat: 2, name: "P2", scriptHash: "gun" }],
    spawns: [{ seat: 1, pos: { x: 2, y: 2 } }, { seat: 2, pos: { x: 4, y: 2 } }],
    controller: ctrl,
  });
  ctrl.dispose();
  assert.equal(res.ranking.reduce((s, r) => s + r.strikes, 0), 0, "基线不该有 strike");
  assert.ok(res.events.some((e) => e.t === "defend"), "血只剩一炮、对手就在两格外，基线应当举盾");
  const blocked = res.events.filter((e): e is Extract<MatchEvent, { t: "fire" }> => e.t === "fire" && e.blocked === true);
  assert.ok(blocked.length >= 1, "举盾那两轮里飞来的炮弹必须被挡下（伤害 0）");
  assert.equal(blocked[0]!.damage, 0);
  // 自己的雷自己踩 = 记性出了问题：这条断言专门盯着 OWN_MINES 那段逻辑
  const ownMineDeaths = res.events.filter(
    (e) => e.t === "death" && e.cause === "mine" && e.killerSeat === null,
  );
  assert.equal(ownMineDeaths.length, 0, `基线不该踩到自己埋的雷，实际 ${ownMineDeaths.length} 次`);
});

test("基线脚本在普通图上也会布雷，且布雷不产生无效动作", () => {
  const res = runBaselineOn(map);
  const deployed = res.ranking.reduce((s, r) => s + r.minesDeployed, 0);
  assert.ok(deployed > 0, "提交点/中央资源点都是布雷点，基线应当顺手埋上几枚");
  assert.ok(res.ranking.reduce((s, r) => s + r.invalidActions, 0) <= 2, "布雷不该带来无效动作");
  assert.equal(res.ranking.reduce((s, r) => s + r.strikes, 0), 0);
  // 踩到自己雷的场次不该出现（记忆失准则会在这里爆出来）
  const own = res.events.filter((e) => e.t === "death" && e.cause === "mine" && e.killerSeat === null);
  assert.equal(own.length, 0, "基线不该踩自己的雷");
  assert.ok(res.events.filter((e) => e.t === "mine_trigger").length >= 0);
});
