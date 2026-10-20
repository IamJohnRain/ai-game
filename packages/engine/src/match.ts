// packages/engine/src/match.ts —— 确定性回合制引擎（规则权威：docs/02-游戏规则-v1.md）
import {
  ActionSchema, API_VERSION, SCHEMA_VERSION, chebyshev, damageOnHit, DIRS, hitChance, step,
  type Action, type Ctx, type GameMap, type InvalidReason, type MatchEvent, type MatchResult,
  type PlayerStats, type Pos, type Ruleset, type ScoreBreakdown, type State, type StateEvent,
} from "@ai-game/protocol";
import { buildTerrain, type Terrain } from "./terrain.ts";
import { PathFinder } from "./pathfind.ts";
import { hasLOS } from "./los.ts";
import { createHostApi, type HostApi } from "./hostApi.ts";
import type { ControllerTurnResult, ScriptGlobals, TurnController } from "./controller.ts";
import { deriveSeed, mulberry32 } from "./rng.ts";

export interface RunMatchInput {
  matchId: string;
  map: GameMap;
  rules: Ruleset;
  seed: number;
  seats: { seat: number; name: string; scriptHash: string }[];
  controller: TurnController;
  onEvent?: (e: MatchEvent) => void;
  /** 每个座位自己的出生点（由调用方按人数与抽签决定） */
  spawns: { seat: number; pos: Pos }[];
}

interface NodeState { id: string; x: number; y: number; capacity: number; remaining: number; regenEveryRounds: number; kind: "home" | "center" }

interface Tank {
  seat: number; name: string; scriptHash: string;
  pos: Pos; spawn: Pos;
  hp: number; ammo: number; fuel: number; cargo: number;
  score: number; alive: boolean; disabledTurns: number;
  moves: number; shotsFired: number; hits: number; damageDealt: number;
  kills: number; deaths: number; deposits: number; unitsDeposited: number; unitsCollected: number;
  ammoLoaded: number; fuelLoaded: number; emergencyMoves: number;
  invalidActions: number; strikes: number; disqualified: boolean; disqualifiedKind?: string;
  turnsTaken: number; decisionMs: number; maxDecisionMs: number;
  breakdown: ScoreBreakdown;
}

const STRIKE_LIMIT = 3;

function emptyBreakdown(): ScoreBreakdown { return { deposit: 0, kill: 0, death: 0, ammo: 0, fuel: 0 }; }

