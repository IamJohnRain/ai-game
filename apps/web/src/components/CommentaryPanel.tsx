// apps/web/src/components/CommentaryPanel.tsx —— 「解说」页签的内容：上帝视角解说员的稿子
//
// 稿子是整场生成、按事件下标锚定的（见 apps/server/src/commentary.ts），
// 这里按"当前光标"逐段播出：光标之前的内容亮着，光标之后默认折叠（避免剧透），当前那一段高亮并自动滚到视野里。
// 点任意一条会把回放光标跳到它锚定的事件上 —— 解说的每一句都能落到画面上。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommentaryState } from "../api";
import { currentSegment, revealedCount, segmentIndex } from "../commentaryView";
import { seatColor } from "../ui";

interface CommentaryPanelProps {
  state: CommentaryState | null;
  /** 前端是否在等（发起/轮询） */
  busy: boolean;
  error: string | null;
  /** 当前事件光标：决定"播到哪儿了" */
  cursor: number;
  onGenerate: (force?: boolean) => void;
  onRemove: () => void;
  onJump: (eventIndex: number) => void;
  /** 未配置时给个去配置的入口 */
  onOpenSettings: () => void;
}

const TONE_LABEL: Record<string, string> = { calm: "平稳", hot: "激烈", fun: "轻松" };

export function CommentaryPanel(props: CommentaryPanelProps) {
  const { state, busy, error, cursor } = props;
  const [showAll, setShowAll] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const segments = state?.segments ?? [];
  const cur = useMemo(() => currentSegment(segments, cursor), [segments, cursor]);
  const curIdx = useMemo(() => segmentIndex(segments, cur), [segments, cur]);
  const revealed = useMemo(() => revealedCount(segments, cursor), [segments, cursor]);
  const status = state?.status ?? "none";
  const generating = busy || status === "generating";

  // 当前段变了 → 滚到它（用户上翻时别打扰）
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !stickRef.current || curIdx < 0) return;
    const row = el.querySelector<HTMLElement>(`[data-seg="${curIdx}"]`);
    if (row) el.scrollTop = Math.max(0, row.offsetTop - el.clientHeight / 2);
  }, [curIdx, showAll]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const shown = showAll ? segments : segments.slice(0, Math.max(revealed, 0));

  return (
    <div className="logbox cmtbox">
      <div className="log-tools cmt-tools">
        <span className={`cmt-state cmt-${status}`}>
          {generating ? "解说生成中…" : status === "ready" ? "解说已就绪" : status === "failed" ? "解说生成失败" : state?.configured ? "尚未生成解说" : "未配置解说模型"}
        </span>
        {state && state.segments.length > 0 && !generating ? (
          <>
            <span className="muted small" title={`模型 ${state.modelId || "-"}${state.usage ? `　${state.usage.calls} 次调用　${state.usage.totalTokens} tokens` : ""}`}>
              {state.modelId || "-"}
            </span>
            <label className="chip-toggle" title="默认只播到当前进度，避免剧透">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              显示全文
            </label>
            <button className="chip" onClick={() => props.onGenerate(true)} disabled={generating} title="用同一场比赛重新生成一份（会再调用模型）">
              重新生成
            </button>
            <button className="chip" onClick={props.onRemove} disabled={generating} title="删掉这份稿子（下次打开可重新生成）">
              删除
            </button>
          </>
        ) : null}
      </div>

      {error ? <div className="cmt-error">{error}</div> : null}
      {status === "failed" && state?.error ? <div className="cmt-error">{state.error}</div> : null}

      <div className="log-list cmt-list" ref={boxRef}>
        {segments.length === 0 && !generating ? (
          <div className="log-empty">
            {state?.configured ? (
              <>
                <p>还没有这场比赛的解说稿。</p>
                <button className="btn btn-sm btn-primary" onClick={() => props.onGenerate(false)}>
                  生成解说
                </button>
                <p className="muted small">
                  生成会用你在「解说设置」里配的模型，对双方的关键行为（交火、阵亡、踩雷、举盾、提交、比分变化）逐段写解说词；
                  一般 3~6 次调用。普通模型几秒钟出稿，推理模型（会先"想"一遍）可能要几分钟。
                </p>
              </>
            ) : (
              <>
                <p>解说需要一个外部模型：填好 baseUrl / modelId / apiKey 后，这里就会出现这场比赛的解说稿。</p>
                <button className="btn btn-sm btn-primary" onClick={props.onOpenSettings}>
                  去配置解说
                </button>
              </>
            )}
          </div>
        ) : segments.length === 0 && generating ? (
          <div className="log-empty">解说员正在翻看你这场比赛的录像…（生成完会自动出现在这里）</div>
        ) : (
          shown.map((s, idx) => {
            const isCur = curIdx === idx;
            const ahead = !showAll && s.i > cursor;
            return (
              <button
                key={`${s.i}-${idx}`}
                type="button"
                data-seg={idx}
                className={`cmt-row ${isCur ? "cmt-cur" : ""} ${ahead ? "cmt-ahead" : ""}`}
                style={{ borderLeftColor: s.seat > 0 ? seatColor(s.seat) : "rgba(148,163,184,0.5)" }}
                onClick={() => props.onJump(s.i)}
                title={`跳到事件 ${s.i}（第 ${s.round} 回合）`}
              >
                <span className="cmt-round">R{s.round}</span>
                <span className="cmt-text">{s.text}</span>
                <span className="cmt-tone" title={TONE_LABEL[s.tone] ?? s.tone}>
                  {s.seat > 0 ? `P${s.seat}` : "解说"}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="log-foot">
        共 {segments.length} 段 · 已播 {Math.min(revealed, segments.length)} 段
        {!showAll && segments.length > revealed ? "（默认不剧透：光标走到哪、说到哪）" : ""}
      </div>
    </div>
  );
}