// apps/web/src/api.ts —— 后端 REST 契约的类型与调用封装
//
// 平台只有一条参赛链路：外部 Agent 自助接入（注册 → 任务书 → 上传 zip → 赛事）。
// 因此这里没有"模型接入 Profile"与"新建对战"的契约——历史上那套接口已随功能一起删除。
import {
  BUILTIN_MAPS,
  DEFAULT_RULESET,
  type GameMap,
  type MatchEvent,
  type PlayerStats,
  type Ruleset,
} from "@ai-game/protocol";

const API_BASE = "/api";

// ---------------- 契约类型（与后端 DTO 一一对应） ----------------

/** 对局状态：赛事跑完即落库，所以只会出现这四种 */
export type MatchStatus = "created" | "running" | "finished" | "failed";

export type MatchSummary = {
  id: string;
  status: MatchStatus;
  mapId: string;
  mapVersion: number;
  rulesetVersion: string;
  scriptProtocolVersion: string;
  seed: number;
  seatCount: number;
  turnIntervalMs: number;
  reproducibilityKey: string;
  createdAt: string;
  endedAt?: string;
  error?: string;
};

export type MatchPlayer = {
  seat: number;
  /** 参赛 Agent 的 id（赛事对局才有） */
  agentId?: string;
  /** Agent 声明的模型名 */
  modelId: string;
  name: string;
  status: string; // OK | STRIKES_EXCEEDED
  validation: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
  script?: string;
  scriptSha256?: string;
  finalScore?: number;
  rank?: number;
  stats?: Record<string, number | boolean>;
};

export type LeaderboardRow = {
  modelId: string;
  matches: number;
  avgScore: number;
  wins: number;
  scriptOkRate: number;
  avgInvalidActions: number;
  avgStrikes: number;
};

export type MapListItem = {
  mapId: string;
  version: number;
  width: number;
  height: number;
  hint?: string;
  is1v1Default?: boolean;
  /** 编辑器保存的自定义地图 */
  custom?: boolean;
  errorCount?: number;
  warningCount?: number;
  spawns?: number;
};

/** 地图审计结论（与 engine.auditMap 的输出同构） */
export type MapAudit = {
  mapId: string;
  version: number;
  errors: string[];
  warnings: string[];
  stats: {
    width: number; height: number; walkable: number;
    wall: number; water: number; forest: number;
    spawns: number; ammoDepots: number; fuelStations: number; resourceNodes: number; depositPoints: number;
  };
  distances: Record<string, number>;
  spawnDistances: number[];
};

export type MapDetail = { map: GameMap; ascii: string; audit: MapAudit; custom: boolean };

export type PlaytestResult = {
  ok: boolean;
  mapId: string;
  seed: number;
  rounds: number;
  spawns: { seat: number; pos: { x: number; y: number } }[];
  combat: { fires: number; hits: number; kills: number; firstFireRound: number | null; turns: number };
  economy: { unitsDeposited: number; invalidActions: number; strikes: number };
  ranking: {
    seat: number; name: string; score: number; rank: number; unitsDeposited: number;
    kills: number; deaths: number; shotsFired: number; hits: number; avgDecisionMs: number;
  }[];
  verdicts: string[];
};

// ---------------- 外部 Agent 自助接入 ----------------

export type ThinkingLevel = "low" | "medium" | "high" | "xhigh";
export type AgentStatus = "registered" | "uploaded" | "rejected";

/** 上传校验的分阶段结论：解压 / 静态扫描 / 编译 / 模糊 / 冒烟 */
export type AgentValidationStep = { stage: string; mapId?: string; ok: boolean; detail?: string };

export type Agent = {
  id: string;
  modelName: string;
  agentName: string;
  thinkingLevel: ThinkingLevel;
  notes: string;
  status: AgentStatus;
  /** 形如 ag_****abcd；明文密钥只在注册/重发响应里出现一次 */
  keyMasked: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  uploadedAt?: string;
  scriptSha256?: string;
  zipBytes?: number;
  validation?: AgentValidationStep[];
  rejectReason?: string;
};

export type UploadLimits = {
  zipMaxBytes: number;
  maxEntries: number;
  maxUncompressedBytes: number;
  maxRatio: number;
  maxScriptLines: number;
  maxUploadAttempts: number;
};

export type AgentRegisterInput = {
  modelName: string;
  agentName: string;
  thinkingLevel: ThinkingLevel;
  notes?: string;
};

export type AgentRegisterResult = {
  agent: Agent;
  /** 仅此一次返回 */
  key: string;
  /** 脚本协议版本（任务书 §5 协议正文的版本号） */
  protocolVersion: string;
  /** 任务书 URL（与地图无关：赛图开赛时才确定，任务书只给通用地图规范） */
  taskDocUrl: string;
  uploadUrl: string;
  limits: UploadLimits;
};

export type AgentReissueResult = { agent: Agent; key: string };

export type TaskDocJson = {
  version: string;
  protocolVersion: string;
  markdown: string;
  endpoints: { register: string; upload: string; taskDoc: string; tournaments: string };
  limits: UploadLimits;
};

// ---------------- 赛事（1v1 循环赛） ----------------

