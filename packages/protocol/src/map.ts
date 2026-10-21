// packages/protocol/src/map.ts —— 地图数据与解析（权威数据：packages/protocol/maps/*.json）
import { z } from "zod";
import type { Pos } from "./pos.ts";

export const TileCharSchema = z.enum([".", "#", "~", "f", "S", "A", "B", "G", "R", "D"]);
export type TileChar = z.infer<typeof TileCharSchema>;

/** 地图尺寸硬约束：编辑器审计、任务书、上传校验共用同一组数字（改这里就是改全局约定） */
export const MAP_MIN_DIM = 9;
export const MAP_MAX_DIM = 64;

/**
 * 地形/设施字符的权威含义（任务书 §6 的字符表、编辑器图例、脚本作者的唯一参考）。
 * 只写"字符 + 元素 + 与 MAP 哪个坐标数组对应"，具体数值一律引用 RULES，避免两处维护。
 */
export const TILE_LEGEND: Record<TileChar, string> = {
  ".": "平地：可通行、不挡视线",
  "#": "墙：阻挡移动，也阻挡视线",
  "~": "水：阻挡移动，但不挡视线（可以隔水对射）",
  f: "森林：可通行、挡视线；站在里面受击伤害按 `RULES.forestDamageMult` 折减，且距离超过 `RULES.forestStealthRadius` 不会被看见",
  S: "出生点：`MAP.spawns` 里的坐标（数组下标 = 座位号 - 1）",
  A: "弹药补给点：`MAP.ammoDepots`（`loadAmmo` 装弹，扣 `RULES.ammoPrice` 分/发）；写了 `capacity` 的点有库存，`state.ammoDepots[].remaining` 可见，拿空后每 `regenEveryRounds` 轮回 1 发",
  B: "弹药补给点：与 `A` 完全等价（不同地图用了不同字符，脚本要同时认这两个）",
  G: "加油点：`MAP.fuelStations`（`refuel` 加油，扣分见 `RULES.fuelPricePer10`）；与弹药点同一套库存规则（`state.fuelStations[].remaining`）",
  R: "资源点：`MAP.resourceNodes`（`collect` 采集，唯一的收入来源）",
  D: "资源提交点：`MAP.depositPoints`（`deposit` 交资源换分）",
};

export const PosSchema = z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() });

/**
 * 补给点（弹药点 A/B、加油点 G）。
 * 只写 x/y = **无限供给**（平台历史行为：站在点上有分就能一直装）；写了 capacity 就变成"有库存"：
 * 起手库存 `initial`（缺省 = capacity），每 `regenEveryRounds` 轮回复 1 点、封顶 capacity，空了就用不了。
 * 与资源点 R 是同一套"容量 / 初始 / 刷新"语义，区别只在资源点供采集、补给点供装弹/加油。
 */
export const SupplyPointSchema = PosSchema.extend({
  capacity: z.number().int().positive().optional(),
  initial: z.number().int().nonnegative().optional(),
  regenEveryRounds: z.number().int().positive().optional(),
});
export type SupplyPoint = z.infer<typeof SupplyPointSchema>;

/**
 * 地图级车辆参数：只写要改的项，其余沿用 RULES。**ammoMax = 0 表示禁止相互攻击**（装不了弹就打不出去，
 * 变成纯经济局）；引擎会把 initial/respawn 夹到新上限之内，否则"上限 0"的图里坦克照样带着初始弹药出门。
 */
export const MapTuningSchema = z.object({
  hpMax: z.number().int().positive().optional(),
  ammoMax: z.number().int().nonnegative().optional(),
  cargoMax: z.number().int().nonnegative().optional(),
});
export type MapTuning = z.infer<typeof MapTuningSchema>;

export const ResourceNodeSchema = z.object({
  id: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  kind: z.enum(["home", "center"]),
  capacity: z.number().int().positive(),
  initial: z.number().int().nonnegative(),
  regenEveryRounds: z.number().int().positive(),
});

export const GameMapSchema = z.object({
  mapId: z.string(),
  version: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** 一句话说明这张图的性格（前端列表与任务书里都会展示） */
  hint: z.string().optional(),
  symmetry: z.string().optional(),
  legend: z.record(z.string()).optional(),
  grid: z.array(z.string()),
  gridNote: z.string().optional(),
  spawns: z.array(PosSchema).min(2),
  spawnsFor1v1: z.array(z.number().int()).optional(),
  ammoDepots: z.array(SupplyPointSchema),
  fuelStations: z.array(SupplyPointSchema),
  resourceNodes: z.array(ResourceNodeSchema),
  depositPoints: z.array(PosSchema),
  /** 车辆参数覆盖（见 MapTuningSchema）；不写 = 全部沿用 RULES */
  tuning: MapTuningSchema.optional(),
  distanceReference_P1: z.record(z.unknown()).optional(),
});
export type GameMap = z.infer<typeof GameMapSchema>;
export type ResourceNode = z.infer<typeof ResourceNodeSchema>;

export class MapValidationError extends Error {}

