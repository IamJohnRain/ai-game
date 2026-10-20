// apps/web/src/pages/CohortsPage.tsx —— 评测批次（docs/08）：多条 leg 的汇总评测 + 评级（±CI）+ 过程分画像
//
// 为什么单独一页：单场赛事只回答"这一局谁赢了"，批次回答"这批条件下的相对强弱与过程质量"。
// 评级用 Bradley–Terry（1500 = 全场几何均值），区间是按 leg 重采样的 95% 置信区间；标尺对手（挂机/基线）单列，当刻度看。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type Agent,
  type CohortDetail,
  type CohortMatrixCell,
  type CohortMetricRow,
  type CohortRatingRow,
  type CohortSummary,
  type CreateCohortInput,
} from "../api";
import { Badge, Banner, EmptyState, Section, fmtNum, fmtTime, shortId } from "../ui";

type Preset = "default" | "quick" | "long";

const PRESETS: { key: Preset; label: string; hint: string }[] = [
  { key: "default", label: "默认评测计划", hint: "按注册表里实际有的图拼装：主赛/短局/长局 + 规则变体 + 考察图（多种子）" },
  { key: "quick", label: "快速冒烟", hint: "1 条 leg · 20 回合 · 1 局/对：几分钟内看流程是否跑通" },
  { key: "long", label: "长赛（3 条 leg）", hint: "150/300 回合各一条 + 侦察变体一条，每对 2 局" },
];

const QUICK_LEGS: CreateCohortInput["legs"] = [{ name: "冒烟", mapId: "duel-01", maxRounds: 20, rulesVariant: "default", seeds: 1 }];
const LONG_LEGS: CreateCohortInput["legs"] = [
  { name: "长局 300", mapId: "duel-01", maxRounds: 300, rulesVariant: "default", seeds: 1 },
  { name: "标准 150", mapId: "arena-01", maxRounds: 150, rulesVariant: "default", seeds: 2 },
  { name: "侦察压制", mapId: "duel-01", maxRounds: 150, rulesVariant: "scout", seeds: 2 },
];

function ratingCell(r: CohortRatingRow): string {
  if (!Number.isFinite(r.lo) || !Number.isFinite(r.hi)) return `${r.rating}`;
  return `${r.rating}（${fmtNum(r.lo, 0)}~${fmtNum(r.hi, 0)}）`;
}

/** 矩阵：把 (aId,bId) 的格子摊成 rows×cols 的表，行视角 = 行选手的胜-平-负 */
function matrixView(matrix: CohortMatrixCell[], ids: string[], nameOf: (id: string) => string) {
  const at = (row: string, col: string) => matrix.find((c) => (c.aId === row && c.bId === col) || (c.aId === col && c.bId === row));
  return ids.map((rowId) => ({
    rowId,
    cells: ids.map((colId) => {
      if (rowId === colId) return null;
      const cell = at(rowId, colId);
      if (!cell) return null;
      const rowIsA = cell.aId === rowId;
      return {
        wins: rowIsA ? cell.wins : cell.losses,
        draws: cell.draws,
        losses: rowIsA ? cell.losses : cell.wins,
        medianDiff: rowIsA ? cell.medianDiff : -cell.medianDiff,
        games: cell.games,
      };
    }),
  }));
}

