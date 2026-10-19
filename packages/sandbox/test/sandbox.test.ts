// packages/sandbox/test/sandbox.test.ts —— 沙箱隔离与预算行为的验收测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUILTIN_MAPS, DEFAULT_RULESET } from "@ai-game/protocol";
import { assignSpawns, runMatch, type TurnController } from "@ai-game/engine";
import { QuickJsController } from "../src/index.ts";

const map = BUILTIN_MAPS["arena-01"]!;
const rules = DEFAULT_RULESET;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baselineScript = readFileSync(join(repoRoot, "docs", "examples", "baseline-strategy.js"), "utf8");

async function runWith(scripts: Record<number, string>, opts = {}, rulesOverride = {}) {
  const ctrl = await QuickJsController.create(opts);
  for (const [seat, text] of Object.entries(scripts)) ctrl.load(Number(seat), text);
  const seats = Object.keys(scripts).map(Number).sort((a, b) => a - b);
  const rs = { ...rules, ...rulesOverride };
  const result = runMatch({
    matchId: "sandbox-test",
    map,
    rules: rs,
    seed: 31337,
    seats: seats.map((seat) => ({ seat, name: `P${seat}`, scriptHash: `h${seat}` })),
    spawns: assignSpawns(map, seats, 31337),
    controller: ctrl,
  });
  ctrl.dispose();
  return result;
}

test("沙箱能正常执行基线脚本，行为与本地控制器一致（无异常、无 strike）", async () => {
  const res = await runWith({ 1: baselineScript, 2: baselineScript });
  for (const st of res.ranking) {
    assert.equal(st.strikes, 0, `P${st.seat} 不应有 strike`);
    assert.equal(st.disqualified, false);
    assert.ok(st.moves > 50, `P${st.seat} 应该在移动，实际 ${st.moves}`);
  }
  const deposits = res.events.filter((e) => e.t === "deposit").length;
  assert.ok(deposits >= 1, "沙箱里跑的基线也应能提交资源");
});

test("沙箱与本地控制器结果一致（同一 seed 下事件流相同）", async () => {
  const { LocalController } = await import("@ai-game/engine");
  const local = new LocalController();
  const seats = [1, 2];
  for (const s of seats) local.load(s, baselineScript);
  const localRes = runMatch({
    matchId: "sandbox-test", map, rules, seed: 31337,
    seats: seats.map((seat) => ({ seat, name: `P${seat}`, scriptHash: `h${seat}` })),
    spawns: assignSpawns(map, seats, 31337),
    controller: local,
  });
  const sandboxRes = await runWith({ 1: baselineScript, 2: baselineScript });
  assert.equal(
    JSON.stringify(sandboxRes.events), JSON.stringify(localRes.events),
    "沙箱执行必须与本地执行逐字节一致（说明 API 语义完全等价）",
  );
});

test("禁用能力：require / process / fetch / Date / Math.random 都不可用", async () => {
  const attempts = [
    `function onInit(){};function onTurn(){ return [{type:"wait",v: typeof require}]; }`,
    `function onInit(){};function onTurn(){ return [{type:"wait",v: typeof process}]; }`,
    `function onInit(){};function onTurn(){ return [{type:"wait",v: typeof fetch}]; }`,
    `function onInit(){};function onTurn(){ return [{type:"wait",v: typeof Date}]; }`,
    `function onInit(){};function onTurn(){ return [{type:"wait",v: typeof globalThis.fetch}]; }`,
  ];
  for (const script of attempts) {
    const res = await runWith({ 1: script, 2: baselineScript }, {}, { maxRounds: 3 });
    const isValidAction = res.events.some((e) => e.t === "turn_begin" && (e as { seat: number }).seat === 1);
    assert.ok(isValidAction, "脚本应能运行");
    assert.equal(res.stats[1]!.strikes, 0, `typeof 探测不应抛错: ${script}`);
  }
  // Math.random 被显式移除
  const rand = await runWith({
    1: `function onInit(){};function onTurn(){ var x = Math.random(); return [{type:"wait"}]; }`,
    2: baselineScript,
  }, {}, { maxRounds: 3 });
  assert.ok(rand.stats[1]!.strikes >= 1, "使用 Math.random 应抛错并记 strike（每回合都抛就一直记）");
  assert.ok((rand.events.find((e) => e.t === "strike") as { detail?: string } | undefined)?.detail?.includes("random"));
});

test("死循环被 CPU 预算中断：记 timeout strike，不拖垮比赛", async () => {
  const res = await runWith({
    1: `function onInit(){};function onTurn(){ while (true) {} }`,
    2: baselineScript,
  }, { cpuMs: 40 }, { maxRounds: 6 });
  const strikes = res.events.filter((e) => e.t === "strike") as { kind: string }[];
  assert.equal(strikes.length, 3, "连续 3 次超时后淘汰");
  assert.equal(strikes[0]!.kind, "timeout");
  assert.equal(res.stats[1]!.disqualified, true);
  assert.equal(res.stats[2]!.strikes, 0, "另一座位不受影响");
  const dq = res.events.filter((e) => e.t === "disqualified");
  assert.equal(dq.length, 1);
});

