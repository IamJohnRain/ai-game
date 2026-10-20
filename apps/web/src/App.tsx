// apps/web/src/App.tsx —— 单页应用外壳：顶部导航 + 页面切换 + 后端健康状态
// 刻意不引入路由库：页面之间只有"当前页 + 当前比赛/赛事 id"这点状态，useState 足够且刷新语义可控。
// 导航只反映平台的唯一参赛链路：Agent 自助接入 → 赛事 → 观战/回放/战报，外加地图编辑器。
import { useEffect, useState } from "react";
import { api, logout, whoami, type MatchSummary } from "./api";
import { AgentsPage } from "./pages/AgentsPage";
import { TournamentPage } from "./pages/TournamentPage";
import { WatchPage } from "./pages/WatchPage";
import { ReplayPage } from "./pages/ReplayPage";
import { ReportPage } from "./pages/ReportPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { CohortsPage } from "./pages/CohortsPage";
import { MapEditorPage } from "./pages/MapEditorPage";
import { Badge, Banner, EmptyState, Section, fmtTime, matchStatusInfo, shortId } from "./ui";

export type Nav =
  | { page: "agents" }
  | { page: "cohorts"; cohortId: string | null }
  | { page: "tournament"; tournamentId: string | null }
  | { page: "watch"; matchId: string | null }
  | { page: "replay"; matchId: string | null }
  | { page: "report"; matchId: string | null }
  | { page: "board" }
  | { page: "editor" };

const NAV_ITEMS: { key: Nav["page"]; label: string }[] = [
  { key: "agents", label: "Agent 自助接入" },
  { key: "cohorts", label: "评测批次" },
  { key: "tournament", label: "赛事" },
  { key: "watch", label: "实时观战" },
  { key: "replay", label: "回放" },
  { key: "report", label: "战报" },
  { key: "board", label: "排行榜" },
  { key: "editor", label: "地图编辑器" },
];

