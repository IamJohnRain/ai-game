// 一次性补丁：修正「补给占比」在"零产出局"上爆炸的公式问题
// 问题：分母用 MAX(1, deposit+kill)，对于那些一局都没提交 / 也没击杀的对局，
//       几十点燃油费会被算成"114 倍"（线上实测：逐行均值 3.25、中位数才 0.21，指标被少数零分局彻底带偏）。
// 修正：只在"有产出"（deposit+kill > 0）的对局上求这个比值（AVG 自动忽略 NULL），
//       同时新增「无产出局占比」把这批局单独暴露出来——它本身也是有用信号。
import { readFileSync, writeFileSync } from "node:fs";

function patch(file, list) {
  let text = readFileSync(file, "utf8");
  for (const [from, to] of list) {
    if (!text.includes(from)) {
      console.error(`MISS in ${file}: ${from.slice(0, 70)}`);
      process.exit(1);
    }
    text = text.split(from).join(to);
  }
  writeFileSync(file, text);
  console.log(`updated ${file}`);
}

patch("apps/server/src/store.ts", [
  [
    `         AVG((-(COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.ammo'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.fuel'), 0))) * 1.0
             / MAX(1, COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.deposit'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.kill'), 0))) AS avgSupplyShare,`,
    `         -- 补给占比只在"有产出"的对局上算：一局没提交没击杀时这个比值没有意义（分母趋零会把 24 点油费算成 114 倍）
         AVG(CASE WHEN (COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.deposit'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.kill'), 0)) > 0
             THEN (-(COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.ammo'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.fuel'), 0))) * 1.0
                  / (COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.deposit'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.kill'), 0))
             END) AS avgSupplyShare,
         AVG(CASE WHEN (COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.deposit'), 0) + COALESCE(json_extract(p.stats_json, '$.scoreBreakdown.kill'), 0)) = 0
             THEN 1.0 ELSE 0.0 END) AS zeroOutputRate,`,
  ],
  [
    `  avgSupplyShare: 0,`,
    `  avgSupplyShare: null,
  zeroOutputRate: 0,`,
  ],
  [
    `    avgSupplyShare: round(r.avgSupplyShare, 3),`,
    `    avgSupplyShare: r.avgSupplyShare == null ? null : round(r.avgSupplyShare, 3),
    zeroOutputRate: round(r.zeroOutputRate, 3),`,
  ],
  [
    `  avgSupplyShare: number;
  disqualifiedRate: number;`,
    `  /** 补给花费 / 得分：只在有产出的对局上统计（没有任何产出时为 null，见 zeroOutputRate） */
  avgSupplyShare: number | null;
  /** "一局都没提交也没击杀"的比例：指标不可算的原因，本身也是信号 */
  zeroOutputRate: number;
  disqualifiedRate: number;`,
  ],
]);

patch("apps/server/src/cohorts.ts", [
  [
    `        supplyShare: round((a.ammoSpend + a.fuelSpend) / Math.max(1, a.depositScore + a.killScore), 3),`,
    `        // 与排行榜同口径：没有产出时不给比值（否则 24 点油费会被算成"114 倍"）
        supplyShare: a.depositScore + a.killScore > 0 ? round((a.ammoSpend + a.fuelSpend) / (a.depositScore + a.killScore), 3) : null,
        zeroOutputRate: round(a.zeroOutput / Math.max(1, a.matches), 3),`,
  ],
  [
    `      endgameUnits: number; totalUnits: number;`,
    `      endgameUnits: number; totalUnits: number; zeroOutput: number;`,
  ],
  [
    `          endgameUnits: 0, totalUnits: 0, byLeg: new Map(),`,
    `          endgameUnits: 0, totalUnits: 0, zeroOutput: 0, byLeg: new Map(),`,
  ],
  [
    `        a.totalUnits += st["unitsDeposited"] ?? 0;
        a.endgameUnits += endgameUnits.get(seat.seat)?.last ?? 0;`,
    `        a.totalUnits += st["unitsDeposited"] ?? 0;
        if ((breakdown["deposit"] ?? 0) + (breakdown["kill"] ?? 0) <= 0) a.zeroOutput += 1;
        a.endgameUnits += endgameUnits.get(seat.seat)?.last ?? 0;`,
  ],
]);

