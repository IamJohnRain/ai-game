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
}
export type AgentStatus = "registered" | "uploaded" | "rejected";

export interface AgentRow {
  id: string; modelName: string; agentName: string; thinkingLevel: string; notes: string;
  status: AgentStatus; keyMasked: string; attempts: number; maxAttempts: number;
  createdAt: string; uploadedAt?: string;
  scriptSha256?: string; zipBytes?: number;
  validation?: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
  rejectReason?: string;
}

export interface TournamentRow {
  id: string; name: string; status: "pending" | "running" | "finished" | "failed";
  seed: number; gamesPerPair: number; mapId: string; rulesetVersion: string; scriptProtocolVersion: string;
  agentIds: string[]; matchIds: string[]; standings?: unknown; error?: string;
  createdAt: string; finishedAt?: string;
}

export interface LeaderboardRow {
  modelId: string;
  matches: number;
  avgScore: number;
  wins: number;
  scriptOkRate: number;
  avgInvalidActions: number;
  avgStrikes: number;
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
  }): void {
    const columns: Record<string, string> = {
      agentId: "agent_id", modelId: "model_id", name: "name", status: "status",
      validation: "validation_json", script: "script", scriptSha256: "script_sha256",
      meta: "meta_json", finalScore: "final_score", rank: "rank", stats: "stats_json",
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
  }): AgentRow {
    this.db.prepare(`INSERT INTO agents (id, model_name, agent_name, thinking_level, notes, key_hash, key_masked, status, attempts, max_attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', 0, ?, ?)`).run(
      input.id, input.modelName, input.agentName, input.thinkingLevel, input.notes,
      input.keyHash, input.keyMasked, input.maxAttempts, new Date().toISOString(),
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
  }): AgentRow | null {
    this.db.prepare(`UPDATE agents SET status='uploaded', uploaded_at=?, script=?, script_sha256=?, zip_sha256=?, zip_bytes=?,
      meta_json=?, validation_json=?, reject_reason=NULL WHERE id=?`).run(
      new Date().toISOString(), data.script, data.scriptSha256, data.zipSha256, data.zipBytes,
      data.meta ? JSON.stringify(data.meta) : null, JSON.stringify(data.validation), id,
    );
    return this.getAgent(id);
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
  }): TournamentRow {
    this.db.prepare(`INSERT INTO tournaments (id, name, status, seed, games_per_pair, map_id, ruleset_version, script_protocol_version, agent_ids_json, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.name, input.seed, input.gamesPerPair, input.mapId, input.rulesetVersion,
      input.scriptProtocolVersion, JSON.stringify(input.agentIds), new Date().toISOString(),
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

  /** 排行榜：按 Agent 声明的模型名聚合（同一模型可以注册多个 Agent，这里看的是"这家模型写出来的脚本打得怎么样"） */
  leaderboard(): LeaderboardRow[] {
    const rows = this.db.prepare(`
      SELECT p.model_id AS modelId,
             COUNT(*) AS matches,
             AVG(COALESCE(p.final_score, 0)) AS avgScore,
             SUM(CASE WHEN p.rank = 1 THEN 1 ELSE 0 END) AS wins,
             AVG(CASE WHEN p.status = 'OK' THEN 1.0 ELSE 0.0 END) AS scriptOkRate,
             AVG(COALESCE(json_extract(p.stats_json, '$.invalidActions'), 0)) AS avgInvalidActions,
             AVG(COALESCE(json_extract(p.stats_json, '$.strikes'), 0)) AS avgStrikes
      FROM match_players p JOIN matches m ON m.id = p.match_id
      WHERE p.model_id <> '' AND m.status = 'finished'
      GROUP BY p.model_id
      ORDER BY avgScore DESC
    `).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      modelId: String(r.modelId),
      matches: Number(r.matches),
      avgScore: Math.round(Number(r.avgScore) * 10) / 10,
      wins: Number(r.wins),
      scriptOkRate: Math.round(Number(r.scriptOkRate) * 1000) / 1000,
      avgInvalidActions: Math.round(Number(r.avgInvalidActions) * 100) / 100,
      avgStrikes: Math.round(Number(r.avgStrikes) * 100) / 100,
    }));
  }
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
  };
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export type { MatchResult };