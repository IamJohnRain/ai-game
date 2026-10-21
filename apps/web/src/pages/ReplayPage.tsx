// apps/web/src/pages/ReplayPage.tsx —— ④ 回放：一次性取全量事件，按事件下标拖动
//
// 与观战页共用 BattleCanvas / EventLog / ScoreCards：回放本质上只是"事件来源不同、光标由用户控制"，
// 归约逻辑完全一样，所以两边都用 BattleAccumulator，避免两套渲染路径行为不一致。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatchEvent } from "@ai-game/protocol";
import { bundles, type ReplayBundle } from "../api";
import { BattleAccumulator, roundStarts } from "../battleState";
import { BattleStage } from "../components/BattleStage";
import { EventLog } from "../components/EventLog";
import { ScoreCards } from "../components/ScoreCards";
import { Timeline, type TimelineMark } from "../components/Timeline";
import { Badge, Banner, EmptyState, matchStatusInfo, seatColor, shortId } from "../ui";

const PLAY_TICK_MS = 50;
const MARKED_KINDS = new Set(["death", "disqualified", "deposit", "match_end"]);

export function ReplayPage({
  matchId,
  initialMatchId,
  onOpen,
}: {
  /** 外部指定的比赛（App 导航、赛事详情的「回放」按钮都走这里） */
  matchId?: string | null;
  /** 兜底：matchId 为空时用它（便于外部只传一个初始值即可打开某场比赛） */
  initialMatchId?: string | null;
  onOpen: (page: "watch" | "replay" | "report", matchId: string) => void;
}) {
  // 组件内保存"当前回放的比赛"：props 只作为初始值与后续的外部覆盖，换比赛不必推翻整个组件结构
  const [activeId, setActiveId] = useState<string | null>(matchId ?? initialMatchId ?? null);
  useEffect(() => {
    if (matchId) setActiveId(matchId);
  }, [matchId]);

  const [bundle, setBundle] = useState<ReplayBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1); // 0 = 极速
  const [viewpoint, setViewpoint] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);

  const accRef = useRef<BattleAccumulator | null>(null);
  const speedRef = useRef(speed);
  const budgetRef = useRef(0);
  speedRef.current = speed;

  const load = useCallback(async () => {
    if (!activeId) return;
    setLoading(true);
    setError(null);
    try {
      const b = await bundles.replay(activeId);
      const names: Record<number, string> = {};
      const hashes: Record<number, string> = {};
      for (let seat = 1; seat <= b.match.seatCount; seat++) names[seat] = `P${seat}`;
      for (const p of b.players) {
        names[p.seat] = p.modelId || `P${p.seat}`;
        if (p.scriptSha256) hashes[p.seat] = p.scriptSha256;
      }
      const acc = new BattleAccumulator(b.map, b.rules, names, hashes);
      acc.reset(b.events);
      accRef.current = acc;
      budgetRef.current = 0;
      setBundle(b);
      setIndex(0);
      setPlaying(false);
      setFrame((f) => f + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    void load();
    return () => {
      accRef.current = null;
    };
  }, [load]);

  const applyIndex = useCallback((target: number) => {
    const acc = accRef.current;
    if (!acc) return;
    acc.seekTo(target);
    setIndex(acc.applied);
    setFrame((f) => f + 1);
  }, []);

  const step = useCallback(
    (delta: number) => {
      const acc = accRef.current;
      if (!acc) return;
      setPlaying(false);
      applyIndex(acc.applied + delta);
    },
    [applyIndex],
  );

  const rounds = useMemo(() => (bundle ? roundStarts(bundle.events) : []), [bundle]);

  const jumpRound = useCallback(
    (direction: -1 | 1) => {
      const acc = accRef.current;
      if (!acc || rounds.length === 0) return;
      setPlaying(false);
      const current = acc.snapshot.round;
      if (direction < 0) {
        // 目标 = 当前回合之前的最后一个回合起点
        let target = 0;
        for (const r of rounds) if (r.round < current) target = r.index;
        applyIndex(target);
      } else {
        const next = rounds.find((r) => r.round > current);
        applyIndex(next ? next.index : acc.total);
      }
    },
    [rounds, applyIndex],
  );

  // 播放循环：极速直接跳到结尾；其他倍速按 (speed / 原始 turnIntervalMs) 的节奏推进
  useEffect(() => {
    if (!playing || !bundle) return;
    const baseMs = Math.max(50, bundle.match.turnIntervalMs || 1200);
    const timer = window.setInterval(() => {
      const acc = accRef.current;
      if (!acc) return;
      if (acc.applied >= acc.total) {
        setPlaying(false);
        return;
      }
      const sp = speedRef.current;
      let take: number;
      if (sp === 0) {
        take = acc.total - acc.applied;
      } else {
        budgetRef.current += (PLAY_TICK_MS * sp) / baseMs;
        take = Math.floor(budgetRef.current);
        if (take <= 0) return;
        budgetRef.current -= take;
      }
      acc.advance(take);
      setIndex(acc.applied);
      setFrame((f) => f + 1);
    }, PLAY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing, bundle]);

  // 键盘：空格播放/暂停，左右方向键逐事件
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const marks = useMemo<TimelineMark[]>(() => {
    if (!bundle) return [];
    const out: TimelineMark[] = [];
    bundle.events.forEach((e: MatchEvent, i) => {
      if (MARKED_KINDS.has(e.t)) out.push({ index: i, kind: e.t });
    });
    return out;
  }, [bundle]);

  // 没有外部指定比赛时不猜：给出明确引导，而不是白屏或空拉一次接口
  if (!activeId) {
    return (
      <EmptyState
        title="还没有选择要回放的比赛"
        hint="从顶部「回放」入口选择历史比赛，或者在赛事详情页点某局的「回放」直接进来。"
      />
    );
  }
  if (loading) return <div className="hint">正在读取回放 {shortId(activeId)} …</div>;
  if (error) {
    return (
      <Banner tone="error">
        加载回放失败：{error}
        <div className="form-actions">
          <button className="btn" onClick={() => void load()}>
            重试
          </button>
        </div>
      </Banner>
    );
  }
  if (!bundle) return <div className="hint">没有可回放的数据。</div>;

  const acc = accRef.current;
  const view = acc ? acc.snapshot : null;
  const seats = view
    ? Object.keys(view.tanks)
        .map(Number)
        .sort((a, b) => a - b)
    : [];
  const st = matchStatusInfo(bundle.match.status);
  const totalRounds = rounds.length > 0 ? rounds[rounds.length - 1]!.round : 0;

  return (
    <div className="stack">
      <div className="watch-head">
        <div className="watch-title">
          <span className="mono">回放 {shortId(activeId)}</span>
          <Badge tone={st.tone}>{st.text}</Badge>
          <span className="muted small">
            {bundle.match.mapId}@{bundle.match.mapVersion} · seed {bundle.match.seed} · 共 {bundle.events.length} 条事件
          </span>
        </div>
        <div className="watch-actions">
          <button className="btn" onClick={() => onOpen("watch", activeId)}>
            实时观战
          </button>
          <button className="btn" onClick={() => onOpen("report", activeId)}>
            战报
          </button>
        </div>
      </div>

      {bundle.degraded.length > 0 ? <Banner tone="warn">{bundle.degraded.join("；")}</Banner> : null}

      <div className="watch-controls">
        <div className="control-group">
          <span className="field-label">视角</span>
          <button className={`chip ${viewpoint === null ? "chip-on" : ""}`} onClick={() => setViewpoint(null)}>
            上帝视角
          </button>
          {seats.map((seat) => (
            <button
              key={seat}
              className={`chip ${viewpoint === seat ? "chip-on" : ""}`}
              style={viewpoint === seat ? { borderColor: seatColor(seat), color: seatColor(seat) } : undefined}
              onClick={() => setViewpoint(viewpoint === seat ? null : seat)}
            >
              P{seat} 视角
            </button>
          ))}
        </div>
        <span className="muted small">空格播放/暂停，← → 逐条事件；时间轴上方色标为关键事件</span>
      </div>

      <Timeline
        index={index}
        total={bundle.events.length}
        playing={playing}
        speed={speed}
        currentRound={view?.round ?? 0}
        totalRounds={totalRounds}
        marks={marks}
        onSeek={(i) => {
          setPlaying(false);
          applyIndex(i);
        }}
        onStep={step}
        onTogglePlay={() => setPlaying((p) => !p)}
        onSpeed={(s) => {
          budgetRef.current = 0;
          setSpeed(s);
          if (s === 0) {
            const a = accRef.current;
            if (a) {
              a.drainAll();
              setIndex(a.applied);
              setFrame((f) => f + 1);
            }
          }
        }}
        onJumpRound={jumpRound}
      />

      {acc && view ? (
        <div className="watch-main">
          {/* 与观战页同一套布局：得分看板在左侧纵向排布（全屏时同一份卡片会悬浮到战场左上角） */}
          <aside className="watch-scores cards-narrow" aria-label="得分看板">
            <ScoreCards view={view} rules={bundle.rules} players={bundle.players} />
          </aside>
          <div className="watch-board">
            <BattleStage
              map={bundle.map}
              terrain={acc.terrain}
              view={view}
              rules={bundle.rules}
              batch={acc.lastApplied}
              batchCount={acc.lastAppliedCount}
              viewpoint={viewpoint}
              onViewpointChange={setViewpoint}
              version={frame}
              players={bundle.players}
            />
            <div className="board-note">
              当前：第 {view.round} 回合 · 第 {view.turn} 个回合动作（事件 {index} / {bundle.events.length}）。
              {viewpoint === null
                ? "上帝视角。"
                : ` 仅显示 P${viewpoint} 视野内信息，其余为迷雾。`}
            </div>
          </div>
          <div className="watch-log">
            <EventLog log={view.log} version={frame} seats={seats} />
          </div>
        </div>
      ) : (
        <div className="hint">没有事件可播放。</div>
      )}
    </div>
  );
}