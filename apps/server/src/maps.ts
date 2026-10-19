// apps/server/src/maps.ts —— 地图注册表：内置地图 + 编辑器保存的自定义地图
//
// 分工说明：
//   packages/protocol 里的 BUILTIN_MAPS 是"随代码发布"的权威地图（有 JSON 文件 + 文档 ASCII 校验）；
//   本注册表在运行时把 `data/maps/*.json`（地图编辑器保存的图）叠加进来，供 API / 赛事 / 上传校验使用。
// 保存时的把关（这是不可信输入，虽然目前只有一个本地用户在编辑）：
//   形状（zod schema）→ 结构（validateMap）→ 玩法审计（auditMap）→ 重算距离参考 → 落盘。
//   任何一条 errors 非空即拒绝保存；warnings 只回给前端提示，不阻止保存。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditMap, type MapAudit } from "@ai-game/engine";
import { BUILTIN_MAPS, DEFAULT_RULESET, GameMapSchema, type GameMap } from "@ai-game/protocol";

/** 自定义地图 id：小写字母/数字/连字符，必须以字母数字开头结尾 */
export const CUSTOM_MAP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

const DEFAULT_LEGEND: Record<string, string> = {
  ".": "平地 plain",
  "#": "墙 wall（阻挡移动，阻挡视线）",
  "~": "水 water（阻挡移动，不阻挡视线）",
  f: "森林 forest（可通行，阻挡视线，站在其中受击伤害减半且远处不可见）",
  S: "出生点 spawn",
  B: "弹药补给点 ammo depot",
  A: "弹药补给点（同 B）",
  G: "加油点 fuel station",
  R: "资源点 resource node",
  D: "资源提交点 deposit",
};

export interface CustomMapRecord {
  map: GameMap;
  file: string;
  audit: MapAudit;
}

export class MapRegistry {
  private custom = new Map<string, CustomMapRecord>();
  private loadErrors: { file: string; reason: string }[] = [];

  constructor(private dir: string) {
    mkdirSync(this.dir, { recursive: true });
    this.reload();
  }

  /** 从磁盘重新加载自定义地图（服务启动与保存后调用） */
  reload(): { loaded: number; skipped: { file: string; reason: string }[] } {
    this.custom.clear();
    this.loadErrors = [];
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      const path = join(this.dir, file);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        const parsed = GameMapSchema.safeParse(raw);
        if (!parsed.success) throw new Error(`字段不合法：${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        const map = parsed.data;
        if (BUILTIN_MAPS[map.mapId]) throw new Error(`地图 id ${map.mapId} 与内置地图冲突`);
        const audit = auditMap(map, DEFAULT_RULESET);
        if (audit.errors.length > 0) throw new Error(`审计未通过：${audit.errors.slice(0, 2).join("; ")}`);
        this.custom.set(map.mapId, { map, file: path, audit });
      } catch (err) {
        // 一个坏文件不应该让服务起不来：记录并跳过，/api/maps 里会带上跳过原因
        this.loadErrors.push({ file, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { loaded: this.custom.size, skipped: this.loadErrors };
  }

  list(): GameMap[] {
    return [...Object.values(BUILTIN_MAPS), ...[...this.custom.values()].map((r) => r.map)];
  }

  ids(): string[] {
    return this.list().map((m) => m.mapId);
  }

  get(mapId: string): GameMap | null {
    return BUILTIN_MAPS[mapId] ?? this.custom.get(mapId)?.map ?? null;
  }

  isBuiltin(mapId: string): boolean {
    return Boolean(BUILTIN_MAPS[mapId]);
  }

  isCustom(mapId: string): boolean {
    return this.custom.has(mapId);
  }

  getCustom(mapId: string): CustomMapRecord | null {
    return this.custom.get(mapId) ?? null;
  }

  skipped(): { file: string; reason: string }[] {
    return this.loadErrors;
  }

  /**
   * 校验一张待保存的地图（不落盘）。错误为空即"可以保存，也可以直接拿去比赛"。
   * 默认使用 1v1 约定：spawnsFor1v1 缺省填 [1,2]。
   */
  validate(map: GameMap): MapAudit {
    return auditMap(normalizeMap(map), DEFAULT_RULESET);
  }

  /** 校验并保存；返回审计结果（errors 非空时不会写盘） */
  save(map: GameMap): { ok: boolean; audit: MapAudit; detail?: string } {
    if (BUILTIN_MAPS[map.mapId]) {
      const audit = this.validate(map);
      return { ok: false, audit, detail: `地图 id ${map.mapId} 是内置地图，自定义地图请换一个 id（例如 ${map.mapId}-mine）` };
    }
    if (!CUSTOM_MAP_ID_RE.test(map.mapId)) {
      const audit = this.validate(map);
      return { ok: false, audit, detail: `地图 id 不合法：只允许小写字母/数字/连字符（3~32 位，首尾必须是字母或数字），当前 "${map.mapId}"` };
    }
    const normalized = normalizeMap(map);
    const audit = auditMap(normalized, DEFAULT_RULESET);
    if (audit.errors.length > 0) {
      return { ok: false, audit, detail: `审计未通过（${audit.errors.length} 条错误）` };
    }
    // 距离参考由服务端按实测寻路重算：脚本与任务书读到的数字永远是"真跑出来的"
    normalized.distanceReference_P1 = audit.distances;
    normalized.legend = normalized.legend ?? DEFAULT_LEGEND;
    const path = join(this.dir, `${normalized.mapId}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(normalized, null, 1)}\n`, "utf8");
    renameSync(tmp, path); // 先写临时文件再改名：避免落盘一半被读到
    this.custom.set(normalized.mapId, { map: normalized, file: path, audit });
    return { ok: true, audit };
  }

  remove(mapId: string): { ok: boolean; detail?: string } {
    if (BUILTIN_MAPS[mapId]) return { ok: false, detail: "内置地图不能删除" };
    const rec = this.custom.get(mapId);
    if (!rec) return { ok: false, detail: `自定义地图 ${mapId} 不存在` };
    if (existsSync(rec.file)) unlinkSync(rec.file);
    this.custom.delete(mapId);
    return { ok: true };
  }
}

/** 补齐可选字段，让"同一张图无论从哪条路径进来"都长一个样 */
function normalizeMap(map: GameMap): GameMap {
  return {
    ...map,
    ...(map.spawnsFor1v1 ? {} : map.spawns.length >= 2 ? { spawnsFor1v1: [1, 2] } : {}),
    legend: map.legend ?? DEFAULT_LEGEND,
  };
}