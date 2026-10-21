// packages/protocol/src/types.ts —— 动作 / 状态 / 上下文 / 事件 / 结果（AI 接入协议 §3 的机器可读版本）
import { z } from "zod";

export const SCHEMA_VERSION = "1.1";
export const API_VERSION = "1.0";

// ---------------- 动作 ----------------
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), dir: z.enum(["N", "E", "S", "W"]) }),
  z.object({ type: z.literal("fire"), target: z.object({ x: z.number().int(), y: z.number().int() }) }),
  z.object({ type: z.literal("collect") }),
  z.object({ type: z.literal("deposit") }),
  z.object({ type: z.literal("loadAmmo") }),
  z.object({ type: z.literal("refuel") }),
  /** 防御：消耗整回合行动力（AP），立即生效，`RULES.defendRounds` 轮内不掉血（对方的脚本看不到你在防御） */
  z.object({ type: z.literal("defend") }),
  /** 布雷：消耗 1 AP + 1 枚地雷，埋在自己当前所在的格子上；对所有人不可见，谁踩上去谁死 */
  z.object({ type: z.literal("deployMine") }),
  z.object({ type: z.literal("wait") }),
]);
export type Action = z.infer<typeof ActionSchema>;

/** 每个动作占用的 AP：wait 免费，defend 占满整回合，其余各 1 点（引擎按此扣减行动力） */
export function actionApCost(action: Action, rules: { apPerTurn: number }): number {
  switch (action.type) {
    case "wait": return 0;
    case "defend": return rules.apPerTurn;
    default: return 1;
  }
}

export const INVALID_REASONS = [
  "BAD_SHAPE",
  "TOO_MANY_ACTIONS",
  "NO_AP",
  "OUT_OF_BOUNDS",
  "BLOCKED_BY_WALL",
  "BLOCKED_BY_WATER",
  "BLOCKED_BY_UNIT",
  "NO_FUEL",
  "NO_AMMO",
  "SELF_TARGET",
  "OUT_OF_RANGE",
  "NO_LOS",
  "NOT_ON_RESOURCE",
  "NODE_EMPTY",
  "CARGO_FULL",
  "NOT_ON_DEPOSIT",
  "NO_CARGO",
  "NOT_ON_AMMO",
  "AMMO_FULL",
  "AMMO_EMPTY",
  "NOT_ON_FUEL",
  "FUEL_FULL",
  "FUEL_EMPTY",
  "NO_MINE",
] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];

// ---------------- 上下文（onInit 入参）----------------
export interface Ctx {
  apiVersion: string;
  rulesetVersion: string;
  mapVersion: string;
  matchId: string;
  seat: number;
  playerName: string;
  seed: number;
  mySpawn: { x: number; y: number };
  playerCount: number;
}

