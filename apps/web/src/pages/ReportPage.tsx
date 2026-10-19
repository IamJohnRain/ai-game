// apps/web/src/pages/ReportPage.tsx —— ⑤ 战报：Markdown 原文 + 各座位明细表（可展开脚本与校验报告）
import { Fragment, useCallback, useEffect, useState } from "react";
import type { PlayerStats } from "@ai-game/protocol";
import { api, type MatchPlayer, type MatchSummary } from "../api";
import { Badge, Banner, Section, fmtMs, fmtTime, matchStatusInfo, shortId, statusInfo } from "../ui";

interface ReportPageProps {
  matchId: string;
  onOpen: (page: "watch" | "replay" | "report", matchId: string) => void;
}

export function ReportPage({ matchId, onOpen }: ReportPageProps) {
  const [report, setReport] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchSummary | null>(null);
  const [players, setPlayers] = useState<MatchPlayer[]>([]);
  const [ranking, setRanking] = useState<PlayerStats[]>([]);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // 两个接口互不依赖：战报挂了也仍要能看座位明细，反之亦然
    const [reportResult, metaResult] = await Promise.allSettled([api.getReport(matchId), api.getMatch(matchId)]);
    if (reportResult.status === "fulfilled") {
      setReport(reportResult.value);
      setReportError(null);
    } else {
      setReport(null);
      setReportError(
        reportResult.reason instanceof Error ? reportResult.reason.message : String(reportResult.reason),
      );
    }
    if (metaResult.status === "fulfilled") {
      setMatch(metaResult.value.match);
      setPlayers(metaResult.value.players);
      setRanking(metaResult.value.ranking);
      setMetaError(null);
    } else {
      setMetaError(metaResult.reason instanceof Error ? metaResult.reason.message : String(metaResult.reason));
    }
    setLoading(false);
  }, [matchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = () => {
    if (!report) return;
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `match-${matchId}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="hint">正在读取战报 {shortId(matchId)} …</div>;

  const st = matchStatusInfo(match?.status ?? "finished");

  return (
    <div className="stack">
      <div className="watch-head">
        <div className="watch-title">
          <span className="mono">战报 {shortId(matchId)}</span>
          <Badge tone={st.tone}>{st.text}</Badge>
          {match ? (
            <span className="muted small">
              {match.mapId}@{match.mapVersion} · ruleset {match.rulesetVersion} · seed {match.seed} ·{" "}
              {fmtTime(match.createdAt)}
              {match.endedAt ? ` ~ ${fmtTime(match.endedAt)}` : ""}
            </span>
          ) : null}
        </div>
        <div className="watch-actions">
          <button className="btn" onClick={() => onOpen("watch", matchId)}>
            实时观战
          </button>
          <button className="btn" onClick={() => onOpen("replay", matchId)}>
            回放
          </button>
          <button className="btn" onClick={() => void load()}>
            刷新
          </button>
          <button className="btn btn-primary" onClick={download} disabled={!report}>
            下载 Markdown
          </button>
        </div>
      </div>

      {match?.error ? <Banner tone="error">比赛错误：{match.error}</Banner> : null}
      {metaError ? <Banner tone="warn">读取比赛元数据失败：{metaError}</Banner> : null}

      <Section title="座位明细">
        {players.length === 0 ? (
          <div className="hint">这场比赛的座位数据还没生成。</div>
        ) : (
          <table className="table table-dense">
            <thead>
              <tr>
                <th>座位</th>
                <th>模型</th>
                <th>状态</th>
                <th>名次</th>
                <th>总分</th>
                <th>提交单位</th>
                <th>击杀</th>
                <th>死亡</th>
                <th>无效动作</th>
                <th>strike</th>
                <th>平均决策</th>
                <th>脚本 SHA256</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {players.map((p) => {
                const stats = ranking.find((r) => r.seat === p.seat);
                const info = statusInfo(p.status);
                const open = expanded === p.seat;
                return (
                  <Fragment key={p.seat}>
                    <tr className={open ? "row-open" : undefined}>
                      <td>P{p.seat}</td>
                      <td className="mono small">{p.modelId}</td>
                      <td>
                        <Badge tone={info.tone}>{info.text}</Badge>
                      </td>
                      <td>{p.rank ?? stats?.rank ?? "-"}</td>
                      <td className="mono">{p.finalScore ?? stats?.score ?? "-"}</td>
                      <td>{stats?.unitsDeposited ?? "-"}</td>
                      <td>{stats?.kills ?? "-"}</td>
                      <td>{stats?.deaths ?? "-"}</td>
                      <td>{stats?.invalidActions ?? "-"}</td>
                      <td>{stats?.strikes ?? "-"}</td>
                      <td>{fmtMs(stats?.avgDecisionMs)}</td>
                      <td className="mono tiny" title={p.scriptSha256}>
                        {p.scriptSha256 ? `${p.scriptSha256.slice(0, 12)}…` : "-"}
                      </td>
                      <td>
                        <button className="btn btn-sm" onClick={() => setExpanded(open ? null : p.seat)}>
                          {open ? "收起" : "展开"}
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="row-detail">
                        <td colSpan={13}>
                          <div className="detail-grid">
                            <div>
                              <h4>校验报告</h4>
                              {p.validation.length === 0 ? (
                                <div className="muted small">没有校验记录。</div>
                              ) : (
                                <ul className="checklist">
                                  {p.validation.map((v, i) => (
                                    <li key={`${v.stage}-${i}`} className={v.ok ? "ck-ok" : "ck-bad"}>
                                      <span className="ck-mark">{v.ok ? "✅" : "⛔"}</span>
                                      <span className="mono">{v.stage}</span>
                                      {v.detail ? <span className="muted"> — {v.detail}</span> : null}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <div className="kv">
                                <span>strike：{stats?.strikes ?? 0}</span>
                                <span>紧急移动：{stats?.emergencyMoves ?? 0}</span>
                                <span>平均决策：{fmtMs(stats?.avgDecisionMs)}</span>
                              </div>
                              {stats ? (
                                <div className="kv">
                                  <span>提交得分：{stats.scoreBreakdown.deposit}</span>
                                  <span>击杀：{stats.scoreBreakdown.kill}</span>
                                  <span>死亡：{stats.scoreBreakdown.death}</span>
                                  <span>补弹支出：{stats.scoreBreakdown.ammo}</span>
                                  <span>加油支出：{stats.scoreBreakdown.fuel}</span>
                                </div>
                              ) : null}
                            </div>
                            <div>
                              <h4>脚本全文（sha256 固化，赛后只读）</h4>
                              {p.script ? (
                                <pre className="code">{p.script}</pre>
                              ) : (
                                <div className="muted small">这场比赛没有可展示的脚本（可能未通过提取/编译阶段）。</div>
                              )}

                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="战报原文（Markdown）" extra={<span className="muted small">由服务端生成，此处仅原样展示</span>}>
        {reportError ? (
          <Banner tone="error">
            读取战报失败：{reportError}
            <div className="banner-hint">
              战报接口返回 <code>text/markdown</code>；比赛可能还没结束，或该比赛未生成战报。
            </div>
          </Banner>
        ) : null}
        {report ? <pre className="report">{report}</pre> : null}
      </Section>
    </div>
  );
}