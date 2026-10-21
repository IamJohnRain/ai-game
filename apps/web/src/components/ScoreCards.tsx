// apps/web/src/components/ScoreCards.tsx —— 底部座位状态卡：模型名、当前分、四条资源条、校验徽章
// 观战与回放共用：观战传服务端 ranking，回放（还没跑完）传空数组，由当前画面分数自行排名。
import type { BattleView } from "@ai-game/engine";
import type { PlayerStats, Ruleset } from "@ai-game/protocol";
import type { MatchPlayer } from "../api";
import { ProgressBar } from "./ProgressBar";
import { Badge, fmtMs, seatColor, statusInfo } from "../ui";

interface ScoreCardsProps {
  view: BattleView;
  rules: Ruleset;
  players?: MatchPlayer[];
  ranking?: PlayerStats[];
}

export function ScoreCards({ view, rules, players = [], ranking = [] }: ScoreCardsProps) {
  const seats = Object.keys(view.tanks)
    .map(Number)
    .sort((a, b) => a - b);

  if (seats.length === 0) {
    return <div className="hint">还没有座位信息。</div>;
  }

  // ranking 来自服务端（含最终名次）；没有时按当前分数临时排名，回放过程中也能看到名次变化
  const rankOf = (seat: number): number | null => {
    const hit = ranking.find((r) => r.seat === seat);
    if (hit) return hit.rank;
    if (ranking.length > 0) return null;
    const sorted = [...seats].sort((a, b) => (view.tanks[b]!.score ?? 0) - (view.tanks[a]!.score ?? 0));
    return sorted.indexOf(seat) + 1;
  };

  return (
    <div className="cards">
      {seats.map((seat) => {
        const tank = view.tanks[seat]!;
        const player = players.find((p) => p.seat === seat);
        const stat = ranking.find((r) => r.seat === seat);
        // 未知状态（例如回放里只有事件流）按"正常参赛"显示，不要凭空报错
        const info = statusInfo(player?.status ?? "OK");
        const detail = player?.validation
          ?.filter((v) => !v.ok)
          .map((v) => `${v.stage}: ${v.detail ?? "未通过"}`)
          .join("\n");
        const rank = rankOf(seat);
        return (
          <div className={`card ${tank.disqualified ? "card-out" : ""}`} key={seat}>
            <header className="card-head">
              <span className="seat-dot" style={{ background: seatColor(seat) }} />
              <span className="card-title" title={player?.modelId ?? tank.name}>
                P{seat} · {player?.modelId ?? tank.name}
              </span>
              <Badge tone={info.tone} title={detail || undefined}>
                {info.text}
              </Badge>
            </header>

            <div className="card-score">
              <span className="score-num">{tank.score}</span>
              <span className="score-label">分</span>
              {rank !== null ? <span className="rank-tag">#{rank}</span> : null}
              {/* 防御状态只有观战能看到（脚本看不到对手的这个状态），用蓝色标签点出来 */}
              {tank.alive && tank.defendLeft > 0 ? (
                <span className="defend-tag" title={`防御中：还剩 ${tank.defendLeft} 轮，炮弹打不动（对方看不到）`}>
                  🛡 防御 {tank.defendLeft}
                </span>
              ) : null}
              <span className={`alive-tag ${tank.alive ? "alive" : "dead"}`}>
                {tank.disqualified ? "已淘汰" : tank.alive ? "在场" : "阵亡（等待复活）"}
              </span>
            </div>

            <ProgressBar label="HP" value={tank.hp} max={rules.hpMax} color={tank.hp > rules.hpMax * 0.5 ? "#34d399" : tank.hp > rules.hpMax * 0.25 ? "#fbbf24" : "#f87171"} />
            <ProgressBar label="弹药" value={tank.ammo} max={rules.ammoMax} color="#f0a72c" />
            <ProgressBar label="燃油" value={tank.fuel} max={rules.fuelMax} color="#2fbdb0" />
            <ProgressBar label="货舱" value={tank.cargo} max={rules.cargoMax} color="#a78bfa" />
            {/* 地雷上限为 0 的图上不摆这一栏（那种图根本没有雷） */}
            {rules.mineMax > 0 ? (
              <ProgressBar label="地雷" value={tank.mines} max={rules.mineMax} color="#f87171" />
            ) : null}

            <footer className="card-foot">
              <span>击杀 {tank.kills}</span>
              <span>死亡 {tank.deaths}</span>
              <span>提交 {tank.deposits} 次 / {tank.unitsDeposited} 单位</span>
              {typeof stat?.minesDeployed === "number" && stat.minesDeployed > 0 ? (
                <span title={stat.mineKills > 0 ? `其中 ${stat.mineKills} 次是对手踩响的` : "对手还没踩到"}>
                  布雷 {stat.minesDeployed}
                </span>
              ) : null}
              {typeof stat?.avgDecisionMs === "number" ? <span>决策 {fmtMs(stat.avgDecisionMs)}</span> : null}
            </footer>
          </div>
        );
      })}
    </div>
  );
}