// ---------------- 状态（onTurn 入参）----------------
export interface EnemyView {
  seat: number;
  pos: { x: number; y: number };
  hp: number;
  cargo: number;
  score: number;
  distance: number;
}
export interface LastKnownEnemy {
  seat: number;
  pos: { x: number; y: number };
  hp: number;
  seenRound: number;
}
export interface ResourceNodeView {
  id: string;
  x: number;
  y: number;
  capacity: number;
  remaining: number | null;
}
/** 补给点（弹药点/加油点）：capacity=null 表示无限供给；remaining=null 表示不在视野里（看不到库存） */
export interface SupplyPointView {
  x: number;
  y: number;
  capacity: number | null;
  remaining: number | null;
}
export interface SelfView {
  seat: number;
  pos: { x: number; y: number };
  hp: number;
  hpMax: number;
  ammo: number;
  ammoMax: number;
  fuel: number;
  fuelMax: number;
  cargo: number;
  cargoMax: number;
  /** 身上还有几枚地雷（`RULES.mineMax` 是上限；开局与复活都补满） */
  mines: number;
  minesMax: number;
  /** 剩余防御轮数：0 = 未防御；> 0 时对方的炮弹打不动你（对方看不到这个字段，你自己的脚本能看到） */
  defendLeft: number;
  score: number;
  alive: boolean;
  disabledTurns: number;
  kills: number;
  deaths: number;
  spawn: { x: number; y: number };
}
export type DeathCause = "fire" | "mine";
export type StateEvent =
  | { type: "hit"; by: number; targetSeat: number; damage: number; pos: { x: number; y: number }; round: number }
  | { type: "miss"; by: number; target: { x: number; y: number }; round: number }
  | { type: "death"; seat: number; killerSeat: number | null; pos: { x: number; y: number }; round: number; cause?: DeathCause }
  | { type: "respawn"; seat: number; pos: { x: number; y: number }; round: number }
  | { type: "invalid_action"; action: unknown; reason: string; round: number }
  | { type: "collect"; seat: number; node: string; amount: number; round: number }
  | { type: "deposit"; seat: number; units: number; scoreDelta: number; round: number }
  | { type: "load_ammo"; seat: number; rounds: number; scoreDelta: number; round: number }
  | { type: "refuel"; seat: number; fuelAdded: number; scoreDelta: number; round: number }
  /** 只发给自己：防御已生效（轮到你的那一刻起，defendRounds 轮内不掉血） */
  | { type: "defend"; seat: number; rounds: number; round: number };

export interface State {
  schemaVersion: string;
  round: number;
  turn: number;
  turnOrder: number[];
  turnInRound: number;
  self: SelfView;
  enemies: EnemyView[];
  lastKnownEnemies: LastKnownEnemy[];
  resourceNodes: ResourceNodeView[];
  depositPoints: { x: number; y: number }[];
  ammoDepots: SupplyPointView[];
  fuelStations: SupplyPointView[];
  scores: { seat: number; score: number; alive: boolean }[];
  events: StateEvent[];
}