patch("apps/server/src/routesCohorts.ts", [
  [
    `      lines.push("| 参赛者 | 局数 | AP 利用率 | 应急移动率 | 每百回合提交 | 终局利用率 | 补给占比 | 死杀差 | 平均决策 | 最慢决策 | 适应力(σ) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");`,
    `      lines.push("| 参赛者 | 局数 | AP 利用率 | 应急移动率 | 每百回合提交 | 终局利用率 | 补给占比 | 无产出局 | 死杀差 | 平均决策 | 最慢决策 | 适应力(σ) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");`,
  ],
  [
    `        lines.push(\`| \${f("agentName")} | \${f("matches")} | \${f("apUtilization")} | \${f("emergencyRate")} | \${f("unitsPer100")} | \${f("endgameShare")} | \${f("supplyShare")} | \${f("killDeathDiff")} | \${f("avgDecisionMs")}ms | \${f("maxDecisionMs")}ms | \${f("adaptivity")} |\`);`,
    `        lines.push(\`| \${f("agentName")} | \${f("matches")} | \${f("apUtilization")} | \${f("emergencyRate")} | \${f("unitsPer100")} | \${f("endgameShare")} | \${r["supplyShare"] ?? "—"} | \${f("zeroOutputRate")} | \${f("killDeathDiff")} | \${f("avgDecisionMs")}ms | \${f("maxDecisionMs")}ms | \${f("adaptivity")} |\`);`,
  ],
]);

patch("apps/web/src/api.ts", [
  [
    `  avgSupplyShare: number;
  disqualifiedRate: number;`,
    `  /** 补给花费 / 得分：只在有产出的对局上统计（无产出时为 null） */
  avgSupplyShare: number | null;
  /** "一局都没提交也没击杀"的比例 */
  zeroOutputRate: number;
  disqualifiedRate: number;`,
  ],
  [
    `  supplyShare: number;
  killDeathDiff: number;`,
    `  supplyShare: number | null;
  zeroOutputRate: number;
  killDeathDiff: number;`,
  ],
]);

patch("apps/web/src/pages/LeaderboardPage.tsx", [
  [
    `                  <td>{r.avgSupplyShare.toFixed(2)}</td>`,
    `                  <td>
                    {r.avgSupplyShare === null || r.avgSupplyShare === undefined ? "—" : r.avgSupplyShare.toFixed(2)}
                    <span className="small muted">（无产出 {((r.zeroOutputRate ?? 0) * 100).toFixed(0)}%）</span>
                  </td>`,
  ],
]);

patch("apps/web/src/pages/CohortsPage.tsx", [
  [
    `                      <td>{fmtNum(m.supplyShare, 2)}</td>`,
    `                      <td>
                        {m.supplyShare === null || m.supplyShare === undefined ? "—" : fmtNum(m.supplyShare, 2)}
                        <span className="small muted">（无产出 {fmtNum((m.zeroOutputRate ?? 0) * 100, 0)}%）</span>
                      </td>`,
  ],
  [
    `                    <th>补给占比</th>`,
    `                    <th>补给占比（无产出局）</th>`,
  ],
  [
    `                <span>AP 利用率 = 1 − 无效动作率（浪费掉的行动力）；终局利用率 = 最后 20% 回合的提交占比（会不会做终局估值）；`,
    `                <span>AP 利用率 = 1 − 无效动作率（浪费掉的行动力）；终局利用率 = 最后 20% 回合的提交占比（会不会做终局估值）；`,
  ],
]);