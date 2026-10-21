// apps/web/src/mapDraft.ts —— 地图编辑器的草稿模型（纯函数，不碰 DOM）
//
// 为什么要有"草稿"这一层：
//   权威地图（GameMap）里地形与设施是**混在一张 grid 字符表**里的，编辑时既要改地形又要增删设施，
//   直接改 GameMap 很容易让两者失步（例如把墙画在有弹药点的格子上）。草稿把两者分开：
//     · terrain：只含地形字符 `.` `#` `~` `f`；
//     · facilities：设施列表（出生点/弹药/加油/资源/提交点，含资源点的产能参数）。
//   toMap() 再把两者叠加成权威 maps JSON 的形状（设施字符覆盖在地形之上）。
//   这样"擦掉设施"天然恢复原地形，"改地形"天然能把越界的设施清掉，不需要额外记账。
//
// 镜像：validateMap() 要求横竖都镜像对称（四角等价 = 座次公平）。编辑器默认开启"镜像锁定"——
// 一次操作同时作用于 4 个镜像格；要自由绘制就切成"自由绘制"，但保存前必须自己把图修对称（校验面板会报）。
import { DEFAULT_RULESET, type GameMap, type MapTuning, type ResourceNode } from "@ai-game/protocol";

export type TerrainChar = "." | "#" | "~" | "f";
export type FacilityKind = "spawn" | "ammo" | "fuel" | "resource" | "deposit";
export type BrushId = TerrainChar | FacilityKind | "erase";
export type MirrorMode = "HV" | "none";

export interface DraftFacility {
  kind: FacilityKind;
  x: number;
  y: number;
  /** 资源点与补给点共用：容量 / 初始量 / 每 N 轮 +1。
   *  补给点**不写容量 = 无限供给**（历史行为）；资源点必须有容量（缺省按 10/10/4 填） */
  capacity?: number;
  initial?: number;
  regenEveryRounds?: number;
  nodeKind?: "home" | "center";
}

export interface MapDraft {
  mapId: string;
  version: number;
  hint: string;
  width: number;
  height: number;
  /** 每行一个字符串，只含地形字符 */
  terrain: string[];
  facilities: DraftFacility[];
  /** 1v1 使用的两个出生点序号（1 基，指向 facilities 里 spawn 的出现顺序） */
  spawnsFor1v1: [number, number];
  mirror: MirrorMode;
  /** 车辆参数：null = 全部跟随 RULES；填了就写进地图 JSON 的 tuning（载弹 0 = 禁止相互攻击） */
  tuning: MapTuning | null;
}

/** 开启"车辆参数"时的默认值：载弹 5（省着打）、载货与血量沿用规则 */
export const DEFAULT_TUNING: Required<MapTuning> = {
  hpMax: DEFAULT_RULESET.hpMax,
  ammoMax: 5,
  cargoMax: DEFAULT_RULESET.cargoMax,
};

export const TERRAIN_CHARS: TerrainChar[] = [".", "#", "~", "f"];

export const BRUSH_LABEL: Record<BrushId, string> = {
  ".": "平地",
  "#": "墙",
  "~": "水",
  f: "森林",
  spawn: "出生点",
  ammo: "弹药补给点",
  fuel: "加油点",
  resource: "资源点",
  deposit: "提交点",
  erase: "橡皮（清设施/地块）",
};

const FACILITY_CHAR: Record<FacilityKind, string> = {
  spawn: "S",
  ammo: "B",
  fuel: "G",
  resource: "R",
  deposit: "D",
};

export const DEFAULT_LEGEND: Record<string, string> = {
  ".": "平地 plain",
  "#": "墙 wall（阻挡移动，阻挡视线）",
  "~": "水 water（阻挡移动，不阻挡视线）",
  f: "森林 forest（可通行，阻挡视线，站在其中受击伤害减半且远处不可见）",
  S: "出生点 spawn",
  B: "弹药补给点 ammo depot",
  G: "加油点 fuel station",
  R: "资源点 resource node",
  D: "资源提交点 deposit",
};

export const DEFAULT_MAX_SPAWNS = 4;

// ---------------------------------------------------------------- 构造

/** 新草稿：四周一圈墙，内部平地（默认就是镜像对称的） */
export function emptyDraft(width = 21, height = 21, mapId = "my-map"): MapDraft {
  const w = clampSize(width);
  const h = clampSize(height);
  const terrain: string[] = [];
  for (let y = 0; y < h; y++) {
    if (y === 0 || y === h - 1) terrain.push("#".repeat(w));
    else terrain.push("#" + ".".repeat(w - 2) + "#");
  }
  return {
    mapId,
    version: 1,
    hint: "",
    width: w,
    height: h,
    terrain,
    facilities: [],
    spawnsFor1v1: [1, 2],
    mirror: "HV",
    // 新图默认带着车辆参数（载弹 5）：想完全跟随规则就把这一栏关掉
    tuning: { ...DEFAULT_TUNING },
  };
}

