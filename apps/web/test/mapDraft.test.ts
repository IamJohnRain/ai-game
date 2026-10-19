// apps/web/test/mapDraft.test.ts —— 地图编辑器草稿模型的验收（纯函数，无 DOM）
//
// 编辑器最容易出错的地方就是"地形与设施失步"（例如把墙画在有弹药点的格子上、删了出生点但 1v1 序号还指着它）。
// 这里把那些不变量钉成测试：托底的是权威校验器 validateMap 与审计 auditMap —— 草稿导出的地图必须能直接参赛。
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_MAPS, validateMap } from "@ai-game/protocol";
import { auditMap } from "@ai-game/engine";
import {
  borderWall, clearFacilities, draftFromMap, draftStats, emptyDraft, eraseAt, facilityAt,
  mirrorize, paint, paintTerrain, placeFacility, resizeDraft, setNodeParams, setSpawn1v1Slot,
  spawnsOf, terrainAt, toMap,
} from "../src/mapDraft.ts";

test("默认草稿：四周墙 + 内部平地，结构自洽（缺设施会被如实报成「还不能用」）", () => {
  const map = toMap(emptyDraft(21, 21, "test-map"));
  assert.equal(map.width, 21);
  assert.equal(map.spawns.length, 0);
  for (let x = 0; x < 21; x++) {
    assert.equal(map.grid[0]![x], "#");
    assert.equal(map.grid[20]![x], "#");
  }
  // 空图不该有"对称/行长度/孤岛"这类结构问题，但必须明确缺设施
  assert.deepEqual(validateMap(map).filter((e) => /镜像|行|孤岛|尺寸/.test(e)), []);
  const audit = auditMap(map);
  for (const needle of ["没有资源点", "没有提交点", "没有弹药补给点", "没有加油点"]) {
    assert.ok(audit.errors.some((e) => e.includes(needle)), `应报出「${needle}」：${audit.errors.join("; ")}`);
  }
});

test("导入内置地图 → 导出：grid / 设施坐标 / 资源点参数逐项还原", () => {
  for (const id of ["duel-01", "arena-01"]) {
    const source = BUILTIN_MAPS[id]!;
    const draft = draftFromMap(source);
    const back = toMap(draft);
    assert.deepEqual(back.grid, source.grid, `${id}: 地形层还原后应与原图完全一致`);
    assert.deepEqual(back.spawns, source.spawns);
    assert.deepEqual(back.ammoDepots, source.ammoDepots);
    assert.deepEqual(back.fuelStations, source.fuelStations);
    assert.deepEqual(back.depositPoints, source.depositPoints);
    assert.deepEqual(
      back.resourceNodes.map((n) => ({ x: n.x, y: n.y, kind: n.kind, capacity: n.capacity, initial: n.initial, regenEveryRounds: n.regenEveryRounds })),
      source.resourceNodes.map((n) => ({ x: n.x, y: n.y, kind: n.kind, capacity: n.capacity, initial: n.initial, regenEveryRounds: n.regenEveryRounds })),
    );
    assert.deepEqual(back.spawnsFor1v1, source.spawnsFor1v1);
    // 还原出来的图仍然通过权威校验与玩法审计
    assert.deepEqual(validateMap(back), []);
    assert.equal(auditMap(back).errors.length, 0, JSON.stringify(auditMap(back).errors));
  }
});

test("镜像锁定：一笔地形/设施同时作用 4 格，且镜像对称天然成立", () => {
  const draft = emptyDraft(21, 21, "mirror-test");
  const withWall = paintTerrain(draft, 5, 4, "#");
  for (const [x, y] of [[5, 4], [15, 4], [5, 16], [15, 16]]) {
    assert.equal(terrainAt(withWall, x, y), "#", `(${x},${y}) 应被镜像画到`);
  }
  assert.equal(validateMap(toMap(withWall)).filter((e) => e.includes("镜像")).length, 0);

  const withSpawn = placeFacility(withWall, "spawn", 3, 3);
  assert.equal(spawnsOf(withSpawn).length, 4, "镜像锁定下一次放 4 个出生点");
  assert.equal(validateMap(toMap(withSpawn)).filter((e) => e.includes("镜像")).length, 0);
  assert.equal(auditMap(toMap(withSpawn)).errors.length > 0, true, "还没有资源点/提交点时应当报错");
});

