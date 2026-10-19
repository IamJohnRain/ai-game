// packages/engine/src/replay.ts —— 事件流 → 可渲染视图（纯函数，浏览器与 Node 共用）
// 回放不需要存视频：事件流是唯一载体，前端逐条 applyEvent 即可重建任意时刻的画面。
import type { GameMap, MatchEvent, Ruleset } from "@ai-game/protocol";
import { buildTerrain, type Terrain } from "./terrain.ts";
import { hasLOS } from "./los.ts";

export interface TankView {
  seat: number; name: string; scriptHash: string;
  x: number; y: number;
  hp: number; ammo: number; fuel: number; cargo: number; score: number;
  alive: boolean; disqualified: boolean;
  kills: number; deaths: number; deposits: number; unitsDeposited: number;
  spawn: { x: number; y: number };
}
export interface NodeViewState { id: string; x: number; y: number; capacity: number; remaining: number }
export interface LogEntry { turn: number; round: number; seat: number | null; text: string; kind: MatchEvent["t"] }

export interface BattleView {
  round: number;
  turn: number;
  tanks: Record<number, TankView>;
  nodes: Record<string, NodeViewState>;
  log: LogEntry[];
  lastFire: { seat: number; target: { x: number; y: number }; hit: boolean; turn: number } | null;
}

const TANK_LABEL = (seat: number) => `P${seat}`;

export function createBattleView(map: GameMap, rules: Ruleset, names: Record<number, string> = {}, hashes: Record<number, string> = {}): BattleView {
  const tanks: Record<number, TankView> = {};
  map.spawns.forEach((spawn, i) => {
    const seat = i + 1;
    if (names[seat] === undefined && Object.keys(names).length > 0) return;
    tanks[seat] = {
      seat, name: names[seat] ?? TANK_LABEL(seat), scriptHash: hashes[seat] ?? "",
      x: spawn.x, y: spawn.y,
      hp: rules.initial.hp, ammo: rules.initial.ammo, fuel: rules.initial.fuel, cargo: rules.initial.cargo,
      score: 0, alive: true, disqualified: false, kills: 0, deaths: 0, deposits: 0, unitsDeposited: 0,
      spawn: { ...spawn },
    };
  });
  const nodes: Record<string, NodeViewState> = {};
  for (const n of map.resourceNodes) nodes[n.id] = { id: n.id, x: n.x, y: n.y, capacity: n.capacity, remaining: n.initial };
  return { round: 0, turn: 0, tanks, nodes, log: [], lastFire: null };
}

