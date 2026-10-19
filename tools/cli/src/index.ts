#!/usr/bin/env node
// tools/cli/src/index.ts —— 平台命令行：地图校验/审计、平衡性仿真、脚本准入检查、外部 Agent 流程自测
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_RULESET, BUILTIN_MAPS, DEFAULT_MAP_1V1, defaultMapId, renderAscii, type GameMap, type Ruleset } from "@ai-game/protocol";
import { assignSpawns, auditMap, LocalController, runMatch } from "@ai-game/engine";
import { QuickJsController } from "@ai-game/sandbox";
import { checkScript, generateFuzzStates } from "@ai-game/script-check";
import { extractScript } from "@ai-game/script-extract";
import { DEFAULT_UPLOAD_LIMITS_PUBLIC, renderTaskDoc } from "@ai-game/prompt";
import { createZip, readZip, DEFAULT_UPLOAD_LIMITS } from "@ai-game/zippack";
import { validateMap } from "@ai-game/protocol";
import { runDemo } from "./demo.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASELINE_PATH = join(repoRoot, "docs", "examples", "baseline-strategy.js");
const TASK_DOC_TEMPLATE_PATH = join(repoRoot, "docs", "prompts", "task-doc.template.md");
const PROTOCOL_CORE = join(repoRoot, "docs", "prompts", "protocol-core.md");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function positional(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith("--"));
}
function intArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * --map 既接受内置地图 id，也接受一个 JSON 文件路径（地图编辑器导出的草稿，或 data/maps/*.json）。
 * 路径形式让"还没保存到服务端的地图"也能走 CLI 的全部校验与仿真。
 */
function loadMap(mapId: string = DEFAULT_MAP_1V1): GameMap {
  if (mapId.endsWith(".json")) return JSON.parse(readFileSync(mapId, "utf8")) as GameMap;
  const map = BUILTIN_MAPS[mapId];
  if (!map) throw new Error(`未知地图 ${mapId}（内置：${Object.keys(BUILTIN_MAPS).join(", ")}；也可以直接给一个 .json 路径）`);
  return map;
}

function loadRules(): Ruleset {
  const maxRounds = arg("maxRounds");
  const killReward = arg("killReward");
  return {
    ...DEFAULT_RULESET,
    ...(maxRounds ? { maxRounds: Number(maxRounds) } : {}),
    ...(killReward ? { killReward: Number(killReward) } : {}),
  };
}

// ---------------------------------------------------------------- verify-map
// 不传路径时校验 maps/ 下的全部地图，并断言「文件 ↔ BUILTIN_MAPS 注册表」双向一致
function cmdVerifyMap(): void {
  const mapsDir = join(repoRoot, "packages", "protocol", "maps");
  const explicit = positional()[1];
  const files = explicit ? [explicit] : readdirSync(mapsDir).filter((f) => f.endsWith(".json")).map((f) => join(mapsDir, f));
  let failed = false;
  const seen = new Set<string>();
  for (const path of files) {
    const map = JSON.parse(readFileSync(path, "utf8")) as GameMap;
    seen.add(map.mapId);
    const errs = validateMap(map);
    console.log(`\n--- ${map.mapId}@${map.version}（${path.replace(repoRoot + "\\", "").replace(repoRoot + "/", "")}）---`);
    console.log(renderAscii(map));
    if (errs.length) {
      failed = true;
      console.error(`❌ 地图校验失败（${errs.length}）：\n` + errs.join("\n"));
      continue;
    }
    const count = (c: string) => map.grid.join("").split("").filter((x) => x === c).length;
    console.log(`✅ ${map.mapId}@${map.version} 结构校验通过：${map.width}×${map.height}，墙 ${count("#")}、水 ${count("~")}、森林 ${count("f")}、` +
      `出生点 ${count("S")}、弹药 ${count("A") + count("B")}、加油 ${count("G")}、资源点 ${count("R")}、提交点 ${count("D")}`);
    // 1v1 出生点声明必须真的能用
    if (map.spawnsFor1v1) {
      const bad = map.spawnsFor1v1.filter((i) => i < 1 || i > map.spawns.length);
      if (bad.length) { failed = true; console.error(`❌ spawnsFor1v1 指向不存在的出生点：${bad.join(", ")}`); }
    }
    // 玩法审计：与地图编辑器、服务端保存闸门用的是同一套判据（可达性/等价性/经济正循环/僵局风险）
    const audit = auditMap(map);
    console.log(`   玩法审计：可通行 ${audit.stats.walkable} 格；出生点两两距离 ${audit.spawnDistances.join(" / ") || "-"} 步；` +
      `出生点→提交点 ${audit.distances.spawn_to_deposit ?? "-"} 步、→中心资源点 ${audit.distances.spawn_to_centerResourceNode ?? "-"} 步`);
    for (const w of audit.warnings) console.log(`   ⚠️ ${w}`);
    if (audit.errors.length) {
      failed = true;
      console.error(`   ❌ 玩法审计发现 ${audit.errors.length} 个问题：\n     ` + audit.errors.join("\n     "));
    }
  }
  const registered = Object.keys(BUILTIN_MAPS);
  const missing = [...seen].filter((id) => !registered.includes(id));
  const orphan = registered.filter((id) => !seen.has(id));
  if (!explicit && (missing.length || orphan.length)) {
    failed = true;
    console.error(`\n❌ 地图注册表不一致：未注册到 BUILTIN_MAPS 的图 [${missing.join(", ")}]；注册了但没有文件的图 [${orphan.join(", ")}]`);
  }
  if (failed) process.exit(1);
}

