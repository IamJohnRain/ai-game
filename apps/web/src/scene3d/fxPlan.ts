// apps/web/src/scene3d/fxPlan.ts —— 事件批次 → 视听指令（纯函数，不依赖 three / DOM，可单测）
//
// 为什么要把这一步单独拿出来：
//   回放与观战的状态是"跳变"的（一次 advance() 可能一口气应用几十条事件，也可能一步跳到结尾），
//   而渲染与音效需要的是"这一帧到底发生了什么、发生在哪一格"。把这段翻译写成纯函数后，
//   3D 特效、音效、以及未来的 2D 抖动都能共用同一份数据，且能脱离浏览器测。
//
// 位置口径：事件本身大多不带坐标（fire/collect/deposit 都没有），但特效必须落在正确格子上，
//   所以这里在批次内**按顺序重放一遍座次位置**：先倒着把 move 撤销回批次开始前的位置，
//   再正着走一遍，这样每条指令发出的瞬间位置都是当时真实的格子。
import type { MatchEvent } from "@ai-game/protocol";

export interface GridPos {
  x: number;
  y: number;
}

export type FxCommand =
  | { kind: "move"; seat: number; from: GridPos; to: GridPos; emergency: boolean }
  | { kind: "fire"; seat: number; from: GridPos; to: GridPos; hit: boolean; targetSeat: number | null; damage: number; blocked: boolean }
  | { kind: "collect"; seat: number; at: GridPos; node: string; amount: number; remaining: number }
  | { kind: "deposit"; seat: number; at: GridPos; units: number; scoreDelta: number }
  | { kind: "loadAmmo"; seat: number; at: GridPos; rounds: number; scoreDelta: number }
  | { kind: "refuel"; seat: number; at: GridPos; fuelAdded: number; scoreDelta: number }
  | { kind: "defend"; seat: number; at: GridPos; rounds: number }
  | { kind: "deployMine"; seat: number; at: GridPos }
  | { kind: "mineTrigger"; seat: number; at: GridPos; owner: number }
  | { kind: "death"; seat: number; at: GridPos; killerSeat: number | null; cause: "fire" | "mine" }
  | { kind: "respawn"; seat: number; at: GridPos }
  | { kind: "invalid"; seat: number; at: GridPos; reason: string }
  | { kind: "disqualified"; seat: number; at: GridPos }
  | { kind: "regen"; at: GridPos; node: string; remaining: number }
  | { kind: "end" };

/** 音效种类：与 apps/web/src/sfx.ts 的 SfxKind 对齐（这里只用字符串，避免两处类型互相牵扯） */
export type FxSound =
  | "fire" | "hit" | "miss" | "collect" | "deposit" | "refuel" | "loadAmmo"
  | "death" | "respawn" | "invalid" | "disqualified" | "tread" | "end"
  | "defend" | "mineDeploy" | "mineBlast";

export interface PlanInput {
  /** 本帧真正被应用的事件（顺序与引擎事件流一致；调用方负责截断到合理的条数） */
  batch: readonly MatchEvent[];
  /** 应用完这批事件之后的座次位置（即当前画面里的坦克位置） */
  seats: Record<number, GridPos>;
  /** 资源点 id → 坐标（regen 事件只有 id） */
  nodes?: Record<string, GridPos>;
}

/**
 * 把一批事件翻译成特效/音效指令。位置以"事件发生的那一刻"为准，
 * 因此调用方传入的 seats 必须是**批次结束后**的位置（本函数会自己回滚）。
 */
