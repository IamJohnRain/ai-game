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
          统计口径：同一模型（<code>modelId</code>）在多场比赛中的累计表现，按平均得分降序。<strong>脚本通过率</strong>
          指该模型生成的脚本一次通过五阶段校验（提取 → 静态扫描 → 沙箱编译 → 模糊测试 → 冒烟对局）的比例；
          <strong>平均无效动作</strong>是每场平均被判定的非法动作数（越低越好）。不同 ruleset / 脚本协议版本的成绩
          不建议横向比较——版本变化会改变分值口径，跨版本对比请回到战报查看当时的 ruleset 版本。
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
                <th>平均无效动作</th>
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
                  <td>{r.avgInvalidActions.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
    </div>
  );
}