test("自由绘制模式：不再镜像，但校验器会把不对称如实报出来", () => {
  const free = { ...emptyDraft(21, 21, "free-test"), mirror: "none" as const };
  const broken = paintTerrain(free, 5, 4, "#");
  assert.equal(terrainAt(broken, 15, 4), ".", "自由绘制不应改镜像格");
  assert.ok(validateMap(toMap(broken)).some((e) => e.includes("镜像")));
  // 一键镜像化之后应当修好
  const fixed = mirrorize(broken);
  assert.equal(validateMap(toMap(fixed)).filter((e) => e.includes("镜像")).length, 0);
  assert.equal(terrainAt(fixed, 15, 4), "#");
});

test("设施与地形不会失步：设施只占一层，改地形会连带清理越界的设施", () => {
  // 单格语义用「自由绘制」最清楚；镜像模式的作用范围在别的用例里单独测
  const solo = { ...emptyDraft(21, 21, "sync-test"), mirror: "none" as const };

  const base = placeFacility(solo, "ammo", 6, 6);
  assert.equal(facilityAt(base, 6, 6)?.kind, "ammo");
  assert.equal(spawnsOf(base).length, 0);

  // 先画森林再放设施：地形保留，设施单独一层，导出时设施字符覆盖在地形之上
  const onForest = placeFacility(paintTerrain(solo, 8, 8, "f"), "fuel", 8, 8);
  assert.equal(terrainAt(onForest, 8, 8), "f", "设施不该覆盖地形");
  assert.equal(facilityAt(onForest, 8, 8)?.kind, "fuel");
  const map = toMap(onForest);
  assert.equal(map.grid[8]![8], "G", "导出时设施字符覆盖在森林之上");
  assert.deepEqual(map.fuelStations, [{ x: 8, y: 8 }]);

  // 擦掉设施 → 恢复出它下面的森林
  const erased = eraseAt(onForest, 8, 8);
  assert.equal(facilityAt(erased, 8, 8), undefined);
  assert.equal(terrainAt(erased, 8, 8), "f", "擦设施不该把地形也抹平");
  assert.equal(toMap(erased).grid[8]![8], "f");

  // 把墙画到弹药点上 → 该格设施必须消失，grid 里不能留「孤儿设施字符」
  const walled = paintTerrain(base, 6, 6, "#");
  assert.equal(facilityAt(walled, 6, 6), undefined);
  assert.equal(toMap(walled).ammoDepots.length, 0);
  assert.deepEqual(validateMap(toMap(walled)).filter((e) => e.includes("不在坐标数组里")), []);
  assert.deepEqual(validateMap(toMap(walled)).filter((e) => e.includes("应为")), []);
});

test("放设施在墙/水上会自动把那一格改成平地（把常见误操作变成顺手的修正）", () => {
  const draft = emptyDraft(21, 21, "auto-floor");
  const onBorder = placeFacility(draft, "deposit", 0, 0); // 左上角是外墙
  assert.equal(terrainAt(onBorder, 0, 0), ".", "应当自动改成平地");
  assert.equal(facilityAt(onBorder, 0, 0)?.kind, "deposit");
  const onBorderMirror = facilityAt(onBorder, 20, 20);
  assert.equal(onBorderMirror?.kind, "deposit", "镜像格同样处理");
});

test("出生点序号与 1v1 用点：删除出生点后序号自动收敛，两个槽位永不相同", () => {
  let draft = placeFacility(emptyDraft(21, 21, "spawn-test"), "spawn", 2, 2);
  assert.equal(spawnsOf(draft).length, 4);
  assert.deepEqual(draft.spawnsFor1v1, [1, 2]);

  // 手动把两个槽位选成同一个：应当自动把另一个挪开
  draft = setSpawn1v1Slot(draft, 1, draft.spawnsFor1v1[0]);
  assert.notEqual(draft.spawnsFor1v1[0], draft.spawnsFor1v1[1]);

  // 删掉 1 号与 2 号出生点（镜像会一次删 4 个，这里先切自由绘制只删一个）
  const free = { ...draft, mirror: "none" as const };
  const s0 = spawnsOf(free)[0]!;
  const removed = eraseAt(free, s0.x, s0.y);
  assert.equal(spawnsOf(removed).length, 3);
  const ordinals = spawnsOf(removed).length;
  assert.ok(removed.spawnsFor1v1.every((i) => i >= 1 && i <= ordinals), `1v1 序号越界：${removed.spawnsFor1v1}`);
  assert.notEqual(removed.spawnsFor1v1[0], removed.spawnsFor1v1[1]);
  assert.deepEqual(validateMap(toMap(removed)).filter((e) => e.includes("spawnsFor1v1")), []);
});

