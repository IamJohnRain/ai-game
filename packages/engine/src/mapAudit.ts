// packages/engine/src/mapAudit.ts —— 地图"可用性审计"：结构校验之外，还要回答"这张图能不能打"
//
// 与 protocol 的 validateMap() 的分工：
//   validateMap()：数据自洽（尺寸/镜像对称/grid 与坐标数组一致/连通性/设施存在）——不通过就根本加载不了；
//   auditMap()  ：在此基础上做**玩法审计**，供地图编辑器与 verify-map 使用：
//                 设施可达性、出生点等价性、1v1 出生点声明、经济是否正循环、是否容易打成僵局等。
// 审计只给结论（errors / warnings），不抛异常，便于编辑器实时显示。
import {
  DEFAULT_RULESET, MAP_MAX_DIM, MAP_MIN_DIM, chebyshev, effectiveRules, validateMap,
  type GameMap, type Pos, type Ruleset,
} from "@ai-game/protocol";
import { PathFinder } from "./pathfind.ts";
import { buildTerrain, type Terrain } from "./terrain.ts";
import { assignSpawns } from "./setup.ts";

export interface MapAudit {
  mapId: string;
  version: number;
  /** 必须修掉：不修就不该拿去比赛 */
  errors: string[];
  /** 建议关注：能打，但可能不平衡或容易打成僵局 */
  warnings: string[];
  stats: {
    width: number;
    height: number;
    walkable: number;
    wall: number;
    water: number;
    forest: number;
    spawns: number;
    ammoDepots: number;
    fuelStations: number;
    resourceNodes: number;
    depositPoints: number;
  };
  /** 从 1 号出生点出发的最短步数（A* 实测，可直接写进地图的 distanceReference_P1） */
  distances: Record<string, number>;
  /** 两两出生点之间的最短步数（-1 = 不可达；对称图应当全部相等） */
  spawnDistances: number[];
}

const MAX_DIM = MAP_MAX_DIM;
const MIN_DIM = MAP_MIN_DIM;

/** 取离 from 最近的某个坐标集合中的点 */
function nearest(pf: PathFinder, from: Pos, targets: Pos[]): { pos: Pos; steps: number } | null {
  let best: { pos: Pos; steps: number } | null = null;
  for (const t of targets) {
    const path = pf.find(from, t);
    if (!path) continue;
    if (!best || path.length < best.steps) best = { pos: t, steps: path.length };
  }
  return best;
}

/**
 * 审计一张地图。rules 只影响"经济是否正循环"等经验判断，不影响结构结论。
 * 时间复杂度：设施数量 × 一次 A*，对 64×64 的地图也在毫秒级。
 */
