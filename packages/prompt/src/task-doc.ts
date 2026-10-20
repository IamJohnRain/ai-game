// packages/prompt/src/task-doc.ts —— 外部 Agent 任务书渲染
// 关键设计：协议正文来自 docs/prompts/protocol-core.md（**脚本协议的唯一真相源**），
// 任务书模板只负责"流程 / 上传规范 / 地图规范 / 校验标准"，两者拼在一起就是外部 Agent 需要的全部信息。
// 平台侧的上传闸门、静态扫描禁用清单、数值表都引用同一份来源，因此不会出现"文档说一套、代码做一套"。
//
// 地图部分刻意**不绑定具体地图**：赛事可以用任意合规地图（内置 + 组织者自制），赛图在开赛时才确定。
// 任务书只给"地图规范"（尺寸范围、元素与字符、MAP 结构、资源点语义），逼着脚本按 MAP 现算，
// 而不是把某张图的坐标写死——这与上传校验"对每张注册地图各跑一遍"是同一个设计意图。
import { readFileSync } from "node:fs";
import {
  API_VERSION, MAP_MAX_DIM, MAP_MIN_DIM, TILE_LEGEND, TileCharSchema,
  type GameMap, type Ruleset,
} from "@ai-game/protocol";
import { rulesetToMarkdownTable } from "./rules-table.ts";

export const TASK_DOC_VERSION = "v1.1";

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

export interface TaskDocOptions {
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

/**
 * §6.3 的 `MAP` 结构示例。
 * 它是一个**合法地图**（尺寸/镜像对称/设施声明/连通性都过 validateMap，测试里有断言），
 * 但绝不是任何一场比赛的赛图：字段名与 `GameMap` 同源（少一个必需字段就编译不过），
 * 数值只是示形状。尺寸取允许的最小值 9×9，真实赛图可能大得多。
 */
export const MAP_SPEC_EXAMPLE: GameMap = {
  mapId: "<赛图 id>",
  version: 1,
  width: 9,
  height: 9,
  hint: "示例用图：字段形状示范，不是任何一场比赛的赛图",
  symmetry: "mirror-x-y",
  grid: [
    "..#...#..",
    "..#.B.#..",
    ".S#.R.#S.",
    "..#.D.#..",
    "G.......G",
    "..#.D.#..",
    ".S#.R.#S.",
    "..#.B.#..",
    "..#...#..",
  ],
  spawns: [{ x: 1, y: 2 }, { x: 7, y: 2 }, { x: 1, y: 6 }, { x: 7, y: 6 }],
  spawnsFor1v1: [1, 3],
  ammoDepots: [{ x: 4, y: 1 }, { x: 4, y: 7 }],
  fuelStations: [{ x: 0, y: 4 }, { x: 8, y: 4 }],
  resourceNodes: [
    { id: "R1", x: 4, y: 2, kind: "center", capacity: 10, initial: 10, regenEveryRounds: 6 },
    { id: "R2", x: 4, y: 6, kind: "center", capacity: 10, initial: 10, regenEveryRounds: 6 },
  ],
  depositPoints: [{ x: 4, y: 3 }, { x: 4, y: 5 }],
};

/** §6.2 字符表：字符与含义都从 protocol 取，改引擎就是改任务书 */
function tileTable(): string {
  const rows = TileCharSchema.options.map((c) => `| \`${c}\` | ${TILE_LEGEND[c]} |`);
  return ["| 字符 | 元素与含义 |", "| --- | --- |", ...rows].join("\n");
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

  // ctx 与真实比赛里 onInit(ctx) 拿到的对象同构（字段名来自 protocol 的 Ctx），只是换成"第一人称示例"：
  // 注意 ctx 里**没有地图本身**——地图是全局 MAP（见协议正文 §5.4.2），mapVersion 只是个标签字符串。
  const ctxJson = JSON.stringify(
    {
      apiVersion: API_VERSION,
      rulesetVersion: opts.rules.version,
      mapVersion: "<赛图 id>@<版本>",
      matchId: "<本场比赛 id>",
      seat: 1,
      playerName: "<你的 Agent 名称>",
      seed: 0,
      mySpawn: MAP_SPEC_EXAMPLE.spawns[0]!,
      playerCount: 2,
    },
    null,
    2,
  );

  const vars: Record<string, string> = {
    TASK_DOC_VERSION,
    RULESET_VERSION: opts.rules.version,
    API_VERSION,
    PROMPT_VERSION: SCRIPT_PROTOCOL_VERSION,
    PROTOCOL_CORE: "",
    CTX_JSON: ctxJson,
    MAP_MIN_DIM: String(MAP_MIN_DIM),
    MAP_MAX_DIM: String(MAP_MAX_DIM),
    TILE_TABLE: tileTable(),
    MAP_SPEC_EXAMPLE: JSON.stringify(MAP_SPEC_EXAMPLE, null, 2),
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