// apps/server/src/tournaments.ts —— 赛事运行器：把上传的脚本组织成 1v1 循环赛并逐局落库
import { EventEmitter } from "node:events";
import type { GameMap, MatchResult, Ruleset } from "@ai-game/protocol";
import { runTournament, type Standing, type TournamentAgent, type TournamentMatchRecord } from "@ai-game/orchestrator";
import type { MapRegistry } from "./maps.ts";
import { persistMatchResult, type StoredSeat } from "./persist.ts";
import type { Store, TournamentRow } from "./store.ts";

export interface TournamentRunnerDeps {
  store: Store;
  /** 赛事用图从注册表取（可能是编辑器保存的自定义地图） */
  registry: MapRegistry;
}

export interface TournamentRunOptions {
  tournamentId: string;
  agentIds: string[];
  gamesPerPair: number;
  seed: number;
  mapId: string;
  rules: Ruleset;
  scriptProtocolVersion: string;
  /**
   * 显式指定参赛脚本（批次快照 / 标尺对手都用它）。
   * 给定时不再"读当前脚本"，这样批次进行中有人重新上传也不会改变本批次的参赛版本。
   */
  scripts?: Record<string, { script: string; scriptHash: string; revision?: number }>;
  /** 追加的非入库参赛者（标尺：idle / baseline），不参与"重新签发/上传"那套流程 */
  calibrators?: { id: string; agentName: string; modelName: string; script: string }[];
  /** 中途停止的判据（当前 leg 已跑完的对局照常落库） */
  shouldStop?: () => boolean;
}

export class TournamentRunner extends EventEmitter {
  status: TournamentRow["status"] = "pending";
  standings: Standing[] = [];
  matches: TournamentMatchRecord[] = [];
  error?: string;
  finishedMatches = 0;
  totalMatches = 0;
  private matchIds: string[] = [];

  constructor(private deps: TournamentRunnerDeps, private opts: TournamentRunOptions) {
    super();
  }

  async start(): Promise<void> {
    const { store } = this.deps;
    const startedAt = new Date().toISOString();
    try {
      // 1) 取出参赛脚本（必须是已上传并通过校验的 Agent；批次快照会给显式 scripts）
      const agents: TournamentAgent[] = [];
      for (const id of this.opts.agentIds) {
        const agent = store.getAgent(id);
        if (!agent) throw new Error(`Agent ${id} 不存在`);
        const snapshot = this.opts.scripts?.[id];
        if (!snapshot && agent.status !== "uploaded") {
          throw new Error(`Agent ${agent.agentName} 状态为 ${agent.status}，只有已通过校验的 Agent 可以参赛`);
        }
        const script = snapshot ?? (() => {
          const cur = store.agentScript(id);
          if (!cur) throw new Error(`Agent ${agent.agentName} 没有可用脚本`);
          return { script: cur.script, scriptHash: cur.scriptSha256 };
        })();
        agents.push({
          id, agentName: agent.agentName, modelName: agent.modelName,
          script: script.script, scriptHash: script.scriptHash,
        });
      }
      // 标尺对手（idle / baseline）：入库的是"标尺"而不是真实参赛者，成绩里单列
      for (const cal of this.opts.calibrators ?? []) {
        agents.push({
          id: cal.id, agentName: cal.agentName, modelName: cal.modelName,
          script: cal.script, scriptHash: `calibration:${cal.id}`,
        });
      }
      if (agents.length < 2) throw new Error("至少需要 2 个已通过校验的 Agent");

      const map = this.deps.registry.get(this.opts.mapId);
      if (!map) throw new Error(`未知地图 ${this.opts.mapId}（可用：${this.deps.registry.ids().join(", ")}）`);
      store.updateTournament(this.opts.tournamentId, { status: "running", matchIds: [] });
      this.status = "running";
      this.emit("progress", { phase: "running", finished: 0, total: 0 });

      // 2) 跑循环赛；每局开始前建 match 行，结束后落库（回放/战报/积木数据）
      const outcome = await runTournament({
        tournamentId: this.opts.tournamentId,
        map,
        rules: this.opts.rules,
        seed: this.opts.seed,
        agents,
        gamesPerPair: this.opts.gamesPerPair,
        ...(this.opts.shouldStop ? { shouldStop: this.opts.shouldStop } : {}),
        onMatchStart: ({ index, total, pairLabel }) => {
          this.totalMatches = total;
          store.createMatch({
            id: `${this.opts.tournamentId}-${String(index).padStart(3, "0")}`,
            status: "created",
            mapId: map.mapId,
            mapVersion: map.version,
            rulesetVersion: this.opts.rules.version,
            scriptProtocolVersion: this.opts.scriptProtocolVersion,
            seed: this.opts.seed,
            seatCount: 2,
            turnIntervalMs: 0,
            config: { tournamentId: this.opts.tournamentId, index, pairLabel, agentIds: this.opts.agentIds },
          });
          this.emit("progress", { phase: "match_start", index, total, pairLabel });
        },
        onMatchFinished: ({ index, matchId, result, agents: pairAgents }) => {
          this.persistTournamentMatch(matchId, result, map, pairAgents, startedAt);
          this.finishedMatches += 1;
          this.matchIds.push(matchId);
          store.updateTournament(this.opts.tournamentId, { matchIds: this.matchIds });
          this.emit("progress", { phase: "match_finished", index, matchId, finished: this.finishedMatches, total: this.totalMatches });
        },
      });

      this.standings = outcome.standings;
      this.matches = outcome.matches;
      this.status = "finished";
      store.updateTournament(this.opts.tournamentId, {
        status: "finished",
        standings: outcome.standings,
        matchIds: this.matchIds,
        finishedAt: new Date().toISOString(),
        error: null,
      });
      this.emit("progress", { phase: "finished", standings: outcome.standings });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      store.updateTournament(this.opts.tournamentId, {
        status: "failed",
        error: this.error,
        matchIds: this.matchIds,
        finishedAt: new Date().toISOString(),
      });
      this.emit("progress", { phase: "failed", error: this.error });
    }
  }

  private persistTournamentMatch(
    matchId: string,
    result: MatchResult,
    map: GameMap,
    pairAgents: { seat: number; id: string; agentName: string }[],
    startedAt: string,
  ): void {
    const seats: StoredSeat[] = pairAgents.map((pa) => {
      const stats = result.stats[pa.seat]!;
      const agent = this.deps.store.getAgent(pa.id);
      const snapshot = this.opts.scripts?.[pa.id];
      const stored = snapshot ? null : this.deps.store.agentScript(pa.id);
      const revision = snapshot?.revision ?? this.deps.store.getAgent(pa.id)?.revision;
      return {
        seat: pa.seat,
        name: pa.agentName,
        // 标尺对手的 modelName 固定为 "calibration"，榜上不会被误当成参赛模型
        modelId: agent?.modelName ?? (pa.id.startsWith("cal-") ? "calibration" : "unknown"),
        agentId: pa.id,
        scriptHash: stats.scriptHash || snapshot?.scriptHash || stored?.scriptSha256 || "",
        ...((snapshot?.script ?? stored?.script) ? { script: (snapshot?.script ?? stored?.script)! } : {}),
        ...(revision != null ? { revision } : {}),
        validation: agent?.validation ?? [{ stage: "upload", ok: true, detail: "已通过上传校验" }],
      };
    });
    persistMatchResult(this.deps.store, {
      matchId, map, rules: this.opts.rules, seed: this.opts.seed, result, seats,
      scriptProtocolVersion: this.opts.scriptProtocolVersion,
      tournamentId: this.opts.tournamentId, startedAt,
    });
  }
}