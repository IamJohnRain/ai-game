// packages/orchestrator/src/report.ts —— 战报（Markdown）生成
// 平台只保留一条参赛链路（外部 Agent 上传脚本），因此战报里的"选手"就是 Agent 本身；
// CLI 打印、服务端 /report、赛事落库都共用这一份实现。
import { createHash } from "node:crypto";
import type { GameMap, MatchEvent, MatchResult, Ruleset } from "@ai-game/protocol";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 一位参赛者（与座位一一对应） */
export interface ReportSeat {
  seat: number;
  /** Agent 名称 */
  name: string;
  /** 模型名（仅用于展示；平台不调用模型，这个字段说明"脚本是哪个模型写出来的"） */
  modelId?: string;
  agentId?: string;
  scriptHash?: string;
  /** 上传准入流水线的留痕（可按地图多次） */
  validation?: { stage: string; mapId?: string; ok: boolean; detail?: string }[];
}

export interface ReportInput {
  matchId: string;
  map: GameMap;
  rules: Ruleset;
  seed: number;
  result: MatchResult;
  seats: ReportSeat[];
  reproducibilityKey: string;
  scriptProtocolVersion: string;
  /** 赛事对局时带上赛事 id */
  tournamentId?: string;
  startedAt?: string;
  endedAt?: string;
}

/** 战报（Markdown） */
export function buildReport(input: ReportInput): string {
  const { result } = input;
  const bySeat = new Map(input.seats.map((s) => [s.seat, s]));
  const lines: string[] = [];
  const title = input.tournamentId ? `# 坦克对战战报（赛事对局 · ${input.tournamentId}）` : `# 坦克对战战报 · ${input.matchId}`;
  lines.push(title, "");
  const date = (input.startedAt ?? new Date().toISOString()).slice(0, 19).replace("T", " ");
  lines.push(`- 时间：${date}${input.endedAt ? ` → ${input.endedAt.slice(0, 19).replace("T", " ")}` : ""}`);
  lines.push(`- 对局 ID：\`${input.matchId}\``);
  lines.push(`- 地图：${input.map.mapId}@${input.map.version}　规则：ruleset-${input.rules.version}　脚本协议：${input.scriptProtocolVersion}`);
  lines.push(`- 种子：\`${input.seed}\`　总回合：${result.turns}　复现键：\`${input.reproducibilityKey}\``);
  lines.push("");

  lines.push("## 排名", "");
  lines.push("| 名次 | 座位 | Agent | 模型 | 总分 | 提交单位 | 击杀 | 死亡 | 补给扣分 | 无效动作 | strike | 平均决策 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const st of result.ranking) {
    const seat = bySeat.get(st.seat);
    const spend = `-${-st.scoreBreakdown.ammo - st.scoreBreakdown.fuel}`;
    lines.push(
      `| ${st.rank} | P${st.seat} | ${st.name} | ${seat?.modelId ?? "-"} | **${st.score}** | ` +
      `${st.unitsDeposited} | ${st.kills} | ${st.deaths} | ${spend} | ${st.invalidActions} | ${st.strikes} | ${st.avgDecisionMs}ms |`,
    );
  }
  lines.push("");

  lines.push("## 得分明细（得分 = 提交 + 击杀 − 死亡 − 补给）", "");
  for (const st of result.ranking) {
    const b = st.scoreBreakdown;
    lines.push(
      `- **P${st.seat} ${st.name}**：提交 +${b.deposit}（${st.unitsDeposited} 单位 × ${input.rules.depositScorePerUnit}）` +
      `、击杀 +${b.kill}（${st.kills}）` +
      `、死亡 ${b.death}（${st.deaths}）` +
      `、装填 ${b.ammo}（${st.ammoLoaded} 发）` +
      `、燃油 ${b.fuel}（${st.fuelLoaded} 点${st.emergencyMoves > 0 ? `，应急移动 ${st.emergencyMoves} 格` : ""}）` +
      ` → 合计 ${st.score}`,
    );
    lines.push(
      `  - 采集 ${st.unitsCollected} 单位、提交 ${st.deposits} 次、移动 ${st.moves} 步、` +
      `开火 ${st.shotsFired} 发、命中 ${st.hits} 次、造成伤害 ${st.damageDealt}、行动回合 ${st.turnsTaken}`,
    );
    if (st.minesDeployed > 0) {
      lines.push(
        `  - 布雷 ${st.minesDeployed} 枚（其中 ${st.mineKills} 枚是对手踩响的）——地雷对所有人不可见、不分敌我，` +
        `踩中即清空血量`,
      );
    }
  }
  lines.push("");

  lines.push("## 脚本与准入校验", "");
  lines.push("| 座位 | Agent | 脚本 SHA256 | 校验结论 |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of input.seats) {
    const stages = s.validation ?? [];
    const ok = stages.length === 0 ? "-" : stages.every((v) => v.ok) ? "✅ 全部通过" : "❌ 有待修项";
    lines.push(`| P${s.seat} | ${s.name} | \`${(s.scriptHash ?? "-").slice(0, 16)}\` | ${ok} |`);
  }
  lines.push("");
  const withStages = input.seats.filter((s) => (s.validation ?? []).length > 0);
  if (withStages.length > 0) {
    lines.push("### 准入流水线留痕", "");
    for (const s of withStages) {
      lines.push(`**P${s.seat} ${s.name}**`);
      for (const stage of s.validation!) {
        lines.push(`- ${stage.ok ? "✅" : "❌"} ${stage.stage}${stage.mapId ? `@${stage.mapId}` : ""}${stage.detail ? `：${stage.detail}` : ""}`);
      }
      lines.push("");
    }
  }

  lines.push("## 关键事件时间线", "");
  const timeline = result.events.filter((e) =>
    e.t === "death" || e.t === "deposit" || e.t === "defend" || e.t === "mine_trigger"
    || e.t === "disqualified" || e.t === "strike" || e.t === "invalid_action");
  const shown = timeline.slice(0, 60);
  for (const e of shown) lines.push(`- ${describeEvent(e)}`);
  if (timeline.length > shown.length) lines.push(`- …（另有 ${timeline.length - shown.length} 条事件，见回放）`);
  lines.push("");

  return lines.join("\n");
}