export function CohortsPage({ onOpenTournament }: { onOpenTournament: (tournamentId: string) => void }) {
  const [cohorts, setCohorts] = useState<CohortSummary[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CohortDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<Preset>("default");
  const [gamesPerPair, setGamesPerPair] = useState(2);
  const [includeCalibration, setIncludeCalibration] = useState(true);
  const [revisionPolicy, setRevisionPolicy] = useState<"latest" | "best" | "pinned">("latest");

  const loadList = useCallback(() => {
    api
      .listCohorts()
      .then((res) => setCohorts(res.cohorts))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const loadDetail = useCallback((id: string) => {
    api
      .getCohort(id)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    loadList();
    api
      .listAgents()
      .then((res) => {
        setAgents(res.agents);
        // 默认把已通过校验的 Agent 都勾上（评测只对 uploaded 的脚本有意义）
        setSelected(res.agents.filter((a) => a.status === "uploaded").map((a) => a.id));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [loadList]);

  // 批次在跑时自动刷新（进度 + 结果）
  useEffect(() => {
    if (!openId) return;
    loadDetail(openId);
    const running = detail?.cohort.status === "running" || detail?.cohort.status === "pending" || detail === null;
    if (!running) return;
    const timer = setInterval(() => loadDetail(openId), 3000);
    return () => clearInterval(timer);
  }, [openId, detail?.cohort.status, loadDetail]);

  const toggle = (id: string) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: CreateCohortInput = {
        agentIds: selected,
        gamesPerPair,
        includeCalibration,
        revisionPolicy,
        ...(preset === "quick" ? { legs: QUICK_LEGS } : preset === "long" ? { legs: LONG_LEGS } : {}),
      };
      const res = await api.createCohort(input);
      setOpenId(res.cohortId);
      setDetail(null);
      loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!openId) return;
    setBusy(true);
    try {
      await api.stopCohort(openId);
      loadDetail(openId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const uploaded = agents.filter((a) => a.status === "uploaded");
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of detail?.snapshot ?? []) map.set(s.agentId, s.agentName);
    for (const a of agents) map.set(a.id, a.agentName);
    map.set("cal-idle", "标尺·挂机");
    map.set("cal-baseline", "标尺·基线");
    return (id: string) => map.get(id) ?? shortId(id);
  }, [detail?.snapshot, agents]);

  const ratingIds = detail?.ratings?.rows.map((r) => r.agentId) ?? [];
  const matrix = detail?.matrix ?? [];

  return (
    <div className="stack">
      <Section
        title="发起评测批次"
        extra={
          <button className="btn" onClick={loadList}>
            刷新列表
          </button>
        }
      >
        <p className="hint">
          一个批次 = 多条 <strong>leg</strong>（多种子 / 多张图 / 短局长局混排 / 规则变体）串起来跑，外加两个<strong>标尺对手</strong>
          （挂机者与平台基线，单列为刻度），最后给出 Bradley–Terry 评级（带 95% 置信区间）、胜负矩阵与过程分画像。
          <strong>批次开始时各家的参赛版本会被冻结</strong>，之后重新提交不影响本批次成绩。
        </p>

        <div className="form-grid">
          <label className="field field-wide">
            <span>参赛 Agent（只有已通过校验的能参评）</span>
            {uploaded.length === 0 ? (
              <div className="hint">还没有通过校验的 Agent：先去「Agent 自助接入」上传脚本。</div>
            ) : (
              <div className="chips">
                {uploaded.map((a) => (
                  <button
                    key={a.id}
                    className={`btn btn-sm ${selected.includes(a.id) ? "btn-primary" : ""}`}
                    onClick={() => toggle(a.id)}
                    title={`${a.modelName} · v${a.revision} · 自测 ${a.practiceRuns}/${a.maxPracticeRuns}`}
                  >
                    {a.agentName}（v{a.revision}）
                  </button>
                ))}
              </div>
            )}
          </label>
          <label className="field">
            <span>计划</span>
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>每对局数（gamesPerPair）</span>
            <input
              type="number"
              min={1}
              max={10}
              value={gamesPerPair}
              onChange={(e) => setGamesPerPair(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            />
          </label>
          <label className="field">
            <span>版本策略（revisionPolicy）</span>
            <select value={revisionPolicy} onChange={(e) => setRevisionPolicy(e.target.value as typeof revisionPolicy)}>
              <option value="latest">latest（用最新一版）</option>
              <option value="best">best（用标尺分最高的一版）</option>
              <option value="pinned">pinned（按指定版本，需手工调接口）</option>
            </select>
          </label>
          <label className="field">
            <span>标尺对手</span>
            <select value={includeCalibration ? "1" : "0"} onChange={(e) => setIncludeCalibration(e.target.value === "1")}>
              <option value="1">包含（挂机 + 基线，榜上当刻度）</option>
              <option value="0">不包含</option>
            </select>
          </label>
        </div>
        {PRESETS.find((p) => p.key === preset) ? <div className="hint">{PRESETS.find((p) => p.key === preset)!.hint}</div> : null}

        {error ? <Banner tone="error">{error}</Banner> : null}
        <div className="form-actions">
          <button className="btn btn-primary" onClick={() => void launch()} disabled={busy || selected.length < 2}>
            {busy ? "发起中…" : `发起批次（${selected.length} 个参赛者）`}
          </button>
        </div>
      </Section>

      <Section title="批次列表">
        {cohorts === null ? (
          <div className="hint">加载中…</div>
        ) : cohorts.length === 0 ? (
          <EmptyState title="还没有批次" hint="上面选好参赛者与计划，点「发起批次」即可。" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>批次</th>
                <th>状态</th>
                <th>进度</th>
                <th>参赛者</th>
                <th>创建时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="mono small">{c.id}</div>
                    <div>{c.name}</div>
                  </td>
                  <td>
                    <Badge tone={c.status === "finished" ? "ok" : c.status === "running" ? "info" : c.status === "failed" ? "danger" : "muted"}>
                      {c.status}
                    </Badge>
                    {c.error ? <div className="small muted">{c.error}</div> : null}
                  </td>
                  <td>
                    {c.finishedLegs !== undefined ? `${c.finishedLegs}/${c.legs} leg` : `${c.legs} leg`}
                  </td>
                  <td>{c.agentCount}</td>
                  <td className="small muted">{fmtTime(c.createdAt)}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => setOpenId(c.id)}>
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {detail ? (
        <>
          <Section
            title={`批次详情 · ${detail.cohort.name}`}
            extra={
              <>
                <a className="btn btn-sm" href={`/api/cohorts/${detail.cohort.id}/report`} target="_blank" rel="noreferrer">
                  打开 Markdown 战报
                </a>
                <button className="btn btn-sm" onClick={() => void stop()} disabled={busy || (detail.cohort.status !== "running" && detail.cohort.status !== "pending")}>
                  停止（跑完当前 leg）
                </button>
              </>
            }
          >
            <div className="kv">
              <span>
                状态：<Badge tone={detail.cohort.status === "finished" ? "ok" : detail.cohort.status === "failed" ? "danger" : "info"}>{detail.cohort.status}</Badge>
              </span>
              <span>种子：<code className="mono">{detail.cohort.masterSeed}</code></span>
              <span>每对局数：{detail.cohort.gamesPerPair}</span>
              {detail.progress ? (
                <span>
                  进度：{detail.progress.leg}/{detail.progress.totalLegs} leg
                </span>
              ) : null}
              {detail.ratings ? <span>评级样本：{detail.ratings.games} 局（bootstrap {detail.ratings.bootstrapRounds} 次）</span> : null}
            </div>
            {detail.cohort.error ? <Banner tone="warn">{detail.cohort.error}</Banner> : null}
          </Section>

          <Section title="leg 计划与进度">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>名称</th>
                  <th>地图</th>
                  <th>回合数</th>
                  <th>规则变体</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {detail.legs.map((l) => (
                  <tr key={l.index}>
                    <td>{l.index + 1}</td>
                    <td>{l.name}</td>
                    <td className="mono small">{l.mapId}</td>
                    <td>{l.maxRounds}</td>
                    <td>{l.rulesVariant}</td>
                    <td>
                      <Badge tone={l.status === "finished" ? "ok" : l.status === "failed" ? "danger" : "muted"}>{l.status}</Badge>
                      {l.error ? <div className="small muted">{l.error}</div> : null}
                    </td>
                    <td>
                      {l.tournamentId ? (
                        <button className="btn btn-sm" onClick={() => onOpenTournament(l.tournamentId!)}>
                          看这条 leg 的对局
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint">
              参赛版本快照：{detail.snapshot.filter((s) => !s.calibration).map((s) => `${s.agentName} v${s.revision}(${s.resolvedBy ?? "latest"})`).join("、") || "-"}
            </div>
          </Section>

          {detail.ratings && detail.ratings.rows.length > 0 ? (
            <Section title="评级（Bradley–Terry · 1500 = 全场几何均值）">
              <table className="table">
                <thead>
                  <tr>
                    <th>名次</th>
                    <th>参赛者</th>
                    <th>模型</th>
                    <th>rating（95% CI）</th>
                    <th>局数</th>
                    <th>胜-平-负</th>
                    <th>净胜分差</th>
                    <th>平均分</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.ratings.rows.map((r, i) => (
                    <tr key={r.agentId}>
                      <td>{r.insufficient ? "—" : i + 1}</td>
                      <td>
                        {r.agentName} {r.calibration ? <Badge tone="muted">标尺</Badge> : null}
                        {r.insufficient ? <Badge tone="warn">样本不足</Badge> : null}
                      </td>
                      <td className="small muted">{r.modelName}</td>
                      <td className="mono">{ratingCell(r)}</td>
                      <td>{r.games}</td>
                      <td>
                        {r.wins}-{r.draws}-{r.losses}
                      </td>
                      <td>
                        {r.scoreDiff >= 0 ? "+" : ""}
                        {r.scoreDiff}
                      </td>
                      <td>{fmtNum(r.avgScore, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="hint">
                区间是按 leg 重采样的 bootstrap 结果；区间重叠 = 差距还没超过噪声。标尺行（挂机/基线）单列，用来判断"绝对水平"。
              </div>
            </Section>
          ) : null}

          {matrix.length > 0 ? (
            <Section title="胜负矩阵（行视角：胜-平-负，括号内为净胜分差中位数）">
              <table className="table">
                <thead>
                  <tr>
                    <th />
                    {ratingIds.map((id) => (
                      <th key={id}>{nameOf(id)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixView(matrix, ratingIds, nameOf).map((row) => (
                    <tr key={row.rowId}>
                      <th>{nameOf(row.rowId)}</th>
                      {row.cells.map((cell, i) => (
                        <td key={ratingIds[i]} className="mono small">
                          {cell === null ? "—" : `${cell.wins}-${cell.draws}-${cell.losses}（${cell.medianDiff >= 0 ? "+" : ""}${cell.medianDiff}）`}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ) : null}

          {detail.metrics && detail.metrics.rows.length > 0 ? (
            <Section title="过程分画像（按每回合/每单位归一）">
              <table className="table">
                <thead>
                  <tr>
                    <th>参赛者</th>
                    <th>局数</th>
                    <th>AP 利用率</th>
                    <th>应急移动率</th>
                    <th>每百回合提交</th>
                    <th>终局利用率</th>
                    <th>补给占比</th>
                    <th>死杀差</th>
                    <th>平均/最慢决策</th>
                    <th>适应力 σ</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.metrics.rows.map((m: CohortMetricRow) => (
                    <tr key={m.agentId}>
                      <td>
                        {m.agentName} {m.calibration ? <Badge tone="muted">标尺</Badge> : null}
                      </td>
                      <td>{m.matches}</td>
                      <td>{fmtNum(m.apUtilization, 3)}</td>
                      <td>{fmtNum(m.emergencyRate, 3)}</td>
                      <td>{fmtNum(m.unitsPer100, 1)}</td>
                      <td>{fmtNum(m.endgameShare, 2)}</td>
                      <td>{fmtNum(m.supplyShare, 2)}</td>
                      <td>{m.killDeathDiff}</td>
                      <td className="mono">
                        {fmtNum(m.avgDecisionMs, 2)}/{fmtNum(m.maxDecisionMs, 1)}ms
                      </td>
                      <td>{fmtNum(m.adaptivity, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="hint">
                AP 利用率 = 1 − 无效动作率（浪费掉的行动力）；终局利用率 = 最后 20% 回合的提交占比（会不会做终局估值）；
                适应力 σ = 各 leg 平均分的标准差（越小越"换个环境也稳"）。
              </div>
            </Section>
          ) : null}
        </>
      ) : openId ? (
        <Section title="批次详情">
          <div className="hint">加载中…（{openId}）</div>
        </Section>
      ) : null}
    </div>
  );
}