// packages/engine/src/replay.ts —— 事件流 → 可渲染视图（纯函数，浏览器与 Node 共用）
// 回放不需要存视频：事件流是唯一载体，前端逐条 applyEvent 即可重建任意时刻的画面。
import type { GameMap, MatchEvent, Ruleset } from "@ai-game/protocol";
import { buildTerrain, type Terrain } from "./terrain.ts";
import { hasLOS } from "./los.ts";

export interface TankView {
  seat: number; name: string; scriptHash: string;
  x: number; y: number;
  hp: number; ammo: number; fuel: number; cargo: number; mines: number; score: number;
  /** 剩余防御轮数（0 = 未防御）；观战能看到，脚本看不到敌人的这个值 */
  defendLeft: number;
  alive: boolean; disqualified: boolean;
  kills: number; deaths: number; deposits: number; unitsDeposited: number;
  spawn: { x: number; y: number };
}
export interface NodeViewState { id: string; x: number; y: number; capacity: number; remaining: number }
/** 补给点（弹药点/加油点）：capacity=null 是无限供给（地图没写容量）；否则 remaining 就是当前库存 */
export interface SupplyViewState { kind: "ammo" | "fuel"; index: number; x: number; y: number; capacity: number | null; remaining: number | null }
/** 场上未触发的地雷（只有观战/回放看得到；脚本那边连自己的雷都不可见） */
export interface MineViewState { id: number; x: number; y: number; owner: number }
export interface LogEntry { turn: number; round: number; seat: number | null; text: string; kind: MatchEvent["t"] }

export interface BattleView {
  round: number;
  turn: number;
  tanks: Record<number, TankView>;
  nodes: Record<string, NodeViewState>;
  supplies: SupplyViewState[];
  mines: MineViewState[];
  log: LogEntry[];
  lastFire: { seat: number; target: { x: number; y: number }; hit: boolean; blocked: boolean; turn: number } | null;
}

const TANK_LABEL = (seat: number) => `P${seat}`;

/** 地图 → 补给点初始视图（与引擎 runMatch 的 initSupply 同一套口径：缺 initial 就是满库存） */
export function initialSupplies(map: GameMap): SupplyViewState[] {
  const wrap = (kind: "ammo" | "fuel", list: { x: number; y: number; capacity?: number; initial?: number }[]) =>
    list.map((p, index) => {
      const capacity = p.capacity ?? null;
      return { kind, index, x: p.x, y: p.y, capacity, remaining: capacity === null ? null : (p.initial ?? capacity) };
    });
  return [...wrap("ammo", map.ammoDepots), ...wrap("fuel", map.fuelStations)];
}

export function createBattleView(map: GameMap, rules: Ruleset, names: Record<number, string> = {}, hashes: Record<number, string> = {}): BattleView {
  const tanks: Record<number, TankView> = {};
  map.spawns.forEach((spawn, i) => {
    const seat = i + 1;
    if (names[seat] === undefined && Object.keys(names).length > 0) return;
    tanks[seat] = {
      seat, name: names[seat] ?? TANK_LABEL(seat), scriptHash: hashes[seat] ?? "",
      x: spawn.x, y: spawn.y,
      hp: rules.initial.hp, ammo: rules.initial.ammo, fuel: rules.initial.fuel, cargo: rules.initial.cargo,
      mines: rules.initial.mines, defendLeft: 0,
      score: 0, alive: true, disqualified: false, kills: 0, deaths: 0, deposits: 0, unitsDeposited: 0,
      spawn: { ...spawn },
    };
  });
  const nodes: Record<string, NodeViewState> = {};
  for (const n of map.resourceNodes) nodes[n.id] = { id: n.id, x: n.x, y: n.y, capacity: n.capacity, remaining: n.initial };
  return { round: 0, turn: 0, tanks, nodes, supplies: initialSupplies(map), mines: [], log: [], lastFire: null };
}

