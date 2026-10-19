// packages/script-check/test/check.test.ts —— 准入流水线验收：20 个坏脚本必须被正确分类拦截
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUILTIN_MAPS, DEFAULT_RULESET } from "@ai-game/protocol";
import { extractScript } from "@ai-game/script-extract";
import { checkScript, staticScan } from "../src/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baselineScript = readFileSync(join(repoRoot, "docs", "examples", "baseline-strategy.js"), "utf8");
const map = BUILTIN_MAPS["arena-01"]!;
const rules = DEFAULT_RULESET;

const wrap = (body: string) => `function onInit(ctx) {}\n${body}`;

test("提取器：有围栏、无语言、多块、纯代码、完全无代码", () => {
  const good = "说明文字\n```js\n" + baselineScript + "\n```\n以上是我的策略";
  const r1 = extractScript(good);
  assert.equal(r1.method, "fenced-js");
  assert.ok(r1.code?.includes("function onTurn"));
  assert.equal(r1.blockCount, 1);

  const r2 = extractScript("```\nfunction onTurn(){return [];}\n```");
  assert.equal(r2.method, "fenced-plain");
  assert.ok(r2.code?.includes("onTurn"));

  const r3 = extractScript("```js\nfunction onTurn(){return []}\n```\n```js\nfunction onTurn(){ var x = 1; return [{type:'wait'}] }\n```");
  assert.ok((r3.code?.length ?? 0) > 20, "应挑最长的含 onTurn 的块");
  assert.equal(r3.blockCount, 2);

  const r4 = extractScript("function onTurn(){ return []; }");
  assert.equal(r4.method, "bare-code");

  const r5 = extractScript("抱歉，我无法完成这个任务。");
  assert.equal(r5.code, null);
  assert.equal(r5.method, "none");
  assert.ok(r5.error);
});

test("静态扫描：注释与字符串里的关键词不应误伤", () => {
  const okScript = wrap(`
    // 注意：不要使用 Date / Math.random，也不要 eval
    var note = "禁止 require 与 import";
    function onTurn(state) { return [{ type: "wait" }]; }
  `);
  const scan = staticScan(okScript);
  assert.equal(scan.ok, true, JSON.stringify(scan.issues));

  const badScript = wrap(`function onTurn(){ var d = new Date().getTime(); return []; }`);
  assert.equal(staticScan(badScript).ok, false);
  assert.equal(staticScan(badScript).issues[0]!.rule, "NO_DATE");

  assert.equal(staticScan(wrap(`function onTurn(){ return [Math.random()]; }`)).issues[0]!.rule, "NO_MATH_RANDOM");
  assert.equal(staticScan(wrap(`function onTurn(){ var fs = require("fs"); return []; }`)).issues[0]!.rule, "NO_REQUIRE");
  assert.equal(staticScan(wrap(`function onTurn(){ while(true){} }`)).issues[0]!.rule, "NO_WHILE_TRUE");
  assert.equal(staticScan(`var x = 1;`).issues[0]!.rule, "MISSING_ON_TURN");
});

test("好脚本（基线）能通过全部四阶段", async () => {
  const res = await checkScript({ script: baselineScript, map, rules, fuzzCount: 60, smokeRounds: 30 });
  assert.equal(res.status, "OK", JSON.stringify(res.stages, null, 1));
  assert.ok(res.scriptSha256 && res.scriptSha256.length === 64);
  assert.equal(res.fuzzFailures.length, 0);
  assert.ok(res.avgDecisionMs >= 0);
  assert.ok(res.smoke && res.smoke.strikes === 0);
  assert.ok(res.smoke!.moves > 0, "冒烟对局里基线应该在移动");
  assert.deepEqual(res.stages.map((st) => st.stage), ["extract", "static", "compile", "fuzz", "smoke"], "五阶段都应留痕");
  for (const st of res.stages) assert.equal(st.ok, true, `阶段 ${st.stage} 应通过：${st.detail ?? ""}`);
});

