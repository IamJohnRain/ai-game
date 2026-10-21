// apps/web/src/components/SidePanel.tsx —— 右侧看板：解说 / 事件 两个页签（默认「解说」）
//
// 为什么把两者放同一个看板：它们描述的是同一件事（这一刻发生了什么），
// 只是"人话版"与"事实版"的区别 —— 切换页签不该把战场也换掉，所以这里只包一层页签壳子。
// 事件页签就是原来的 EventLog（筛选/只看关键事件原样保留）。
import { useState } from "react";
import type { LogEntry } from "@ai-game/engine";
import type { CommentaryState } from "../api";
import { CommentaryPanel } from "./CommentaryPanel";
import { EventLog } from "./EventLog";

interface SidePanelProps {
  log: LogEntry[];
  version: number;
  seats: number[];
  /** 解说相关 */
  commentary: CommentaryState | null;
  commentaryBusy: boolean;
  commentaryError: string | null;
  cursor: number;
  onGenerate: (force?: boolean) => void;
  onRemove: () => void;
  onJump: (eventIndex: number) => void;
  onOpenSettings: () => void;
}

type Tab = "commentary" | "events";

export function SidePanel(props: SidePanelProps) {
  // 需求：右侧看板默认展示「解说」。刻意不做持久化——每次进观战/回放都从解说开始，
  // 切到「事件」只在当前这次浏览里生效。
  const [tab, setTab] = useState<Tab>("commentary");

  const hasCommentary = (props.commentary?.segments.length ?? 0) > 0;

  return (
    <div className="sidepanel">
      <div className="sp-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "commentary"}
          className={`sp-tab ${tab === "commentary" ? "sp-tab-on" : ""}`}
          onClick={() => setTab("commentary")}
          title="上帝视角解说：按回放光标逐段播出，点句子可以跳到那一刻"
        >
          🎙 解说
          {props.commentaryBusy || props.commentary?.status === "generating" ? <span className="sp-dot" /> : null}
          {hasCommentary ? <span className="sp-count">{props.commentary!.segments.length}</span> : null}
        </button>
        <button
          role="tab"
          aria-selected={tab === "events"}
          className={`sp-tab ${tab === "events" ? "sp-tab-on" : ""}`}
          onClick={() => setTab("events")}
          title="逐条事件日志（可按座位筛选、只看关键事件）"
        >
          📋 事件
          <span className="sp-count">{props.log.length}</span>
        </button>
      </div>
      {tab === "commentary" ? (
        <CommentaryPanel
          state={props.commentary}
          busy={props.commentaryBusy}
          error={props.commentaryError}
          cursor={props.cursor}
          onGenerate={props.onGenerate}
          onRemove={props.onRemove}
          onJump={props.onJump}
          onOpenSettings={props.onOpenSettings}
        />
      ) : (
        <EventLog log={props.log} version={props.version} seats={props.seats} />
      )}
    </div>
  );
}