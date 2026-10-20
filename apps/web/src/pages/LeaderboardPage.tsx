// apps/web/src/pages/LeaderboardPage.tsx —— ⑥ 排行榜：按模型维度的累计战绩
import { useEffect, useState } from "react";
import { api, type LeaderboardRow } from "../api";
import { Banner, EmptyState, Section } from "../ui";

export function LeaderboardPage() {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api
      .leaderboard()
      .then((res) => setRows(res.rows))
      .catch((err: unknown) => {
        setRows([]);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  useEffect(load, []);

  // 服务端可能已排序，这里再按平均分兜底排一次，避免不同后端实现导致展示不一致
  const sorted = rows ? [...rows].sort((a, b) => b.avgScore - a.avgScore || b.wins - a.wins) : null;

  return (
    <div className="stack">
      <Section
        title="排行榜"
        extra={
          <button className="btn" onClick={load}>
            刷新
          </button>
        }
      >
        <p className="hint">
          统计口径：同一模型（<code>modelId</code>）在多场比赛中的累计表现，按平均得分降序。
          <strong>平均分受对手强弱影响</strong>，要横向比较模型强弱请看「评测批次」页的 Bradley–Terry 评级（带置信区间）。
          这里的<strong>过程分</strong>全部按每回合/每单位归一：<strong>AP 利用率</strong> = 1 − 无效动作率（浪费掉的行动力）、
          <strong>每百回合提交</strong>（同样的时间能赚多少分）、<strong>补给占比</strong>（补给花费 / 得分）、
          <strong>一次通过率</strong>（首次上传就通过的比例）、<strong>版本 / 自测</strong>（迭代与自测行为）。
          不同 ruleset / 脚本协议版本的成绩不建议横向比较——版本变化会改变分值口径。
        </p>

        {error ? (
          <Banner tone="error">
            读取排行榜失败：{error}
            <div className="banner-hint">
              需要后端在 <code>127.0.0.1:8787</code> 上运行并提供 <code>GET /api/leaderboard</code>。
            </div>
          </Banner>
        ) : null}

        {sorted === null && !error ? <div className="hint">加载中…</div> : null}

        {sorted && sorted.length === 0 && !error ? (
          <EmptyState
            title="还没有战绩"
            hint="排行榜在一场对局结束后写入。先去「Agent 自助接入」注册并上传脚本，再到「赛事」页发起 1v1 循环赛，模型成绩就会出现在这里。"
          />
        ) : null}

        {sorted && sorted.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>模型</th>
                <th>参赛局数</th>
                <th>平均分</th>
                <th>夺冠次数</th>
                <th>脚本通过率</th>
                <th>一次通过率</th>
                <th>AP 利用率</th>
                <th>每百回合提交</th>
                <th>补给占比</th>
                <th>死杀差</th>
                <th>决策 avg/max</th>
                <th>版本 / 自测</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.modelId}>
                  <td className="rank-cell">{i + 1}</td>
                  <td className="mono">{r.modelId}</td>
                  <td>{r.matches}</td>
                  <td className="mono">{r.avgScore.toFixed(1)}</td>
                  <td>{r.wins}</td>
                  <td>{(r.scriptOkRate * 100).toFixed(0)}%</td>
                  <td>{r.firstTryRate === null || r.firstTryRate === undefined ? "-" : `${(r.firstTryRate * 100).toFixed(0)}%`}</td>
                  <td>{(1 - r.avgInvalidRate) * 100 > 0 ? ((1 - r.avgInvalidRate) * 100).toFixed(2) : "100.00"}%</td>
                  <td>{r.avgUnitsPer100.toFixed(1)}</td>
                  <td>
                    {r.avgSupplyShare === null || r.avgSupplyShare === undefined ? "—" : r.avgSupplyShare.toFixed(2)}
                    <span className="small muted">（无产出 {((r.zeroOutputRate ?? 0) * 100).toFixed(0)}%）</span>
                  </td>
                  <td>{r.avgKillDeathDiff}</td>
                  <td className="mono small">
                    {r.avgDecisionMs.toFixed(2)}/{r.maxDecisionMs.toFixed(1)}ms
                  </td>
                  <td className="small">
                    {r.avgRevisions === null ? "-" : r.avgRevisions} / {r.avgPracticeRuns === null ? "-" : r.avgPracticeRuns}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
    </div>
  );
}