export function App() {
  const [nav, setNav] = useState<Nav>({ page: "agents" });
  /** 记住最近一次进入的比赛，切页时不必重新选 */
  const [lastMatchId, setLastMatchId] = useState<string | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; version: string } | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  /** 当前登录用户（顶栏展示 + 退出登录）；未登录时 whoami 会 401，api.ts 直接把人送去登录页 */
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    whoami()
      .then((me) => {
        if (alive) setUser(me.user);
      })
      .catch(() => {
        /* 401 已由 api.ts 送去登录页，这里不用再报错 */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (alive) setHealth(h);
      })
      .catch((err: unknown) => {
        if (alive) setHealthError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const go = (target: { page: Nav["page"]; matchId?: string | null; tournamentId?: string | null }) => {
    if (target.matchId) setLastMatchId(target.matchId);
    switch (target.page) {
      case "agents":
      case "board":
      case "editor":
        setNav({ page: target.page });
        break;
      case "cohorts":
        setNav({ page: "cohorts", cohortId: null });
        break;
      case "tournament":
        setNav({ page: "tournament", tournamentId: target.tournamentId ?? null });
        break;
      case "watch":
      case "replay":
      case "report":
        setNav({ page: target.page, matchId: target.matchId ?? null });
        break;
    }
  };

  const openMatch = (page: "watch" | "replay" | "report", matchId: string) => go({ page, matchId });

  const activeKey = nav.page;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">AI</span>
          <span className="brand-text">坦克对战平台 · 观战台</span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => {
            const needsMatch = item.key === "watch" || item.key === "replay" || item.key === "report";
            return (
              <button
                key={item.key}
                className={`nav-item ${activeKey === item.key ? "nav-on" : ""}`}
                onClick={() => go({ page: item.key, matchId: needsMatch ? lastMatchId : null })}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="health">
          {health ? (
            <Badge tone="ok">后端在线 v{health.version}</Badge>
          ) : healthError ? (
            <Badge tone="danger" title={healthError}>
              后端离线
            </Badge>
          ) : (
            <Badge tone="muted">检测后端…</Badge>
          )}
          {user ? <span className="muted small" title="当前登录账号">已登录 {user}</span> : null}
          {user ? (
            <button className="btn btn-sm" onClick={() => void logout()}>
              退出登录
            </button>
          ) : null}
        </div>
      </header>

      <main className="page">
        {healthError ? (
          <Banner tone="error">
            连接后端失败：{healthError}
            <div className="banner-hint">
              观战台需要 <code>apps/server</code> 在 <code>127.0.0.1:8787</code> 上运行；开发模式下 Vite 会把
              <code>/api</code> 与 <code>/ws</code> 代理过去。后端未启动时，页面仍可浏览，内置地图与规则会退化为本地数据。
            </div>
          </Banner>
        ) : null}

        {nav.page === "agents" ? <AgentsPage onGotoTournament={(id) => go({ page: "tournament", tournamentId: id ?? null })} /> : null}

        {nav.page === "cohorts" ? (
          <CohortsPage onOpenTournament={(id) => go({ page: "tournament", tournamentId: id })} />
        ) : null}

        {nav.page === "tournament" ? (
          <TournamentPage initialId={nav.tournamentId} onOpen={openMatch} onGotoEditor={() => go({ page: "editor" })} />
        ) : null}

        {nav.page === "watch" ? (
          nav.matchId ? (
            <WatchPage
              key={nav.matchId}
              matchId={nav.matchId}
              onOpen={openMatch}
              onGotoTournament={(id) => go({ page: "tournament", tournamentId: id ?? null })}
            />
          ) : (
            <MatchPicker
              title="选择要观战的比赛"
              onPick={(id) => openMatch("watch", id)}
              onGotoTournament={() => go({ page: "tournament" })}
            />
          )
        ) : null}

        {nav.page === "replay" ? (
          nav.matchId ? (
            <ReplayPage key={nav.matchId} matchId={nav.matchId} initialMatchId={lastMatchId} onOpen={openMatch} />
          ) : (
            <MatchPicker
              title="选择要回放的比赛"
              onPick={(id) => openMatch("replay", id)}
              onGotoTournament={() => go({ page: "tournament" })}
            />
          )
        ) : null}

        {nav.page === "report" ? (
          nav.matchId ? (
            <ReportPage key={nav.matchId} matchId={nav.matchId} onOpen={openMatch} />
          ) : (
            <MatchPicker
              title="选择要查看战报的比赛"
              onPick={(id) => openMatch("report", id)}
              onGotoTournament={() => go({ page: "tournament" })}
            />
          )
        ) : null}

        {nav.page === "board" ? <LeaderboardPage /> : null}

        {nav.page === "editor" ? <MapEditorPage /> : null}
      </main>

      <footer className="footer">
        <span>外部 Agent 上传脚本，服务端五道准入闸（解压/静态/编译/模糊/冒烟）后入库，赛中由 QuickJS 沙箱执行，事件流可复现。</span>
        <span>种子与脚本 SHA256 全程公开，观战支持上帝视角与单座位迷雾视角。</span>
      </footer>
    </div>
  );
}

/** 没有指定比赛时的选择器：直接列出历史比赛，点一行进入 */
function MatchPicker({
  title,
  onPick,
  onGotoTournament,
}: {
  title: string;
  onPick: (matchId: string) => void;
  onGotoTournament: () => void;
}) {
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listMatches()
      .then((list) => {
        if (alive) setMatches(list);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Section title={title} extra={<button className="btn" onClick={onGotoTournament}>去赛事页发起比赛</button>}>
      {error ? <Banner tone="error">读取比赛列表失败：{error}</Banner> : null}
      {matches === null && !error ? <div className="hint">加载中…</div> : null}
      {matches && matches.length === 0 ? (
        <EmptyState
          title="还没有任何比赛"
          hint="比赛由赛事产生：先去「Agent 自助接入」注册并上传脚本，再到「赛事」页勾选 2 个以上 Agent 发起 1v1 循环赛。"
        />
      ) : null}
      {matches && matches.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>比赛</th>
              <th>状态</th>
              <th>地图</th>
              <th>座位</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {matches.map((m) => {
              const st = matchStatusInfo(m.status);
              return (
                <tr key={m.id}>
                  <td className="mono">{shortId(m.id)}</td>
                  <td>
                    <Badge tone={st.tone}>{st.text}</Badge>
                  </td>
                  <td>
                    {m.mapId}@{m.mapVersion}
                  </td>
                  <td>{m.seatCount}</td>
                  <td>{fmtTime(m.createdAt)}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => onPick(m.id)}>
                      选择
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </Section>
  );
}