// ---------------------------------------------------------------- check-docs
// 文档里的每张地图 ASCII 用 <!-- map:<mapId> --> 标记，逐张与权威 JSON 对比；
// 新增地图如果不写进文档，这里会直接报错（防止文档漏掉新图）。
function cmdCheckDocs(): void {
  const errors: string[] = [];
  const rulesDoc = readFileSync(join(repoRoot, "docs", "02-游戏规则-v1.md"), "utf8");

  // 1) 地图 ASCII：标记 → 紧随其后的代码块必须与对应 JSON 的 grid 完全一致
  const markered = new Map<string, string[]>();
  const markerRe = /<!--\s*map:([a-z0-9-]+)\s*-->[\s\S]*?```\n([\s\S]*?)```/g;
  for (const m of rulesDoc.matchAll(markerRe)) {
    const rows = m[2]!.split("\n").map((l) => l.replace(/^y=\d+\s*/, "").trim()).filter((l) => l.length > 0);
    markered.set(m[1]!, rows);
  }
  for (const [mapId, map] of Object.entries(BUILTIN_MAPS)) {
    const rows = markered.get(mapId);
    if (!rows) { errors.push(`docs/02 里找不到 <!-- map:${mapId} --> 标记的 ASCII 地图代码块`); continue; }
    if (rows.length !== map.grid.length) errors.push(`${mapId} ASCII 行数 ${rows.length} ≠ ${map.grid.length}`);
    map.grid.forEach((row, i) => {
      if (rows[i] !== row) errors.push(`${mapId} ASCII 第 ${i} 行不一致：\n  文档: ${rows[i]}\n  权威: ${row}`);
    });
  }
  for (const mapId of markered.keys()) {
    if (!BUILTIN_MAPS[mapId]) errors.push(`docs/02 里的地图标记 <!-- map:${mapId} --> 不在内置地图注册表里`);
  }

  // 2) 文档里的参数表必须与 DEFAULT_RULESET 一致（抽查关键数值）
  const expectNumbers: [string, number][] = [
    ["`maxRounds` | 150", 150], ["`apPerTurn` | 2", 2], ["`hpMax` | 100", 100],
    ["`ammoMax` | 20", 20], ["`fuelMax` | 100", 100], ["`cargoMax` | 5", 5],
    ["`moveFuelCost` | 2", 2], ["`ammoPrice` | 2", 2], ["`deathPenalty` | 20", 20], ["`killReward` | 20", 20],
    ["`respawnRounds` | 3", 3], ["`fireRange` | 8", 8], ["`shellDamage` | 20", 20],
  ];
  for (const [needle, value] of expectNumbers) {
    if (!rulesDoc.includes(needle)) {
      errors.push(`docs/02 参数表缺少或改动了 "${needle}"（应为 ${value}）`);
    }
  }
  // 3) 任务书模板 + 协议正文的占位符必须都能被渲染器替换（渲染器只认 [A-Z_0-9]+ 形式的占位符）
  const taskDocTpl = readFileSync(TASK_DOC_TEMPLATE_PATH, "utf8");
  const core = readFileSync(PROTOCOL_CORE, "utf8");
  const taskDocPlaceholders = [
    "{{TASK_DOC_VERSION}}", "{{RULESET_VERSION}}", "{{MAP_VERSION}}", "{{MAP_ID}}", "{{MAP_VERSION_NUM}}",
    "{{MAP_ASCII}}", "{{MAP_JSON}}", "{{MAP_LEGEND}}", "{{DISTANCE_TABLE}}", "{{RULES_TABLE}}", "{{BASELINE_EXAMPLE}}",
    "{{REGISTER_URL}}", "{{UPLOAD_URL}}", "{{TASK_DOC_URL}}", "{{ZIP_MAX}}", "{{MAX_LINES}}", "{{PROTOCOL_CORE}}",
  ];
  for (const ph of taskDocPlaceholders) {
    if (!taskDocTpl.includes(ph)) errors.push(`任务书模板缺少占位符 ${ph}`);
  }
  // 协议正文只带"与脚本自身相关"的占位符；地图/数值由任务书第 6、7 节负责（避免一处数字两处维护）
  const corePlaceholders = ["{{CTX_JSON}}", "{{MAX_LINES}}", "{{PROMPT_VERSION}}"];
  for (const ph of corePlaceholders) {
    if (!core.includes(ph)) errors.push(`协议正文 docs/prompts/protocol-core.md 缺少占位符 ${ph}`);
  }
  // 正文里必须留下"去哪儿看地图/数值"的指针，否则换图/改数值时脚本作者会读不到最新信息
  for (const needle of ["第 6 节", "第 7 节"]) {
    if (!core.includes(needle)) errors.push(`协议正文没有指向任务书 ${needle}（地图与数值表的出处）`);
  }

  // 4) 协议正文里的规则数值必须**引用 RULES 字段**而不是写死数字。
  //    历史 bug：正文写"死亡扣 30 分"、参数表是 20 —— 这类漂移由这条检查拦住。
  const rulesReferences = [
    "视野半径 `RULES.visionRadius` 格",
    "射程 ≤ `RULES.fireRange`",
    "命中 `RULES.shellDamage` 点",
    "载货上限 `RULES.cargoMax`",
    "扣 `RULES.deathPenalty` 分",
    "跳过 `RULES.respawnRounds` 个自己的回合",
  ];
  for (const needle of rulesReferences) {
    if (!core.includes(needle)) {
      errors.push(`协议正文没有引用规则字段（应写成「${needle}」）：写死数字会与 ruleset-${DEFAULT_RULESET.version} 漂移`);
    }
  }

  if (errors.length) {
    console.error(`❌ 文档一致性检查失败（${errors.length}）：\n` + errors.join("\n"));
    process.exit(1);
  }
  console.log("✅ 文档一致性检查通过：ASCII 地图、参数表、任务书与协议正文占位符均与代码同源");
}