export function clampSize(v: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 21;
  return Math.max(9, Math.min(48, n));
}

/** 从权威地图导入（内置地图或服务端保存过的自定义地图都能作为起点） */
export function draftFromMap(map: GameMap): MapDraft {
  // grid 里的设施字符还原成"地形 + 设施表"
  const terrain = map.grid.map((row) =>
    [...row].map((ch) => (TERRAIN_CHARS.includes(ch as TerrainChar) ? ch : ".")).join(""),
  );
  const spawns = map.spawns.map((p) => ({ kind: "spawn" as FacilityKind, x: p.x, y: p.y }));
  const facilities: DraftFacility[] = [
    ...spawns,
    ...map.ammoDepots.map((p) => ({
      kind: "ammo" as FacilityKind, x: p.x, y: p.y,
      capacity: p.capacity, initial: p.initial, regenEveryRounds: p.regenEveryRounds,
    })),
    ...map.fuelStations.map((p) => ({
      kind: "fuel" as FacilityKind, x: p.x, y: p.y,
      capacity: p.capacity, initial: p.initial, regenEveryRounds: p.regenEveryRounds,
    })),
    ...map.resourceNodes.map((n) => ({
      kind: "resource" as FacilityKind, x: n.x, y: n.y,
      capacity: n.capacity, initial: n.initial, regenEveryRounds: n.regenEveryRounds, nodeKind: n.kind,
    })),
    ...map.depositPoints.map((p) => ({ kind: "deposit" as FacilityKind, x: p.x, y: p.y })),
  ];
  const s1v1 = map.spawnsFor1v1 && map.spawnsFor1v1.length === 2
    ? [map.spawnsFor1v1[0]!, map.spawnsFor1v1[1]!] as [number, number]
    : [1, Math.min(2, map.spawns.length)] as [number, number];
  return {
    mapId: map.mapId,
    version: map.version,
    hint: map.hint ?? "",
    width: map.width,
    height: map.height,
    terrain,
    facilities,
    spawnsFor1v1: s1v1,
    mirror: "none", // 导入的图已经是成品，默认不强制镜像（免得一画就把原图改形）
    // 导入时**不**凭空给图加车辆参数：只有原图确实写了才带进来（其余留空 = 跟随规则）
    tuning: map.tuning ? { ...DEFAULT_TUNING, ...map.tuning } : null,
  };
}

// ---------------------------------------------------------------- 查询

export function spawnsOf(draft: MapDraft): DraftFacility[] {
  return draft.facilities.filter((f) => f.kind === "spawn");
}

export function facilitiesOf(draft: MapDraft, kind: FacilityKind): DraftFacility[] {
  return draft.facilities.filter((f) => f.kind === kind);
}

export function facilityAt(draft: MapDraft, x: number, y: number): DraftFacility | undefined {
  return draft.facilities.find((f) => f.x === x && f.y === y);
}

export function terrainAt(draft: MapDraft, x: number, y: number): TerrainChar {
  const ch = (draft.terrain[y] ?? "")[x];
  return (TERRAIN_CHARS.includes(ch as TerrainChar) ? ch : ".") as TerrainChar;
}

/** 该格是否可通行（墙与水不可通行）——编辑器里用来提示"设施不能放在这里" */
export function isWalkable(draft: MapDraft, x: number, y: number): boolean {
  const ch = terrainAt(draft, x, y);
  return ch !== "#" && ch !== "~";
}

