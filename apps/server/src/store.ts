// apps/server/src/store.ts —— SQLite 存储（node:sqlite，零原生依赖）
// 表结构对应文档 §6。平台只有一条参赛链路：外部 Agent 上传脚本 → 赛事对局 → 回放/战报/排行榜，
// 因此库里只存 Agent、赛事、对局、回放四类数据（历史上"模型接入 Profile / 提示词留档"两张表已不再使用，
// 老库里的 profiles / match_prompts 表可以手工 DROP，服务端不会再读写它们）。
import { DatabaseSync } from "node:sqlite";
import type { MatchEvent, MatchResult, PlayerStats } from "@ai-game/protocol";
import type { CheckStatus } from "@ai-game/script-check";

export type MatchStatus = "created" | "running" | "finished" | "failed";

export interface MatchRow {
  id: string;
  status: MatchStatus;
  mapId: string;
  mapVersion: number;
  rulesetVersion: string;
  scriptProtocolVersion: string;
  seed: number;
  seatCount: number;
  turnIntervalMs: number;
  config: Record<string, unknown>;
  reproducibilityKey: string;
  error?: string;
  createdAt: string;
  endedAt?: string;
  ranking?: PlayerStats[];
}
export interface MatchPlayerRow {
  seat: number;
  /** 参赛 Agent 的 id（赛事对局才有） */
  agentId?: string;
  /** Agent 声明的模型名（仅用于展示与排行榜聚合） */
  modelId: string;
  name: string;
  status: CheckStatus;
  validation: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
  script?: string;
  scriptSha256?: string;
  finalScore?: number;
  rank?: number;
  stats?: Record<string, unknown>;
  /** 参赛时用的脚本版本（批次评测用来把成绩归因到版本） */
  revision?: number;
}
export type AgentStatus = "registered" | "uploaded" | "rejected";

export interface AgentRow {
  id: string; modelName: string; agentName: string; thinkingLevel: string; notes: string;
  status: AgentStatus; keyMasked: string; attempts: number; maxAttempts: number;
  createdAt: string; uploadedAt?: string;
  scriptSha256?: string; zipBytes?: number;
  validation?: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
  rejectReason?: string;
  /** 已提交的脚本版本数（0 = 还没交过；每次成功上传 +1） */
  revision: number;
  /** 成功那次上传时已经失败的次数（0 = 一次过） */
  attemptsAtUpload: number;
  /** 练习通道：已用次数 / 上限 */
  practiceRuns: number; maxPracticeRuns: number;
}

export interface TournamentRow {
  id: string; name: string; status: "pending" | "running" | "finished" | "failed";
  seed: number; gamesPerPair: number; mapId: string; rulesetVersion: string; scriptProtocolVersion: string;
  agentIds: string[]; matchIds: string[]; standings?: unknown; error?: string;
  createdAt: string; finishedAt?: string;
  /** 批次（评测）归属：旧赛事为 undefined，行为与原来一致 */
  cohortId?: string;
  legIndex?: number;
  leg?: { name: string; mapId: string; maxRounds: number; rulesVariant: string };
}

export type CohortStatus = "pending" | "running" | "finished" | "finished_with_errors" | "failed" | "stopped";

/** 一个评测批次：一组参赛者 + 一份 leg 计划 + 一份冻结的参赛版本快照 */
export interface CohortRow {
  id: string; name: string; status: CohortStatus;
  masterSeed: number; gamesPerPair: number;
  agentIds: string[];
  plan: { gamesPerPair: number; legs: { name: string; mapId: string; maxRounds: number; rulesVariant: string; seeds?: number }[] };
  snapshot: { agentId: string; agentName: string; modelName: string; revision: number; scriptSha256: string; calibration?: boolean; resolvedBy?: string }[];
  ratings?: unknown;
  matrix?: unknown;
  metrics?: unknown;
  error?: string;
  createdAt: string; finishedAt?: string;
}

export interface AgentRevisionRow {
  revision: number; scriptSha256: string; zipBytes?: number;
  attemptsAtUpload: number; uploadedAt: string;
  meta?: unknown;
  validation?: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
}

export interface PracticeRunRow {
  id: string; agentId: string; createdAt: string;
  ok: boolean; stage?: string; detail?: string;
  stages?: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
  practice?: unknown;
  sourceIp?: string;
}

/** 批次聚合用的"一局"视图：只有参赛双方与比分 */
export interface CohortMatchRow {
  matchId: string; legIndex: number; status: MatchStatus; mapId: string; rulesetVersion: string; seed: number;
  seats: { seat: number; agentId: string; modelId: string; score: number; rank: number; revision?: number; stats?: Record<string, unknown> }[];
}