export type TournamentStatus = "pending" | "running" | "finished" | "failed";

export type TournamentSummary = {
  id: string;
  name: string;
  status: TournamentStatus;
  agentCount: number;
  matchCount: number;
  finishedMatches: number;
  gamesPerPair: number;
  mapId?: string;
  scriptProtocolVersion?: string;
  createdAt: string;
  finishedAt?: string;
  error?: string;
};

export type CreateTournamentInput = {
  agentIds: string[];
  gamesPerPair?: number;
  name?: string;
  seed?: number;
  /** 赛图：可以是内置地图，也可以是编辑器保存的自定义地图 */
  mapId?: string;
  maxRounds?: number;
};

export type Standing = {
  rank: number;
  agentId: string;
  agentName: string;
  modelName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  scoreDiff: number;
  totalScore: number;
  totalUnitsDeposited: number;
  kills: number;
  deaths: number;
};

export type TournamentMatch = {
  matchId: string;
  index: number;
  pairLabel: string;
  seats: { seat: number; agentId: string; agentName: string; score: number; rank: number }[];
  winnerAgentId: string | null;
  replayUrl: string;
  reportUrl: string;
  status?: MatchStatus;
};

export type TournamentDetail = {
  tournament: TournamentSummary;
  standings: Standing[];
  matches: TournamentMatch[];
};

export type WsMessage =
  | {
      type: "snapshot";
      data: { match: MatchSummary; players: MatchPlayer[]; events: MatchEvent[]; ranking: PlayerStats[]; status?: MatchStatus };
    }
  | {
      type: "phase";
      data: { phase: MatchStatus; detail?: string; players?: MatchPlayer[] };
    }
  | { type: "event"; data: MatchEvent }
  | { type: "scores"; data: { ranking: PlayerStats[] } }
  | { type: "end"; data: { ranking: PlayerStats[] } };

// ---------------- 基础 fetch 封装 ----------------

export class ApiError extends Error {
  readonly status: number;
  /** 后端返回的结构化附加信息（例如地图审计结论） */
  readonly payload: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // 后端没起来时 fetch 直接抛 TypeError：统一成可展示的文案，页面只需渲染 message
    throw new ApiError(`无法连接后端 ${API_BASE}${path}（后端是否已启动？）: ${errText(err)}`, 0);
  }
  if (res.status === 401) {
    // 会话过期/未登录：后端对页面请求会 302，但 XHR 只能拿到 401——这里统一送去登录页
    redirectToLogin();
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let payload: unknown = undefined;
    try { payload = JSON.parse(raw); } catch { /* 非 JSON 错误体 */ }
    throw new ApiError(`${method} ${API_BASE}${path} 失败（HTTP ${res.status}）${extractDetail(raw)}`, res.status, payload);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 跳登录页并带上回跳地址（已在登录页就不跳，避免循环） */
function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.replace(`/login?next=${next}`);
}

/** 退出登录：让服务端作废会话并清 Cookie，然后回登录页 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST" });
  } finally {
    if (typeof window !== "undefined") window.location.replace("/login");
  }
}

/** 当前登录用户（未登录时 request() 会把人送去登录页） */
export function whoami(): Promise<{ user: string; expiresAt: string }> {
  return request<{ user: string; expiresAt: string }>("GET", "/auth/me");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractDetail(raw: string): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { message?: string; error?: string; detail?: string };
    const msg = parsed.message ?? parsed.error ?? parsed.detail;
    if (msg) return `：${msg.slice(0, 300)}`;
  } catch {
    // 非 JSON 错误体（例如纯文本 502 页面），保留原文
  }
  return `：${raw.slice(0, 300)}`;
}

/** 文本响应（任务书 / 战报 Markdown） */
async function requestText(path: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(`无法连接后端 ${API_BASE}${path}（后端是否已启动？）: ${errText(err)}`, 0);
  }
  if (!res.ok) throw new ApiError(`GET ${API_BASE}${path} 失败（HTTP ${res.status}）`, res.status);
  return await res.text();
}

// ---------------- REST 调用 ----------------

