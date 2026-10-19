// apps/web/src/components/EventLog.tsx —— 事件日志（观战与回放共用同一个组件）
// 日志来自 BattleView.log（由引擎 applyEvent 生成），按座位着色；长局只渲染尾部若干条，
// 否则一次插入几千个 DOM 节点会让观战页明显掉帧。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "@ai-game/engine";
import { seatColor } from "../ui";

interface EventLogProps {
  log: LogEntry[];
  /** 归约版本号：log 是复用数组，靠它触发重新过滤/渲染 */
  version: number;
  /** 只显示最近 N 条（默认 400） */
  limit?: number;
  seats?: number[];
}

const KIND_LABEL: Record<string, string> = {
  match_start: "开赛",
  fire: "射击",
  death: "阵亡",
  respawn: "复活",
  deposit: "提交",
  collect: "采集",
  load_ammo: "补弹",
  refuel: "加油",
  invalid_action: "无效动作",
  strike: "Strike",
  disqualified: "淘汰",
  node_regen: "资源再生",
  match_end: "结束",
};

export function EventLog({ log, version, limit = 400, seats = [1, 2, 3, 4] }: EventLogProps) {
  const [filter, setFilter] = useState<number | null>(null);
  const [onlyKey, setOnlyKey] = useState(false);
  const [stick, setStick] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const KEY_KINDS = useMemo(
    () => new Set(["death", "disqualified", "strike", "invalid_action", "match_end", "match_start"]),
    [],
  );

  const shown = useMemo(() => {
    // 先过滤再截断：过滤后仍然要看得到"最后发生的事"
    const filtered = log.filter((e) => {
      if (filter !== null && e.seat !== filter) return false;
      if (onlyKey && !KEY_KINDS.has(e.kind)) return false;
      return true;
    });
    return filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
    // version 参与依赖：log 数组是原地追加的复用对象，只有版本号变化才知道内容变了
  }, [log, version, filter, onlyKey, limit, KEY_KINDS]);

  // 追加式日志：用户已经在底部时自动跟随；用户上翻查看历史时不打扰
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !stick) return;
    el.scrollTop = el.scrollHeight;
  }, [shown.length, stick, version]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setStick(atBottom);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="logbox">
      <div className="log-tools">
        <button className={`chip ${filter === null ? "chip-on" : ""}`} onClick={() => setFilter(null)}>
          全部
        </button>
        {seats.map((seat) => (
          <button
            key={seat}
            className={`chip ${filter === seat ? "chip-on" : ""}`}
            style={filter === seat ? { borderColor: seatColor(seat), color: seatColor(seat) } : undefined}
            onClick={() => setFilter(filter === seat ? null : seat)}
          >
            P{seat}
          </button>
        ))}
        <label className="chip-toggle">
          <input type="checkbox" checked={onlyKey} onChange={(e) => setOnlyKey(e.target.checked)} />
          只看关键事件
        </label>
      </div>
      <div className="log-list" ref={boxRef}>
        {shown.length === 0 ? (
          <div className="log-empty">暂无事件。比赛开始后这里会滚动显示每一次移动、射击与提交。</div>
        ) : (
          shown.map((e, i) => (
            <div className={`log-row log-${e.kind}`} key={`${e.round}-${e.turn}-${i}`}>
              <span className="log-turn">R{e.round}</span>
              <span className="log-kind" style={{ color: e.seat ? seatColor(e.seat) : undefined }}>
                {KIND_LABEL[e.kind] ?? e.kind}
              </span>
              <span className="log-text">{e.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="log-foot">
        共 {log.length} 条{shown.length < log.length ? ` · 仅显示最近 ${shown.length} 条` : ""}
        {!stick ? <button className="link" onClick={() => setStick(true)}>回到最新</button> : null}
      </div>
    </div>
  );
}