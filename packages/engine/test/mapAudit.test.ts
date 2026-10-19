// packages/engine/test/mapAudit.test.ts —— 地图玩法审计的验收
//
// 审计是"地图编辑器 / verify-map / 服务端保存闸门 / 上传校验"共用的判据，
// 所以这里同时盯两件事：结论正确（该报的必须报），以及**绝不在坏数据上抛异常**（编辑器要实时调用它）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_MAPS, DEFAULT_RULESET, type GameMap } from "@ai-game/protocol";
import { auditMap } from "../src/mapAudit.ts";

test("内置地图：审计 0 错误，且实测距离与地图自带的 distanceReference_P1 逐项一致", () => {
  for (const map of Object.values(BUILTIN_MAPS)) {
    const audit = auditMap(map);
    assert.equal(audit.errors.length, 0, `${map.mapId} 不该有审计错误：${audit.errors.join("; ")}`);
    assert.equal(audit.stats.width, map.width);
    assert.equal(audit.stats.spawns, map.spawns.length);
    const ref = (map.distanceReference_P1 ?? {}) as Record<string, unknown>;
    let checked = 0;
    for (const [key, value] of Object.entries(ref)) {
      if (typeof value !== "number") continue; // note 之类的说明字段
      // 地图自带的表里可能还有本审计不产出的项（某张图的专属路线），只校验两边都有的键
      if (!(key in audit.distances)) continue;
      assert.equal(audit.distances[key], value, `${map.mapId} 的 ${key} 应为 ${value}，审计算出 ${audit.distances[key]}`);
      checked += 1;
    }
    assert.ok(checked >= 5, `${map.mapId} 至少应校验 5 项距离，实际 ${checked}`);
  }
});

test("duel-01：四向出生点两两距离完全相等（镜像对称 ⇒ 座次公平）", () => {
  const audit = auditMap(BUILTIN_MAPS["duel-01"]!);
  assert.equal(audit.spawnDistances.length, 6);
  assert.equal(new Set(audit.spawnDistances).size, 1, `两两距离应全部相等：${audit.spawnDistances.join(",")}`);
  assert.equal(audit.spawnDistances[0], 12);
});

test("尺寸与 grid 对不上：只回结构结论，不抛异常、不给假的寻路距离", () => {
  const duel = BUILTIN_MAPS["duel-01"]!;
  const broken: GameMap = { ...duel, width: 80, height: 80 };
  const audit = auditMap(broken);
  assert.ok(audit.errors.some((e) => e.includes("grid 行数")), JSON.stringify(audit.errors));
  assert.ok(audit.errors.some((e) => e.includes("超过上限")));
  assert.deepEqual(audit.distances, {}, "尺寸不一致时不能给出距离");
  assert.deepEqual(audit.spawnDistances, []);
  assert.ok(audit.warnings.some((w) => w.includes("跳过")));
});

test("设施不可达 / 落在障碍上：必须报错误", () => {
  const duel = BUILTIN_MAPS["duel-01"]!;
  // 把提交点换成墙（同时把它的镜像格也换掉，保证错误来源是"不可站"而不是"不对称"）
  const rows = [...duel.grid];
  const [dx, dy] = [duel.depositPoints[0]!.x, duel.depositPoints[0]!.y];
  for (const [x, y] of [[dx, dy], [duel.width - 1 - dx, dy], [dx, duel.height - 1 - dy], [duel.width - 1 - dx, duel.height - 1 - dy]]) {
    rows[y] = rows[y]!.slice(0, x) + "#" + rows[y]!.slice(x + 1);
  }
  const audit = auditMap({ ...duel, grid: rows });
  assert.ok(audit.errors.some((e) => e.includes("不可通行格")), JSON.stringify(audit.errors));
});

test("玩法警告：缺中央资源点 / 缺森林 / 没有墙水 都会被点出来", () => {
  const duel = BUILTIN_MAPS["duel-01"]!;
  // 1) 把所有资源点降级成 home（没有"值得抢"的目标）
  const noCenter = auditMap({
    ...duel,
    resourceNodes: duel.resourceNodes.map((n) => ({ ...n, kind: "home" as const })),
  });
  assert.ok(noCenter.warnings.some((w) => w.includes("center")), JSON.stringify(noCenter.warnings));

  // 2) 全图森林变平地、墙也去掉（无掩体、无遮挡）
  const bare = auditMap({
    ...duel,
    grid: duel.grid.map((row) => row.replace(/f/g, ".").replace(/#/g, (m, i: number) => (i === 0 ? m : "."))),
  });
  assert.ok(bare.warnings.some((w) => w.includes("森林")), JSON.stringify(bare.warnings));
});

test("经济判断：一趟搬运的净收益低于死亡惩罚时必须提示（否则双方会龟缩）", () => {
  const duel = BUILTIN_MAPS["duel-01"]!;
  // 默认规则下这张图是正收益：不该出现这条警告
  const normal = auditMap(duel);
  assert.equal(normal.warnings.filter((w) => w.includes("净收益")).length, 0);

  // 把"货舱价值"压到极低（等价于一张资源换不出分的图）→ 审计必须点出来
  const stingy = auditMap(duel, { ...DEFAULT_RULESET, cargoMax: 1, depositScorePerUnit: 1 });
  assert.ok(stingy.warnings.some((w) => w.includes("净收益")), JSON.stringify(stingy.warnings));
});