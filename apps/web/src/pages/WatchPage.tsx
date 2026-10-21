// apps/web/src/pages/WatchPage.tsx —— 观战台（核心页面）
//
// 数据流：REST 拿元数据（比赛/地图/规则）→ 建立 BattleAccumulator → 连 WS。
// 赛事对局是"跑完即落库"的，所以 WS 连上后收到的是存档快照（含全量事件），客户端按节拍把它们放出来。
// 刷新页面/断线重连都能无损恢复：快照是全量真相，覆盖本地缓冲后直接跳到"直播边缘"。
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerStats } from "@ai-game/protocol";
import {
  api,
  bundles,
  type MatchBundle,
  type MatchPlayer,
  type MatchStatus,
  type MatchSummary,
  type WsMessage,
} from "../api";
import { BattleAccumulator } from "../battleState";
import { openMatchSocket, type ConnectionStatus } from "../ws";
import { BattleStage } from "../components/BattleStage";
import { SidePanel } from "../components/SidePanel";
import { useCommentary } from "../useCommentary";
import { ScoreCards } from "../components/ScoreCards";
import { PhaseBar } from "../components/ProgressBar";
import { Badge, Banner, matchStatusInfo, seatColor, shortId } from "../ui";

const SPEEDS = [1, 2, 4, 8, 0];
const DRAIN_TICK_MS = 60;

interface WatchPageProps {
  matchId: string;
  onOpen: (page: "watch" | "replay" | "report", matchId: string) => void;
  /** 跳回赛事页（"同配置再战"会新建一场赛事，进度在赛事详情里看） */
  onGotoTournament: (tournamentId?: string) => void;
  /** 未配置解说模型时，解说页签里的“去配置解说”要能跳到设置页 */
  onGotoCommentary?: () => void;
}