// ---------------------------------------------------------------- simulate
async function cmdSimulate(): Promise<void> {
  const games = intArg("games", 20);
  const seatCount = intArg("seats", 4);
  const scriptPath = arg("script");
  const script = scriptPath ? readFileSync(scriptPath, "utf8") : readFileSync(BASELINE_PATH, "utf8");
  const rules = loadRules();
  const map = loadMap(arg("map", defaultMapId(seatCount))!);
  const baseSeed = intArg("seed", 20261019);
  const useSandbox = flag("sandbox");

  const scores: number[] = [];
  const perSeat: number[][] = Array.from({ length: seatCount }, () => []);
  const depositTotals: number[] = [];
  const invalidTotals: number[] = [];
  const strikeTotals: number[] = [];
  const deathTotals: number[] = [];
  const fireTotals: number[] = [];
  const hitTotals: number[] = [];
  const killTotals: number[] = [];
  const firstFireRounds: number[] = [];
  const contactGames: boolean[] = [];
  let totalMs = 0;

  for (let g = 0; g < games; g++) {
    const seed = baseSeed + g;
    const seats = Array.from({ length: seatCount }, (_, i) => i + 1);
    const controller = useSandbox ? await QuickJsController.create() : new LocalController();
    for (const s of seats) controller.load(s, script);
    const t0 = performance.now();
    const res = runMatch({
      matchId: `sim-${g}`, map, rules, seed,
      seats: seats.map((s) => ({ seat: s, name: `P${s}`, scriptHash: "baseline" })),
      spawns: assignSpawns(map, seats, seed),
      controller,
    });
    totalMs += performance.now() - t0;
    controller.dispose();
    for (const st of res.ranking) {
      scores.push(st.score);
      perSeat[st.seat - 1]!.push(st.score);
      invalidTotals.push(st.invalidActions);
      strikeTotals.push(st.strikes);
      deathTotals.push(st.deaths);
    }
    depositTotals.push(res.ranking.reduce((s, r) => s + r.unitsDeposited, 0));
    killTotals.push(res.ranking.reduce((s, r) => s + r.kills, 0));

    // 交战统计：开火/命中事件数 + 第一次开火发生在第几轮（用 turn_begin 跟踪轮次）
    let round = 0, fires = 0, hits = 0, firstFire = -1;
    for (const ev of res.events) {
      if (ev.t === "turn_begin") round = ev.round;
      else if (ev.t === "fire") {
        fires += 1;
        if (ev.hit) hits += 1;
        if (firstFire < 0) firstFire = round;
      }
    }
    fireTotals.push(fires);
    hitTotals.push(hits);
    if (firstFire >= 0) firstFireRounds.push(firstFire);
    contactGames.push(fires > 0);
    if (games <= 5) {
      console.log(`局 ${g + 1}: ` + res.ranking.map((r) => `P${r.seat}=${r.score}`).join("  ") +
        `　（开火 ${fires}、命中 ${hits}、首次交火第 ${firstFire < 0 ? "-" : firstFire} 轮）`);
    }
  }

  const avg = (xs: number[]) => xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;
  const sd = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.round(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) * 10) / 10;
  };
  const sorted = [...scores].sort((a, b) => a - b);
  console.log(`\n=== 仿真报告（${games} 局 × ${seatCount} 座，地图 ${map.mapId}@${map.version}，${useSandbox ? "沙箱" : "本地"}执行，规则 ruleset-${rules.version}）===`);
  console.log(`得分：均值 ${avg(scores)}　标准差 ${sd(scores)}　最低 ${sorted[0]}　中位 ${sorted[Math.floor(sorted.length / 2)]}　最高 ${sorted[sorted.length - 1]}`);
  console.log(`每个座位均值：` + perSeat.map((xs, i) => `P${i + 1}=${avg(xs)}`).join("  "));
  console.log(`每局平均提交单位 ${avg(depositTotals)}　平均死亡 ${avg(deathTotals)} 次/座　平均无效动作 ${avg(invalidTotals)}　平均 strike ${avg(strikeTotals)}`);
  console.log(`交战：${contactGames.filter(Boolean).length}/${games} 局发生交火　平均开火 ${avg(fireTotals)} 次/局　平均命中 ${avg(hitTotals)} 次/局　平均击杀 ${avg(killTotals)} 次/局　首次交火平均第 ${avg(firstFireRounds)} 轮`);
  console.log(`单局平均耗时 ${Math.round(totalMs / games)}ms（含 ${seatCount} 个沙箱实例的创建与执行）`);
}

