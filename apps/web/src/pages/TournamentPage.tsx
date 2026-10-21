// apps/web/src/pages/TournamentPage.tsx —— ⑧ 赛事：勾选已入库 Agent → 1v1 循环赛 → 积分榜 + 对局回放
//
// 页面内用 openId 这个 state 在"列表 / 详情"之间切换，不引入路由库（与 App.tsx 的整体风格一致）。
// 详情在 pending/running 时每 2 秒轮询一次，状态落到 finished/failed 后自动停止，避免无意义的后台请求。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type Agent,
  type MapListItem,
  type Standing,
  type TournamentDetail,
  type TournamentSummary,
} from "../api";
import { ProgressBar } from "../components/ProgressBar";
import {
  Badge,
  Banner,
  EmptyState,
  Section,
  agentStatusInfo,
  fmtTime,
  shortId,
  tournamentStatusInfo,
} from "../ui";

const POLL_MS = 2000;

/** 只用于参与计算的数值字段：后端契约里是必填，但并行实现期间缺失时也要能安全渲染 */
function toCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function TournamentPage({
  initialId,
  onOpen,
  onGotoEditor,
}: {
  /** 从别处（例如观战页的"同配置再战"）带过来的赛事 id：进页面直接打开详情 */
  initialId?: string | null;
  /** 跳到已有的观战/回放/战报页，参数是单场比赛的 matchId */
  onOpen: (page: "watch" | "replay" | "report", matchId: string) => void;
  /** 去地图编辑器挑/做一张赛图 */
  onGotoEditor?: () => void;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [maps, setMaps] = useState<MapListItem[]>([]);
  const [mapId, setMapId] = useState<string>("");
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [tournaments, setTournaments] = useState<TournamentSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [gamesPerPair, setGamesPerPair] = useState(2);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 删除的回执 / 失败原因：单独放一条横幅，不跟"读取列表失败"混在一起 */
  const [listAction, setListAction] = useState<{ kind: "notice" | "error"; text: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /** 正在跑 / 批次里的轮次都不能删：按钮提前禁用并说明原因，省得用户点了才被服务端拒 */
  const deleteBlockedReason = (t: TournamentSummary): string | null => {
    if (t.status === "pending" || t.status === "running") return "赛事正在跑：等它跑完再删";
    if (t.cohortId) return `这是评测批次 ${shortId(t.cohortId)} 的第 ${(t.legIndex ?? 0) + 1} 轮：到「评测批次」页删除整个批次`;
    return null;
  };

  const loadAgents = useCallback(() => {
    setAgentsError(null);
    api
      .listAgents()
      .then((res) => setAgents(res.agents))
      .catch((err: unknown) => {
        setAgents([]);
        setAgentsError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const loadTournaments = useCallback(() => {
    setListError(null);
    api
      .listTournaments()
      .then((res) => setTournaments(res.tournaments))
      .catch((err: unknown) => {
        setTournaments([]);
        setListError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    loadAgents();
    loadTournaments();
    api
      .listMaps()
      .then((list) => {
        setMaps(list);
        // 默认选 1v1 默认图（服务端缺省也是它）；用户改过就不再覆盖
        setMapId((cur) => cur || list.find((m) => m.is1v1Default)?.mapId || list[0]?.mapId || "");
      })
      .catch(() => setMaps([]));
  }, [loadAgents, loadTournaments]);

  // 带 id 进来时直接打开详情（"同配置再战"跳转用）
  useEffect(() => {
    if (initialId) {
      setOpenId(initialId);
      setDetail(null);
      setDetailError(null);
      void loadDetail(initialId);
    }
    // loadDetail 是 useCallback([]) 依赖 loadTournaments，引用稳定，这里只需响应 initialId 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId]);

  const loadDetail = useCallback(
    async (id: string, opts?: { silent?: boolean }) => {
      if (!opts?.silent) setDetailLoading(true);
      try {
        const res = await api.getTournament(id);
        setDetail(res);
        setDetailError(null);
        if (res.tournament.status === "finished" || res.tournament.status === "failed") {
          // 轮询到终态时顺手刷新一次列表，让列表页的对局数与详情保持一致
          loadTournaments();
        }
      } catch (err) {
        // 静默轮询失败不清空已渲染的积分榜，只留一条横幅；手动进入/点刷新时才回到错误态
        setDetailError(err instanceof Error ? err.message : String(err));
        if (!opts?.silent) setDetail(null);
      } finally {
        if (!opts?.silent) setDetailLoading(false);
      }
    },
    [loadTournaments],
  );

  const live = detail?.tournament.status === "pending" || detail?.tournament.status === "running";

  useEffect(() => {
    if (!openId || !live) return;
    const timer = window.setInterval(() => void loadDetail(openId, { silent: true }), POLL_MS);
    return () => window.clearInterval(timer);
  }, [openId, live, loadDetail]);

  const uploaded = useMemo(() => (agents ?? []).filter((a) => a.status === "uploaded"), [agents]);
  const canCreate = uploaded.length >= 2 && selected.length >= 2;

  const toggle = (id: string) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const openDetail = (id: string) => {
    setOpenId(id);
    setDetail(null);
    setDetailError(null);
    void loadDetail(id);
  };

  const create = async () => {
    setCreateError(null);
    if (selected.length < 2) {
      setCreateError("至少勾选 2 个已入库的 Agent 才能开赛");
      return;
    }
    if (!Number.isInteger(gamesPerPair) || gamesPerPair < 2) {
      setCreateError("每组对局数必须是不小于 2 的整数");
      return;
    }
    setCreating(true);
    try {
      const { tournamentId } = await api.createTournament({
        agentIds: selected,
        gamesPerPair,
        name: name.trim() || undefined,
        ...(mapId ? { mapId } : {}),
      });
      setSelected([]);
      setName("");
      loadTournaments();
      openDetail(tournamentId);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (t: TournamentSummary) => {
    const label = t.name || shortId(t.id);
    const games = toCount(t.matchCount) || toCount(t.finishedMatches);
    // 二次确认：连带删掉这一场的全部对局与回放，属于不可撤销操作
    if (
      !window.confirm(
        `删除赛事「${label}」？\n\n它的 ${games} 局对局、回放、选手成绩与解说稿都会一并删除，排行榜里的这些成绩也会随之消失。\nAgent、密钥与地图不受影响。`,
      )
    ) {
      return;
    }
    setListAction(null);
    setDeletingId(t.id);
    try {
      const { deleted } = await api.deleteTournament(t.id);
      setListAction({
        kind: "notice",
        text: `已删除「${label}」：${deleted.matches} 局对局、${deleted.replays} 份回放、${deleted.commentary} 份解说稿。`,
      });
      loadTournaments();
    } catch (err) {
      setListAction({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setDeletingId(null);
    }
  };

  if (openId) {
    return (
      <TournamentDetailView
        tournamentId={openId}
        detail={detail}
        error={detailError}
        loading={detailLoading}
        live={Boolean(live)}
        onBack={() => {
          setOpenId(null);
          setDetail(null);
          setDetailError(null);
          loadTournaments();
        }}
        onDeleted={(text) => {
          setOpenId(null);
          setDetail(null);
          setDetailError(null);
          setListAction({ kind: "notice", text });
          loadTournaments();
        }}
        onReload={() => void loadDetail(openId)}
        onOpen={onOpen}
      />
    );
  }

  return (
    <div className="stack">
      <Section
        title="发起赛事（1v1 循环赛）"
        extra={
          <>
            <button className="btn" onClick={loadAgents}>
              刷新 Agent
            </button>
            <button className="btn" onClick={loadTournaments}>
              刷新赛事
            </button>
          </>
        }
      >
        <p className="hint">
          只有状态为「已入库」的外部 Agent 能参赛。每一对 Agent 打 <code>gamesPerPair</code> 局
          （默认 2 局 = 双方各先手一次），平台跑完循环赛给出积分榜与每局回放。赛事创建后自动开跑，详情页会每 2 秒刷新进度。
          <br />
          赛图可以是内置地图，也可以是你在「地图编辑器」里做的自定义地图——上传校验会对注册表里的每一张图各跑一遍，只是换图不会让脚本突然挂掉。
        </p>

        {agentsError ? (
          <Banner tone="error">
            读取 Agent 列表失败：{agentsError}
            <div className="banner-hint">
              需要在「Agent 自助接入」页注册并成功上传过脚本；后端 <code>GET /api/agents</code> 不可用时无法发起赛事。
            </div>
          </Banner>
        ) : null}
        {agents === null && !agentsError ? <div className="hint">加载 Agent 列表…</div> : null}

        {agents && uploaded.length < 2 ? (
          <EmptyState
            title={agents.length === 0 ? "还没有注册任何 Agent" : `只有 ${uploaded.length} 个已入库 Agent`}
            hint="赛事至少需要 2 个「已入库」的 Agent。先去「Agent 自助接入」页注册拿一次性密钥，按任务文档写脚本并上传，校验通过后这里就能勾选了。"
          />
        ) : null}

        {agents && agents.length > 0 ? (
          <div className="pick-grid">
            {agents.map((a) => {
              const st = agentStatusInfo(a.status);
              const usable = a.status === "uploaded";
              const on = selected.includes(a.id);
              const order = selected.indexOf(a.id) + 1;
              return (
                <button
                  key={a.id}
                  className={`pick ${on ? "pick-on" : ""}`}
                  onClick={() => usable && toggle(a.id)}
                  disabled={!usable}
                  title={usable ? `${a.modelName} · ${a.thinkingLevel}` : `状态「${st.text}」不可参赛`}
                >
                  <span className="pick-head">
                    <span className={`pick-box ${on ? "on" : ""}`}>{on ? order : ""}</span>
                    <span className="pick-name">{a.agentName}</span>
                    <Badge tone={st.tone}>{st.text}</Badge>
                  </span>
                  <span className="pick-meta mono small">{a.modelName}</span>
                  <span className="pick-meta small">
                    思考等级 {a.thinkingLevel}
                    {usable ? "" : "（不可参赛）"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="config-grid">
          <label className="field">
            <span>每组对局数 gamesPerPair</span>
            <input
              type="number"
              min={2}
              value={gamesPerPair}
              onChange={(e) => setGamesPerPair(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>赛事名称（可空，留空由服务端命名）</span>
            <input value={name} placeholder="例如：10 月循环赛" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field field-wide">
            <span>
              赛图
              {onGotoEditor ? (
                <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={onGotoEditor}>
                  打开地图编辑器
                </button>
              ) : null}
            </span>
            <select value={mapId} onChange={(e) => setMapId(e.target.value)}>
              {maps.length === 0 ? <option value={mapId}>{mapId || "（地图列表不可用）"}</option> : null}
              {maps.map((m) => (
                <option key={m.mapId} value={m.mapId}>
                  {m.mapId}@{m.version}（{m.width}×{m.height}）{m.is1v1Default ? " · 1v1 默认" : ""}
                  {m.custom ? " · 自定义" : ""}
                  {m.errorCount ? ` · ⛔ ${m.errorCount} 项错误` : ""}
                </option>
              ))}
            </select>
            {maps.find((m) => m.mapId === mapId)?.hint ? (
              <span className="muted small">{maps.find((m) => m.mapId === mapId)!.hint}</span>
            ) : null}
          </label>
        </div>

        <div className="create-bar">
          <span className={`sel-count ${canCreate ? "ok" : "bad"}`}>
            已选 {selected.length} 个 Agent{canCreate ? "" : "（需至少 2 个已入库 Agent）"}
          </span>
          <button className="btn btn-primary btn-lg" onClick={create} disabled={creating || !canCreate}>
            {creating ? "创建中…" : "创建并开赛"}
          </button>
        </div>

        {createError ? <Banner tone="error">{createError}</Banner> : null}
      </Section>

      <Section title="赛事列表" extra={<span className="muted small">共 {tournaments?.length ?? 0} 个</span>}>
        {listError ? (
          <Banner tone="error">
            读取赛事列表失败：{listError}
            <div className="banner-hint">
              请确认后端已启动并实现了 <code>GET /api/tournaments</code>。已有赛事不会因为这次读取失败而丢失。
            </div>
          </Banner>
        ) : null}
        {listAction ? (
          <Banner tone={listAction.kind === "notice" ? "info" : "error"}>{listAction.text}</Banner>
        ) : null}
        {tournaments === null && !listError ? <div className="hint">加载中…</div> : null}

        {tournaments && tournaments.length === 0 && !listError ? (
          <EmptyState
            title="还没有赛事"
            hint="勾选至少 2 个已入库的 Agent，填好每组对局数，点「创建并开赛」——平台会自己跑完循环赛并把积分榜放在这里。"
          />
        ) : null}

        {tournaments && tournaments.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>状态</th>
                <th>参赛数</th>
                <th>对局数</th>
                <th>创建时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tournaments.map((t) => {
                const st = tournamentStatusInfo(t.status);
                return (
                  <tr key={t.id}>
                    <td>
                      {t.name || <span className="muted">（未命名）</span>}
                      {t.cohortId ? (
                        <Badge tone="muted" title={`评测批次 ${t.cohortId} 的第 ${(t.legIndex ?? 0) + 1} 轮`}>
                          批次 leg
                        </Badge>
                      ) : null}
                      <div className="mono tiny muted">{shortId(t.id)}</div>
                    </td>
                    <td>
                      <Badge tone={st.tone} title={t.error}>
                        {st.text}
                      </Badge>
                    </td>
                    <td>{t.agentCount}</td>
                    <td className="mono small">
                      {t.finishedMatches} / {t.matchCount}
                    </td>
                    <td className="small">{fmtTime(t.createdAt)}</td>
                    <td className="row-actions">
                      <button className="btn btn-sm btn-primary" onClick={() => openDetail(t.id)}>
                        查看详情
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => void remove(t)}
                        disabled={deletingId === t.id || deleteBlockedReason(t) !== null}
                        title={deleteBlockedReason(t) ?? "删除这场赛事及其全部对局（不可撤销）"}
                      >
                        {deletingId === t.id ? "删除中…" : "删除"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </Section>
    </div>
  );
}

/** 赛事详情：积分榜 + 对局列表；running/pending 时由父组件轮询驱动刷新 */
function TournamentDetailView({
  tournamentId,
  detail,
  error,
  loading,
  live,
  onBack,
  onDeleted,
  onReload,
  onOpen,
}: {
  tournamentId: string;
  detail: TournamentDetail | null;
  error: string | null;
  loading: boolean;
  live: boolean;
  onBack: () => void;
  /** 删除成功：父组件回到列表、刷新并把"已删除 N 局"的回执挂在列表上 */
  onDeleted: (notice: string) => void;
  onReload: () => void;
  onOpen: (page: "watch" | "replay" | "report", matchId: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 并列名次：rank 与相邻行相同即视为平局行，用底色 + 角标标出来，避免读表时看错位次
  const tieRows = useMemo(() => {
    const set = new Set<number>();
    if (!detail) return set;
    detail.standings.forEach((s, i) => {
      const prev = detail.standings[i - 1];
      const next = detail.standings[i + 1];
      if ((prev && prev.rank === s.rank) || (next && next.rank === s.rank)) set.add(i);
    });
    return set;
  }, [detail]);

  if (loading && !detail) return <div className="hint">正在读取赛事 {shortId(tournamentId)} …</div>;

  if (!detail) {
    return (
      <Section
        title={`赛事 ${shortId(tournamentId)}`}
        extra={
          <button className="btn" onClick={onBack}>
            返回赛事列表
          </button>
        }
      >
        <Banner tone="error">
          加载赛事详情失败：{error ?? "未知错误"}
          <div className="form-actions">
            <button className="btn" onClick={onReload}>
              重试
            </button>
          </div>
        </Banner>
      </Section>
    );
  }

  const t = detail.tournament;
  const st = tournamentStatusInfo(t.status);
  // 进度条要做除法：后端字段缺失时退化成 0，避免 NaN 把整页渲染搞崩
  const total = toCount(t.matchCount);
  const done = toCount(t.finishedMatches);
  // 与列表页同一套禁删理由；批次 leg 单独说一句，免得用户以为"删不了"
  const deleteBlockedReason = live
    ? "赛事正在跑：等它跑完再删"
    : t.cohortId
      ? `这是评测批次 ${shortId(t.cohortId)} 的第 ${(t.legIndex ?? 0) + 1} 轮：到「评测批次」页删除整个批次`
      : null;

  const removeSelf = async () => {
    const label = t.name || shortId(t.id);
    const games = toCount(t.matchCount) || toCount(t.finishedMatches);
    if (
      !window.confirm(
        `删除赛事「${label}」？\n\n它的 ${games} 局对局、回放、选手成绩与解说稿都会一并删除，排行榜里的这些成绩也会随之消失。\nAgent、密钥与地图不受影响。`,
      )
    ) {
      return;
    }
    setDeleteError(null);
    setDeleting(true);
    try {
      const { deleted } = await api.deleteTournament(t.id);
      onDeleted(`已删除「${label}」：${deleted.matches} 局对局、${deleted.replays} 份回放、${deleted.commentary} 份解说稿。`);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack">
      <div className="watch-head">
        <div className="watch-title">
          <span className="watch-name">{t.name || "（未命名赛事）"}</span>
          <Badge tone={st.tone}>{st.text}</Badge>
          <span className="mono small muted">{shortId(t.id)}</span>
          <span className="muted small">
            {t.mapId ? <>地图 <code>{t.mapId}</code> · </> : null}
            {t.scriptProtocolVersion ? <>脚本协议 {t.scriptProtocolVersion} · </> : null}
            {t.agentCount} 个 Agent · 每组 {t.gamesPerPair} 局 · 创建于 {fmtTime(t.createdAt)}
            {t.finishedAt ? ` · 结束于 ${fmtTime(t.finishedAt)}` : ""}
          </span>
        </div>
        <div className="watch-actions">
          <button className="btn" onClick={onReload} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void removeSelf()}
            disabled={deleting || deleteBlockedReason !== null}
            title={deleteBlockedReason ?? "删除这场赛事及其全部对局（不可撤销）"}
          >
            {deleting ? "删除中…" : "删除赛事"}
          </button>
          <button className="btn" onClick={onBack}>
            返回赛事列表
          </button>
        </div>
      </div>

      {error ? <Banner tone="warn">最近一次刷新失败（页面保留上一次数据）：{error}</Banner> : null}
      {deleteError ? <Banner tone="error">删除失败：{deleteError}</Banner> : null}
      {deleteBlockedReason ? <Banner tone="info">{deleteBlockedReason}</Banner> : null}
      {t.status === "failed" ? <Banner tone="error">赛事失败：{t.error ?? "服务端未给出原因"}</Banner> : null}

      <div className="detail-progress">
        <ProgressBar label="进度" value={done} max={total} hint={`${done} / ${total}`} />
        <span className="muted small">
          {live
            ? `进行中，每 ${POLL_MS / 1000} 秒自动刷新；已完成 ${done} / ${total} 局`
            : `已结束轮询：赛事状态为「${st.text}」`}
        </span>
      </div>

      <Section
        title="积分榜"
        extra={<span className="muted small">名次由服务端 rank 字段给出，同 rank 视为并列</span>}
      >
        {detail.standings.length === 0 ? (
          <div className="hint">赛事刚创建，还没有成绩。第一局跑完后积分榜就会出现在这里。</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>名次</th>
                  <th>Agent</th>
                  <th>模型</th>
                  <th>已赛</th>
                  <th>胜</th>
                  <th>平</th>
                  <th>负</th>
                  <th>积分</th>
                  <th>净胜分差</th>
                  <th>总得分</th>
                  <th>总提交单位</th>
                  <th>击杀</th>
                  <th>死亡</th>
                </tr>
              </thead>
              <tbody>
                {detail.standings.map((s: Standing, i) => {
                  const tie = tieRows.has(i);
                  return (
                    <tr key={s.agentId} className={tie ? "row-tie" : undefined}>
                      <td className="rank-cell">
                        {s.rank}
                        {tie ? <span className="tie-tag">并列</span> : null}
                      </td>
                      <td>{s.agentName}</td>
                      <td className="mono small">{s.modelName}</td>
                      <td className="mono">{s.played}</td>
                      <td className="mono">{s.wins}</td>
                      <td className="mono">{s.draws}</td>
                      <td className="mono">{s.losses}</td>
                      <td className="mono rank-points">{s.points}</td>
                      <td className={`mono ${s.scoreDiff > 0 ? "diff-up" : s.scoreDiff < 0 ? "diff-down" : ""}`}>
                        {s.scoreDiff > 0 ? `+${s.scoreDiff}` : s.scoreDiff}
                      </td>
                      <td className="mono">{s.totalScore}</td>
                      <td className="mono">{s.totalUnitsDeposited}</td>
                      <td className="mono">{s.kills}</td>
                      <td className="mono">{s.deaths}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="对局列表" extra={<span className="muted small">共 {detail.matches.length} 局</span>}>
        {detail.matches.length === 0 ? (
          <div className="hint">还没有已落库的对局记录；赛事跑起来后每完成一局都会出现在这里。</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>组别</th>
                <th>对阵</th>
                <th>比分</th>
                <th>胜者</th>
                <th>对局</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.matches.map((m) => {
                const ordered = [...m.seats].sort((a, b) => a.seat - b.seat);
                const scores = ordered.map((s) => s.score).join(" : ");
                const winner = m.winnerAgentId
                  ? ordered.find((s) => s.agentId === m.winnerAgentId)?.agentName ?? shortId(m.winnerAgentId)
                  : "平局";
                const seatDetail = ordered.map((s) => `P${s.seat} ${s.agentName} 得分 ${s.score}`).join(" · ");
                return (
                  <tr key={m.matchId}>
                    <td className="mono small">第 {m.index} 组</td>
                    <td>{m.pairLabel}</td>
                    <td className="mono" title={seatDetail}>
                      {scores}
                    </td>
                    <td>
                      {m.winnerAgentId ? (
                        <span className="winner">{winner}</span>
                      ) : (
                        <Badge tone="muted">平局</Badge>
                      )}
                    </td>
                    <td className="mono tiny muted">{shortId(m.matchId)}</td>
                    <td className="row-actions">
                      <button className="btn btn-sm btn-primary" onClick={() => onOpen("replay", m.matchId)}>
                        回放
                      </button>
                      <button className="btn btn-sm" onClick={() => onOpen("report", m.matchId)}>
                        战报
                      </button>
                      <button className="btn btn-sm" onClick={() => onOpen("watch", m.matchId)}>
                        观战
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}