export const api = {
  health: () => request<{ ok: boolean; version: string; maps: string[]; builtinMaps: string[]; defaultMap1v1: string }>("GET", "/health"),

  // —— 地图
  listMaps: () => request<MapListItem[]>("GET", "/maps"),
  getMap: (mapId: string) => request<MapDetail>("GET", `/maps/${encodeURIComponent(mapId)}`),
  listSkippedMaps: () => request<{ skipped: { file: string; reason: string }[] }>("GET", "/maps/skipped"),
  /** 编辑器：只校验不落盘（实时提示用） */
  validateMapDraft: (map: GameMap) =>
    request<{ ok: boolean; mapId: string; audit: MapAudit }>("POST", "/maps/validate", map),
  /** 编辑器：校验并保存（errors 非空会被拒） */
  saveMap: (map: GameMap) =>
    request<{ ok: true; mapId: string; audit: MapAudit }>("POST", "/maps", map),
  deleteMap: (mapId: string) => request<{ ok: true }>("DELETE", `/maps/${encodeURIComponent(mapId)}`),
  /** 编辑器：拿基线脚本在自己的地图上试跑一局 */
  playtestMap: (input: { map?: GameMap; mapId?: string; seed?: number; maxRounds?: number }) =>
    request<PlaytestResult>("POST", "/maps/playtest", input),

  getRuleset: (version: string) => request<Ruleset>("GET", `/rulesets/${encodeURIComponent(version)}`),

  // —— 对局（只读：赛事跑完即落库）
  listMatches: () => request<MatchSummary[]>("GET", "/matches"),
  getMatch: (id: string) =>
    request<{ match: MatchSummary; players: MatchPlayer[]; ranking: PlayerStats[] }>(
      "GET",
      `/matches/${encodeURIComponent(id)}`,
    ),
  getReplay: (id: string) =>
    request<{ match: MatchSummary; players: MatchPlayer[]; events: MatchEvent[]; ranking: PlayerStats[] }>(
      "GET",
      `/matches/${encodeURIComponent(id)}/replay`,
    ),
  getReport: (id: string) => requestText(`/matches/${encodeURIComponent(id)}/report`),
  /** 同配置再战：让这场对局的双方用新种子再打一组（新赛事，攻守互换） */
  rematch: (id: string) =>
    request<{ tournamentId: string; matchIds: string[]; seed: number; mapId: string }>(
      "POST",
      `/matches/${encodeURIComponent(id)}/rematch`,
    ),
  leaderboard: () => request<{ rows: LeaderboardRow[] }>("GET", "/leaderboard"),

  // —— 外部 Agent 自助接入：注册/列表/重发密钥/删除 + 任务文档
  // 注意：registerAgent / reissueAgentKey 的响应里含明文 key，页面只在内存里持有，不落 localStorage。
  listAgents: () => request<{ agents: Agent[] }>("GET", "/agents"),
  registerAgent: (input: AgentRegisterInput) => request<AgentRegisterResult>("POST", "/agents", input),
  reissueAgentKey: (id: string) =>
    request<AgentReissueResult>("POST", `/agents/${encodeURIComponent(id)}/reissue`),
  deleteAgent: (id: string) => request<{ ok: true }>("DELETE", `/agents/${encodeURIComponent(id)}`),
  getTaskDoc: () => requestText("/task-doc"),
  getTaskDocJson: () => request<TaskDocJson>("GET", "/task-doc?format=json"),

  // —— 赛事（1v1 循环赛）
  listTournaments: () => request<{ tournaments: TournamentSummary[] }>("GET", "/tournaments"),
  createTournament: (input: CreateTournamentInput) =>
    request<{ tournamentId: string; seed: number; mapId: string }>("POST", "/tournaments", input),
  getTournament: (id: string) => request<TournamentDetail>("GET", `/tournaments/${encodeURIComponent(id)}`),
  getTournamentReport: (id: string) => requestText(`/tournaments/${encodeURIComponent(id)}/report`),
};

// ---------------- 组合加载：页面渲染战场前需要 (map, rules) ----------------

export interface MatchBundle {
  match: MatchSummary;
  players: MatchPlayer[];
  ranking: PlayerStats[];
  map: GameMap;
  rules: Ruleset;
  /** 降级说明：后端某接口不可用时前端用了内置数据，界面上会提示口径 */
  degraded: string[];
}

export interface ReplayBundle extends MatchBundle {
  events: MatchEvent[];
}

/**
 * 地图/规则优先取后端（后端可能升版），失败则退回 workspace 内置数据。
 * 自定义地图没有内置副本，后端不可用时只能报错——这比画出一张错的图要诚实。
 */
async function resolveMap(mapId: string, degraded: string[]): Promise<GameMap> {
  try {
    const { map } = await api.getMap(mapId);
    return map;
  } catch (err) {
    const local = BUILTIN_MAPS[mapId];
    if (local) {
      degraded.push(`地图接口不可用，使用内置 ${mapId}@${local.version}（${errText(err)}）`);
      return local;
    }
    throw err;
  }
}

async function resolveRules(version: string, degraded: string[]): Promise<Ruleset> {
  try {
    return await api.getRuleset(version);
  } catch (err) {
    degraded.push(`规则接口不可用，使用内置规则 ${DEFAULT_RULESET.version}（${errText(err)}）`);
    return DEFAULT_RULESET;
  }
}

async function baseBundle(matchId: string): Promise<MatchBundle> {
  const { match, players, ranking } = await api.getMatch(matchId);
  const degraded: string[] = [];
  const [map, rules] = await Promise.all([
    resolveMap(match.mapId, degraded),
    resolveRules(match.rulesetVersion, degraded),
  ]);
  return { match, players, ranking, map, rules, degraded };
}

export const bundles = {
  match: baseBundle,
  async replay(matchId: string): Promise<ReplayBundle> {
    const { match, players, events, ranking } = await api.getReplay(matchId);
    const degraded: string[] = [];
    const [map, rules] = await Promise.all([
      resolveMap(match.mapId, degraded),
      resolveRules(match.rulesetVersion, degraded),
    ]);
    return { match, players, events, ranking, map, rules, degraded };
  },
};