export function WatchPage({ matchId, onOpen, onGotoTournament, onGotoCommentary }: WatchPageProps) {
  const [bundle, setBundle] = useState<MatchBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [match, setMatch] = useState<MatchSummary | null>(null);
  const [players, setPlayers] = useState<MatchPlayer[]>([]);
  const [ranking, setRanking] = useState<PlayerStats[]>([]);
  const [phase, setPhase] = useState<MatchStatus>("created");
  const [phaseDetail, setPhaseDetail] = useState<string | undefined>(undefined);

  const [conn, setConn] = useState<ConnectionStatus>("connecting");
  const [connDetail, setConnDetail] = useState<string | null>(null);
  const [wsNotice, setWsNotice] = useState<string | null>(null);

  const [speed, setSpeed] = useState(1);
  const [viewpoint, setViewpoint] = useState<number | null>(null);
  const [buffered, setBuffered] = useState(0);
  const [frame, setFrame] = useState(0);
  const [rematching, setRematching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const commentary = useCommentary(matchId);
  const accRef = useRef<BattleAccumulator | null>(null);
  const speedRef = useRef(speed);
  const budgetRef = useRef(0);
  const bufferedRef = useRef(0);
  const baseMsRef = useRef(1200);

  speedRef.current = speed;

  // ---------- 元数据装载 ----------
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const b = await bundles.match(matchId);
      // 座位名/哈希先塞给视图：match_start 到达前也能画出正确的座位数量
      const names: Record<number, string> = {};
      const hashes: Record<number, string> = {};
      for (let seat = 1; seat <= b.match.seatCount; seat++) names[seat] = `P${seat}`;
      for (const p of b.players) {
        names[p.seat] = p.name || p.modelId || `P${p.seat}`;
        if (p.scriptSha256) hashes[p.seat] = p.scriptSha256;
      }
      const acc = new BattleAccumulator(b.map, b.rules, names, hashes);
      accRef.current = acc;
      budgetRef.current = 0;
      baseMsRef.current = Math.max(50, b.match.turnIntervalMs || 1200);
      setBundle(b);
      setMatch(b.match);
      setPlayers(b.players);
      setRanking(b.ranking);
      setPhase(b.match.status);
      setReady(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    void load();
    return () => {
      accRef.current = null;
      setReady(false);
    };
  }, [load]);

  // ---------- WebSocket ----------
  const handleMessage = useCallback(
    (msg: WsMessage) => {
      const acc = accRef.current;
      switch (msg.type) {
        case "snapshot": {
          // 快照是全量真相：直接覆盖事件流，丢弃本地缓冲（重连/中途进入都走这条路径）。
          // 覆盖后立刻全部应用 = 跳到"直播边缘"，否则重连补发的几百条事件要按 1x 慢慢播，
          // 画面会一直落后于服务端正在发生的事。之后再按速度消费新到达的事件。
          acc?.reset(msg.data.events);
          acc?.drainAll();
          budgetRef.current = 0;
          bufferedRef.current = 0;
          setMatch(msg.data.match);
          setPlayers(msg.data.players);
          setRanking(msg.data.ranking);
          setPhase(msg.data.match.status);
          baseMsRef.current = Math.max(50, msg.data.match.turnIntervalMs || 1200);
          setBuffered(0);
          setFrame((f) => f + 1);
          return;
        }
        case "phase": {
          setPhase(msg.data.phase);
          setPhaseDetail(msg.data.detail);
          if (msg.data.players) setPlayers(msg.data.players);
          return;
        }
        case "event": {
          acc?.append(msg.data);
          return;
        }
        case "scores":
        case "end": {
          setRanking(msg.data.ranking);
          if (msg.type === "end") setPhase("finished");
          return;
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    setConn("connecting");
    const socket = openMatchSocket(matchId, {
      onMessage: handleMessage,
      onStatus: (status, detail) => {
        setConn(status);
        setConnDetail(detail ?? null);
      },
      onError: (message) => setWsNotice(message),
    });
    return () => socket.close();
  }, [ready, matchId, handleMessage]);

  // ---------- 播放速度 ----------
  // 服务端已按 turnIntervalMs 节流，客户端能做的只是"平滑显示"：按 baseMs/speed 的节拍消费队列。
  // 1x 时画面最多落后服务端一个节拍（看起来最自然），倍速用于追赶积压（重连补发、事件成批到达），
  // 极速则一次性应用全部已收到的事件。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const acc = accRef.current;
      if (!acc) return;
      const pending = acc.total - acc.applied;
      if (pending <= 0) {
        if (bufferedRef.current !== 0) {
          bufferedRef.current = 0;
          setBuffered(0);
        }
        return;
      }
      const sp = speedRef.current;
      let take: number;
      if (sp === 0) {
        take = pending;
        budgetRef.current = 0;
      } else {
        budgetRef.current = Math.min(1, budgetRef.current + (DRAIN_TICK_MS * sp) / baseMsRef.current);
        take = Math.floor(budgetRef.current);
        if (take <= 0) {
          if (bufferedRef.current !== pending) {
            bufferedRef.current = pending;
            setBuffered(pending);
          }
          return;
        }
        budgetRef.current -= take;
      }
      acc.advance(take);
      bufferedRef.current = acc.total - acc.applied;
      setBuffered(bufferedRef.current);
      setFrame((f) => f + 1);
    }, DRAIN_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // REST 补齐：WebSocket 不可用时（后端没实现 /ws、代理没开 ws、比赛已结束但没连上）仍能看到画面。
  // 事件流在比赛结束后不再变化，所以这条路径与快照恢复等价。
  const loadEventsFromRest = useCallback(
    async (silent: boolean) => {
      const acc = accRef.current;
      if (!acc) return;
      try {
        const res = await api.getReplay(matchId);
        acc.reset(res.events);
        acc.drainAll();
        budgetRef.current = 0;
        bufferedRef.current = 0;
        setBuffered(0);
        setMatch(res.match);
        setPlayers(res.players);
        setRanking(res.ranking);
        setFrame((f) => f + 1);
      } catch (err) {
        if (!silent) setActionError(`从 REST 补齐事件失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [matchId],
  );

  // 已经结束的比赛：不等 WebSocket，直接用 REST 补一份事件（快照到达时会再次覆盖，结果一致）
  useEffect(() => {
    if (!ready || !bundle) return;
    if (bundle.match.status !== "finished" && bundle.match.status !== "failed") return;
    void loadEventsFromRest(true);
  }, [ready, bundle, loadEventsFromRest]);

  // 结束时补齐最终 players/ranking（含 finalScore / rank / token 用量）
  useEffect(() => {
    if (phase !== "finished" && phase !== "failed") return;
    let alive = true;
    api
      .getMatch(matchId)
      .then((res) => {
        if (!alive) return;
        setMatch(res.match);
        setPlayers(res.players);
        setRanking(res.ranking);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [phase, matchId]);

  /** 同配置再战：服务端会用新种子把双方再拉进一场 1v1 赛事（默认 2 局、攻守互换） */
  const rematch = async () => {
    setRematching(true);
    setActionError(null);
    try {
      const { tournamentId } = await api.rematch(matchId);
      onGotoTournament(tournamentId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRematching(false);
    }
  };

  if (loading) return <div className="hint">正在读取比赛 {shortId(matchId)} …</div>;
  if (loadError) {
    return (
      <Banner tone="error">
        加载比赛失败：{loadError}
        <div className="form-actions">
          <button className="btn" onClick={() => void load()}>
            重试
          </button>
          <button className="btn" onClick={() => onGotoTournament()}>
            去赛事页
          </button>
        </div>
      </Banner>
    );
  }
  if (!bundle) return <div className="hint">没有可展示的比赛数据。</div>;

  const acc = accRef.current;
  const view = acc ? acc.snapshot : null;
  const seats = view
    ? Object.keys(view.tanks)
        .map(Number)
        .sort((a, b) => a - b)
    : [];
  const st = matchStatusInfo(phase);

  return (
    <div className="stack">
      <div className="watch-head">
        <div className="watch-title">
          <span className="mono">比赛 {shortId(matchId)}</span>
          <Badge tone={st.tone}>{st.text}</Badge>
          <span className="muted small">
            {bundle.match.mapId}@{bundle.match.mapVersion} · seed {match?.seed ?? bundle.match.seed} ·{" "}
            {match?.seatCount ?? bundle.match.seatCount} 座位 · {bundle.match.turnIntervalMs}ms/事件
          </span>
          <span className={`conn conn-${conn}`}>
            {conn === "connected" ? "已连接" : conn === "connecting" ? "连接中…" : "已断开，自动重连中"}
            {connDetail && conn !== "connected" ? `（${connDetail}）` : ""}
          </span>
        </div>
        <div className="watch-actions">
          <button className="btn" onClick={() => onOpen("replay", matchId)}>
            回放
          </button>
          <button className="btn" onClick={() => onOpen("report", matchId)}>
            战报
          </button>
          <button className="btn" onClick={() => void loadEventsFromRest(false)} title="WebSocket 不可用时用 REST 拉取事件流">
            REST 补齐
          </button>
          <button className="btn" onClick={rematch} disabled={rematching} title="用新种子把双方再拉进一场 1v1 赛事（默认 2 局、攻守互换）">
            {rematching ? "创建中…" : "同配置再战"}
          </button>
          <button className="btn" onClick={() => onGotoTournament()}>
            赛事页
          </button>
        </div>
      </div>

      <PhaseBar
        phase={phase}
        detail={phaseDetail}
        extra={<span className="muted small">{buffered > 0 ? `缓冲 ${buffered} 条事件` : "已追平推送"}</span>}
      />

      {bundle.degraded.length > 0 ? <Banner tone="warn">{bundle.degraded.join("；")}</Banner> : null}
      {wsNotice ? <Banner tone="warn">{wsNotice}</Banner> : null}
      {actionError ? <Banner tone="error">{actionError}</Banner> : null}

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
              title={`只看 P${seat} 视野内可见的信息`}
            >
              P{seat} 视角
            </button>
          ))}
        </div>
        <div className="control-group">
          <span className="field-label">速度</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`chip ${speed === s ? "chip-on" : ""}`}
              onClick={() => setSpeed(s)}
              title={s === 0 ? "极速：一次性应用全部已收到的事件" : `以 ${s} 倍速消费积压事件`}
            >
              {s === 0 ? "极速" : `${s}x`}
            </button>
          ))}
          <span className="muted small">
            服务端按 turnIntervalMs 节流推送；1x 平滑跟随（最多落后一个节拍），倍速与极速用于追赶积压的事件
          </span>
        </div>
      </div>

      {acc && view ? (
        <div className="watch-main">
          {/* 得分看板：挪到左侧、卡片纵向排布（窄卡片一列到底；全屏时同一份卡片会悬浮到战场左上角） */}
          <aside className="watch-scores cards-narrow" aria-label="得分看板">
            <ScoreCards view={view} rules={bundle.rules} players={players} ranking={ranking} />
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
              players={players}
              ranking={ranking}
            />
            <div className="board-note">
              {viewpoint === null
                ? "上帝视角：看到全部坦克、资源余量与事件。"
                : `P${viewpoint} 视角：视野半径 ${bundle.rules.visionRadius} 格（视线被墙与森林遮挡，森林中的敌人在 ${bundle.rules.forestStealthRadius} 格外不可见）；视野外显示最后一次目击的虚影，记忆保留 ${bundle.rules.lastKnownMemoryRounds} 回合。`}
            </div>
          </div>
          <div className="watch-log">
            <SidePanel
              log={view.log}
              version={frame}
              seats={seats}
              commentary={commentary.state}
              commentaryBusy={commentary.busy}
              commentaryError={commentary.error}
              cursor={acc ? acc.applied : 0}
              onGenerate={(force) => void commentary.generate(force)}
              onRemove={() => void commentary.remove()}
              onJump={() => { /* 观战是直播节拍，不支持回跳；看回放可以点句子跳转 */ }}
              onOpenSettings={() => onGotoCommentary?.()}
            />
          </div>
        </div>
      ) : (
        <div className="hint">等待第一条事件…</div>
      )}
    </div>
  );
}