export function runMatch(input: RunMatchInput): MatchResult {
  const { map, rules, seed } = input;
  const terrain = buildTerrain(map);
  const pathFinder = new PathFinder(terrain);
  const engineRng = mulberry32(deriveSeed(seed, "engine"));
  const events: MatchEvent[] = [];
  const emit = (e: MatchEvent) => { events.push(e); input.onEvent?.(e); };

  const spawnOf = new Map(input.spawns.map((s) => [s.seat, s.pos]));
  const tanks = new Map<number, Tank>();
  for (const s of input.seats) {
    const spawn = spawnOf.get(s.seat);
    if (!spawn) throw new Error(`座位 ${s.seat} 缺少出生点`);
    tanks.set(s.seat, {
      seat: s.seat, name: s.name, scriptHash: s.scriptHash, pos: { ...spawn }, spawn: { ...spawn },
      hp: rules.initial.hp, ammo: rules.initial.ammo, fuel: rules.initial.fuel, cargo: rules.initial.cargo,
      score: 0, alive: true, disabledTurns: 0,
      moves: 0, shotsFired: 0, hits: 0, damageDealt: 0,
      kills: 0, deaths: 0, deposits: 0, unitsDeposited: 0, unitsCollected: 0,
      ammoLoaded: 0, fuelLoaded: 0, emergencyMoves: 0,
      invalidActions: 0, strikes: 0, disqualified: false,
      turnsTaken: 0, decisionMs: 0, maxDecisionMs: 0, breakdown: emptyBreakdown(),
    });
  }
  const seatList = input.seats.map((s) => s.seat).sort((a, b) => a - b);

  const nodes: NodeState[] = map.resourceNodes.map((n) => ({
    id: n.id, x: n.x, y: n.y, capacity: n.capacity, remaining: n.initial, regenEveryRounds: n.regenEveryRounds, kind: n.kind,
  }));

  // 每个座位的"自上次行动以来的可知事件"队列
  const pending = new Map<number, StateEvent[]>(seatList.map((s) => [s, []]));
  // 引擎维护的短期敌人记忆：seat -> (enemySeat -> {pos, hp, round})
  const lastKnown = new Map<number, Map<number, { pos: Pos; hp: number; round: number }>>(
    seatList.map((s) => [s, new Map()]),
  );

  const scriptGlobals: ScriptGlobals = { MAP: map, RULES: rules };
  const hostApis = new Map<number, HostApi>();
  const seatRngs = new Map<number, () => number>();
  for (const s of seatList) {
    const rng = mulberry32(deriveSeed(seed, `seat:${s}`));
    seatRngs.set(s, rng);
    hostApis.set(s, createHostApi({
      map, rules, terrain, pathFinder,
      seat: s,
      rng,
      occupied: () => visibleEnemiesOf(s),
      onLog: () => { /* 日志由控制器捕获，宿主侧忽略 */ },
    }));
  }

  /** 脚本可见的占位：只包含本座位能看见的敌方坦克（与 state.enemies 一致，不泄露战争迷雾） */
  function visibleEnemiesOf(seat: number): Pos[] {
    const me = tanks.get(seat);
    if (!me) return [];
    const out: Pos[] = [];
    for (const other of tanks.values()) {
      if (other.seat === seat || !other.alive) continue;
      if (visibleBy(me, other)) out.push({ x: other.pos.x, y: other.pos.y });
    }
    return out;
  }

  emit({
    t: "match_start", mapId: map.mapId, mapVersion: map.version, rulesetVersion: rules.version, seed,
    playerCount: seatList.length,
    seats: input.seats.map((s) => ({ seat: s.seat, name: s.name, scriptHash: s.scriptHash, spawn: { ...(spawnOf.get(s.seat)!) } })),
    rules: rules as unknown as Record<string, unknown>,
  });

  // ---- onInit ----
  for (const s of seatList) {
    const tank = tanks.get(s)!;
    const ctx: Ctx = {
      apiVersion: API_VERSION, rulesetVersion: rules.version, mapVersion: `${map.mapId}@${map.version}`,
      matchId: input.matchId, seat: s, playerName: tank.name, seed: deriveSeed(seed, `seat:${s}`),
      mySpawn: { ...tank.spawn }, playerCount: seatList.length,
    };
    try {
      input.controller.init(s, ctx, hostApis.get(s)!, scriptGlobals);
    } catch (err) {
      // onInit 失败：记录一次 strike，后续每回合都按待机处理
      tank.strikes = STRIKE_LIMIT;
      tank.disqualified = true;
      tank.disqualifiedKind = "INIT_ERROR";
      emit({ t: "strike", seat: s, kind: "exception", detail: `onInit: ${errText(err)}` });
      emit({ t: "disqualified", seat: s, kind: "STRIKES_EXCEEDED" });
    }
  }

  let turn = 0;
  let lastRound = 0;

  for (let round = 1; round <= rules.maxRounds; round++) {
    lastRound = round;
    // 行动顺序：每轮轮换起点
    const startIdx = (round - 1) % seatList.length;
    const order = [...seatList.slice(startIdx), ...seatList.slice(0, startIdx)];

    for (let oi = 0; oi < order.length; oi++) {
      const seat = order[oi]!;
      const tank = tanks.get(seat)!;

      // 停机 / 复活
      if (!tank.alive) {
        if (tank.disabledTurns > 0) { tank.disabledTurns -= 1; continue; }
        tank.alive = true;
        tank.hp = rules.respawn.hp; tank.ammo = rules.respawn.ammo;
        tank.fuel = rules.respawn.fuel; tank.cargo = rules.respawn.cargo;
        tank.pos = { ...tank.spawn };
        emit({ t: "respawn", seat, pos: { ...tank.pos } });
        pushToAll(pending, seatList, { type: "respawn", seat, pos: { ...tank.pos }, round });
      }

      turn += 1;

      // 已淘汰（连续异常/超时）的座位不再行动，但仍在场上（可被击杀）
      if (tank.disqualified) continue;

      emit({ t: "turn_begin", round, turn, seat, order: [...order] });

      const state = buildState(seat, round, turn, oi + 1, order);
      pending.get(seat)!.length = 0; // 本回合的可知事件已随 state 交付
      let result: ControllerTurnResult;
      const t0 = nowMs();
      try {
        result = input.controller.onTurn(seat, state);
      } catch (err) {
        result = { actions: null, kind: "exception", error: errText(err) };
      }
      const spent = nowMs() - t0;
      tank.decisionMs += spent;
      if (spent > tank.maxDecisionMs) tank.maxDecisionMs = spent;
      tank.turnsTaken += 1;

      // 控制器返回值完全不可信：异常/超时 → strike；非数组 → strike + BAD_SHAPE
      if (result.kind === "exception" || result.kind === "timeout") {
        tank.strikes += 1;
        emit({ t: "strike", seat, kind: result.kind, detail: result.error ?? "" });
        if (tank.strikes >= STRIKE_LIMIT) markDisqualified(tank, seat);
        continue;
      }
      if (!Array.isArray(result.actions)) {
        tank.strikes += 1;
        tank.invalidActions += 1;
        emit({ t: "strike", seat, kind: "bad_return", detail: result.error ?? "onTurn 未返回数组" });
        emit({ t: "invalid_action", seat, action: null, reason: "BAD_SHAPE" });
        pushTo(pending, seat, { type: "invalid_action", action: null, reason: "BAD_SHAPE", round });
        if (tank.strikes >= STRIKE_LIMIT) markDisqualified(tank, seat);
        continue;
      }

      let actions = result.actions;
      const maxActions = rules.apPerTurn;
      if (actions.length > maxActions) {
        emit({ t: "invalid_action", seat, action: { extra: actions.length - maxActions }, reason: "TOO_MANY_ACTIONS" });
        pushTo(pending, seat, { type: "invalid_action", action: { extra: actions.length - maxActions }, reason: "TOO_MANY_ACTIONS", round });
        actions = actions.slice(0, maxActions);
      }
      for (let ai = 0; ai < actions.length; ai++) {
        const parsed = ActionSchema.safeParse(actions[ai]);
        if (!parsed.success) {
          invalid(tank, actions[ai], "BAD_SHAPE", round, seat);
          continue;
        }
        applyAction(tank, parsed.data, round, seat, ai);
      }
    }

    // 回合末：资源点回充
    for (const n of nodes) {
      if (round % n.regenEveryRounds === 0 && n.remaining < n.capacity) {
        n.remaining += 1;
        emit({ t: "node_regen", node: n.id, remainingAfter: n.remaining });
      }
    }
  }

  const ranking = finishRanking();
  emit({ t: "match_end", ranking: ranking.map((p) => ({ seat: p.seat, score: p.score, rank: p.rank })) });

  const stats: Record<number, PlayerStats> = {};
  for (const p of ranking) stats[p.seat] = p;
  return {
    ranking, stats, events, seed,
    mapId: map.mapId, mapVersion: map.version, rulesetVersion: rules.version, turns: turn,
  };

  // ---------- 内部函数 ----------
  function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  function errText(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  function pushTo(map2: Map<number, StateEvent[]>, seat: number, ev: StateEvent): void {
    const q = map2.get(seat);
    if (q && q.length < 64) q.push(ev);
  }
  function pushToAll(map2: Map<number, StateEvent[]>, all: number[], ev: StateEvent): void {
    for (const s of all) pushTo(map2, s, ev);
  }

  function visibleBy(observer: Tank, target: Tank): boolean {
    if (!target.alive) return false;
    const d = chebyshev(observer.pos, target.pos);
    if (d > rules.visionRadius) return false;
    const inForest = terrain.forest[terrain.index(target.pos.x, target.pos.y)] === 1;
    if (inForest && d > rules.forestStealthRadius) return false;
    return hasLOS(terrain, observer.pos, target.pos);
  }

  function buildState(seat: number, round: number, turnNo: number, turnInRound: number, order: number[]): State {
    const me = tanks.get(seat)!;
    const seen = lastKnown.get(seat)!;
    const enemies = [];
    for (const other of tanks.values()) {
      if (other.seat === seat) continue;
      if (!visibleBy(me, other)) continue;
      enemies.push({
        seat: other.seat, pos: { ...other.pos }, hp: other.hp, cargo: other.cargo, score: other.score,
        distance: chebyshev(me.pos, other.pos),
      });
      seen.set(other.seat, { pos: { ...other.pos }, hp: other.hp, round });
    }
    // 清理过期记忆
    const lastKnownEnemies = [];
    for (const [enemySeat, rec] of seen) {
      if (round - rec.round > rules.lastKnownMemoryRounds) { seen.delete(enemySeat); continue; }
      lastKnownEnemies.push({ seat: enemySeat, pos: { ...rec.pos }, hp: rec.hp, seenRound: rec.round });
    }
    lastKnownEnemies.sort((a, b) => a.seat - b.seat);

    const nodeViews = nodes.map((n) => {
      const visible = chebyshev(me.pos, { x: n.x, y: n.y }) <= rules.visionRadius && hasLOS(terrain, me.pos, { x: n.x, y: n.y });
      return { id: n.id, x: n.x, y: n.y, capacity: n.capacity, remaining: visible ? n.remaining : null };
    });
    const scores = seatList.map((s) => {
      const t = tanks.get(s)!;
      return { seat: s, score: t.score, alive: t.alive };
    });
    return {
      schemaVersion: SCHEMA_VERSION, round, turn: turnNo, turnOrder: [...order], turnInRound,
      self: {
        seat, pos: { ...me.pos }, hp: me.hp, hpMax: rules.hpMax, ammo: me.ammo, ammoMax: rules.ammoMax,
        fuel: me.fuel, fuelMax: rules.fuelMax, cargo: me.cargo, cargoMax: rules.cargoMax,
        score: me.score, alive: true, disabledTurns: 0, kills: me.kills, deaths: me.deaths,
        spawn: { ...me.spawn },
      },
      enemies,
      lastKnownEnemies,
      resourceNodes: nodeViews,
      depositPoints: map.depositPoints.map((p) => ({ ...p })),
      ammoDepots: map.ammoDepots.map((p) => ({ ...p })),
      fuelStations: map.fuelStations.map((p) => ({ ...p })),
      scores,
      events: (pending.get(seat) ?? []).map((e) => ({ ...e })),
    };
  }

  function markDisqualified(tank: Tank, seat: number): void {
    tank.disqualified = true;
    tank.disqualifiedKind = "STRIKES_EXCEEDED";
    emit({ t: "disqualified", seat, kind: "STRIKES_EXCEEDED" });
  }

  function invalid(tank: Tank, action: unknown, reason: InvalidReason, round: number, seat: number): void {
    tank.invalidActions += 1;
    emit({ t: "invalid_action", seat, action: action as never, reason });
    pushTo(pending, seat, { type: "invalid_action", action, reason, round });
  }

  function applyAction(tank: Tank, action: Action, round: number, seat: number, actionIndex: number): void {
    const t = terrain;
    switch (action.type) {
      case "move": {
        const to = step(tank.pos, action.dir);
        if (!t.inBounds(to.x, to.y)) return invalid(tank, action, "OUT_OF_BOUNDS", round, seat);
        if (t.wall[t.index(to.x, to.y)]) return invalid(tank, action, "BLOCKED_BY_WALL", round, seat);
        if (t.water[t.index(to.x, to.y)]) return invalid(tank, action, "BLOCKED_BY_WATER", round, seat);
        let blocker: Tank | null = null;
        for (const other of tanks.values()) {
          if (other.seat !== seat && other.alive && other.pos.x === to.x && other.pos.y === to.y) blocker = other;
        }
        if (blocker) {
          // 看得见对方却撞上去：脚本自己的错，记无效动作
          if (visibleBy(tank, blocker)) return invalid(tank, action, "BLOCKED_BY_UNIT", round, seat);
          // 看不见的坦克占位：物理阻挡，静默失败（不罚分、不泄露位置信息）
          return;
        }
        // 燃油不足时允许"应急燃料"移动：不耗燃油，但每格扣分（避免卡死半路的死局）
        const emergency = tank.fuel < rules.moveFuelCost;
        const from = { ...tank.pos };
        tank.pos = to;
        if (emergency) {
          tank.emergencyMoves += 1;
          tank.score -= rules.emergencyMoveCost;
          tank.breakdown.fuel -= rules.emergencyMoveCost;
        } else {
          tank.fuel -= rules.moveFuelCost;
        }
        tank.moves += 1;
        emit({ t: "move", seat, from, to: { ...to }, fuelAfter: tank.fuel, ...(emergency ? { emergency: true } : {}) });
        return;
      }
      case "fire": {
        const target = action.target;
        if (!t.inBounds(target.x, target.y)) return invalid(tank, action, "OUT_OF_BOUNDS", round, seat);
        if (tank.ammo < 1) return invalid(tank, action, "NO_AMMO", round, seat);
        if (target.x === tank.pos.x && target.y === tank.pos.y) return invalid(tank, action, "SELF_TARGET", round, seat);
        const d = chebyshev(tank.pos, target);
        if (d > rules.fireRange) return invalid(tank, action, "OUT_OF_RANGE", round, seat);
        if (!hasLOS(t, tank.pos, target)) return invalid(tank, action, "NO_LOS", round, seat);

        tank.ammo -= 1;
        tank.shotsFired += 1;
        let victim: Tank | null = null;
        for (const other of tanks.values()) {
          if (other.seat !== seat && other.alive && other.pos.x === target.x && other.pos.y === target.y) victim = other;
        }
        if (!victim) {
          emit({ t: "fire", seat, target: { ...target }, hit: false, damage: 0, targetSeat: null, ammoAfter: tank.ammo });
          return; // 空放：只消耗弹药
        }
        const victimInForest = t.forest[t.index(victim.pos.x, victim.pos.y)] === 1;
        const chance = hitChance(rules, d, victimInForest);
        const roll = engineRng() * 100;
        const hit = roll < chance;
        if (!hit) {
          emit({ t: "fire", seat, target: { ...target }, hit: false, damage: 0, targetSeat: victim.seat, ammoAfter: tank.ammo });
          pushTo(pending, seat, { type: "miss", by: seat, target: { ...target }, round });
          pushTo(pending, victim.seat, { type: "miss", by: seat, target: { ...target }, round });
          return;
        }
        const dmg = damageOnHit(rules, victimInForest);
        victim.hp -= dmg;
        tank.hits += 1;
        tank.damageDealt += dmg;
        emit({ t: "fire", seat, target: { ...target }, hit: true, damage: dmg, targetSeat: victim.seat, ammoAfter: tank.ammo });
        pushTo(pending, seat, { type: "hit", by: seat, targetSeat: victim.seat, damage: dmg, pos: { ...target }, round });
        pushTo(pending, victim.seat, { type: "hit", by: seat, targetSeat: victim.seat, damage: dmg, pos: { ...target }, round });
        if (victim.hp <= 0) killTank(victim, seat, round);
        return;
      }
      case "collect": {
        const ni = t.resourceIndex[t.index(tank.pos.x, tank.pos.y)];
        if (ni < 0) return invalid(tank, action, "NOT_ON_RESOURCE", round, seat);
        const node = nodes[ni]!;
        if (node.remaining <= 0) return invalid(tank, action, "NODE_EMPTY", round, seat);
        if (tank.cargo >= rules.cargoMax) return invalid(tank, action, "CARGO_FULL", round, seat);
        const take = Math.min(rules.collectPerAction, node.remaining, rules.cargoMax - tank.cargo);
        node.remaining -= take;
        tank.cargo += take;
        tank.unitsCollected += take;
        emit({ t: "collect", seat, node: node.id, amount: take, remainingAfter: node.remaining, cargoAfter: tank.cargo });
        pushTo(pending, seat, { type: "collect", seat, node: node.id, amount: take, round });
        return;
      }
      case "deposit": {
        if (!t.deposit[t.index(tank.pos.x, tank.pos.y)]) return invalid(tank, action, "NOT_ON_DEPOSIT", round, seat);
        if (tank.cargo <= 0) return invalid(tank, action, "NO_CARGO", round, seat);
        const units = tank.cargo;
        const delta = units * rules.depositScorePerUnit;
        tank.score += delta;
        tank.breakdown.deposit += delta;
        tank.cargo = 0;
        tank.deposits += 1;
        tank.unitsDeposited += units;
        emit({ t: "deposit", seat, units, scoreDelta: delta, scoreAfter: tank.score });
        pushTo(pending, seat, { type: "deposit", seat, units, scoreDelta: delta, round });
        return;
      }
      case "loadAmmo": {
        if (!t.ammo[t.index(tank.pos.x, tank.pos.y)]) return invalid(tank, action, "NOT_ON_AMMO", round, seat);
        if (tank.ammo >= rules.ammoMax) return invalid(tank, action, "AMMO_FULL", round, seat);
        const n = Math.min(rules.loadAmmoPerAction, rules.ammoMax - tank.ammo);
        const cost = n * rules.ammoPrice;
        tank.ammo += n;
        tank.score -= cost;
        tank.breakdown.ammo -= cost;
        tank.ammoLoaded += n;
        emit({ t: "load_ammo", seat, rounds: n, scoreDelta: -cost, ammoAfter: tank.ammo, scoreAfter: tank.score });
        pushTo(pending, seat, { type: "load_ammo", seat, rounds: n, scoreDelta: -cost, round });
        return;
      }
      case "refuel": {
        if (!t.fuel[t.index(tank.pos.x, tank.pos.y)]) return invalid(tank, action, "NOT_ON_FUEL", round, seat);
        if (tank.fuel >= rules.fuelMax) return invalid(tank, action, "FUEL_FULL", round, seat);
        const added = Math.min(rules.refuelPerAction, rules.fuelMax - tank.fuel);
        const cost = Math.ceil(added / 10) * rules.fuelPricePer10;
        tank.fuel += added;
        tank.score -= cost;
        tank.breakdown.fuel -= cost;
        tank.fuelLoaded += added;
        emit({ t: "refuel", seat, fuelAdded: added, scoreDelta: -cost, fuelAfter: tank.fuel, scoreAfter: tank.score });
        pushTo(pending, seat, { type: "refuel", seat, fuelAdded: added, scoreDelta: -cost, round });
        return;
      }
      case "wait":
      default:
        return;
    }
  }

  function killTank(victim: Tank, killerSeat: number | null, round: number): void {
    victim.alive = false;
    victim.hp = 0;
    victim.cargo = 0; // 载货全部损失
    victim.deaths += 1;
    victim.disabledTurns = rules.respawnRounds;
    victim.score -= rules.deathPenalty;
    victim.breakdown.death -= rules.deathPenalty;
    const killer = killerSeat !== null ? tanks.get(killerSeat) ?? null : null;
    if (killer && killer.seat !== victim.seat) {
      killer.kills += 1;
      if (rules.killReward > 0) {
        killer.score += rules.killReward;
        killer.breakdown.kill += rules.killReward;
      }
    }
    emit({
      t: "death", seat: victim.seat, killerSeat: killer ? killer.seat : null, pos: { ...victim.pos },
      scoreDelta: -rules.deathPenalty, scoreAfter: victim.score,
    });
    pushToAll(pending, seatList, {
      type: "death", seat: victim.seat, killerSeat: killer ? killer.seat : null,
      pos: { ...victim.pos }, round,
    });
  }

  function finishRanking(): PlayerStats[] {
    const list = seatList.map((s) => {
      const t = tanks.get(s)!;
      return {
        seat: s, name: t.name, scriptHash: t.scriptHash, score: t.score, rank: 0,
        turnsTaken: t.turnsTaken, moves: t.moves, shotsFired: t.shotsFired, hits: t.hits,
        damageDealt: t.damageDealt, kills: t.kills, deaths: t.deaths, deposits: t.deposits,
        unitsDeposited: t.unitsDeposited, unitsCollected: t.unitsCollected,
        ammoLoaded: t.ammoLoaded, fuelLoaded: t.fuelLoaded, emergencyMoves: t.emergencyMoves,
        invalidActions: t.invalidActions, strikes: t.strikes, disqualified: t.disqualified,
        avgDecisionMs: t.turnsTaken > 0 ? Math.round((t.decisionMs / t.turnsTaken) * 1000) / 1000 : 0,
        maxDecisionMs: Math.round(t.maxDecisionMs * 1000) / 1000,
        scoreBreakdown: { ...t.breakdown },
        ...(t.disqualifiedKind ? { disqualifiedKind: t.disqualifiedKind } : {}),
      } satisfies PlayerStats;
    });
    list.sort((a, b) =>
      b.score - a.score ||
      b.unitsDeposited - a.unitsDeposited ||
      b.kills - a.kills ||
      a.deaths - b.deaths ||
      a.seat - b.seat,
    );
    list.forEach((p, i) => { p.rank = i + 1; });
    return list;
  }
}