test("坏脚本矩阵：每类都必须被正确分类（不得进入比赛）", async () => {
  const cases: { name: string; response: string; expect: string }[] = [
    { name: "完全没有代码块", response: "我不会写代码，请你自己想。", expect: "EXTRACT_FAILED" },
    { name: "空代码块", response: "```js\n\n```", expect: "EXTRACT_FAILED" },
    { name: "使用 require", response: "```js\n" + wrap(`function onTurn(){ return require("fs").readdirSync(".").length; }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "使用 import", response: "```js\n" + `import fs from "fs";\n` + wrap(`function onTurn(){ return []; }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "使用 process", response: "```js\n" + wrap(`function onTurn(){ return process.env; }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "使用 globalThis", response: "```js\n" + wrap(`function onTurn(){ return globalThis.MAP; }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "使用 eval", response: "```js\n" + wrap(`function onTurn(){ return eval("1+1"); }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "使用 new Function", response: "```js\n" + wrap(`function onTurn(){ return new Function("return 1")(); }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "使用 Date", response: "```js\n" + wrap(`function onTurn(){ return [{ n: Date.now() }]; }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "使用 Math.random", response: "```js\n" + wrap(`function onTurn(){ return [{ n: Math.random() }]; }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "使用 fetch", response: "```js\n" + wrap(`function onTurn(){ fetch("http://x"); return []; }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "while(true) 死循环", response: "```js\n" + wrap(`function onTurn(){ while(true){} return []; }`) + "\n```", expect: "STATIC_REJECT" },
    { name: "缺少 onTurn", response: "```js\nfunction onInit(){}\n```", expect: "STATIC_REJECT" },
    { name: "语法错误（括号不配）", response: "```js\n" + wrap(`function onTurn(){ return [; }`) + "\n```", expect: "COMPILE_ERROR" },
    { name: "语法错误（关键字拼错）", response: "```js\n" + wrap(`function onTurn(){ retrun []; }`) + "\n```", expect: "COMPILE_ERROR" },
    { name: "onInit 抛错", response: "```js\nfunction onInit(){ null.x = 1; }\nfunction onTurn(){ return []; }\n```", expect: "INIT_ERROR" },
    { name: "onInit 死循环", response: "```js\nfunction onInit(){ while(Date.now()>=0){ var a=1; } }\nfunction onTurn(){ return []; }\n```", expect: "STATIC_REJECT" },
    { name: "onTurn 每回合抛错", response: "```js\n" + wrap(`function onTurn(){ throw new Error("always"); }`) + "\n```", expect: "SMOKE_FAILED" },
    { name: "onTurn 返回非数组", response: "```js\n" + wrap(`function onTurn(){ return { type: "wait" }; }`) + "\n```", expect: "SMOKE_FAILED" },
    { name: "onTurn 死循环（超时）", response: "```js\n" + wrap(`function onTurn(){ var t = 0; for (var i=0;i<1e12;i++) t += i; return []; }`) + "\n```", expect: "SMOKE_FAILED" },
    { name: "返回非法动作结构", response: "```js\n" + wrap(`function onTurn(){ return [{ type: "teleport", to: [1,2] }]; }`) + "\n```", expect: "SMOKE_FAILED" },
    { name: "超长脚本（>600 行）", response: "```js\n" + wrap("function onTurn(){ return []; }\n" + "// padding\n".repeat(700)) + "\n```", expect: "STATIC_REJECT" },
  ];

  const results: string[] = [];
  for (const c of cases) {
    const res = await checkScript({ response: c.response, map, rules, fuzzCount: 40, smokeRounds: 6, sandbox: { cpuMs: 60, initCpuMs: 300 } });
    results.push(`${c.name}: ${res.status}${res.status === c.expect ? "" : " ← 期望 " + c.expect}`);
    assert.equal(res.status, c.expect, `${c.name} 期望 ${c.expect}，实际 ${res.status}；阶段=${JSON.stringify(res.stages)}`);
    assert.equal(res.ok, false);
  }
  // 供人工核对的汇总（失败时能从输出直接看出）
  assert.equal(results.filter((r) => r.includes("←")).length, 0, results.join("\n"));
});

test("通过校验的脚本哈希稳定（同一文本同哈希）", async () => {
  const a = await checkScript({ script: baselineScript, map, rules, fuzzCount: 5, smokeRounds: 4 });
  const b = await checkScript({ script: baselineScript, map, rules, fuzzCount: 5, smokeRounds: 4 });
  assert.equal(a.scriptSha256, b.scriptSha256);
});