// ---------------------------------------------------------------- check (单个脚本走准入流水线)
// 默认对**全部内置地图**跑一遍（与服务端上传闸门一致）：脚本只在一张图上通过不算通过。
async function cmdCheck(): Promise<void> {
  const file = arg("file");
  const response = arg("response");
  if (!file && !response) throw new Error("用法：check --file <script.js> 或 --response <模型回复.txt>");
  const mapIds = arg("map") ? [arg("map")!] : Object.keys(BUILTIN_MAPS);
  const rules = loadRules();
  const scriptText = file ? readFileSync(file, "utf8") : undefined;
  const responseText = response ? readFileSync(response, "utf8") : undefined;
  let failed = false;
  for (const mapId of mapIds) {
    const res = await checkScript({
      ...(scriptText !== undefined ? { script: scriptText } : {}),
      ...(responseText !== undefined ? { response: responseText } : {}),
      map: loadMap(mapId), rules,
      fuzzCount: intArg("fuzz", 200),
      smokeRounds: intArg("rounds", 40),
    });
    if (!res.ok) failed = true;
    console.log(`\n【${mapId}】结论：${res.ok ? "✅ 通过" : `❌ ${res.status}`}`);
    console.log(`脚本哈希：${res.scriptSha256 ?? "-"}　平均决策 ${res.avgDecisionMs}ms　最慢 ${res.maxDecisionMs}ms`);
    for (const s of res.stages) console.log(`  ${s.ok ? "✅" : "❌"} ${s.stage}${s.detail ? `：${s.detail}` : ""}`);
    if (res.fuzzFailures.length) console.log("模糊测试失败样本：" + JSON.stringify(res.fuzzFailures, null, 1));
  }
  if (failed) process.exit(1);
}

