// apps/web/test/sfx.test.ts —— 战场音效层的验收（纯 Node，不模拟 AudioContext）
//
// 音效层最怕两类事故：
//   1) "表与实现不同源"：新增了 kind 却忘了给它限流/基准增益，快进回放时要么漏音、要么削波 —— 用 sfxSpec 那张表把两者钉在一起；
//   2) "没声音反而更吵"：未 unlock（或在没有 WebAudio 的浏览器/Node 里）抛异常、留下声部，把观战页打崩 ——
//      所以这里刻意不去模拟 AudioContext，验证的正是"环境不支持时静默降级"这条真实路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SFX_KINDS, Sfx, sfx, sfxSpec, type SfxKind } from "../src/sfx.ts";

/** 期望的 kind 全集：类型标注保证左边的字面量都在 SfxKind 里，deepEqual 保证两边一个不差（漏登记/多登记都会失败） */
const EXPECTED_KINDS: readonly SfxKind[] = [
  "fire", "hit", "miss", "collect", "deposit", "refuel", "loadAmmo",
  "death", "respawn", "invalid", "disqualified", "tread", "end", "ui",
  "defend", "mineDeploy", "mineBlast",
];

test("SFX_KINDS 与 SfxKind 一一对应且无重复", () => {
  assert.equal(new Set(SFX_KINDS).size, SFX_KINDS.length, `SFX_KINDS 里有重复项：${SFX_KINDS.join(", ")}`);
  assert.deepEqual([...SFX_KINDS].sort(), [...EXPECTED_KINDS].sort(), "SFX_KINDS 应当恰好覆盖全部 kind");
});

test("每个 kind 都有规格：限流窗口与基准增益是合理有限数", () => {
  for (const kind of SFX_KINDS) {
    const spec = sfxSpec(kind);
    assert.ok(Number.isFinite(spec.minIntervalMs) && spec.minIntervalMs > 0, `${kind}: minIntervalMs 应为正有限数，实际 ${spec.minIntervalMs}`);
    assert.ok(Number.isFinite(spec.baseGain) && spec.baseGain > 0 && spec.baseGain <= 1, `${kind}: baseGain 应落在 (0,1]，实际 ${spec.baseGain}`);
    assert.ok(spec.desc.trim().length > 0, `${kind}: 应有非空的文字说明`);
    // 同源：play() 与测试查到的是同一份对象，调参不会各说各话
    assert.equal(sfxSpec(kind), spec, `${kind}: sfxSpec 的查询结果应当稳定`);
  }
});

test("未 unlock：play() 静默 no-op，不抛异常也不产生声部", () => {
  const engine = new Sfx();
  assert.equal(engine.unlocked, false);
  assert.equal(engine.activeVoices, 0);
  for (const kind of SFX_KINDS) {
    engine.play(kind);
    engine.play(kind, { pan: -0.5, gain: 0.5 });
  }
  // 渲染层算坏参数（NaN / 越界）也不能把它打崩
  engine.play("fire", { pan: Number.NaN, gain: 5 });
  engine.play("hit", { pan: -3, gain: Number.POSITIVE_INFINITY });
  assert.equal(engine.activeVoices, 0, "未 unlock 时不应出现活跃声部");
  assert.equal(engine.unlocked, false);
  engine.dispose(); // 未 unlock 时 dispose 也必须安全
});

test("无 AudioContext 的 Node 环境：unlock() 返回 false，重复调用结果一致（幂等）", async () => {
  const engine = new Sfx();
  assert.equal(await engine.unlock(), false, "Node 里没有 AudioContext，应当如实返回不可用");
  assert.equal(await engine.unlock(), false, "第二次调用必须与第一次一致，不能变成抛异常或变卦");
  assert.equal(engine.unlocked, false, "解锁失败的实例永远保持未解锁");
  engine.play("death");
  assert.equal(engine.activeVoices, 0, "标记不可用之后 play() 仍然只是 no-op");
  engine.dispose();
});

test("单例 sfx：与普通实例同一条降级路径", async () => {
  assert.equal(sfx.unlocked, false);
  assert.equal(sfx.volume > 0 && sfx.volume <= 1, true, `默认主音量应在 (0,1]，实际 ${sfx.volume}`);
  assert.equal(await sfx.unlock(), false);
  sfx.play("ui");
  assert.equal(sfx.activeVoices, 0);
  // 单例是整个浏览器会话共用的：测试里不 dispose，避免影响同进程里的其它用例
});

test("setVolume 的 clamp：负值归 0，超过 1 归 1，正常值原样保留", () => {
  const engine = new Sfx();
  engine.setVolume(-1);
  assert.equal(engine.volume, 0);
  engine.setVolume(2);
  assert.equal(engine.volume, 1);
  engine.setVolume(0.35);
  assert.equal(engine.volume, 0.35);
  engine.setVolume(0);
  assert.equal(engine.volume, 0, "音量 0 是合法的静音档，不应被当成非法值丢弃");
  engine.dispose();
});

test("dispose() 幂等；dispose 之后 unlock/play/setVolume 全都安静无害", async () => {
  const engine = new Sfx();
  engine.dispose();
  engine.dispose();
  engine.setVolume(0.5);
  assert.equal(await engine.unlock(), false);
  engine.play("end");
  assert.equal(engine.activeVoices, 0);
});