export interface LeaderboardRow {
  modelId: string;
  matches: number;
  avgScore: number;
  wins: number;
  scriptOkRate: number;
  avgInvalidActions: number;
  avgStrikes: number;
  /** ↓ 过程分（docs/08 §4.1）：全部按每回合/每单位归一到 0~1 或"每百回合" */
  avgInvalidRate: number;
  avgEmergencyRate: number;
  avgUnitsPer100: number;
  avgKillDeathDiff: number;
  avgDecisionMs: number;
  maxDecisionMs: number;
  /** 补给花费 / 得分：只在有产出的对局上统计（没有任何产出时为 null，见 zeroOutputRate） */
  avgSupplyShare: number | null;
  /** "一局都没提交也没击杀"的比例：指标不可算的原因，本身也是信号 */
  zeroOutputRate: number;
  disqualifiedRate: number;
  /** 需要 agents 关联的字段：没有任何 Agent 记录时为 null（老数据/已删除 Agent） */
  firstTryRate: number | null;
  avgRevisions: number | null;
  avgPracticeRuns: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL,
  map_id TEXT NOT NULL, map_version INTEGER NOT NULL, ruleset_version TEXT NOT NULL,
  script_protocol_version TEXT NOT NULL,
  seed INTEGER NOT NULL, seat_count INTEGER NOT NULL, turn_interval_ms INTEGER NOT NULL,
  config_json TEXT NOT NULL, reproducibility_key TEXT NOT NULL DEFAULT '', result_json TEXT, report_md TEXT,
  error TEXT, created_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL, seat INTEGER NOT NULL, agent_id TEXT, model_id TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL, validation_json TEXT NOT NULL DEFAULT '[]', script TEXT, script_sha256 TEXT,
  meta_json TEXT, final_score INTEGER, rank INTEGER, stats_json TEXT,
  PRIMARY KEY (match_id, seat)
);
CREATE TABLE IF NOT EXISTS match_replays (match_id TEXT PRIMARY KEY, events BLOB NOT NULL, ranking_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, model_name TEXT NOT NULL, agent_name TEXT NOT NULL,
  thinking_level TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL, key_masked TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL, uploaded_at TEXT,
  script TEXT, script_sha256 TEXT, zip_sha256 TEXT, zip_bytes INTEGER,
  meta_json TEXT, validation_json TEXT, reject_reason TEXT
);
CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
  seed INTEGER NOT NULL, games_per_pair INTEGER NOT NULL,
  map_id TEXT NOT NULL, ruleset_version TEXT NOT NULL, script_protocol_version TEXT NOT NULL,
  agent_ids_json TEXT NOT NULL, match_ids_json TEXT NOT NULL DEFAULT '[]',
  standings_json TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS cohorts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
  master_seed INTEGER NOT NULL, games_per_pair INTEGER NOT NULL,
  agent_ids_json TEXT NOT NULL, plan_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
  ratings_json TEXT, matrix_json TEXT, metrics_json TEXT, error TEXT,
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS practice_runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
  ok INTEGER NOT NULL, stage TEXT, detail TEXT, stages_json TEXT, practice_json TEXT, source_ip TEXT
);
CREATE TABLE IF NOT EXISTS agent_revisions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, revision INTEGER NOT NULL,
  script TEXT NOT NULL, script_sha256 TEXT NOT NULL, zip_sha256 TEXT, zip_bytes INTEGER,
  meta_json TEXT, validation_json TEXT, attempts_at_upload INTEGER NOT NULL DEFAULT 0,
  source_ip TEXT, uploaded_at TEXT NOT NULL,
  UNIQUE (agent_id, revision)
);
`;

export class Store {
  private db: DatabaseSync;
  constructor(private dbPath: string, private masterKey: Buffer) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * 兼容早期库：列名与语义变化按需就地迁移。
   * ADD/RENAME COLUMN 重复执行会报错，这里直接吞掉——迁移是幂等的。
   */
  private migrate(): void {
    try { this.db.exec("ALTER TABLE matches ADD COLUMN report_md TEXT"); } catch { /* 列已存在 */ }
    // 早期版本把这两个字段叫 prompt_version（平台当时自己调用大模型生成脚本）
    try { this.db.exec("ALTER TABLE matches RENAME COLUMN prompt_version TO script_protocol_version"); } catch { /* 已迁移 */ }
    try { this.db.exec("ALTER TABLE tournaments RENAME COLUMN prompt_version TO script_protocol_version"); } catch { /* 已迁移 */ }
    // match_players.profile_id 现在存的是参赛 Agent 的 id
    try { this.db.exec("ALTER TABLE match_players RENAME COLUMN profile_id TO agent_id"); } catch { /* 已迁移 */ }
    // ---- 评测批次（docs/08）：赛事归属批次；参赛者的脚本版本、练习与过程分字段 ----
    try { this.db.exec("ALTER TABLE tournaments ADD COLUMN cohort_id TEXT"); } catch { /* 列已存在 */ }
    try { this.db.exec("ALTER TABLE tournaments ADD COLUMN leg_index INTEGER"); } catch { /* 列已存在 */ }
    try { this.db.exec("ALTER TABLE tournaments ADD COLUMN leg_json TEXT"); } catch { /* 列已存在 */ }
    try { this.db.exec("ALTER TABLE agents ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"); } catch { /* 列已存在 */ }
    try { this.db.exec("ALTER TABLE agents ADD COLUMN attempts_at_upload INTEGER NOT NULL DEFAULT 0"); } catch { /* 列已存在 */ }
    try { this.db.exec("ALTER TABLE agents ADD COLUMN practice_runs INTEGER NOT NULL DEFAULT 0"); } catch { /* 列已存在 */ }
    try { this.db.exec("ALTER TABLE agents ADD COLUMN max_practice_runs INTEGER NOT NULL DEFAULT 5"); } catch { /* 列已存在 */ }
    try { this.db.exec("ALTER TABLE match_players ADD COLUMN revision INTEGER"); } catch { /* 列已存在 */ }
  }

  close(): void { this.db.close(); }

  // ---------------- matches ----------------
  createMatch(input: {
    id: string; status: MatchStatus; mapId: string; mapVersion: number; rulesetVersion: string;
    scriptProtocolVersion: string; seed: number; seatCount: number; turnIntervalMs: number;
    config: Record<string, unknown>;
  }): MatchRow {
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO matches (id, status, map_id, map_version, ruleset_version, script_protocol_version, seed, seat_count, turn_interval_ms, config_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.status, input.mapId, input.mapVersion, input.rulesetVersion, input.scriptProtocolVersion,
      input.seed, input.seatCount, input.turnIntervalMs, JSON.stringify(input.config), createdAt,
    );
    for (let seat = 1; seat <= input.seatCount; seat++) {
      this.db.prepare(`INSERT INTO match_players (match_id, seat, model_id, name, status) VALUES (?, ?, '', '', 'OK')`)
        .run(input.id, seat);
    }
    return this.getMatch(input.id)!;
  }

  listMatches(limit = 50): MatchRow[] {
    const rows = this.db.prepare("SELECT * FROM matches ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(toMatchRow);
  }

  getMatch(id: string): MatchRow | null {
    const row = this.db.prepare("SELECT * FROM matches WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toMatchRow(row) : null;
  }

  setMatchStatus(id: string, status: MatchStatus, extra: { error?: string; reproducibilityKey?: string; endedAt?: string; ranking?: PlayerStats[] } = {}): void {
    const cur = this.getMatch(id);
    if (!cur) return;
    this.db.prepare("UPDATE matches SET status=?, error=?, reproducibility_key=?, ended_at=?, result_json=? WHERE id=?").run(
      status,
      extra.error ?? cur.error ?? null,
      extra.reproducibilityKey ?? cur.reproducibilityKey,
      extra.endedAt ?? cur.endedAt ?? null,
      extra.ranking ? JSON.stringify({ ranking: extra.ranking }) : null,
      id,
    );
  }

  /**
   * 部分更新某个座位（只写传入的字段）。
   * 注意：不能写成"全字段 UPDATE + 未传字段填空"，否则赛后更新得分时会把脚本/哈希清成 NULL。
   */
  savePlayer(matchId: string, seat: number, data: {
    agentId?: string; modelId?: string; name?: string; status?: CheckStatus;
    validation?: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
    script?: string; scriptSha256?: string;
    meta?: unknown; finalScore?: number; rank?: number; stats?: Record<string, unknown>;
    revision?: number;
  }): void {
    const columns: Record<string, string> = {
      agentId: "agent_id", modelId: "model_id", name: "name", status: "status",
      validation: "validation_json", script: "script", scriptSha256: "script_sha256",
      meta: "meta_json", finalScore: "final_score", rank: "rank", stats: "stats_json",
      revision: "revision",
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in data)) continue;
      const raw = (data as Record<string, unknown>)[key];
      let value: string | number | null;
      if (raw === undefined || raw === null) value = null;
      else if (key === "validation" || key === "meta" || key === "stats") value = JSON.stringify(raw);
      else if (typeof raw === "number") value = raw;
      else value = String(raw);
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE match_players SET ${sets.join(", ")} WHERE match_id = ? AND seat = ?`)
      .run(...values, matchId, seat);
  }

  listPlayers(matchId: string): MatchPlayerRow[] {
    const rows = this.db.prepare("SELECT * FROM match_players WHERE match_id = ? ORDER BY seat").all(matchId) as Record<string, unknown>[];
    return rows.map((r) => ({
      seat: r.seat as number,
      ...(r.agent_id ? { agentId: r.agent_id as string } : {}),
      modelId: (r.model_id as string) ?? "",
      name: (r.name as string) ?? "",
      status: (r.status as CheckStatus) ?? "OK",
      validation: safeJsonParse(r.validation_json as string, []),
      ...(r.script ? { script: r.script as string } : {}),
      ...(r.script_sha256 ? { scriptSha256: r.script_sha256 as string } : {}),
      ...(r.final_score != null ? { finalScore: r.final_score as number } : {}),
      ...(r.rank != null ? { rank: r.rank as number } : {}),
      ...(r.revision != null ? { revision: r.revision as number } : {}),
      ...(r.stats_json ? { stats: safeJsonParse(r.stats_json as string, {}) } : {}),
    }));
  }

  saveReplay(matchId: string, events: MatchEvent[], ranking: PlayerStats[]): void {
    const buf = Buffer.from(JSON.stringify(events), "utf8");
    this.db.prepare("INSERT OR REPLACE INTO match_replays (match_id, events, ranking_json) VALUES (?, ?, ?)")
      .run(matchId, buf, JSON.stringify(ranking));
  }

  getReplay(matchId: string): { events: MatchEvent[]; ranking: PlayerStats[] } | null {
    const row = this.db.prepare("SELECT events, ranking_json FROM match_replays WHERE match_id = ?").get(matchId) as
      | { events: Buffer | Uint8Array; ranking_json: string }
      | undefined;
    if (!row) return null;
    const text = Buffer.isBuffer(row.events) ? row.events.toString("utf8") : Buffer.from(row.events).toString("utf8");
    return { events: JSON.parse(text) as MatchEvent[], ranking: safeJsonParse(row.ranking_json, []) };
  }

  // ---------------- agents（外部 Agent 注册与提交） ----------------
  createAgent(input: {
    id: string; modelName: string; agentName: string; thinkingLevel: string; notes: string;
    keyHash: string; keyMasked: string; maxAttempts: number;
    /** 练习通道配额（不传则用表默认值 5） */
    maxPracticeRuns?: number;
  }): AgentRow {
    this.db.prepare(`INSERT INTO agents (id, model_name, agent_name, thinking_level, notes, key_hash, key_masked, status, attempts, max_attempts, max_practice_runs, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', 0, ?, ?, ?)`).run(
      input.id, input.modelName, input.agentName, input.thinkingLevel, input.notes,
      input.keyHash, input.keyMasked, input.maxAttempts, input.maxPracticeRuns ?? 5, new Date().toISOString(),
    );
    return this.getAgent(input.id)!;
  }

  listAgents(): AgentRow[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map(toAgentRow);
  }

  getAgent(id: string): AgentRow | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toAgentRow(row) : null;
  }

  /** 按密钥哈希查 Agent（上传鉴权用；返回内部记录含 keyHash） */
  findAgentByKeyHash(keyHash: string): (AgentRow & { keyHash: string }) | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE key_hash = ?").get(keyHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ...toAgentRow(row), keyHash: row.key_hash as string };
  }

  reissueAgentKey(id: string, keyHash: string, keyMasked: string): AgentRow | null {
    this.db.prepare("UPDATE agents SET key_hash=?, key_masked=?, attempts=0, status='registered', reject_reason=NULL WHERE id=?")
      .run(keyHash, keyMasked, id);
    return this.getAgent(id);
  }

  bumpAgentAttempts(id: string): number {
    this.db.prepare("UPDATE agents SET attempts = attempts + 1 WHERE id = ?").run(id);
    return this.getAgent(id)?.attempts ?? 0;
  }

  markAgentUploaded(id: string, data: {
    script: string; scriptSha256: string; zipSha256: string; zipBytes: number;
    meta?: unknown; validation: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
    sourceIp?: string;
  }): AgentRow | null {
    const now = new Date().toISOString();
    const cur = this.getAgent(id);
    if (!cur) return null;
    const revision = cur.revision + 1;
    this.db.prepare(`UPDATE agents SET status='uploaded', uploaded_at=?, script=?, script_sha256=?, zip_sha256=?, zip_bytes=?,
      meta_json=?, validation_json=?, reject_reason=NULL, revision=?, attempts_at_upload=? WHERE id=?`).run(
      now, data.script, data.scriptSha256, data.zipSha256, data.zipBytes,
      data.meta ? JSON.stringify(data.meta) : null, JSON.stringify(data.validation),
      revision, cur.attempts, id,
    );
    // 版本留档：每份脚本都存下来，供"批次快照"与"改进斜率"回看（agents 表只保留最新一份）
    this.db.prepare(`INSERT OR REPLACE INTO agent_revisions
      (id, agent_id, revision, script, script_sha256, zip_sha256, zip_bytes, meta_json, validation_json, attempts_at_upload, source_ip, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `${id}#${revision}`, id, revision, data.script, data.scriptSha256, data.zipSha256, data.zipBytes,
      data.meta ? JSON.stringify(data.meta) : null, JSON.stringify(data.validation), cur.attempts, data.sourceIp ?? null, now,
    );
    return this.getAgent(id);
  }

  /** 版本历史（新版本在前） */
  listAgentRevisions(agentId: string): AgentRevisionRow[] {
    const rows = this.db.prepare("SELECT * FROM agent_revisions WHERE agent_id = ? ORDER BY revision DESC").all(agentId) as Record<string, unknown>[];
    return rows.map((r) => ({
      revision: r.revision as number,
      scriptSha256: (r.script_sha256 as string) ?? "",
      ...(r.zip_bytes != null ? { zipBytes: r.zip_bytes as number } : {}),
      attemptsAtUpload: (r.attempts_at_upload as number) ?? 0,
      uploadedAt: r.uploaded_at as string,
      ...(r.meta_json ? { meta: safeJsonParse(r.meta_json as string, null) } : {}),
      ...(r.validation_json ? { validation: safeJsonParse(r.validation_json as string, []) } : {}),
    }));
  }

  /** 取某个版本的脚本（批次快照用它锁定"本批次用的是哪一版"） */
  agentScriptAtRevision(agentId: string, revision: number): { script: string; scriptSha256: string; agentName: string; modelName: string; revision: number } | null {
    const row = this.db.prepare(`SELECT r.script AS script, r.script_sha256 AS script_sha256, a.agent_name AS agent_name, a.model_name AS model_name
      FROM agent_revisions r JOIN agents a ON a.id = r.agent_id WHERE r.agent_id = ? AND r.revision = ?`).get(agentId, revision) as
      | Record<string, unknown>
      | undefined;
    if (row) {
      return {
        script: row.script as string,
        scriptSha256: (row.script_sha256 as string) ?? "",
        agentName: row.agent_name as string,
        modelName: row.model_name as string,
        revision,
      };
    }
    // 老库（升级前上传的脚本没有 version 行）回落到 agents 表的当前脚本，并标记为第 1 版
    const cur = this.agentScript(agentId);
    if (!cur || revision !== 1) return null;
    return { ...cur, revision: 1 };
  }

  // ---------------- 练习通道（docs/08 §6：不消耗正式提交、不计分） ----------------
  recordPracticeRun(input: {
    id: string; agentId: string; ok: boolean; stage?: string; detail?: string;
    stages?: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
    practice?: unknown; sourceIp?: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO practice_runs (id, agent_id, created_at, ok, stage, detail, stages_json, practice_json, source_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.agentId, now, input.ok ? 1 : 0,
      input.stage ?? null, input.detail ?? null,
      input.stages ? JSON.stringify(input.stages) : null,
      input.practice ? JSON.stringify(input.practice) : null,
      input.sourceIp ?? null,
    );
    this.db.prepare("UPDATE agents SET practice_runs = practice_runs + 1 WHERE id = ?").run(input.agentId);
  }

  listPracticeRuns(agentId: string, limit = 50): PracticeRunRow[] {
    const rows = this.db.prepare("SELECT * FROM practice_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      agentId: r.agent_id as string,
      createdAt: r.created_at as string,
      ok: Number(r.ok) === 1,
      ...(r.stage ? { stage: r.stage as string } : {}),
      ...(r.detail ? { detail: r.detail as string } : {}),
      ...(r.stages_json ? { stages: safeJsonParse(r.stages_json as string, []) } : {}),
      ...(r.practice_json ? { practice: safeJsonParse(r.practice_json as string, null) } : {}),
      ...(r.source_ip ? { sourceIp: r.source_ip as string } : {}),
    }));
  }

  /** 自测行为画像：首次自测是否通过、从首次失败到最终上传之间练习了几次 */
  practiceProfile(agentId: string): { runs: number; firstPass: boolean; runsBeforeUpload: number | null } {
    const rows = this.db.prepare("SELECT ok, created_at FROM practice_runs WHERE agent_id = ? ORDER BY created_at").all(agentId) as { ok: number; created_at: string }[];
    const agent = this.getAgent(agentId);
    const uploadedAt = agent?.uploadedAt ?? null;
    const before = uploadedAt ? rows.filter((r) => r.created_at <= uploadedAt).length : rows.length;
    return {
      runs: rows.length,
      firstPass: rows.length > 0 && Number(rows[0]!.ok) === 1,
      runsBeforeUpload: uploadedAt ? before : null,
    };
  }

  markAgentRejected(id: string, reason: string, validation: { stage: string; mapId?: string; ok: boolean; detail?: string }[]): AgentRow | null {
    this.db.prepare("UPDATE agents SET status='rejected', reject_reason=?, validation_json=? WHERE id=?")
      .run(reason, JSON.stringify(validation), id);
    return this.getAgent(id);
  }

  /** 取用于参赛的脚本 */
  agentScript(id: string): { script: string; scriptSha256: string; agentName: string; modelName: string } | null {
    const row = this.db.prepare("SELECT script, script_sha256, agent_name, model_name FROM agents WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row || !row.script) return null;
    return {
      script: row.script as string,
      scriptSha256: (row.script_sha256 as string) ?? "",
      agentName: row.agent_name as string,
      modelName: row.model_name as string,
    };
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  // ---------------- tournaments（1v1 循环赛） ----------------
  createTournament(input: {
    id: string; name: string; seed: number; gamesPerPair: number;
    mapId: string; rulesetVersion: string; scriptProtocolVersion: string; agentIds: string[];
    /** 批次（评测）归属：普通单场赛事不传 */
    cohortId?: string; legIndex?: number; leg?: TournamentRow["leg"];
  }): TournamentRow {
    this.db.prepare(`INSERT INTO tournaments (id, name, status, seed, games_per_pair, map_id, ruleset_version, script_protocol_version, agent_ids_json, cohort_id, leg_index, leg_json, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.name, input.seed, input.gamesPerPair, input.mapId, input.rulesetVersion,
      input.scriptProtocolVersion, JSON.stringify(input.agentIds),
      input.cohortId ?? null, input.legIndex ?? null, input.leg ? JSON.stringify(input.leg) : null,
      new Date().toISOString(),
    );
    return this.getTournament(input.id)!;
  }

  listTournaments(limit = 50): TournamentRow[] {
    const rows = this.db.prepare("SELECT * FROM tournaments ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(toTournamentRow);
  }

  getTournament(id: string): TournamentRow | null {
    const row = this.db.prepare("SELECT * FROM tournaments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toTournamentRow(row) : null;
  }

  updateTournament(id: string, patch: {
    status?: string; standings?: unknown; matchIds?: string[]; error?: string | null; finishedAt?: string | null;
  }): void {
    this.db.prepare(`UPDATE tournaments SET
        status = COALESCE(?, status),
        standings_json = CASE WHEN ? IS NULL THEN standings_json ELSE ? END,
        match_ids_json = COALESCE(?, match_ids_json),
        error = CASE WHEN ? = '__KEEP__' THEN error ELSE ? END,
        finished_at = CASE WHEN ? = '__KEEP__' THEN finished_at ELSE ? END
      WHERE id = ?`).run(
      patch.status ?? null,
      patch.standings === undefined ? null : JSON.stringify(patch.standings),
      patch.standings === undefined ? null : JSON.stringify(patch.standings),
      patch.matchIds ? JSON.stringify(patch.matchIds) : null,
      patch.error === undefined ? "__KEEP__" : (patch.error ?? null),
      patch.error === undefined ? null : (patch.error ?? null),
      patch.finishedAt === undefined ? "__KEEP__" : (patch.finishedAt ?? null),
      patch.finishedAt === undefined ? null : (patch.finishedAt ?? null),
      id,
    );
  }

  /** 某场赛事的全部对局（含比分），用于赛事详情页 */
  tournamentMatchRows(tournamentId: string): { matchId: string; status: MatchStatus; ranking: PlayerStats[] }[] {
    const rows = this.db.prepare("SELECT id, status, result_json FROM matches WHERE json_extract(config_json, '$.tournamentId') = ? ORDER BY created_at").all(tournamentId) as Record<string, unknown>[];
    return rows.map((r) => ({
      matchId: r.id as string,
      status: r.status as MatchStatus,
      ranking: r.result_json ? ((safeJsonParse(r.result_json as string, {}) as { ranking?: PlayerStats[] }).ranking ?? []) : [],
    }));
  }

  saveReport(matchId: string, markdown: string): void {
    this.db.prepare("UPDATE matches SET report_md = ? WHERE id = ?").run(markdown, matchId);
  }

  getReport(matchId: string): string | null {
    const row = this.db.prepare("SELECT report_md FROM matches WHERE id = ?").get(matchId) as { report_md?: string } | undefined;
    return row?.report_md ?? null;
  }

  // ---------------- cohorts（评测批次，docs/08 §2） ----------------
  createCohort(input: {
    id: string; name: string; masterSeed: number; gamesPerPair: number; agentIds: string[];
    plan: CohortRow["plan"]; snapshot: CohortRow["snapshot"];
  }): CohortRow {
    this.db.prepare(`INSERT INTO cohorts (id, name, status, master_seed, games_per_pair, agent_ids_json, plan_json, snapshot_json, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.name, input.masterSeed, input.gamesPerPair,
      JSON.stringify(input.agentIds), JSON.stringify(input.plan), JSON.stringify(input.snapshot), new Date().toISOString(),
    );
    return this.getCohort(input.id)!;
  }

  listCohorts(limit = 50): CohortRow[] {
    const rows = this.db.prepare("SELECT * FROM cohorts ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(toCohortRow);
  }

  getCohort(id: string): CohortRow | null {
    const row = this.db.prepare("SELECT * FROM cohorts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toCohortRow(row) : null;
  }

  updateCohort(id: string, patch: {
    status?: CohortStatus; ratings?: unknown; matrix?: unknown; metrics?: unknown;
    error?: string | null; finishedAt?: string | null;
  }): void {
    this.db.prepare(`UPDATE cohorts SET
        status = COALESCE(?, status),
        ratings_json = CASE WHEN ? IS NULL THEN ratings_json ELSE ? END,
        matrix_json = CASE WHEN ? IS NULL THEN matrix_json ELSE ? END,
        metrics_json = CASE WHEN ? IS NULL THEN metrics_json ELSE ? END,
        error = CASE WHEN ? = '__KEEP__' THEN error ELSE ? END,
        finished_at = CASE WHEN ? = '__KEEP__' THEN finished_at ELSE ? END
      WHERE id = ?`).run(
      patch.status ?? null,
      patch.ratings === undefined ? null : JSON.stringify(patch.ratings),
      patch.ratings === undefined ? null : JSON.stringify(patch.ratings),
      patch.matrix === undefined ? null : JSON.stringify(patch.matrix),
      patch.matrix === undefined ? null : JSON.stringify(patch.matrix),
      patch.metrics === undefined ? null : JSON.stringify(patch.metrics),
      patch.metrics === undefined ? null : JSON.stringify(patch.metrics),
      patch.error === undefined ? "__KEEP__" : (patch.error ?? null),
      patch.error === undefined ? null : (patch.error ?? null),
      patch.finishedAt === undefined ? "__KEEP__" : (patch.finishedAt ?? null),
      patch.finishedAt === undefined ? null : (patch.finishedAt ?? null),
      id,
    );
  }

  /** 批次下所有 leg（按 leg_index 排序） */
  cohortLegs(cohortId: string): TournamentRow[] {
    const rows = this.db.prepare("SELECT * FROM tournaments WHERE cohort_id = ? ORDER BY leg_index").all(cohortId) as Record<string, unknown>[];
    return rows.map(toTournamentRow);
  }

  /** 批次里所有已完成对局的双方与比分（评级/矩阵/画像的输入） */
  cohortMatchRows(cohortId: string): CohortMatchRow[] {
    const rows = this.db.prepare(`
      SELECT m.id AS id, m.status AS status, m.map_id AS map_id, m.ruleset_version AS ruleset_version,
             m.seed AS seed, m.result_json AS result_json, t.leg_index AS leg_index
      FROM matches m JOIN tournaments t ON json_extract(m.config_json, '$.tournamentId') = t.id
      WHERE t.cohort_id = ? ORDER BY t.leg_index, m.created_at
    `).all(cohortId) as Record<string, unknown>[];
    return rows.map((r) => {
      const matchId = r.id as string;
      const ranking = r.result_json ? ((safeJsonParse(r.result_json as string, {}) as { ranking?: PlayerStats[] }).ranking ?? []) : [];
      const seats = this.listPlayers(matchId).map((p) => {
        const stat = ranking.find((x) => x.seat === p.seat);
        return {
          seat: p.seat,
          agentId: p.agentId ?? "",
          modelId: p.modelId,
          score: stat?.score ?? p.finalScore ?? 0,
          rank: stat?.rank ?? p.rank ?? p.seat,
          ...(p.revision != null ? { revision: p.revision } : {}),
          ...(p.stats ? { stats: p.stats } : {}),
        };
      });
      return {
        matchId,
        legIndex: Number(r.leg_index ?? 0),
        status: r.status as MatchStatus,
        mapId: r.map_id as string,
        rulesetVersion: r.ruleset_version as string,
        seed: Number(r.seed),
        seats,
      };
    });
  }

  /** 排行榜：按 Agent 声明的模型名聚合（同一模型可以注册多个 Agent，这里看的是"这家模型写出来的脚本打得怎么样"） */
  leaderboard(): LeaderboardRow[] {
    const rows = this.db.prepare(`${LEADERBOARD_SQL} GROUP BY p.model_id ORDER BY avgScore DESC`).all() as Record<string, unknown>[];
    return rows.map(mapLeaderboardRow);
  }

  /** 单个模型的画像：对外可比的过程分 + 它名下每个 Agent 的版本/练习痕迹 */
  modelProfile(modelId: string): {
    metrics: LeaderboardRow;
    agents: { id: string; agentName: string; status: AgentStatus; revision: number; practiceRuns: number; maxPracticeRuns: number; attemptsAtUpload: number; practiceFirstPass: boolean | null; runsBeforeUpload: number | null }[];
  } | null {
    const row = this.db.prepare(`${LEADERBOARD_SQL} AND p.model_id = ? GROUP BY p.model_id`).get(modelId) as Record<string, unknown> | undefined;
    const agents = this.listAgents().filter((a) => a.modelName === modelId);
    if (!row && agents.length === 0) return null;
    const metrics: LeaderboardRow = row
      ? mapLeaderboardRow(row)
      : { ...EMPTY_LEADERBOARD, modelId };
    return {
      metrics,
      agents: agents.map((a) => {
        const prof = this.practiceProfile(a.id);
        return {
          id: a.id, agentName: a.agentName, status: a.status,
          revision: a.revision, practiceRuns: a.practiceRuns, maxPracticeRuns: a.maxPracticeRuns,
          attemptsAtUpload: a.attemptsAtUpload,
          practiceFirstPass: prof.runs > 0 ? prof.firstPass : null,
          runsBeforeUpload: prof.runsBeforeUpload,
        };
      }),
    };
  }
}

/**
 * 排行榜/画像的统一口径（docs/08 §4.1）：
 * 全部指标按"每回合/每单位"归一，否则不同回合数、不同地图的局之间不可比。
 */
const LEADERBOARD_SQL = `
  SELECT p.model_id AS modelId,
         COUNT(*) AS matches,
         AVG(COALESCE(p.final_score, 0)) AS avgScore,
         SUM(CASE WHEN p.rank = 1 THEN 1 ELSE 0 END) AS wins,
         AVG(CASE WHEN p.status = 'OK' THEN 1.0 ELSE 0.0 END) AS scriptOkRate,
         AVG(COALESCE(json_extract(p.stats_json, '$.invalidActions'), 0)) AS avgInvalidActions,
         AVG(COALESCE(json_extract(p.stats_json, '$.strikes'), 0)) AS avgStrikes,
         AVG(COALESCE(json_extract(p.stats_json, '$.invalidActions'), 0) * 1.0
             / MAX(1, COALESCE(json_extract(p.stats_json, '$.turnsTaken'), 0))) AS avgInvalidRate,
         AVG(COALESCE(json_extract(p.stats_json, '$.emergencyMoves'), 0) * 1.0
             / MAX(1, COALESCE(json_extract(p.stats_json, '$.moves'), 0))) AS avgEmergencyRate,
         AVG(COALESCE(json_extract(p.stats_json, '$.unitsDeposited'), 0) * 100.0
             / MAX(1, COALESCE(json_extract(p.stats_json, '$.turnsTaken'), 0))) AS avgUnitsPer100,
         AVG(COALESCE(json_extract(p.stats_json, '$.kills'), 0) - COALESCE(json_extract(p.stats_json, '$.deaths'), 0)) AS avgKillDeathDiff,
         AVG(COALESCE(json_extract(p.stats_json, '$.avgDecisionMs'), 0)) AS avgDecisionMs,
         MAX(COALESCE(json_extract(p.stats_json, '$.maxDecisionMs'), 0)) AS maxDecisionMs,
         -- 补给占比只在"有产出"的对局上算：一局没提交没击杀时这个比值没有意义（分母趋零会把 24 点油费算成 114 倍）
         AVG(CASE WHEN (COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.deposit'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.kill'), 0)) > 0
             THEN (-(COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.ammo'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.fuel'), 0))) * 1.0
                  / (COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.deposit'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.kill'), 0))
             END) AS avgSupplyShare,
         AVG(CASE WHEN (COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.deposit'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.kill'), 0)) = 0
             THEN 1.0 ELSE 0.0 END) AS zeroOutputRate,
         AVG(CASE WHEN json_extract(p.stats_json, '$.disqualified') = 1 THEN 1.0 ELSE 0.0 END) AS disqualifiedRate,
         AVG(CASE WHEN a.id IS NULL THEN NULL WHEN a.attempts_at_upload = 0 THEN 1.0 ELSE 0.0 END) AS firstTryRate,
         AVG(CASE WHEN a.id IS NULL THEN NULL ELSE a.revision END) AS avgRevisions,
         AVG(CASE WHEN a.id IS NULL THEN NULL ELSE a.practice_runs END) AS avgPracticeRuns
  FROM match_players p JOIN matches m ON m.id = p.match_id
  LEFT JOIN agents a ON a.id = p.agent_id
  WHERE p.model_id <> '' AND m.status = 'finished'`;

const EMPTY_LEADERBOARD: LeaderboardRow = {
  modelId: "", matches: 0, avgScore: 0, wins: 0, scriptOkRate: 0,
  avgInvalidActions: 0, avgStrikes: 0, avgInvalidRate: 0, avgEmergencyRate: 0,
  avgUnitsPer100: 0, avgKillDeathDiff: 0, avgDecisionMs: 0, maxDecisionMs: 0,
  avgSupplyShare: null,
  zeroOutputRate: 0, disqualifiedRate: 0, firstTryRate: null, avgRevisions: null, avgPracticeRuns: null,
};

function round(x: unknown, digits: number): number {
  const n = Number(x ?? 0);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function mapLeaderboardRow(r: Record<string, unknown>): LeaderboardRow {
  return {
    modelId: String(r.modelId),
    matches: Number(r.matches),
    avgScore: round(r.avgScore, 1),
    wins: Number(r.wins),
    scriptOkRate: round(r.scriptOkRate, 3),
    avgInvalidActions: round(r.avgInvalidActions, 2),
    avgStrikes: round(r.avgStrikes, 2),
    avgInvalidRate: round(r.avgInvalidRate, 4),
    avgEmergencyRate: round(r.avgEmergencyRate, 4),
    avgUnitsPer100: round(r.avgUnitsPer100, 2),
    avgKillDeathDiff: round(r.avgKillDeathDiff, 2),
    avgDecisionMs: round(r.avgDecisionMs, 3),
    maxDecisionMs: round(r.maxDecisionMs, 3),
    avgSupplyShare: r.avgSupplyShare == null ? null : round(r.avgSupplyShare, 3),
    zeroOutputRate: round(r.zeroOutputRate, 3),
    disqualifiedRate: round(r.disqualifiedRate, 3),
    firstTryRate: r.firstTryRate == null ? null : round(r.firstTryRate, 3),
    avgRevisions: r.avgRevisions == null ? null : round(r.avgRevisions, 2),
    avgPracticeRuns: r.avgPracticeRuns == null ? null : round(r.avgPracticeRuns, 2),
  };
}

function toMatchRow(r: Record<string, unknown>): MatchRow {
  const resultJson = r.result_json ? (safeJsonParse(r.result_json as string, {}) as { ranking?: PlayerStats[] }) : null;
  return {
    id: r.id as string,
    status: r.status as MatchStatus,
    mapId: r.map_id as string,
    mapVersion: r.map_version as number,
    rulesetVersion: r.ruleset_version as string,
    scriptProtocolVersion: (r.script_protocol_version as string) ?? "",
    seed: Number(r.seed),
    seatCount: r.seat_count as number,
    turnIntervalMs: r.turn_interval_ms as number,
    config: safeJsonParse(r.config_json as string, {}),
    reproducibilityKey: (r.reproducibility_key as string) ?? "",
    ...(r.error ? { error: r.error as string } : {}),
    createdAt: r.created_at as string,
    ...(r.ended_at ? { endedAt: r.ended_at as string } : {}),
    ...(resultJson?.ranking ? { ranking: resultJson.ranking } : {}),
  };
}

function toAgentRow(r: Record<string, unknown>): AgentRow {
  return {
    id: r.id as string,
    modelName: r.model_name as string,
    agentName: r.agent_name as string,
    thinkingLevel: r.thinking_level as string,
    notes: (r.notes as string) ?? "",
    status: r.status as AgentStatus,
    keyMasked: (r.key_masked as string) ?? "",
    attempts: (r.attempts as number) ?? 0,
    maxAttempts: (r.max_attempts as number) ?? 5,
    createdAt: r.created_at as string,
    ...(r.uploaded_at ? { uploadedAt: r.uploaded_at as string } : {}),
    ...(r.script_sha256 ? { scriptSha256: r.script_sha256 as string } : {}),
    ...(r.zip_bytes != null ? { zipBytes: r.zip_bytes as number } : {}),
    ...(r.validation_json ? { validation: safeJsonParse(r.validation_json as string, []) } : {}),
    ...(r.reject_reason ? { rejectReason: r.reject_reason as string } : {}),
    revision: (r.revision as number) ?? 0,
    attemptsAtUpload: (r.attempts_at_upload as number) ?? 0,
    practiceRuns: (r.practice_runs as number) ?? 0,
    maxPracticeRuns: (r.max_practice_runs as number) ?? 5,
  };
}

function toTournamentRow(r: Record<string, unknown>): TournamentRow {
  return {
    id: r.id as string,
    name: r.name as string,
    status: r.status as TournamentRow["status"],
    seed: Number(r.seed),
    gamesPerPair: Number(r.games_per_pair),
    mapId: r.map_id as string,
    rulesetVersion: r.ruleset_version as string,
    scriptProtocolVersion: (r.script_protocol_version as string) ?? "",
    agentIds: safeJsonParse(r.agent_ids_json as string, []),
    matchIds: safeJsonParse(r.match_ids_json as string, []),
    ...(r.standings_json ? { standings: safeJsonParse(r.standings_json as string, null) } : {}),
    ...(r.error ? { error: r.error as string } : {}),
    createdAt: r.created_at as string,
    ...(r.finished_at ? { finishedAt: r.finished_at as string } : {}),
    ...(r.cohort_id ? { cohortId: r.cohort_id as string } : {}),
    ...(r.leg_index != null ? { legIndex: Number(r.leg_index) } : {}),
    ...(r.leg_json ? { leg: (safeJsonParse(r.leg_json as string, null) ?? undefined) as TournamentRow["leg"] } : {}),
  };
}

function toCohortRow(r: Record<string, unknown>): CohortRow {
  return {
    id: r.id as string,
    name: r.name as string,
    status: r.status as CohortStatus,
    masterSeed: Number(r.master_seed),
    gamesPerPair: Number(r.games_per_pair),
    agentIds: safeJsonParse(r.agent_ids_json as string, []),
    plan: safeJsonParse(r.plan_json as string, { gamesPerPair: 2, legs: [] }),
    snapshot: safeJsonParse(r.snapshot_json as string, []),
    ...(r.ratings_json ? { ratings: safeJsonParse(r.ratings_json as string, null) } : {}),
    ...(r.matrix_json ? { matrix: safeJsonParse(r.matrix_json as string, null) } : {}),
    ...(r.metrics_json ? { metrics: safeJsonParse(r.metrics_json as string, null) } : {}),
    ...(r.error ? { error: r.error as string } : {}),
    createdAt: r.created_at as string,
    ...(r.finished_at ? { finishedAt: r.finished_at as string } : {}),
  };
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export type { MatchResult };