// ---------------------------------------------------------------- task-doc（外部 Agent 任务书）
function cmdTaskDoc(): void {
  const serverBaseUrl = arg("baseUrl", "http://127.0.0.1:8787")!;
  const doc = renderTaskDoc({
    map: loadMap(arg("map", DEFAULT_MAP_1V1)!),
    rules: loadRules(),
    protocolCorePath: PROTOCOL_CORE,
    taskDocTemplatePath: TASK_DOC_TEMPLATE_PATH,
    baselineScript: readFileSync(BASELINE_PATH, "utf8"),
    serverBaseUrl,
    limits: DEFAULT_UPLOAD_LIMITS_PUBLIC,
    gamesPerPair: intArg("gamesPerPair", 2),
    turnBudgetMs: 50,
  });
  const out = arg("out");
  if (out) {
    writeFileSync(out, doc.markdown, "utf8");
    console.log(`任务书已写入 ${out}（${doc.version}，${doc.markdown.length} 字符）`);
    console.log(`注册：POST ${doc.endpoints.register}　上传：POST ${doc.endpoints.upload}　任务书：GET ${doc.endpoints.taskDoc}`);
  } else {
    console.log(doc.markdown);
  }
}

// ---------------------------------------------------------------- pack（把脚本打成规范 zip）
function cmdPack(): void {
  const scriptPath = arg("file") ?? arg("script");
  if (!scriptPath) throw new Error("用法：pack --file strategy.js [--meta meta.json] [--readme README.md] [--out strategy.zip]");
  const entries: { name: string; data: string }[] = [{ name: "strategy.js", data: readFileSync(scriptPath, "utf8") }];
  const metaPath = arg("meta");
  if (metaPath) entries.push({ name: "meta.json", data: readFileSync(metaPath, "utf8") });
  const readmePath = arg("readme");
  if (readmePath) entries.push({ name: "README.md", data: readFileSync(readmePath, "utf8") });
  const zip = createZip(entries);
  const out = arg("out", "strategy.zip")!;
  writeFileSync(out, zip);

  // 自查：用与服务端同一套解包器读回，确保能通过上传闸门
  const back = readZip(zip, DEFAULT_UPLOAD_LIMITS);
  console.log(`已生成 ${out}（${zip.length} 字节 / 上限 ${DEFAULT_UPLOAD_LIMITS.maxZipBytes}）`);
  if (!back.ok) {
    console.error(`❌ 自查失败：${back.reason} —— ${back.detail}`);
    process.exit(1);
  }
  console.log(`✅ 自查通过：条目 ${back.entries.map((e) => `${e.name}(${e.uncompressedSize}B)`).join(", ")}`);
  if (zip.length > DEFAULT_UPLOAD_LIMITS.maxZipBytes) {
    console.error("❌ 超过 200KB 上限，服务端会拒绝");
    process.exit(1);
  }
}

