// packages/prompt/src/task-doc.ts —— 外部 Agent 任务书渲染
// 关键设计：协议正文来自 docs/prompts/protocol-core.md（**脚本协议的唯一真相源**），
// 任务书模板只负责"流程 / 上传规范 / 本局地图 / 校验标准"，两者拼在一起就是外部 Agent 需要的全部信息。
// 平台侧的上传闸门、静态扫描禁用清单、数值表都引用同一份来源，因此不会出现"文档说一套、代码做一套"。
import { readFileSync } from "node:fs";
import { API_VERSION, renderAscii, type GameMap, type Pos, type Ruleset } from "@ai-game/protocol";
import { compactMapJson, rulesetToMarkdownTable } from "./rules-table.ts";

export const TASK_DOC_VERSION = "v1.0";

/** 脚本协议版本：协议正文（task-doc §5）任何影响脚本行为的改动都必须升这个号 */
export const SCRIPT_PROTOCOL_VERSION = "p1.0";

export interface UploadLimitsPublic {
  zipMaxBytes: number;
  maxEntries: number;
  maxUncompressedBytes: number;
  maxRatio: number;
  maxScriptLines: number;
  maxUploadAttempts: number;
}

export const DEFAULT_UPLOAD_LIMITS_PUBLIC: UploadLimitsPublic = {
  zipMaxBytes: 200 * 1024,
  maxEntries: 8,
  maxUncompressedBytes: 320 * 1024,
  maxRatio: 200,
  maxScriptLines: 600,
  maxUploadAttempts: 10,
};

/** 任务书里给外部 Agent 看的"到各关键位置多少步"，由调用方用寻路实测后传入（可缺省） */
export type DistanceReference = Record<string, number>;

export interface TaskDocOptions {
  map: GameMap;
  rules: Ruleset;
  /** 协议正文（docs/prompts/protocol-core.md）与任务书模板（docs/prompts/task-doc.template.md）的路径 */
  protocolCorePath: string;
  taskDocTemplatePath: string;
  baselineScript: string;
  /** 对外可访问的服务地址，用于拼注册/上传/任务书 URL */
  serverBaseUrl: string;
  limits?: UploadLimitsPublic;
  gamesPerPair?: number;
  turnBudgetMs?: number;
  maxLines?: number;
  /** 距离参考表；缺省时用地图自带的 distanceReference_P1 */
  distances?: DistanceReference;
}

export interface RenderedTaskDoc {
  version: string;
  protocolVersion: string;
  markdown: string;
  limits: UploadLimitsPublic;
  endpoints: {
    register: string;
    upload: string;
    taskDoc: string;
    tournaments: string;
    /** 哪些端点要登录：外部 Agent 只需要免登录的 taskDoc 与 upload */
    requiresLogin: { register: boolean; upload: boolean; taskDoc: boolean; tournaments: boolean };
  };
}

/** 渲染占位符：未提供的占位符原样保留，最后统一检查是否残留 */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_0-9]+)\}\}/g, (m, key: string) => (vars[key] !== undefined ? vars[key]! : m));
}

/** 地图图例 → Markdown 表（自定义地图的图例由编辑器生成） */
function legendTable(map: GameMap): string {
  const legend = map.legend ?? {};
  const chars = Object.keys(legend);
  if (chars.length === 0) return "（本图未单独声明图例，按协议正文 §5.4.2 的通用字符表理解）";
  return ["| 字符 | 含义 |", "| --- | --- |", ...chars.map((c) => `| \`${c}\` | ${legend[c]!.replace(/\|/g, "\\|")} |`)].join("\n");
}

const DISTANCE_LABELS: Record<string, string> = {
  spawn_to_ammoDepot: "出生点 → 最近弹药补给点",
  spawn_to_fuelStation: "出生点 → 最近加油点",
  spawn_to_homeResourceNode: "出生点 → 最近资源点（前哨）",
  spawn_to_centerResourceNode: "出生点 → 中央资源点（高收益）",
  spawn_to_deposit: "出生点 → 提交点",
  spawn_to_oppositeSpawn: "出生点 → 对手出生点",
  centerResourceNode_to_deposit: "中央资源点 → 提交点",
};