test("资源点参数：类型/容量/回复间隔能通过面板改，并如实反映到导出结果", () => {
  const draft = placeFacility(emptyDraft(21, 21, "node-test"), "resource", 10, 10);
  const idx = draft.facilities.findIndex((f) => f.kind === "resource");
  const tuned = setNodeParams(draft, idx, { capacity: 20, initial: 8, regenEveryRounds: 2, nodeKind: "home" });
  const node = toMap(tuned).resourceNodes[0]!;
  assert.deepEqual(
    { kind: node.kind, capacity: node.capacity, initial: node.initial, regen: node.regenEveryRounds },
    { kind: "home", capacity: 20, initial: 8, regen: 2 },
  );
  // 资源点没有上下限约束（编辑器只保证 >=1），但产出会反映在统计里
  assert.equal(toMap(tuned).resourceNodes[0]!.id, "R1");
});

test("改尺寸 / 清空：保留左上角内容、新增区域跟随外墙风格、越界设施被丢弃", () => {
  const base = placeFacility(emptyDraft(21, 21, "resize-test"), "deposit", 2, 2);
  const bigger = resizeDraft(base, 31, 25);
  assert.equal(bigger.width, 31);
  assert.equal(bigger.height, 25);
  assert.equal(facilityAt(bigger, 2, 2)?.kind, "deposit", "原内容保留");
  assert.equal(terrainAt(bigger, 0, 24), "#", "新增区域跟随外墙风格");
  assert.equal(terrainAt(bigger, 30, 0), "#");

  const smaller = resizeDraft(base, 9, 9);
  assert.equal(smaller.width, 9);
  assert.equal(facilityAt(smaller, 2, 2)?.kind, "deposit");
  assert.ok(smaller.facilities.every((f) => f.x < 9 && f.y < 9));

  const cleared = clearFacilities(bigger);
  assert.equal(cleared.facilities.length, 0);
  assert.equal(draftStats(cleared).deposit, 0);

  // 去掉/加回外墙都是对称的
  const noBorder = borderWall(base, false);
  assert.equal(terrainAt(noBorder, 0, 0), ".");
  assert.deepEqual(validateMap(toMap(noBorder)).filter((e) => e.includes("镜像")), []);
});

test("设计一张能打的图：拖几笔之后审计必须是 0 错误（编辑器的核心承诺）", () => {
  // 目标：在 17×17 上快速造一张「南北对峙」的决斗图
  let draft = emptyDraft(17, 17, "quick-duel");
  draft = paint(draft, "spawn", 8, 2);        // 中轴线上的出生点 → 镜像成南北 2 个
  draft = paint(draft, "deposit", 8, 8);      // 正中央唯一提交点
  draft = paint(draft, "resource", 7, 8);     // 紧邻提交点的资源点（镜像成左右 2 个）
  draft = paint(draft, "resource", 4, 4);     // 前哨资源点（镜像成 4 个）
  draft = paint(draft, "ammo", 6, 2);         // 开局补弹（镜像成 4 个）
  draft = paint(draft, "fuel", 8, 4);         // 中轴加油点（镜像成南北 2 个）
  draft = paint(draft, "f", 5, 6);            // 一点掩体，免得审计提示「全图没有森林」

  const map = toMap(draft);
  assert.deepEqual(validateMap(map), []);
  const audit = auditMap(map);
  assert.equal(audit.errors.length, 0, `这张图不该有审计错误：${audit.errors.join("; ")}`);
  // 中轴线上的设施镜像后会和自己重合，去重后只剩南北 2 个
  assert.equal(audit.stats.spawns, 2);
  assert.equal(audit.stats.depositPoints, 1);
  assert.equal(audit.stats.resourceNodes, 6);
  assert.equal(audit.stats.ammoDepots, 4);
  assert.equal(audit.stats.forest, 4);
  assert.equal(audit.spawnDistances[0], 12);
  assert.ok(audit.distances.spawn_to_deposit! > 0);
  // 这张图「想得分就得进中央」，符合设计意图
  assert.equal(audit.distances.centerResourceNode_to_deposit, 1);
});