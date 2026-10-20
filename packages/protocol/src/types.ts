// packages/protocol/src/types.ts —— 动作 / 状态 / 上下文 / 事件 / 结果（AI 接入协议 §3 的机器可读版本）
import { z } from "zod";

export const SCHEMA_VERSION = "1.0";
export const API_VERSION = "1.0";

// ---------------- 动作 ----------------
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), dir: z.enum(["N", "E", "S", "W"]) }),
  z.object({ type: z.literal("fire"), target: z.object({ x: z.number().int(), y: z.number().int() }) }),
  z.object({ type: z.literal("collect") }),
  z.object({ type: z.literal("deposit") }),
  z.object({ type: z.literal("loadAmmo") }),
  z.object({ type: z.literal("refuel") }),
  z.object({ type: z.literal("wait") }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const INVALID_REASONS = [
  "BAD_SHAPE",
  "TOO_MANY_ACTIONS",
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
  "NOT_ON_FUEL",
  "FUEL_FULL",
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
  score: number;
  alive: boolean;
  disabledTurns: number;
  kills: number;
  deaths: number;
  spawn: { x: number; y: number };
}
export type StateEvent =
  | { type: "hit"; by: number; targetSeat: number; damage: number; pos: { x: number; y: number }; round: number }
  | { type: "miss"; by: number; target: { x: number; y: number }; round: number }
  | { type: "death"; seat: number; killerSeat: number | null; pos: { x: number; y: number }; round: number }
  | { type: "respawn"; seat: number; pos: { x: number; y: number }; round: number }
  | { type: "invalid_action"; action: unknown; reason: string; round: number }
  | { type: "collect"; seat: number; node: string; amount: number; round: number }
  | { type: "deposit"; seat: number; units: number; scoreDelta: number; round: number }
  | { type: "load_ammo"; seat: number; rounds: number; scoreDelta: number; round: number }
  | { type: "refuel"; seat: number; fuelAdded: number; scoreDelta: number; round: number };

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
  ammoDepots: { x: number; y: number }[];
  fuelStations: { x: number; y: number }[];
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
export interface FireEvent { t: "fire"; seat: number; target: { x: number; y: number }; hit: boolean; damage: number; targetSeat: number | null; ammoAfter: number }
export interface CollectEvent { t: "collect"; seat: number; node: string; amount: number; remainingAfter: number; cargoAfter: number }
export interface DepositEvent { t: "deposit"; seat: number; units: number; scoreDelta: number; scoreAfter: number }
export interface LoadAmmoEvent { t: "load_ammo"; seat: number; rounds: number; scoreDelta: number; ammoAfter: number; scoreAfter: number }
export interface RefuelEvent { t: "refuel"; seat: number; fuelAdded: number; scoreDelta: number; fuelAfter: number; scoreAfter: number }
export interface DeathEvent { t: "death"; seat: number; killerSeat: number | null; pos: { x: number; y: number }; scoreDelta: number; scoreAfter: number }
export interface RespawnEvent { t: "respawn"; seat: number; pos: { x: number; y: number } }
export interface InvalidActionEvent { t: "invalid_action"; seat: number; action: unknown; reason: InvalidReason }
export interface StrikeEvent { t: "strike"; seat: number; kind: "exception" | "timeout" | "bad_return"; detail: string }
export interface DisqualifiedEvent { t: "disqualified"; seat: number; kind: "STRIKES_EXCEEDED" }
export interface NodeRegenEvent { t: "node_regen"; node: string; remainingAfter: number }
export interface MatchEndEvent {
  t: "match_end";
  ranking: { seat: number; score: number; rank: number }[];
}
export type MatchEvent =
  | MatchStartEvent | TurnBeginEvent | MoveEvent | FireEvent | CollectEvent | DepositEvent
  | LoadAmmoEvent | RefuelEvent | DeathEvent | RespawnEvent | InvalidActionEvent | StrikeEvent
  | DisqualifiedEvent | NodeRegenEvent | MatchEndEvent;

export const EVENT_TYPES = [
  "match_start", "turn_begin", "move", "fire", "collect", "deposit", "load_ammo", "refuel",
  "death", "respawn", "invalid_action", "strike", "disqualified", "node_regen", "match_end",
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