export function applyEvent(view: BattleView, e: MatchEvent, rules: Ruleset): void {
  switch (e.t) {
    case "match_start": {
      for (const s of e.seats) {
        view.tanks[s.seat] = {
          seat: s.seat, name: s.name, scriptHash: s.scriptHash,
          x: s.spawn.x, y: s.spawn.y,
          hp: rules.initial.hp, ammo: rules.initial.ammo, fuel: rules.initial.fuel, cargo: rules.initial.cargo,
          mines: rules.initial.mines, defendLeft: 0,
          score: 0, alive: true, disqualified: false, kills: 0, deaths: 0, deposits: 0, unitsDeposited: 0,
          spawn: { ...s.spawn },
        };
      }
      view.log.push({ turn: 0, round: 0, seat: null, kind: e.t, text: `比赛开始 seed=${e.seed}（${e.seats.map((s) => `P${s.seat} ${s.name}`).join(" / ")}）` });
      return;
    }
    case "turn_begin": {
      // 跨轮：防御计时走一格（引擎在回合末扣，回放按"进入新一轮"对齐同一口径）
      if (e.round > view.round) {
        for (const t of Object.values(view.tanks)) if (t.defendLeft > 0) t.defendLeft -= 1;
      }
      view.round = e.round;
      view.turn = e.turn;
      return;
    }
    case "defend": {
      const t = view.tanks[e.seat];
      if (t) t.defendLeft = e.rounds;
      view.log.push({ turn: view.turn, round: view.round, seat: e.seat, kind: e.t, text: `🛡 P${e.seat} 停止行动转入防御（${e.rounds} 轮内不受伤，对手看不到）` });
      return;
    }
    case "deploy_mine": {
      const t = view.tanks[e.seat];
      if (t) t.mines = e.minesAfter;
      view.mines.push({ id: e.mineId, x: e.x, y: e.y, owner: e.seat });
      view.log.push({ turn: view.turn, round: view.round, seat: e.seat, kind: e.t, text: `💣 P${e.seat} 在 (${e.x},${e.y}) 埋下一枚地雷（全场不可见，剩 ${e.minesAfter} 枚）` });
      return;
    }
    case "mine_trigger": {
      const i = view.mines.findIndex((m) => m.id === e.mineId);
      if (i >= 0) view.mines.splice(i, 1);
      view.log.push({ turn: view.turn, round: view.round, seat: e.seat, kind: e.t, text: `💥 P${e.seat} 踩中 P${e.owner} 的地雷 (${e.x},${e.y})` });
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
      view.lastFire = { seat: e.seat, target: { ...e.target }, hit: e.hit, blocked: Boolean(e.blocked), turn: view.turn };
      const victim = e.targetSeat !== null ? view.tanks[e.targetSeat] : null;
      if (victim && e.hit) victim.hp = Math.max(0, victim.hp - e.damage);
      view.log.push({
        turn: view.turn, round: view.round, seat: e.seat, kind: e.t,
        text: `P${e.seat} ${e.targetSeat === null ? "对空射击" : `射击 P${e.targetSeat}`} (${e.target.x},${e.target.y}) ` +
          (e.hit ? (e.blocked ? "命中但被防御弹开（0 伤害）" : `命中 -${e.damage}`) : "未命中"),
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
      if (t) {
        t.ammo = e.ammoAfter; t.score = e.scoreAfter;
        if (typeof e.minesAfter === "number") t.mines = e.minesAfter;
      }
      applySupplyUse(view, "ammo", e.depotIndex, e.depotRemainingAfter);
      return;
    }
    case "refuel": {
      const t = view.tanks[e.seat];
      if (t) { t.fuel = e.fuelAfter; t.score = e.scoreAfter; }
      applySupplyUse(view, "fuel", e.depotIndex, e.depotRemainingAfter);
      return;
    }
    case "death": {
      const t = view.tanks[e.seat];
      if (t) { t.hp = 0; t.alive = false; t.cargo = 0; t.defendLeft = 0; t.deaths += 1; t.score = e.scoreAfter; }
      const killer = e.killerSeat !== null ? view.tanks[e.killerSeat] : null;
      if (killer && e.killerSeat !== e.seat) {
        killer.kills += 1;
        if (rules.killReward > 0) killer.score += rules.killReward; // 与引擎结算口径一致
      }
      const how = e.cause === "mine"
        ? `被地雷炸毁${e.killerSeat !== null ? `（P${e.killerSeat} 埋的雷）` : "（自己的雷）"}`
        : `被击毁${e.killerSeat !== null ? `（P${e.killerSeat} 击杀）` : ""}`;
      view.log.push({
        turn: view.turn, round: view.round, seat: e.seat, kind: e.t,
        text: `💀 P${e.seat} ${how} ${e.scoreDelta} 分，停机 ${rules.respawnRounds} 回合后复活`,
      });
      return;
    }
    case "respawn": {
      const t = view.tanks[e.seat];
      if (t) {
        t.alive = true; t.hp = rules.respawn.hp; t.ammo = rules.respawn.ammo;
        t.fuel = rules.respawn.fuel; t.cargo = rules.respawn.cargo; t.mines = rules.respawn.mines;
        t.defendLeft = 0;
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
    case "supply_regen": {
      const s = view.supplies.find((x) => x.kind === e.kind && x.index === e.index);
      if (s) s.remaining = e.remainingAfter;
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

/** 装弹/加油把补给点拿掉了一些：事件里带着"用完之后剩多少"，照抄即可（无库存的地图不带这两个字段） */
function applySupplyUse(view: BattleView, kind: "ammo" | "fuel", index?: number, remainingAfter?: number): void {
  if (index === undefined || remainingAfter === undefined) return;
  const s = view.supplies.find((x) => x.kind === kind && x.index === index);
  if (s) s.remaining = remainingAfter;
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