export function planFx(input: PlanInput): FxCommand[] {
  const { batch, seats, nodes = {} } = input;
  if (batch.length === 0) return [];

  // 1) 倒着撤销 move，还原批次开始前的位置（respawn 无法撤销，但它的坐标写在事件里，
  //    正向重放时会立刻纠正，因此只有"同一批里先死后复活"这种极罕见次序才会偏一格）
  const pos: Record<number, GridPos> = {};
  for (const [seat, p] of Object.entries(seats)) pos[Number(seat)] = { x: p.x, y: p.y };
  for (let i = batch.length - 1; i >= 0; i--) {
    const e = batch[i]!;
    if (e.t === "move") pos[e.seat] = { x: e.from.x, y: e.from.y };
  }

  const at = (seat: number): GridPos => pos[seat] ?? { x: 0, y: 0 };
  const out: FxCommand[] = [];

  // 2) 正着重放，逐条产出指令
  for (const e of batch) {
    switch (e.t) {
      case "move": {
        out.push({ kind: "move", seat: e.seat, from: { x: e.from.x, y: e.from.y }, to: { x: e.to.x, y: e.to.y }, emergency: Boolean(e.emergency) });
        pos[e.seat] = { x: e.to.x, y: e.to.y };
        break;
      }
      case "fire": {
        out.push({
          kind: "fire",
          seat: e.seat,
          from: at(e.seat),
          to: { x: e.target.x, y: e.target.y },
          hit: e.hit,
          targetSeat: e.targetSeat,
          damage: e.damage,
          blocked: Boolean(e.blocked),
        });
        break;
      }
      case "collect":
        out.push({ kind: "collect", seat: e.seat, at: at(e.seat), node: e.node, amount: e.amount, remaining: e.remainingAfter });
        break;
      case "deposit":
        out.push({ kind: "deposit", seat: e.seat, at: at(e.seat), units: e.units, scoreDelta: e.scoreDelta });
        break;
      case "load_ammo":
        out.push({ kind: "loadAmmo", seat: e.seat, at: at(e.seat), rounds: e.rounds, scoreDelta: e.scoreDelta });
        break;
      case "refuel":
        out.push({ kind: "refuel", seat: e.seat, at: at(e.seat), fuelAdded: e.fuelAdded, scoreDelta: e.scoreDelta });
        break;
      case "death": {
        out.push({
          kind: "death", seat: e.seat, at: { x: e.pos.x, y: e.pos.y }, killerSeat: e.killerSeat,
          cause: e.cause === "mine" ? "mine" : "fire",
        });
        pos[e.seat] = { x: e.pos.x, y: e.pos.y };
        break;
      }
      case "defend":
        out.push({ kind: "defend", seat: e.seat, at: at(e.seat), rounds: e.rounds });
        break;
      case "deploy_mine":
        out.push({ kind: "deployMine", seat: e.seat, at: { x: e.x, y: e.y } });
        break;
      case "mine_trigger":
        out.push({ kind: "mineTrigger", seat: e.seat, at: { x: e.x, y: e.y }, owner: e.owner });
        break;
      case "respawn": {
        out.push({ kind: "respawn", seat: e.seat, at: { x: e.pos.x, y: e.pos.y } });
        pos[e.seat] = { x: e.pos.x, y: e.pos.y };
        break;
      }
      case "invalid_action":
        out.push({ kind: "invalid", seat: e.seat, at: at(e.seat), reason: e.reason });
        break;
      case "disqualified":
        out.push({ kind: "disqualified", seat: e.seat, at: at(e.seat) });
        break;
      case "strike":
        out.push({ kind: "invalid", seat: e.seat, at: at(e.seat), reason: e.kind });
        break;
      case "node_regen": {
        const p = nodes[e.node];
        if (p) out.push({ kind: "regen", at: { x: p.x, y: p.y }, node: e.node, remaining: e.remainingAfter });
        break;
      }
      case "match_end":
        out.push({ kind: "end" });
        break;
      case "turn_begin":
      case "match_start":
        break;
    }
  }
  return out;
}

/** 指令 → 音效种类。命中与脱靶用不同音色，是"看得见"之外的听觉反馈。 */
export function soundFor(command: FxCommand): { kind: FxSound; seat: number | null } | null {
  switch (command.kind) {
    case "fire":
      // 被防御弹开的那一炮换成"护盾吃弹"的音色：听起来就像打在装甲上，而不是打进了车体
      return { kind: command.blocked ? "defend" : "fire", seat: command.seat };
    case "death":
      return { kind: "death", seat: command.killerSeat ?? command.seat };
    case "defend":
      return { kind: "defend", seat: command.seat };
    case "deployMine":
      return { kind: "mineDeploy", seat: command.seat };
    case "mineTrigger":
      return { kind: "mineBlast", seat: command.seat };
    case "move":
      return command.emergency ? { kind: "tread", seat: command.seat } : null; // 普通移动的履带声太密集，只在应急移动时给一下
    case "deposit":
      return { kind: "deposit", seat: command.seat };
    case "collect":
      return { kind: "collect", seat: command.seat };
    case "loadAmmo":
      return { kind: "loadAmmo", seat: command.seat };
    case "refuel":
      return { kind: "refuel", seat: command.seat };
    case "respawn":
      return { kind: "respawn", seat: command.seat };
    case "invalid":
      return { kind: "invalid", seat: command.seat };
    case "disqualified":
      return { kind: "disqualified", seat: command.seat };
    case "regen":
      return { kind: "collect", seat: null };
    case "end":
      return { kind: "end", seat: null };
  }
}

/**
 * 命中/脱靶的落点音：开火事件本身已经由 fire 音效覆盖，
 * 这里把"打中了什么"单独给一声，让密集对射时的节奏更清楚。
 */
export function impactSound(hit: boolean): FxSound {
  return hit ? "hit" : "miss";
}

/** 指令涉及的位置（供音效做立体声定位）；没有位置的指令返回 null */
export function commandPosition(command: FxCommand): GridPos | null {
  switch (command.kind) {
    case "fire":
      return command.to;
    case "mineTrigger":
      return command.at;
    case "move":
      return command.to;
    case "collect":
    case "deposit":
    case "loadAmmo":
    case "refuel":
    case "defend":
    case "deployMine":
    case "death":
    case "respawn":
    case "invalid":
    case "disqualified":
    case "regen":
      return command.at;
    case "end":
      return null;
  }
}