export function applyEvent(view: BattleView, e: MatchEvent, rules: Ruleset): void {
  switch (e.t) {
    case "match_start": {
      for (const s of e.seats) {
        view.tanks[s.seat] = {
          seat: s.seat, name: s.name, scriptHash: s.scriptHash,
          x: s.spawn.x, y: s.spawn.y,
          hp: rules.initial.hp, ammo: rules.initial.ammo, fuel: rules.initial.fuel, cargo: rules.initial.cargo,
          score: 0, alive: true, disqualified: false, kills: 0, deaths: 0, deposits: 0, unitsDeposited: 0,
          spawn: { ...s.spawn },
        };
      }
      view.log.push({ turn: 0, round: 0, seat: null, kind: e.t, text: `比赛开始 seed=${e.seed}（${e.seats.map((s) => `P${s.seat} ${s.name}`).join(" / ")}）` });
      return;
    }
    case "turn_begin": {
      view.round = e.round;
      view.turn = e.turn;
      return;
    }
    case "move": {
      const t = view.tanks[e.seat];
      if (t) {
        t.x = e.to.x; t.y = e.to.y; t.fuel = e.fuelAfter;
        if (e.emergency) t.score -= rules.emergencyMoveCost; // 应急燃料按格扣分
      }
      return;
    }
    case "fire": {
      const t = view.tanks[e.seat];
      if (t) t.ammo = Math.max(0, t.ammo - 1);
      view.lastFire = { seat: e.seat, target: { ...e.target }, hit: e.hit, turn: view.turn };
      const victim = e.targetSeat !== null ? view.tanks[e.targetSeat] : null;
      if (victim && e.hit) victim.hp = Math.max(0, victim.hp - e.damage);
      view.log.push({
        turn: view.turn, round: view.round, seat: e.seat, kind: e.t,
        text: `P${e.seat} ${e.targetSeat === null ? "对空射击" : `射击 P${e.targetSeat}`} (${e.target.x},${e.target.y}) ${e.hit ? `命中 -${e.damage}` : "未命中"}`,
      });
      return;
    }
    case "collect": {
      const n = view.nodes[e.node];
      if (n) n.remaining = e.remainingAfter;
      const t = view.tanks[e.seat];
      if (t) t.cargo = e.cargoAfter;
      return;
    }
    case "deposit": {
      const t = view.tanks[e.seat];
      if (t) { t.cargo = 0; t.score = e.scoreAfter; t.deposits += 1; t.unitsDeposited += e.units; }
      view.log.push({ turn: view.turn, round: view.round, seat: e.seat, kind: e.t, text: `P${e.seat} 提交 ${e.units} 单位资源 ${e.scoreDelta >= 0 ? "+" : ""}${e.scoreDelta} 分（总 ${e.scoreAfter}）` });
      return;
    }
    case "load_ammo": {
      const t = view.tanks[e.seat];
      if (t) { t.ammo = e.ammoAfter; t.score = e.scoreAfter; }
      return;
    }
    case "refuel": {
      const t = view.tanks[e.seat];
      if (t) { t.fuel = e.fuelAfter; t.score = e.scoreAfter; }
      return;
    }
    case "death": {
      const t = view.tanks[e.seat];
      if (t) { t.hp = 0; t.alive = false; t.cargo = 0; t.deaths += 1; t.score = e.scoreAfter; }
      const killer = e.killerSeat !== null ? view.tanks[e.killerSeat] : null;
      if (killer && e.killerSeat !== e.seat) {
        killer.kills += 1;
        if (rules.killReward > 0) killer.score += rules.killReward; // 与引擎结算口径一致
      }
      view.log.push({
        turn: view.turn, round: view.round, seat: e.seat, kind: e.t,
        text: `💀 P${e.seat} 被击毁${e.killerSeat !== null ? `（P${e.killerSeat} 击杀）` : ""} ${e.scoreDelta} 分，停机 ${rules.respawnRounds} 回合后复活`,
      });
      return;
    }
    case "respawn": {
      const t = view.tanks[e.seat];
      if (t) {
        t.alive = true; t.hp = rules.respawn.hp; t.ammo = rules.respawn.ammo;
        t.fuel = rules.respawn.fuel; t.cargo = rules.respawn.cargo;
        t.x = e.pos.x; t.y = e.pos.y;
      }
      view.log.push({ turn: view.turn, round: view.round, seat: e.seat, kind: e.t, text: `P${e.seat} 在出生点复活` });
      return;
    }
    case "invalid_action": {
      view.log.push({ turn: view.turn, round: view.round, seat: e.seat, kind: e.t, text: `⚠ P${e.seat} 无效动作 ${e.reason}` });
      return;
    }
    case "strike": {
      view.log.push({ turn: view.turn, round: view.round, seat: e.seat, kind: e.t, text: `⚠ P${e.seat} strike(${e.kind}) ${e.detail}`.slice(0, 200) });
      return;
    }
    case "disqualified": {
      const t = view.tanks[e.seat];
      if (t) t.disqualified = true;
      view.log.push({ turn: view.turn, round: view.round, seat: e.seat, kind: e.t, text: `⛔ P${e.seat} 被淘汰（${e.kind}），后续回合待机` });
      return;
    }
    case "node_regen": {
      const n = view.nodes[e.node];
      if (n) n.remaining = e.remainingAfter;
      return;
    }
    case "match_end": {
      view.log.push({ turn: view.turn, round: view.round, seat: null, kind: e.t, text: `🏁 比赛结束：${e.ranking.map((r) => `#${r.rank} P${r.seat}(${r.score})`).join(" ")}` });
      return;
    }
  }
}

export function reduceEvents(map: GameMap, rules: Ruleset, events: MatchEvent[]): BattleView {
  const view = createBattleView(map, rules);
  for (const e of events) applyEvent(view, e, rules);
  return view;
}

/** 战争迷雾：从某个位置可见的格集合（供观战"座位视角"使用） */
export function visibleTiles(terrain: Terrain, from: { x: number; y: number }, radius: number): Uint8Array {
  const mask = new Uint8Array(terrain.width * terrain.height);
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      if (Math.max(Math.abs(x - from.x), Math.abs(y - from.y)) > radius) continue;
      if (hasLOS(terrain, from, { x, y })) mask[terrain.index(x, y)] = 1;
    }
  }
  return mask;
}

export { buildTerrain };