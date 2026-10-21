// packages/script-check/src/fuzz.ts —— 生成"极端但合法"的状态用于冒烟测试
// 设计取舍：只生成符合 protocol schema 的状态（引擎保证不会给出缺失字段），
// 极端值包括：空敌人、贴身敌人、零弹零油满货、资源点已空/不可见、刚被打、刚死亡公告等。
import {
  API_VERSION, SCHEMA_VERSION, chebyshev, DIRS, SPAWN_SETS,
  type GameMap, type Ruleset, type State, type StateEvent,
} from "@ai-game/protocol";
import { deriveSeed, mulberry32 } from "@ai-game/engine";

export function generateFuzzStates(map: GameMap, rules: Ruleset, count: number, seed = 20261019): State[] {
  const rng = mulberry32(deriveSeed(seed, "fuzz"));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const int = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
  const walkable: { x: number; y: number }[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const c = map.grid[y]![x]!;
      if (c !== "#" && c !== "~") walkable.push({ x, y });
    }
  }
  const seats = [1, 2, 3, 4];
  const states: State[] = [];
  for (let i = 0; i < count; i++) {
    const seat = pick(seats);
    const mySpawn = map.spawns[seat - 1] ?? map.spawns[0]!;
    // 有 1/4 的样本强制站到"设施格"上，覆盖采集/提交/补给分支
    const onFacility = rng() < 0.25;
    const pos = onFacility
      ? pick([
          ...map.resourceNodes.map((n) => ({ x: n.x, y: n.y })),
          ...map.depositPoints, ...map.ammoDepots, ...map.fuelStations,
        ])
      : pick(walkable);

    const enemyCount = rng() < 0.3 ? 0 : int(1, Math.min(3, seats.length - 1));
    const enemies = Array.from({ length: enemyCount }, () => {
      // 一半贴身（1~2 格），一半在视野内
      const dist = rng() < 0.5 ? int(1, 2) : int(3, rules.visionRadius);
      const ex = Math.max(0, Math.min(map.width - 1, pos.x + int(-dist, dist)));
      const ey = Math.max(0, Math.min(map.height - 1, pos.y + int(-dist, dist)));
      const seatNo = pick(seats.filter((s) => s !== seat));
      return {
        seat: seatNo, pos: { x: ex, y: ey }, hp: int(1, rules.hpMax), cargo: int(0, rules.cargoMax),
        score: int(-100, 400), distance: chebyshev(pos, { x: ex, y: ey }),
      };
    });

    const nodes = map.resourceNodes.map((n) => ({
      id: n.id, x: n.x, y: n.y, capacity: n.capacity,
      // 一半可见一半不可见；可见的里再分"有货/空"
      remaining: rng() < 0.5 ? null : (rng() < 0.3 ? 0 : int(1, n.capacity)),
    }));

    // 补给点：没写容量的图是无限供给（capacity=null）；写了容量的一半可见、可见的随机余量
    const supplyView = (p: { x: number; y: number; capacity?: number }) => {
      const capacity = p.capacity ?? null;
      if (capacity === null) return { x: p.x, y: p.y, capacity, remaining: null };
      return { x: p.x, y: p.y, capacity, remaining: rng() < 0.5 ? null : int(0, capacity) };
    };

    const evCount = int(0, 4);
    const events: StateEvent[] = Array.from({ length: evCount }, () => {
      const kind = int(0, 9);
      const other = pick(seats.filter((s) => s !== seat));
      switch (kind) {
        case 0: return { type: "hit", by: other, targetSeat: seat, damage: int(1, 30), pos: { ...pos }, round: int(1, rules.maxRounds) };
        case 1: return { type: "miss", by: seat, target: { x: pos.x, y: pos.y }, round: 1 };
        // 死亡/踩雷两种死因都过一遍：脚本不能假设"死亡一定有凶手"
        case 2: return { type: "death", seat: other, killerSeat: seat, pos: { ...pos }, round: 1 };
        case 3: return { type: "respawn", seat: other, pos: { ...mySpawn }, round: 1 };
        case 4: return { type: "invalid_action", action: { type: "move", dir: pick(DIRS) }, reason: "BLOCKED_BY_WALL", round: 1 };
        case 5: return { type: "collect", seat, node: "R1", amount: 3, round: 1 };
        case 6: return { type: "invalid_action", action: { type: "deployMine" }, reason: "NO_MINE", round: 1 };
        case 7: return { type: "defend", seat, rounds: rules.defendRounds, round: 1 };
        case 8: return { type: "deposit", seat, units: 5, scoreDelta: 50, round: 1 };
        default: return { type: "death", seat: other, killerSeat: null, pos: { ...pos }, round: 1, cause: "mine" };
      }
    });

    const turnOrder = [...seats].sort(() => (rng() < 0.5 ? -1 : 1)).slice(0, SPAWN_SETS[2] ? seats.length : 4);
    states.push({
      schemaVersion: SCHEMA_VERSION,
      round: int(1, rules.maxRounds),
      turn: int(1, rules.maxRounds * 4),
      turnOrder,
      turnInRound: int(1, turnOrder.length),
      self: {
        seat, pos: { ...pos },
        // 极端值：残血/满血、零弹/满弹、零油/满油、空仓/满载
        hp: rng() < 0.25 ? 1 : (rng() < 0.3 ? rules.hpMax : int(1, rules.hpMax)),
        hpMax: rules.hpMax,
        ammo: rng() < 0.25 ? 0 : int(0, rules.ammoMax),
        ammoMax: rules.ammoMax,
        fuel: rng() < 0.25 ? 0 : int(0, rules.fuelMax),
        fuelMax: rules.fuelMax,
        cargo: rng() < 0.25 ? rules.cargoMax : int(0, rules.cargoMax),
        cargoMax: rules.cargoMax,
        // 地雷：一半样本"没雷可布"、一半"身上有雷"；防御也随机给一个
        mines: rng() < 0.5 ? 0 : int(0, rules.mineMax),
        minesMax: rules.mineMax,
        defendLeft: rng() < 0.25 ? int(1, rules.defendRounds) : 0,
        score: int(-150, 500),
        alive: true,
        disabledTurns: 0,
        kills: int(0, 5),
        deaths: int(0, 5),
        spawn: { ...mySpawn },
      },
      enemies,
      lastKnownEnemies: enemies.map((e) => ({ seat: e.seat, pos: { ...e.pos }, hp: e.hp, seenRound: Math.max(1, 1) })),
      resourceNodes: nodes,
      depositPoints: map.depositPoints.map((p) => ({ ...p })),
      ammoDepots: map.ammoDepots.map((p) => supplyView(p)),
      fuelStations: map.fuelStations.map((p) => supplyView(p)),
      scores: seats.map((s) => ({ seat: s, score: s === seat ? int(-150, 500) : int(-150, 300), alive: rng() < 0.8 })),
      events,
    });
  }
  return states;
}

export const API_VERSION_FOR_FUZZ = API_VERSION;