export function auditMap(map: GameMap, rules: Ruleset = DEFAULT_RULESET): MapAudit {
  // 玩法判断一律按「地图生效后的规则」算：地图可能把血量/载弹/载货上限调过（见 map.tuning）
  const eff = effectiveRules(rules, map);
  const errors: string[] = [];
  const warnings: string[] = [];
  const count = (c: string) => map.grid.join("").split("").filter((x) => x === c).length;

  // ---------- 结构（复用权威校验器） ----------
  errors.push(...validateMap(map));
  if (map.width > MAX_DIM || map.height > MAX_DIM) {
    errors.push(`地图尺寸 ${map.width}×${map.height} 超过上限 ${MAX_DIM}×${MAX_DIM}（观战渲染与寻路缓存都会退化）`);
  }
  if (map.width < MIN_DIM || map.height < MIN_DIM) {
    errors.push(`地图尺寸 ${map.width}×${map.height} 小于下限 ${MIN_DIM}×${MIN_DIM}（出生点与设施摆不开）`);
  }

  // 尺寸与 grid 对不上时（编辑器改尺寸、手写 JSON 出错），地形位图与坐标数组是错位的：
  // 这时候只回结构结论，绝不去做寻路分析——否则要么抛异常，要么给出看似合理其实错误的距离。
  const dimsOk = map.grid.length === map.height && map.grid.every((row) => row.length === map.width);
  if (!dimsOk || map.width < 2 || map.height < 2) {
    return {
      mapId: map.mapId,
      version: map.version,
      errors: [...new Set(errors)],
      warnings: ["地图尺寸与 grid 不一致，已跳过可达性/经济审计（先修好尺寸再看这张图的玩法）"],
      stats: {
        width: map.width, height: map.height, walkable: 0,
        wall: count("#"), water: count("~"), forest: count("f"),
        spawns: map.spawns.length, ammoDepots: map.ammoDepots.length,
        fuelStations: map.fuelStations.length, resourceNodes: map.resourceNodes.length,
        depositPoints: map.depositPoints.length,
      },
      distances: {},
      spawnDistances: [],
    };
  }

  const terrain: Terrain = buildTerrain(map);
  const pf = new PathFinder(terrain);
  let walkable = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) if (terrain.isWalkable(x, y)) walkable += 1;
  }

  const stats: MapAudit["stats"] = {
    width: map.width,
    height: map.height,
    walkable,
    wall: count("#"),
    water: count("~"),
    forest: count("f"),
    spawns: map.spawns.length,
    ammoDepots: map.ammoDepots.length,
    fuelStations: map.fuelStations.length,
    resourceNodes: map.resourceNodes.length,
    depositPoints: map.depositPoints.length,
  };

  // ---------- 出生点 ----------
  const seenSpawn = new Set<string>();
  for (const [i, sp] of map.spawns.entries()) {
    const key = `${sp.x},${sp.y}`;
    if (seenSpawn.has(key)) errors.push(`第 ${i + 1} 个出生点与前面重复（${key}）`);
    seenSpawn.add(key);
    if (!terrain.isWalkable(sp.x, sp.y)) errors.push(`出生点 ${i + 1} (${sp.x},${sp.y}) 落在墙/水上，坦克无法站立`);
  }
  if (map.spawnsFor1v1) {
    for (const idx of map.spawnsFor1v1) {
      if (!Number.isInteger(idx) || idx < 1 || idx > map.spawns.length) {
        errors.push(`spawnsFor1v1 含非法序号 ${idx}（出生点共 ${map.spawns.length} 个，序号从 1 开始）`);
      }
    }
    if (map.spawnsFor1v1.length !== 2) {
      errors.push(`spawnsFor1v1 应恰好是 2 个出生点，当前 ${map.spawnsFor1v1.length} 个`);
    } else {
      const a = map.spawns[map.spawnsFor1v1[0]! - 1];
      const b = map.spawns[map.spawnsFor1v1[1]! - 1];
      if (a && b && a.x === b.x && a.y === b.y) errors.push("spawnsFor1v1 的两个出生点是同一个点");
    }
  } else if (map.spawns.length < 4) {
    warnings.push("出生点少于 4 个且未声明 spawnsFor1v1：1v1 之外的赛制无法使用这张图");
  }

  // ---------- 出生点之间的对称性 ----------
  const spawnDistances: number[] = [];
  for (let i = 0; i < map.spawns.length; i++) {
    for (let j = i + 1; j < map.spawns.length; j++) {
      const path = pf.find(map.spawns[i]!, map.spawns[j]!);
      spawnDistances.push(path ? path.length : -1);
    }
  }
  if (spawnDistances.some((d) => d < 0)) {
    errors.push("存在互相不可达的出生点（地图对某些座位不公平）");
  } else if (map.spawns.length >= 4) {
    const uniq = new Set(spawnDistances);
    if (uniq.size > 1) {
      warnings.push(`4 个出生点两两距离不一致（${[...uniq].join(" / ")} 步）：镜像对称能保证四角等价，破坏对称会让座次影响胜负`);
    }
  }

  const distances: Record<string, number> = {};
  const homeNodes: Pos[] = map.resourceNodes.filter((n) => n.kind === "home").map((n) => ({ x: n.x, y: n.y }));
  const centerNodes: Pos[] = map.resourceNodes.filter((n) => n.kind === "center").map((n) => ({ x: n.x, y: n.y }));
  const allNodes: Pos[] = map.resourceNodes.map((n) => ({ x: n.x, y: n.y }));

  // ---------- 设施可达性 ----------
  const spawn0 = map.spawns[0];
  if (spawn0) {
    const groups: { name: string; list: Pos[] }[] = [
      { name: "弹药补给点", list: map.ammoDepots },
      { name: "加油点", list: map.fuelStations },
      { name: "资源点", list: allNodes },
      { name: "提交点", list: map.depositPoints },
    ];
    for (const group of groups) {
      if (group.list.length === 0) continue;
      const unreachable = group.list.filter((p) => pf.find(spawn0, p) === null);
      if (unreachable.length > 0) {
        const detail = unreachable.map((p) => `(${p.x},${p.y})`).join(" ");
        const all = unreachable.length === group.list.length ? "（全部不可达 = 这张图打不了）" : "";
        errors.push(`${unreachable.length} 个${group.name}从出生点不可达：${detail}${all}`);
      }
    }
    const onBadTile: string[] = [];
    const facilityLists: [string, Pos[]][] = [
      ["弹药补给点", map.ammoDepots],
      ["加油点", map.fuelStations],
      ["资源点", allNodes],
      ["提交点", map.depositPoints],
    ];
    for (const [name, list] of facilityLists) {
      for (const p of list) if (!terrain.isWalkable(p.x, p.y)) onBadTile.push(`${name}(${p.x},${p.y})`);
    }
    if (onBadTile.length > 0) errors.push(`以下设施落在不可通行格上：${onBadTile.join(" ")}`);

    // ---------- 距离参考（与地图 JSON 的 distanceReference_P1 同口径） ----------
    const put = (key: string, hit: { steps: number } | null) => { if (hit) distances[key] = hit.steps; };
    put("spawn_to_ammoDepot", nearest(pf, spawn0, map.ammoDepots));
    put("spawn_to_fuelStation", nearest(pf, spawn0, map.fuelStations));
    put("spawn_to_homeResourceNode", nearest(pf, spawn0, homeNodes.length ? homeNodes : allNodes));
    put("spawn_to_centerResourceNode", nearest(pf, spawn0, centerNodes.length ? centerNodes : allNodes));
    put("spawn_to_deposit", nearest(pf, spawn0, map.depositPoints));
    put("spawn_to_oppositeSpawn", nearest(pf, spawn0, map.spawns.slice(1)));
    const deposit0 = map.depositPoints[0];
    if (deposit0) put("centerResourceNode_to_deposit", nearest(pf, deposit0, centerNodes.length ? centerNodes : allNodes));

    // ---------- 玩法经验判断 ----------
    const ammo = distances.spawn_to_ammoDepot;
    const fuel = distances.spawn_to_fuelStation;
    if (ammo !== undefined && ammo > 8) warnings.push(`出生点到最近弹药补给点 ${ammo} 步：开局补弹太远，容易一上来就被压制`);
    if (fuel !== undefined && fuel > 8) warnings.push(`出生点到最近加油点 ${fuel} 步：开局必须规划补油，否则会困在半路`);

    const openDist = distances.spawn_to_oppositeSpawn;
    if (openDist !== undefined && openDist <= 6) warnings.push(`对手出生点只有 ${openDist} 步：开局就会撞脸，座次会显著影响胜负`);
    if (openDist !== undefined && openDist > 40) warnings.push(`对手出生点远达 ${openDist} 步：双方可能长期碰不上面，容易打成僵尸局`);

    if (stats.forest === 0) warnings.push("全图没有森林：没有掩体与隐蔽，战斗会退化成纯对射");
    if (stats.wall + stats.water === 0) warnings.push("全图没有墙/水：没有任何遮挡，视线一望到底");
    if (map.depositPoints.some((d) => chebyshev(d, spawn0) <= 1)) {
      warnings.push("提交点紧贴出生点：资源搬运几乎没有风险，可能退化成纯刷分");
    }
  } else {
    warnings.push("地图没有出生点，无法审计距离与可达性");
  }

  // ---------- 经济可持续性 ----------
  const totalSustainable = map.resourceNodes.reduce((sum, n) => sum + n.capacity / n.regenEveryRounds, 0);
  const cargoPerTrip = eff.cargoMax * eff.depositScorePerUnit;
  if (map.resourceNodes.length > 0) {
    const tripSteps = (distances.spawn_to_homeResourceNode ?? 0) + (distances.spawn_to_deposit ?? 0);
    const fuelCost = Math.ceil((tripSteps * eff.moveFuelCost) / 10) * eff.fuelPricePer10;
    if (tripSteps > 0 && cargoPerTrip - fuelCost <= eff.deathPenalty) {
      warnings.push(`一趟搬运净收益仅 ${cargoPerTrip - fuelCost} 分（≈死亡惩罚 ${eff.deathPenalty} 分）：冒险搬资源不划算，双方会倾向龟缩`);
    }
    if (centerNodes.length === 0) warnings.push("没有 kind=center 的高收益资源点：缺少值得抢的目标，容易打成僵局");
    if (totalSustainable < 0.3) warnings.push(`全图资源可持续产出仅 ${totalSustainable.toFixed(2)} 单位/轮：后期会采空`);
  }

  // ---------- 地图级车辆参数 ----------
  // 这些是"作者故意这么调"的旋钮：审计不拦，只把后果说清楚（0 载弹 = 禁止相互攻击最容易被忽略）
  const tuning = map.tuning;
  if (tuning) {
    if (tuning.ammoMax === 0) {
      const minesLeft = eff.mineMax;
      warnings.push(
        minesLeft > 0
          ? `车辆参数：载弹上限 0 —— 炮弹互射被禁，但地雷上限 ${minesLeft}，踩雷照样清空血量（想彻底没战斗就把地雷上限也写 0）`
          : "车辆参数：载弹上限 0 —— 这张图禁止相互攻击，比分只能靠采集与提交",
      );
    } else if (tuning.ammoMax !== undefined && tuning.ammoMax < eff.loadAmmoPerAction) {
      warnings.push(`车辆参数：载弹上限 ${tuning.ammoMax} 发 < 一次装弹 ${eff.loadAmmoPerAction} 发：每次来补给点都装不满上限`);
    }
    if (tuning.cargoMax === 0) warnings.push("车辆参数：载货上限 0 —— 一单位资源都装不下，得分只能来自击杀");
    if (tuning.mineMax === 0) warnings.push("车辆参数：地雷上限 0 —— 这张图没有地雷，布雷动作永远无效（NO_MINE）");
    if (tuning.hpMax !== undefined && tuning.hpMax <= eff.shellDamage) {
      warnings.push(`车辆参数：血量上限 ${tuning.hpMax} ≤ 一炮伤害 ${eff.shellDamage}：一炮一条命，回合数会很短`);
    }
    // 只列真被夹住的项：载货初始本来就是 0，混在里面会让人以为它也被改了
    const clamped: string[] = [];
    if (eff.initial.hp !== rules.initial.hp) clamped.push(`血量 ${eff.initial.hp}`);
    if (eff.initial.ammo !== rules.initial.ammo) clamped.push(`载弹 ${eff.initial.ammo}`);
    if (eff.initial.cargo !== rules.initial.cargo) clamped.push(`载货 ${eff.initial.cargo}`);
    if (eff.initial.mines !== rules.initial.mines) clamped.push(`地雷 ${eff.initial.mines}`);
    if (clamped.length > 0) warnings.push(`上限调低后出生补给会被夹住：${clamped.join(" / ")}（复活同理）`);
  }

  // ---------- 补给点库存 ----------
  // 只有一部分补给点写了容量是最常见的坑：玩家会绕远去"无限"的那几个
  const supplyGroups: { label: string; list: { capacity?: number; regenEveryRounds?: number }[]; perVisit: number }[] = [
    { label: "弹药点", list: map.ammoDepots, perVisit: eff.loadAmmoPerAction },
    { label: "加油点", list: map.fuelStations, perVisit: eff.refuelPerAction },
  ];
  for (const { label, list, perVisit } of supplyGroups) {
    const limited = list.filter((p) => p.capacity !== undefined);
    if (limited.length === 0) continue;
    if (limited.length < list.length) {
      warnings.push(`${label}里只有 ${limited.length}/${list.length} 个写了容量：其余仍是无限供给，玩家会只去无限的那几个`);
    }
    const tiny = limited.filter((p) => (p.capacity ?? 0) < perVisit);
    if (tiny.length > 0) warnings.push(`${tiny.length} 个${label}容量不足一次补给（< ${perVisit}）：跑一趟装不满`);
    const sustainable = limited.reduce((sum, p) => sum + 1 / Math.max(1, p.regenEveryRounds ?? 1), 0);
    if (sustainable < 0.25) warnings.push(`${label}总回复只有 ${sustainable.toFixed(2)} 点/轮：后期基本补给不上，别把图打成废土`);
  }

  return {
    mapId: map.mapId,
    version: map.version,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    stats,
    distances,
    spawnDistances,
  };
}

/** 预览各座位的出生点（1v1 用地图声明的 spawnsFor1v1，否则按人数默认抽签） */
export function previewSpawns(map: GameMap, seatCount: 2 | 3 | 4, seed = 0): { seat: number; pos: Pos }[] {
  return assignSpawns(map, Array.from({ length: seatCount }, (_, i) => i + 1), seed);
}