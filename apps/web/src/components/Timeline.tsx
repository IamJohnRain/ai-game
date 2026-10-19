// apps/web/src/components/Timeline.tsx —— 回放时间轴（按事件下标）+ 播放控制 + 逐回合跳转
import type { MatchEvent } from "@ai-game/protocol";

export interface TimelineMark {
  index: number;
  kind: MatchEvent["t"];
}

interface TimelineProps {
  index: number;
  total: number;
  playing: boolean;
  speed: number; // 1 | 2 | 4 | 8 | 0(极速)
  currentRound: number;
  totalRounds: number;
  marks: TimelineMark[];
  onSeek(index: number): void;
  onStep(delta: number): void;
  onTogglePlay(): void;
  onSpeed(speed: number): void;
  onJumpRound(direction: -1 | 1): void;
}

const MARK_COLOR: Partial<Record<MatchEvent["t"], string>> = {
  death: "#f87171",
  disqualified: "#f97316",
  deposit: "#34d399",
  match_end: "#e2e8f0",
};

const SPEEDS = [1, 2, 4, 8, 0];

export function Timeline(props: TimelineProps) {
  const { index, total, playing, speed, currentRound, totalRounds, marks } = props;
  const safeTotal = Math.max(1, total);
  return (
    <div className="timeline">
      <div className="tl-row">
        <button className="btn btn-icon" onClick={() => props.onStep(-1)} disabled={index <= 0} title="上一条事件">
          ◀|
        </button>
        <button className="btn btn-icon" onClick={() => props.onJumpRound(-1)} disabled={index <= 0} title="上一回合">
          ◀◀
        </button>
        <button className="btn btn-primary" onClick={props.onTogglePlay}>
          {playing ? "暂停" : "播放"}
        </button>
        <button className="btn btn-icon" onClick={() => props.onJumpRound(1)} disabled={index >= total} title="下一回合">
          ▶▶
        </button>
        <button className="btn btn-icon" onClick={() => props.onStep(1)} disabled={index >= total} title="下一条事件">
          |▶
        </button>

        <div className="tl-slider">
          <input
            type="range"
            min={0}
            max={total}
            value={index}
            onChange={(e) => props.onSeek(Number(e.target.value))}
          />
          <div className="tl-marks">
            {marks.map((m) => (
              <span
                key={`${m.kind}-${m.index}`}
                className="tl-mark"
                style={{ left: `${(m.index / safeTotal) * 100}%`, background: MARK_COLOR[m.kind] ?? "#64748b" }}
                title={m.kind}
              />
            ))}
          </div>
        </div>

        <span className="tl-pos">
          第 {currentRound} 回合（事件 {index} / {total}）
        </span>
        <span className="tl-rounds">共 {totalRounds} 回合</span>

        <div className="speed-group">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`chip ${speed === s ? "chip-on" : ""}`}
              onClick={() => props.onSpeed(s)}
              title={s === 0 ? "极速：一次性应用全部剩余事件" : `以 ${s} 倍速播放`}
            >
              {s === 0 ? "极速" : `${s}x`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}