export function describeEvent(e: MatchEvent): string {
  switch (e.t) {
    case "death":
      return e.cause === "mine"
        ? `💀 P${e.seat} 踩雷阵亡${e.killerSeat !== null ? `（P${e.killerSeat} 埋的）` : "（自己的雷）"} ${e.scoreDelta} 分`
        : `💀 P${e.seat} 被击毁${e.killerSeat !== null ? `（P${e.killerSeat}）` : ""} ${e.scoreDelta} 分`;
    case "deposit": return `💰 P${e.seat} 提交 ${e.units} 单位 +${e.scoreDelta} 分（总分 ${e.scoreAfter}）`;
    case "defend": return `🛡 P${e.seat} 举盾（${e.rounds} 轮内炮弹伤害全免）`;
    case "mine_trigger": return `💥 P${e.seat} 在 (${e.x},${e.y}) 踩响 P${e.owner} 的地雷（清空血量）`;
    case "disqualified": return `⛔ P${e.seat} 被淘汰（${e.kind}）`;
    case "strike": return `⚠️ P${e.seat} ${e.kind}: ${e.detail.slice(0, 80)}`;
    case "invalid_action": return `⚠️ P${e.seat} 无效动作 ${e.reason}`;
    case "match_end": return `🏁 结束：${e.ranking.map((r) => `#${r.rank} P${r.seat}(${r.score})`).join(" ")}`;
    default: return e.t;
  }
}

/** 复现键：脚本协议 + 规则 + 地图 + 种子 + 各座位脚本哈希（同键重跑事件流逐字节一致） */
export function reproducibilityKey(input: {
  scriptProtocolVersion: string;
  rules: Ruleset;
  map: GameMap;
  seed: number;
  seats: { seat: number; scriptHash?: string }[];
}): string {
  return sha256([
    input.scriptProtocolVersion,
    input.rules.version,
    `${input.map.mapId}@${input.map.version}`,
    String(input.seed),
    ...[...input.seats].sort((a, b) => a.seat - b.seat).map((s) => `${s.seat}:${s.scriptHash ?? ""}`),
  ].join("|"));
}