// ---------------- 引擎事件流（回放的唯一载体）----------------
export interface MatchStartEvent {
  t: "match_start";
  mapId: string; mapVersion: number; rulesetVersion: string; seed: number;
  playerCount: number;
  seats: { seat: number; name: string; scriptHash: string; spawn: { x: number; y: number } }[];
  rules: Record<string, unknown>;
}
export interface TurnBeginEvent { t: "turn_begin"; round: number; turn: number; seat: number; order: number[] }
export interface MoveEvent { t: "move"; seat: number; from: { x: number; y: number }; to: { x: number; y: number }; fuelAfter: number; emergency?: boolean }
export interface FireEvent {
  t: "fire"; seat: number; target: { x: number; y: number }; hit: boolean; damage: number;
  targetSeat: number | null; ammoAfter: number;
  /** 打中了但目标处于防御状态：伤害被完全挡下（脚本侧只看到 damage=0，防御状态本身不可感知） */
  blocked?: boolean;
}
/** 防御：从这一刻起 `rounds` 轮内不受伤（含本轮）。对手的脚本看不到这个状态。 */
export interface DefendEvent { t: "defend"; seat: number; rounds: number }
/** 布雷：在自己所在的格子上埋下一枚地雷（同一格可以叠放多枚；对所有人不可见） */
export interface DeployMineEvent { t: "deploy_mine"; seat: number; mineId: number; x: number; y: number; minesAfter: number }
/** 地雷被踩响：谁踩上去谁清空血量（不分敌我），这枚雷随之消耗掉 */
export interface MineTriggerEvent { t: "mine_trigger"; seat: number; mineId: number; x: number; y: number; owner: number }
export interface CollectEvent { t: "collect"; seat: number; node: string; amount: number; remainingAfter: number; cargoAfter: number }
export interface DepositEvent { t: "deposit"; seat: number; units: number; scoreDelta: number; scoreAfter: number }
export interface LoadAmmoEvent {
  t: "load_ammo"; seat: number; rounds: number; scoreDelta: number; ammoAfter: number; scoreAfter: number;
  /** 同一次补给里取了几枚地雷、取完之后身上还有几枚（老事件流没有这两个字段） */
  mines?: number;
  minesAfter?: number;
  /** 补给点有库存时才带：这次装弹后该点的余量（回放据此在格子上显示数字） */
  depotIndex?: number;
  depotRemainingAfter?: number;
}
export interface RefuelEvent {
  t: "refuel"; seat: number; fuelAdded: number; scoreDelta: number; fuelAfter: number; scoreAfter: number;
  /** 同 load_ammo：有库存的加油点才带 */
  depotIndex?: number;
  depotRemainingAfter?: number;
}
export interface DeathEvent {
  t: "death"; seat: number; killerSeat: number | null; pos: { x: number; y: number }; scoreDelta: number; scoreAfter: number;
  /** 死因：fire = 被炮弹打死（老事件流缺省即此意），mine = 踩到地雷 */
  cause?: DeathCause;
}
export interface RespawnEvent { t: "respawn"; seat: number; pos: { x: number; y: number } }
export interface InvalidActionEvent { t: "invalid_action"; seat: number; action: unknown; reason: InvalidReason }
export interface StrikeEvent { t: "strike"; seat: number; kind: "exception" | "timeout" | "bad_return"; detail: string }
export interface DisqualifiedEvent { t: "disqualified"; seat: number; kind: "STRIKES_EXCEEDED" }
export interface NodeRegenEvent { t: "node_regen"; node: string; remainingAfter: number }
/** 补给点刷新：kind 区分弹药点/加油点，index 是该点在 MAP.ammoDepots / MAP.fuelStations 里的下标 */
export interface SupplyRegenEvent {
  t: "supply_regen";
  kind: "ammo" | "fuel";
  index: number;
  x: number;
  y: number;
  remainingAfter: number;
}
export interface MatchEndEvent {
  t: "match_end";
  ranking: { seat: number; score: number; rank: number }[];
}
export type MatchEvent =
  | MatchStartEvent | TurnBeginEvent | MoveEvent | FireEvent | CollectEvent | DepositEvent
  | LoadAmmoEvent | RefuelEvent | DeathEvent | RespawnEvent | InvalidActionEvent | StrikeEvent
  | DisqualifiedEvent | NodeRegenEvent | SupplyRegenEvent | DefendEvent | DeployMineEvent
  | MineTriggerEvent | MatchEndEvent;

export const EVENT_TYPES = [
  "match_start", "turn_begin", "move", "fire", "collect", "deposit", "load_ammo", "refuel",
  "death", "respawn", "invalid_action", "strike", "disqualified", "node_regen", "supply_regen",
  "defend", "deploy_mine", "mine_trigger", "match_end",
] as const;

// ---------------- 结果与统计 ----------------
export interface ScoreBreakdown {
  deposit: number;
  kill: number;
  death: number;
  ammo: number;
  fuel: number;
}
export interface PlayerStats {
  seat: number;
  name: string;
  scriptHash: string;
  score: number;
  rank: number;
  turnsTaken: number;
  moves: number;
  shotsFired: number;
  hits: number;
  damageDealt: number;
  kills: number;
  deaths: number;
  deposits: number;
  unitsDeposited: number;
  unitsCollected: number;
  ammoLoaded: number;
  fuelLoaded: number;
  /** 埋下的地雷枚数（同一格可叠放） */
  minesDeployed: number;
  /** 其中有多少次是"对方踩响了我的雷"（自己踩自己的不算） */
  mineKills: number;
  emergencyMoves: number;
  invalidActions: number;
  strikes: number;
  disqualified: boolean;
  avgDecisionMs: number;
  /** 单回合最长决策耗时（毫秒）：用来抓"偶尔卡死"的脚本 */
  maxDecisionMs: number;
  scoreBreakdown: ScoreBreakdown;
  disqualifiedKind?: string;
}
export interface MatchResult {
  ranking: PlayerStats[];
  events: MatchEvent[];
  stats: Record<number, PlayerStats>;
  seed: number;
  mapId: string;
  mapVersion: number;
  rulesetVersion: string;
  turns: number;
}