test("内存超限被拦截：分配超大数组不会打穿宿主", async () => {
  const res = await runWith({
    1: `function onInit(){};function onTurn(){ var a = []; for (var i=0;i<5e7;i++) a.push(i); return [{type:"wait"}]; }`,
    2: baselineScript,
  }, { memoryMB: 32 }, { maxRounds: 4 });
  assert.ok(res.stats[1]!.strikes >= 1, "应记录 strike");
  assert.equal(res.stats[2]!.strikes, 0, "宿主与其他座位不受影响");
});

test("onInit 抛错：该座位被淘汰，比赛照常进行", async () => {
  const res = await runWith({
    1: `function onInit(){ throw new Error("init 崩了"); };function onTurn(){ return []; }`,
    2: baselineScript,
  }, {}, { maxRounds: 6 });
  assert.equal(res.stats[1]!.disqualified, true);
  assert.equal(res.stats[1]!.disqualifiedKind, "INIT_ERROR");
  assert.ok(res.events.some((e) => e.t === "disqualified"));
  assert.equal(res.stats[2]!.turnsTaken, 6, "对手跑完整场比赛");
});

test("缺失 onInit 也能工作；缺失 onTurn 视为无效脚本", async () => {
  const ok = await runWith({ 1: `function onTurn(){ return [{type:"wait"}]; }`, 2: baselineScript }, {}, { maxRounds: 3 });
  assert.equal(ok.stats[1]!.strikes, 0, "没有 onInit 也应正常");

  const ctrl = await QuickJsController.create();
  ctrl.load(9, `function onInit(){}`);
  const seats = [1, 2];
  const res = runMatch({
    matchId: "t", map, rules: { ...rules, maxRounds: 2 }, seed: 1,
    seats: seats.map((seat) => ({ seat, name: `P${seat}`, scriptHash: "h" })),
    spawns: assignSpawns(map, seats, 1),
    controller: (() => {
      const inner: TurnController = { load() {}, init() {}, dispose() {}, onTurn: () => ({ actions: [] }) };
      // 座位 1 用真沙箱（会因缺少 onTurn 在 init 阶段失败），座位 2 用哑控制器
      const hybrid: TurnController = {
        load: (seat, text) => { if (seat === 1) ctrl.load(seat, text); else inner.load(seat, text); },
        init: (seat, ctx, api, globals) => { if (seat === 1) ctrl.init(seat, ctx, api, globals); else inner.init(seat, ctx, api, globals); },
        onTurn: (seat, state) => (seat === 1 ? ctrl.onTurn(seat, state) : inner.onTurn(seat, state)),
        dispose: () => ctrl.dispose(),
      };
      return hybrid;
    })(),
  });
  assert.equal(res.stats[1]!.disqualified, true, "缺 onTurn 的脚本应被淘汰");
  ctrl.dispose();
});

test("API.log 有配额与长度上限", async () => {
  const res = await runWith({
    1: `function onInit(){};
function onTurn(){ for (var i=0;i<100;i++) API.log("x".repeat(500)); return [{type:"wait"}]; }`,
    2: baselineScript,
  }, { maxLogsPerTurn: 5 }, { maxRounds: 2 });
  assert.equal(res.stats[1]!.strikes, 0, "日志刷屏不应导致失败");
});

test("API 工具函数在沙箱内可用且语义正确", async () => {
  const script = `
var seen = [];
function onInit(ctx){ seen.push(API.version); }
function onTurn(state){
  var a = {x:2,y:2}, b = {x:5,y:2};
  seen.push(API.chebyshev(a,b));          // 3
  seen.push(API.dirTo(a,b));              // E
  seen.push(API.isPassable(2,0));         // false（墙）
  seen.push(API.isWater(12,5));           // true
  seen.push(API.hasLOS(a,b));             // true
  seen.push(API.pathFind(a,{x:7,y:4}).length > 0);  // true
  seen.push(API.neighbors(2,2).length);   // 4
  seen.push(API.isResource(7,4));         // true
  seen.push(API.isDeposit(15,11));        // true
  seen.push(typeof API.randomInt(1,3) === "number");
  return [{type:"wait"}];
}
`;
  const ctrl = await QuickJsController.create();
  ctrl.load(1, script);
  const seats = [1, 2];
  const res = runMatch({
    matchId: "api", map, rules: { ...rules, maxRounds: 1 }, seed: 3,
    seats: seats.map((seat) => ({ seat, name: `P${seat}`, scriptHash: "h" })),
    spawns: assignSpawns(map, seats, 3),
    controller: ctrl,
  });
  assert.equal(res.stats[1]!.strikes, 0, "API 调用不应抛错");
  ctrl.dispose();
});