/** 镜像点集合（含自己；去重） */
export function mirrorPoints(draft: MapDraft, x: number, y: number): { x: number; y: number }[] {
  const w = draft.width;
  const h = draft.height;
  const pts = [{ x, y }];
  if (draft.mirror === "HV") {
    pts.push({ x: w - 1 - x, y }, { x, y: h - 1 - y }, { x: w - 1 - x, y: h - 1 - y });
  }
  const seen = new Set<string>();
  return pts.filter((p) => {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- 编辑（全部返回新对象，便于 undo）

function clone(draft: MapDraft): MapDraft {
  return { ...draft, terrain: [...draft.terrain], facilities: draft.facilities.map((f) => ({ ...f })) };
}

function setTerrainAt(draft: MapDraft, x: number, y: number, ch: TerrainChar): void {
  if (x < 0 || y < 0 || x >= draft.width || y >= draft.height) return;
  const row = draft.terrain[y] ?? "";
  draft.terrain[y] = row.slice(0, x) + ch + row.slice(x + 1);
}

function removeFacilityAt(draft: MapDraft, x: number, y: number): boolean {
  const before = draft.facilities.length;
  draft.facilities = draft.facilities.filter((f) => !(f.x === x && f.y === y));
  return draft.facilities.length !== before;
}

/** 画地形：作用到镜像点；如果新地形不可通行，该格上的设施会被清掉（否则地图自相矛盾） */
export function paintTerrain(draft: MapDraft, x: number, y: number, ch: TerrainChar): MapDraft {
  const next = clone(draft);
  for (const p of mirrorPoints(draft, x, y)) {
    setTerrainAt(next, p.x, p.y, ch);
    if (ch === "#" || ch === "~") removeFacilityAt(next, p.x, p.y);
  }
  return fixSpawnPair(next);
}

/**
 * 放设施：作用到镜像点。
 * 若目标格是墙/水，先把它改成平地（把"拖到障碍上"这种常见误操作变成顺手的自动修正，而不是静默失败）。
 */
export function placeFacility(draft: MapDraft, kind: FacilityKind, x: number, y: number): MapDraft {
  const next = clone(draft);
  for (const p of mirrorPoints(draft, x, y)) {
    if (!isWalkable(next, p.x, p.y)) setTerrainAt(next, p.x, p.y, ".");
    removeFacilityAt(next, p.x, p.y);
  }
  const defaults: Record<FacilityKind, Partial<DraftFacility>> = {
    spawn: {},
    ammo: {},
    fuel: {},
    deposit: {},
    resource: { capacity: 10, initial: 10, regenEveryRounds: 4, nodeKind: "center" },
  };
  if (kind === "spawn" && spawnsOf(next).length >= 8) return draft; // 出生点多到 8 个就没意义了
  for (const p of mirrorPoints(draft, x, y)) {
    next.facilities.push({ kind, x: p.x, y: p.y, ...defaults[kind] });
  }
  return fixSpawnPair(next);
}

/** 橡皮：先清设施，没有设施就把地块恢复成平地 */
export function eraseAt(draft: MapDraft, x: number, y: number): MapDraft {
  const next = clone(draft);
  let removed = false;
  for (const p of mirrorPoints(draft, x, y)) {
    if (removeFacilityAt(next, p.x, p.y)) removed = true;
  }
  if (!removed) {
    for (const p of mirrorPoints(draft, x, y)) setTerrainAt(next, p.x, p.y, ".");
  }
  return fixSpawnPair(next);
}

/** 用当前画笔在 (x,y) 落一笔 */
export function paint(draft: MapDraft, brush: BrushId, x: number, y: number): MapDraft {
  if (brush === "erase") return eraseAt(draft, x, y);
  if (TERRAIN_CHARS.includes(brush as TerrainChar)) return paintTerrain(draft, x, y, brush as TerrainChar);
  return placeFacility(draft, brush as FacilityKind, x, y);
}

/**
 * 出生点被增删后，把 spawnsFor1v1 收敛回合法范围（序号是 1 基，指向 spawn 的出现顺序）。
 * 出生点**保持出现顺序**、不做排序：编辑器里标的 ①②③④ 就是脚本里 MAP.spawns 的顺序。
 */
function fixSpawnPair(draft: MapDraft): MapDraft {
  const count = draft.facilities.filter((f) => f.kind === "spawn").length;
  if (count === 0) return draft;
  const a = clampIndex(draft.spawnsFor1v1[0], count);
  let b = clampIndex(draft.spawnsFor1v1[1], count);
  if (count >= 2 && a === b) b = a === 1 ? 2 : 1;
  return { ...draft, spawnsFor1v1: [a, b] };
}

export function setSpawnsFor1v1(draft: MapDraft, pair: [number, number]): MapDraft {
  const next = clone(draft);
  next.spawnsFor1v1 = pair;
  return fixSpawnPair(next);
}

/**
 * 改"1v1 用哪两个出生点"。两个下拉框绑定同一个 pair：
 * 选中的值如果撞车，就把另一个挪到第一个空位——始终保证是**两个不同的**出生点。
 */
export function setSpawn1v1Slot(draft: MapDraft, slot: 0 | 1, ordinal: number): MapDraft {
  const count = spawnsOf(draft).length;
  if (count < 2) return draft;
  const pair: [number, number] = [...draft.spawnsFor1v1] as [number, number];
  pair[slot] = clampIndex(ordinal, count);
  if (pair[0] === pair[1]) {
    const other = slot === 0 ? 1 : 0;
    pair[other] = firstFree(count, pair[slot]);
  }
  return setSpawnsFor1v1(draft, pair);
}

function firstFree(count: number, taken: number): number {
  for (let i = 1; i <= count; i++) if (i !== taken) return i;
  return taken;
}

export function setNodeParams(draft: MapDraft, index: number, patch: Partial<DraftFacility>): MapDraft {
  const next = clone(draft);
  const node = next.facilities[index];
  if (!node) return draft;
  Object.assign(node, patch);
  return next;
}

/** 车辆参数：传 null = 关掉（跟随 RULES），传 patch = 开启并覆盖对应字段 */
export function setTuning(draft: MapDraft, patch: Partial<MapTuning> | null): MapDraft {
  const next = clone(draft);
  next.tuning = patch === null ? null : { ...DEFAULT_TUNING, ...(next.tuning ?? {}), ...patch };
  return next;
}

/** 补给点参数：capacity 传 undefined 就整块清掉（回到"无限供给"） */
export function setSupplyParams(draft: MapDraft, index: number, patch: Partial<DraftFacility>): MapDraft {
  const next = clone(draft);
  const f = next.facilities[index];
  if (!f) return draft;
  Object.assign(f, patch);
  if (f.capacity === undefined) {
    delete f.initial;
    delete f.regenEveryRounds;
  }
  return next;
}

export function clearFacilities(draft: MapDraft, kind?: FacilityKind): MapDraft {
  const next = clone(draft);
  next.facilities = kind ? next.facilities.filter((f) => f.kind !== kind) : [];
  return next;
}

export function setMeta(draft: MapDraft, patch: Partial<Pick<MapDraft, "mapId" | "version" | "hint" | "mirror">>): MapDraft {
  return { ...clone(draft), ...patch };
}

/** 四周补墙（镜像对称天然满足） / 去掉四周的墙 */
export function borderWall(draft: MapDraft, on: boolean): MapDraft {
  const next = clone(draft);
  const ch: TerrainChar = on ? "#" : ".";
  for (let x = 0; x < next.width; x++) {
    setTerrainAt(next, x, 0, ch);
    setTerrainAt(next, x, next.height - 1, ch);
  }
  for (let y = 0; y < next.height; y++) {
    setTerrainAt(next, 0, y, ch);
    setTerrainAt(next, next.width - 1, y, ch);
  }
  if (on) next.facilities = next.facilities.filter((f) => f.x > 0 && f.y > 0 && f.x < next.width - 1 && f.y < next.height - 1);
  return next;
}

/** 四周是否都是墙（决定改尺寸时新增区域补墙还是补平地） */
function hasBorderWall(draft: MapDraft): boolean {
  for (let x = 0; x < draft.width; x++) {
    if (terrainAt(draft, x, 0) !== "#" || terrainAt(draft, x, draft.height - 1) !== "#") return false;
  }
  for (let y = 0; y < draft.height; y++) {
    if (terrainAt(draft, 0, y) !== "#" || terrainAt(draft, draft.width - 1, y) !== "#") return false;
  }
  return true;
}

/** 改尺寸：保留左上角内容，新增区域按原来的"是否有外墙"补相应字符 */
export function resizeDraft(draft: MapDraft, width: number, height: number): MapDraft {
  const w = clampSize(width);
  const h = clampSize(height);
  const fill: TerrainChar = hasBorderWall(draft) ? "#" : ".";
  const next = clone(draft);
  next.width = w;
  next.height = h;
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    const old = draft.terrain[y] ?? "";
    let row = "";
    for (let x = 0; x < w; x++) {
      if (x < draft.width && y < draft.height) row += old[x] ?? fill;
      else row += fill;
    }
    rows.push(row);
  }
  next.terrain = rows;
  next.facilities = next.facilities.filter((f) => f.x < w && f.y < h);
  return next;
}

/** 一键镜像化：以左上象限为准重建整张图（用于把自由绘制的图修回对称） */
export function mirrorize(draft: MapDraft): MapDraft {
  const next = clone(draft);
  const w = next.width;
  const h = next.height;
  const halfX = Math.ceil(w / 2);
  const halfY = Math.ceil(h / 2);
  const src: TerrainChar[][] = [];
  for (let y = 0; y < halfY; y++) {
    const row: TerrainChar[] = [];
    for (let x = 0; x < halfX; x++) row.push(terrainAt(draft, x, y));
    src.push(row);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(x, w - 1 - x);
      const sy = Math.min(y, h - 1 - y);
      setTerrainAt(next, x, y, src[sy]![sx]!);
    }
  }
  next.facilities = draft.facilities.filter(
    (f) => f.x < halfX && f.y < halfY && next.terrain[f.y]![f.x] !== "#" && next.terrain[f.y]![f.x] !== "~",
  );
  return fixSpawnPair(next);
}

// ---------------------------------------------------------------- 导出为权威地图

/** 草稿 → GameMap（grid 里叠加设施字符，坐标数组与之一一对应） */
export function toMap(draft: MapDraft): GameMap {
  const rows = draft.terrain.map((row) => [...row]);
  // 设施写在 grid 上（同一格只允许一个设施：编辑器在放置时已保证）
  for (const f of draft.facilities) {
    const row = rows[f.y];
    if (!row || f.x < 0 || f.x >= draft.width) continue;
    row[f.x] = FACILITY_CHAR[f.kind];
  }
  const nodes: ResourceNode[] = draft.facilities
    .filter((f) => f.kind === "resource")
    .map((f, i) => ({
      id: `R${i + 1}`,
      x: f.x,
      y: f.y,
      kind: f.nodeKind ?? "center",
      capacity: Math.max(1, Math.round(f.capacity ?? 10)),
      initial: Math.max(0, Math.round(f.initial ?? f.capacity ?? 10)),
      regenEveryRounds: Math.max(1, Math.round(f.regenEveryRounds ?? 4)),
    }));
  const spawns = draft.facilities.filter((f) => f.kind === "spawn").map((f) => ({ x: f.x, y: f.y }));
  const pair: [number, number] = [
    clampIndex(draft.spawnsFor1v1[0], spawns.length),
    clampIndex(draft.spawnsFor1v1[1], spawns.length),
  ];
  if (spawns.length >= 2 && pair[0] === pair[1]) pair[1] = pair[0] === 1 ? 2 : 1;
  /** 补给点 → 权威坐标对象：写了容量才带容量三件套，否则就是"无限供给"（与地图 schema 一致） */
  const supplyPoints = (kind: FacilityKind) => draft.facilities
    .filter((f) => f.kind === kind)
    .map((f) => {
      if (f.capacity === undefined) return { x: f.x, y: f.y };
      const capacity = Math.max(1, Math.round(f.capacity));
      return {
        x: f.x, y: f.y, capacity,
        initial: Math.max(0, Math.min(capacity, Math.round(f.initial ?? capacity))),
        regenEveryRounds: Math.max(1, Math.round(f.regenEveryRounds ?? 4)),
      };
    });
  return {
    mapId: draft.mapId,
    version: Math.max(1, Math.round(draft.version)),
    width: draft.width,
    height: draft.height,
    ...(draft.hint ? { hint: draft.hint } : {}),
    legend: DEFAULT_LEGEND,
    grid: rows.map((r) => r.join("")),
    spawns,
    spawnsFor1v1: pair,
    ammoDepots: supplyPoints("ammo"),
    fuelStations: supplyPoints("fuel"),
    resourceNodes: nodes,
    depositPoints: draft.facilities.filter((f) => f.kind === "deposit").map((f) => ({ x: f.x, y: f.y })),
    ...(draft.tuning ? { tuning: draft.tuning } : {}),
  };
}

function clampIndex(i: number, count: number): number {
  if (count === 0) return 1;
  return Math.max(1, Math.min(count, Math.round(i)));
}

/** 统计（编辑器侧栏显示） */
export function draftStats(draft: MapDraft): {
  wall: number; water: number; forest: number; plain: number; walkable: number;
  spawns: number; ammo: number; fuel: number; resource: number; deposit: number;
} {
  let wall = 0, water = 0, forest = 0, plain = 0;
  for (const row of draft.terrain) {
    for (const ch of row) {
      if (ch === "#") wall++;
      else if (ch === "~") water++;
      else if (ch === "f") forest++;
      else plain++;
    }
  }
  const count = (k: FacilityKind) => draft.facilities.filter((f) => f.kind === k).length;
  return {
    wall, water, forest, plain,
    walkable: plain + forest,
    spawns: count("spawn"), ammo: count("ammo"), fuel: count("fuel"),
    resource: count("resource"), deposit: count("deposit"),
  };
}

/** 草稿的 JSON 文本（导出/复制用；与落盘格式一致） */
export function draftJson(draft: MapDraft): string {
  return `${JSON.stringify(toMap(draft), null, 1)}\n`;
}