// apps/web/src/components/ProgressBar.tsx —— 通用进度条（HP/弹药/燃油/货舱）+ 比赛阶段进度条
import type { ReactNode } from "react";

interface ProgressBarProps {
  label: string;
  value: number;
  max: number;
  color?: string;
  /** 数值后缀，例如 "12 / 20" */
  hint?: string;
}

export function ProgressBar({ label, value, max, color = "#4f9dff", hint }: ProgressBarProps) {
  const safeMax = max > 0 ? max : 1;
  const frac = Math.max(0, Math.min(1, value / safeMax));
  return (
    <div className="pbar" title={`${label} ${value} / ${max}`}>
      <span className="pbar-label">{label}</span>
      <span className="pbar-track">
        <span className="pbar-fill" style={{ width: `${frac * 100}%`, background: color }} />
      </span>
      <span className="pbar-value">{hint ?? `${Math.round(value)}/${max}`}</span>
    </div>
  );
}

const PHASES = [
  { key: "created", text: "已创建" },
  { key: "running", text: "对战" },
  { key: "finished", text: "结束" },
] as const;

export function PhaseBar({
  phase,
  detail,
  extra,
}: {
  phase: string;
  detail?: string;
  extra?: ReactNode;
}) {
  const failed = phase === "failed";
  const order = PHASES.findIndex((p) => p.key === phase);
  const current = failed ? PHASES.length - 1 : order;
  return (
    <div className="phasebar">
      {PHASES.map((p, i) => {
        const state = failed && i === PHASES.length - 1 ? "failed" : i < current ? "done" : i === current ? "active" : "todo";
        return (
          <div className={`phase phase-${state}`} key={p.key}>
            <span className="phase-dot" />
            <span className="phase-text">{p.text}</span>
            {i < PHASES.length - 1 ? <span className="phase-line" /> : null}
          </div>
        );
      })}
      <div className="phase-detail">
        {failed ? <span className="phase-error">{detail ?? "比赛失败"}</span> : detail ? <span>{detail}</span> : null}
        {extra}
      </div>
    </div>
  );
}