/** 校验地图：尺寸、镜像对称、grid 与坐标数组一致、连通性。任何比赛开始前必须通过。 */
export function validateMap(map: GameMap): string[] {
  const errs: string[] = [];
  const { width: W, height: H, grid } = map;
  const at = (x: number, y: number): TileChar | "?" => ((grid[y] ?? "")[x] ?? "?") as TileChar | "?";

  if (grid.length !== H) errs.push(`grid 行数 ${grid.length} ≠ height ${H}`);
  grid.forEach((row, y) => {
    if (row.length !== W) errs.push(`第 ${y} 行长度 ${row.length} ≠ width ${W}`);
  });
  // 四角等价的前提：横竖镜像
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (at(x, y) !== at(W - 1 - x, y)) errs.push(`水平镜像不一致 (${x},${y}) '${at(x, y)}' vs '${at(W - 1 - x, y)}'`);
      if (at(x, y) !== at(x, H - 1 - y)) errs.push(`垂直镜像不一致 (${x},${y}) '${at(x, y)}' vs '${at(x, H - 1 - y)}'`);
    }
  }
  // grid 与权威坐标数组一致
  const declared = new Set<string>();
  const check = (key: keyof GameMap, chars: string[]) => {
    for (const p of map[key] as Pos[]) {
      declared.add(`${p.x},${p.y}`);
      if (!chars.includes(at(p.x, p.y))) errs.push(`${String(key)} (${p.x},${p.y}) grid='${at(p.x, p.y)}'，应为 ${chars.join("/")}`);
    }
  };
  check("ammoDepots", ["B", "A"]);
  check("fuelStations", ["G"]);
  check("resourceNodes", ["R"]);
  check("depositPoints", ["D"]);
  check("spawns", ["S"]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ("BAGRSD".includes(at(x, y)) && !declared.has(`${x},${y}`)) {
        errs.push(`grid (${x},${y}) 标记为设施 '${at(x, y)}'，但不在坐标数组里`);
      }
    }
  }
  // 连通性
  const passable = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && at(x, y) !== "#" && at(x, y) !== "~";
  let start: Pos | null = null;
  for (let y = 0; y < H && !start; y++) for (let x = 0; x < W; x++) if (passable(x, y)) { start = { x, y }; break; }
  if (start) {
    const seen = new Set<string>([`${start.x},${start.y}`]);
    const queue: Pos[] = [start];
    while (queue.length) {
      const p = queue.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = p.x + dx, ny = p.y + dy, k = `${nx},${ny}`;
        if (passable(nx, ny) && !seen.has(k)) { seen.add(k); queue.push({ x: nx, y: ny }); }
      }
    }
    let total = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (passable(x, y)) total++;
    if (seen.size !== total) errs.push(`存在孤岛：可通行 ${total} 格，仅 ${seen.size} 格连通`);
  }
  // 关键设施存在性
  if (map.spawns.length < 4 && !map.spawnsFor1v1) errs.push("出生点少于 4 个且未声明 spawnsFor1v1");
  if (map.resourceNodes.length === 0) errs.push("没有资源点");
  if (map.depositPoints.length === 0) errs.push("没有提交点");
  if (map.ammoDepots.length === 0) errs.push("没有弹药补给点");
  if (map.fuelStations.length === 0) errs.push("没有加油点");
  // 补给点：要"有库存"就得说清刷新节奏，缺一样都是作者写漏了（无限供给请整块不写）
  const checkSupply = (key: "ammoDepots" | "fuelStations", label: string) => {
    (map[key] as SupplyPoint[]).forEach((p, i) => {
      const where = `${label} #${i + 1} (${p.x},${p.y})`;
      if (p.capacity === undefined) {
        if (p.initial !== undefined || p.regenEveryRounds !== undefined) {
          errs.push(`${where} 写了 initial/regenEveryRounds 却没写 capacity（无限供给请整块留空）`);
        }
        return;
      }
      if (p.regenEveryRounds === undefined) errs.push(`${where} 有容量却没有刷新间隔 regenEveryRounds`);
      if (p.initial !== undefined && p.initial > p.capacity) {
        errs.push(`${where} 初始库存 ${p.initial} 超过容量 ${p.capacity}`);
      }
    });
  };
  checkSupply("ammoDepots", "弹药点");
  checkSupply("fuelStations", "加油点");
  return errs;
}

export function parseMap(data: unknown): GameMap {
  const map = GameMapSchema.parse(data);
  const errs = validateMap(map);
  if (errs.length) throw new MapValidationError(`地图校验失败:\n${errs.join("\n")}`);
  return map;
}

/** 渲染为 ASCII（用于任务书、地图列表与编辑器预览） */
export function renderAscii(map: GameMap): string {
  return map.grid.join("\n");
}

/** 1v1 时使用的出生点索引（默认取对角：[1,3]） */
export function seatSpawns(map: GameMap, playerCount: number): Pos[] {
  if (playerCount >= 4) return map.spawns;
  const idx = map.spawnsFor1v1 ?? [1, 3];
  return idx.map((i) => map.spawns[i - 1]!).filter(Boolean);
}