/** 距离参考表：数值来自寻路实测（地图 JSON 的 distanceReference_P1 或调用方传入） */
function distanceTable(map: GameMap, distances: DistanceReference | undefined): string {
  const ref = distances ?? ((map.distanceReference_P1 ?? {}) as DistanceReference);
  const entries = Object.entries(ref).filter(([, v]) => typeof v === "number");
  if (entries.length === 0) return "（本图未提供距离参考）";
  const rows = entries.map(([k, v]) => `| ${DISTANCE_LABELS[k] ?? k} | ${v} 步 |`);
  return ["| 路线 | 最短步数 |", "| --- | --- |", ...rows].join("\n");
}

export function renderTaskDoc(opts: TaskDocOptions): RenderedTaskDoc {
  const limits = opts.limits ?? DEFAULT_UPLOAD_LIMITS_PUBLIC;
  const base = opts.serverBaseUrl.replace(/\/+$/, "");
  const endpoints = {
    register: `${base}/api/agents`,
    upload: `${base}/api/upload`,
    taskDoc: `${base}/api/task-doc`,
    tournaments: `${base}/api/tournaments`,
    // 除任务书与上传外，界面与接口都要登录（单账号）；外部 Agent 用不到带会话的那几个
    requiresLogin: { register: true, upload: false, taskDoc: false, tournaments: true },
  };

  const map = opts.map;
  const mySpawn: Pos = map.spawns[0] ?? { x: 0, y: 0 };
  // ctx 与真实比赛里 onInit(ctx) 拿到的对象同构，只是换成"第一人称示例"
  const ctxJson = JSON.stringify(
    {
      schemaVersion: "1.0",
      apiVersion: API_VERSION,
      rulesetVersion: opts.rules.version,
      mapId: map.mapId,
      mapVersion: map.version,
      seat: 1,
      mySpawn,
      playerCount: 2,
      seed: 0,
    },
    null,
    2,
  );

  const vars: Record<string, string> = {
    TASK_DOC_VERSION,
    RULESET_VERSION: opts.rules.version,
    MAP_VERSION: `${map.mapId}@${map.version}`,
    MAP_ID: map.mapId,
    MAP_VERSION_NUM: String(map.version),
    API_VERSION,
    PROMPT_VERSION: SCRIPT_PROTOCOL_VERSION,
    PROTOCOL_CORE: "",
    CTX_JSON: ctxJson,
    MAP_ASCII: renderAscii(map),
    MAP_JSON: compactMapJson(map),
    MAP_LEGEND: legendTable(map),
    DISTANCE_TABLE: distanceTable(map, opts.distances),
    RULES_TABLE: rulesetToMarkdownTable(opts.rules),
    BASELINE_EXAMPLE: opts.baselineScript.trim(),
    REGISTER_URL: endpoints.register,
    UPLOAD_URL: endpoints.upload,
    TASK_DOC_URL: endpoints.taskDoc,
    ZIP_MAX: formatBytes(limits.zipMaxBytes),
    MAX_ENTRIES: String(limits.maxEntries),
    MAX_ENTRY_UNCOMPRESSED: formatBytes(256 * 1024),
    MAX_TOTAL_UNCOMPRESSED: formatBytes(limits.maxUncompressedBytes),
    MAX_RATIO: String(limits.maxRatio),
    MAX_LINES: String(opts.maxLines ?? limits.maxScriptLines),
    MAX_UPLOAD_ATTEMPTS: String(limits.maxUploadAttempts),
    TURN_BUDGET: String(opts.turnBudgetMs ?? 50),
    GAMES_PER_PAIR: String(opts.gamesPerPair ?? 2),
  };

  // 协议正文先渲染（它内部也用了 CTX_JSON / MAX_LINES 等占位符），再整体交给模板
  const core = readFileSync(opts.protocolCorePath, "utf8");
  vars.PROTOCOL_CORE = fill(core, vars).trim();

  const markdown = fill(readFileSync(opts.taskDocTemplatePath, "utf8"), vars);
  const leftover = markdown.match(/\{\{[A-Z_0-9]+\}\}/g);
  if (leftover) throw new Error(`任务书渲染后仍有未替换的占位符：${[...new Set(leftover)].join(", ")}`);

  return { version: TASK_DOC_VERSION, protocolVersion: SCRIPT_PROTOCOL_VERSION, markdown, limits, endpoints };
}

function formatBytes(n: number): string {
  if (n % 1024 === 0) return `${n / 1024} KB`;
  return `${n} 字节`;
}