// ---------------------------------------------------------------- upload（模拟外部 Agent 上传）
async function cmdUpload(): Promise<void> {
  const zipPath = arg("zip", "strategy.zip")!;
  const key = arg("key") ?? process.env.AGENT_KEY;
  if (!key) throw new Error("用法：upload --zip strategy.zip --key ag_xxx [--url http://127.0.0.1:8787/api/upload]");
  const url = arg("url", "http://127.0.0.1:8787/api/upload")!;
  const body = readFileSync(zipPath);
  console.log(`上传 ${zipPath}（${body.length} 字节）→ ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/zip", Authorization: `Bearer ${key}` },
    body,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(parsed, null, 2));
  if (!res.ok) process.exit(1);
}

// ---------------------------------------------------------------- demo（一键演示数据）
async function cmdDemo(): Promise<void> {
  const baseUrl = arg("url", "http://127.0.0.1:8787")!;
  console.log(`向 ${baseUrl} 填充演示数据（注册 3 个 Agent → 打包上传 → 发起 1v1 赛事）`);
  const result = await runDemo({
    baseUrl,
    tournament: !flag("no-tournament"),
    gamesPerPair: intArg("gamesPerPair", 2),
    maxRounds: intArg("maxRounds", DEFAULT_RULESET.maxRounds),
    ...(arg("map") ? { mapId: arg("map")! } : {}),
    log: (line) => console.log(line),
  });
  console.log(`\n完成。打开 ${baseUrl} 或前端地址查看：`);
  console.log(`  Agent 注册与上传：/agents（${result.agentIds.length} 个，已全部入库）`);
  if (result.tournamentId) console.log(`  赛事详情与回放：/tournaments → ${result.tournamentId}`);
}

// ---------------------------------------------------------------- fuzz（只生成样本，便于人工检查）
function cmdFuzz(): void {
  const map = loadMap(arg("map", DEFAULT_MAP_1V1)!);
  const states = generateFuzzStates(map, loadRules(), intArg("count", 3));
  console.log(JSON.stringify(states, null, 1));
}

// ---------------------------------------------------------------- inspect（打印一局的逐回合轨迹）
// 用途：人工判断"这张图打不打得起来"——靠看事件流，而不是只看总分。
function cmdInspect(): void {
  const rules = loadRules();
  const map = loadMap(arg("map", defaultMapId(2))!);
  const seed = intArg("seed", 20261019);
  const mode = arg("mode", "mirror")!; // mirror=双方同脚本 | home=守家流 | idle=挂机
  const custom = arg("script");
  const baseline = readFileSync(BASELINE_PATH, "utf8");
  const scriptOf = (seat: number): string => {
    if (custom) return readFileSync(custom, "utf8");
    if (mode === "home" && seat === 2) return baseline.replace("const ALLOW_CENTER = true;", "const ALLOW_CENTER = false;");
    if (mode === "idle" && seat === 2) return `function onInit() {}\nfunction onTurn() { return [{ type: "wait" }]; }\n`;
    return baseline;
  };
  const seats = [1, 2];
  const controller = new LocalController();
  for (const s of seats) controller.load(s, scriptOf(s));
  const spawns = assignSpawns(map, seats, seed);
  const res = runMatch({
    matchId: "inspect", map, rules, seed,
    seats: seats.map((s) => ({ seat: s, name: `P${s}`, scriptHash: "inspect" })),
    spawns, controller,
  });
  controller.dispose();

  const at = (p: { x: number; y: number }) => `(${p.x},${p.y})`;
  console.log(`地图 ${map.mapId}@${map.version}　seed ${seed}　模式 ${mode}　` +
    `出生点 ${spawns.map((s) => `P${s.seat}=${at(s.pos)}`).join(" ")}`);
  const show = flag("all");
  let round = 0;
  for (const ev of res.events) {
    const R = `R${String(round).padStart(3)}`;
    switch (ev.t) {
      case "turn_begin": round = ev.round; break;
      case "move": if (ev.emergency) console.log(`${R} P${ev.seat} 应急移动 ${at(ev.from)}→${at(ev.to)}（油 ${ev.fuelAfter}）`); break;
      case "fire": console.log(`${R} P${ev.seat} 开火→${at(ev.target)} ${ev.hit ? `命中 -${ev.damage}` : "未命中"}（弹 ${ev.ammoAfter}）`); break;
      case "collect": if (show) console.log(`${R} P${ev.seat} 采集 ${ev.node} +${ev.amount}（余 ${ev.remainingAfter}，载 ${ev.cargoAfter}）`); break;
      case "deposit": console.log(`${R} P${ev.seat} 提交 ${ev.units} 单位 +${ev.scoreDelta}（总分 ${ev.scoreAfter}）`); break;
      case "load_ammo": if (show) console.log(`${R} P${ev.seat} 装弹 ${ev.rounds} 发 ${ev.scoreDelta}（分 ${ev.scoreAfter}）`); break;
      case "refuel": if (show) console.log(`${R} P${ev.seat} 加油 ${ev.fuelAdded} ${ev.scoreDelta}（分 ${ev.scoreAfter}）`); break;
      case "death": console.log(`${R} P${ev.seat} *** 阵亡 ***（凶手 P${ev.killerSeat ?? "-"}，分 ${ev.scoreAfter}）`); break;
      case "respawn": console.log(`${R} P${ev.seat} 复活于 ${at(ev.pos)}`); break;
      case "invalid_action": console.log(`${R} P${ev.seat} 无效动作 ${ev.reason}`); break;
      case "strike": console.log(`${R} P${ev.seat} STRIKE ${ev.kind}: ${ev.detail}`); break;
      default: break;
    }
  }
  const fires = res.events.filter((e) => e.t === "fire").length;
  const roundOfFirstFire = (() => {
    let r = 0;
    for (const ev of res.events) {
      if (ev.t === "turn_begin") r = ev.round;
      else if (ev.t === "fire") return r;
    }
    return -1;
  })();
  console.log(`\n总轮次 ${res.turns}　开火 ${fires} 次　首次交火第 ${roundOfFirstFire} 轮`);
  for (const st of [...res.ranking].sort((a, b) => a.seat - b.seat)) {
    console.log(`P${st.seat}: 分 ${st.score}（提交 ${st.scoreBreakdown.deposit} / 击杀 ${st.scoreBreakdown.kill} / 阵亡 ${st.scoreBreakdown.death} / 弹药 ${st.scoreBreakdown.ammo} / 油 ${st.scoreBreakdown.fuel}）` +
      ` 开火 ${st.shotsFired} 命中 ${st.hits} 击杀 ${st.kills} 阵亡 ${st.deaths} 提交 ${st.unitsDeposited} 单位 采集 ${st.unitsCollected} 移动 ${st.moves}` +
      ` 无效动作 ${st.invalidActions} strike ${st.strikes}`);
  }
}

function usage(): void {
  console.log(`AI 坦克对战平台 CLI

  verify-map [path]                 校验地图：结构（对称性/一致性/连通性/注册表）+ 玩法审计（可达性/经济/僵局风险）
                                    默认校验全部内置地图；给一个 .json 路径可校验编辑器导出的地图草稿
  check-docs                        校验文档与代码同源（ASCII 地图、参数表、任务书与协议正文）
  simulate [--games 20] [--seats 4] [--map duel-01|draft.json] [--script file.js] [--seed N] [--sandbox]
                                    跑仿真并输出平衡性与交战报告（默认用基线脚本；地图默认随人数：2 人→duel-01，否则 arena-01）
  check --file script.js [--map duel-01|draft.json]
                                    让一个脚本走完整准入流水线（默认对全部内置地图各跑一遍，与上传闸门一致）
  inspect [--seed N] [--map duel-01] [--mode mirror|home|idle] [--script file.js] [--all]
                                    打印一局的逐回合轨迹（开火/阵亡/提交），人工判断地图是否打得起来；--all 连采集/补给也打印
  fuzz [--count 3]                  打印模糊测试样本状态

对外 Agent 流程（外部 Agent 只需这三条）：
  task-doc [--map duel-01] [--out task-doc.md] [--baseUrl http://host:8787]
                                    生成"外部 Agent 任务书"（协议/地图/数值/上传规范/校验标准）
  pack --file strategy.js [--meta meta.json] [--out strategy.zip]
                                    打包成规范 zip 并用服务端同款解包器自查
  upload --zip strategy.zip --key ag_xxx [--url .../api/upload]
                                    用一次性密钥上传（模拟外部 Agent）

  demo [--url http://127.0.0.1:8787] [--no-tournament] [--gamesPerPair 2] [--map duel-01]
                                    一键填充演示数据：注册 3 个 Agent → 上传 → 跑一场赛事`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "verify-map": cmdVerifyMap(); break;
    case "check-docs": cmdCheckDocs(); break;
    case "simulate": await cmdSimulate(); break;
    case "check": await cmdCheck(); break;
    case "fuzz": cmdFuzz(); break;
    case "inspect": cmdInspect(); break;
    case "demo": await cmdDemo(); break;
    case "task-doc": cmdTaskDoc(); break;
    case "pack": cmdPack(); break;
    case "upload": await cmdUpload(); break;
    default: usage(); break;
  }
}

main().catch((err) => {
  console.error("❌ " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});

export { extractScript };