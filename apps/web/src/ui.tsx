// apps/web/src/ui.tsx —— 跨页面共用的小组件与文案表（座位配色、状态徽章、时间格式化）
import type { ReactNode } from "react";

/** 座位配色：P1 红 / P2 蓝 / P3 绿 / P4 黄，与 Canvas 里的坦克颜色保持同一张表 */
export const SEAT_COLORS: Record<number, string> = {
  1: "#ef4444",
  2: "#3b82f6",
  3: "#22c55e",
  4: "#eab308",
};

export function seatColor(seat: number): string {
  return SEAT_COLORS[seat] ?? "#94a3b8";
}

/** 座位运行状态 → 中文标签 + 徽章配色（只有"正常参赛"和"因 strike 超限被淘汰"两种） */
const STATUS_LABELS: Record<string, { text: string; tone: string }> = {
  OK: { text: "正常参赛", tone: "ok" },
  STRIKES_EXCEEDED: { text: "strike 超限淘汰", tone: "danger" },
};

export function statusInfo(status: string): { text: string; tone: string } {
  return STATUS_LABELS[status] ?? { text: status || "未知", tone: "muted" };
}

const MATCH_STATUS: Record<string, { text: string; tone: string }> = {
  created: { text: "已创建", tone: "muted" },
  running: { text: "对战中", tone: "ok" },
  finished: { text: "已结束", tone: "muted" },
  failed: { text: "失败", tone: "danger" },
};

export function matchStatusInfo(status: string): { text: string; tone: string } {
  return MATCH_STATUS[status] ?? { text: status || "未知", tone: "muted" };
}

/** 外部 Agent 自助流程的状态：待上传 → 已入库 / 校验失败 */
const AGENT_STATUS: Record<string, { text: string; tone: string }> = {
  registered: { text: "待上传", tone: "info" },
  uploaded: { text: "已入库", tone: "ok" },
  rejected: { text: "校验失败", tone: "danger" },
};

export function agentStatusInfo(status: string): { text: string; tone: string } {
  return AGENT_STATUS[status] ?? { text: status || "未知", tone: "muted" };
}

const TOURNAMENT_STATUS: Record<string, { text: string; tone: string }> = {
  pending: { text: "待开始", tone: "muted" },
  running: { text: "进行中", tone: "info" },
  finished: { text: "已结束", tone: "ok" },
  failed: { text: "失败", tone: "danger" },
};

export function tournamentStatusInfo(status: string): { text: string; tone: string } {
  return TOURNAMENT_STATUS[status] ?? { text: status || "未知", tone: "muted" };
}

export function Badge({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function fmtTime(iso?: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function fmtNum(v?: number | null, digits = 0): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}

/** 字节数 → 人类可读（上传限制表用，后端给的是原始字节数） */
export function fmtBytes(v?: number | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "-";
  const units = ["B", "KiB", "MiB", "GiB"];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
}

/** 空数据引导卡片：页面在没有 Agent / 没有比赛时用它，而不是留白 */
export function EmptyState({ title, hint, action }: { title: string; hint: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-hint">{hint}</div>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Banner({ tone, children }: { tone: "error" | "info" | "warn"; children: ReactNode }) {
  return <div className={`banner banner-${tone}`}>{children}</div>;
}

export function Section({
  title,
  extra,
  children,
}: {
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {extra ? <div className="panel-extra">{extra}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}