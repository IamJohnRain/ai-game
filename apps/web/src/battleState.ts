// apps/web/src/battleState.ts —— 事件流 → 可渲染战场的归约器（观战与回放共用）
//
// 关键设计（"事件归约的时机"）：
// 1) 服务端保证事件顺序到达（先算完整局，再按 turnIntervalMs 节流推送），所以实时观战
//    只需顺序 applyEvent 累积，绝不能假设自己知道未来事件；
// 2) BattleView 是可变对象，reduceEvents 每次全量重算是 O(n)，长局会退化到 O(n²)，
//    因此这里维护 (source, cursor)：前进只 apply 增量，只有回放"拖回过去"时才重建；
// 3) 重建成本是几千次纯函数调用（毫秒级），不值得引入快照表/Worker。
import { applyEvent, buildTerrain, createBattleView, type BattleView, type Terrain } from "@ai-game/engine";
import type { GameMap, MatchEvent, Ruleset } from "@ai-game/protocol";

/**
 * 特效/音效只需要"刚刚发生的这几条"。极速播放或拖时间轴时一次可能应用上千条，
 * 那时画面与声音都跟不上（也不该跟），所以只保留批次末尾这么多条，其余交由调用方按
 * lastAppliedCount 判断"这是一次跳转"，直接跳过演出。
 */
export const MAX_FX_EVENTS = 64;

export class BattleAccumulator {
  readonly terrain: Terrain;
  /** 已知的完整事件流：实时观战时由 WS 逐条追加，回放时一次性写入 */
  private source: MatchEvent[] = [];
  /** 已经归约到 source 的第几条 */
  private cursor = 0;
  private view: BattleView;
  private batch: MatchEvent[] = [];
  private batchCount = 0;

  constructor(
    readonly map: GameMap,
    readonly rules: Ruleset,
    private names: Record<number, string> = {},
    private hashes: Record<number, string> = {},
  ) {
    this.terrain = buildTerrain(map);
    this.view = this.freshView();
  }

  /** 新建画面：必须带上座位名单，否则只有 2 个座位的对局会在其余出生点留下"幽灵坦克" */
  private freshView(): BattleView {
    return createBattleView(this.map, this.rules, this.names, this.hashes);
  }

  /** 当前画面。注意：对象是复用的，React 侧靠 bump 版本号触发重绘 */
  get snapshot(): BattleView {
    return this.view;
  }

  get total(): number {
    return this.source.length;
  }

  get applied(): number {
    return this.cursor;
  }

  /** 已收到但还没应用到画面上的事件数 */
  get buffered(): number {
    return this.source.length - this.cursor;
  }

  /**
   * 最近一次 advance() 真正应用的事件（末尾最多 MAX_FX_EVENTS 条，顺序不变）。
   * 渲染层据此播特效与音效：状态是"现在在哪"，批次才是"刚刚发生了什么"。
   */
  get lastApplied(): readonly MatchEvent[] {
    return this.batch;
  }

  /** 最近一次 advance() 应用的事件总数；远大于 lastApplied.length 即表示发生过跳转 */
  get lastAppliedCount(): number {
    return this.batchCount;
  }

  /** 覆盖式重置（WS snapshot 恢复 / 回放装载）：来源流被整体替换 */
  reset(events: readonly MatchEvent[]): void {
    this.source = [...events];
    this.cursor = 0;
    this.view = this.freshView();
    this.batch = [];
    this.batchCount = 0;
  }

  /** 实时新增事件：只入队，何时上屏由调用方的播放速度决定 */
  append(event: MatchEvent): void {
    this.source.push(event);
  }

  /** 顺序应用最多 n 条未消费事件，返回真正应用的数量 */
  advance(n: number): number {
    const end = Math.min(this.source.length, this.cursor + Math.max(0, n));
    for (let i = this.cursor; i < end; i++) applyEvent(this.view, this.source[i]!, this.rules);
    const applied = end - this.cursor;
    this.batchCount = applied;
    this.batch = applied > 0 ? this.source.slice(Math.max(this.cursor, end - MAX_FX_EVENTS), end) : [];
    this.cursor = end;
    return applied;
  }

  /** 跳到第 index 条事件之后的状态（回放时间轴） */
  seekTo(index: number): void {
    const target = Math.max(0, Math.min(index, this.source.length));
    if (target < this.cursor) {
      // 拖回过去：整体重建。回放拖动是低频操作，重建比维护快照更简单也更不容易出错。
      this.view = this.freshView();
      this.cursor = 0;
    }
    this.advance(target - this.cursor);
  }

  /** 一次性把已收到的事件全部应用（极速） */
  drainAll(): number {
    return this.advance(this.source.length - this.cursor);
  }
}

/** 事件下标 → 回合起始表，供回放时间轴做"上一回合/下一回合"跳转 */
export function roundStarts(events: readonly MatchEvent[]): { round: number; index: number }[] {
  const out: { round: number; index: number }[] = [];
  let last = -1;
  events.forEach((e, i) => {
    if (e.t !== "turn_begin") return;
    if (e.round !== last) {
      out.push({ round: e.round, index: i });
      last = e.round;
    }
  });
  return out;
}