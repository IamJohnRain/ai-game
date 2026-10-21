// apps/web/test/commentaryView.test.ts —— 解说稿"播出进度"的纯函数验收
//
// 这一层最容易出错的地方是"边界"：光标刚好落在锚点上、光标在两条之间、光标还没到第一条、锚点乱序。
// 判据很直白：已播出的段必须都锚在光标之前，当前段必须是最后一条已播出的 —— 错一条，解说就会剧透或卡住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentSegment, revealedCount, revealedSegments, segmentIndex } from "../src/commentaryView.ts";
import type { CommentarySegment } from "../src/api.ts";

const seg = (i: number, text = `t${i}`): CommentarySegment => ({ i, round: Math.floor(i / 10), seat: 0, tone: "calm", text });
const SEGS: CommentarySegment[] = [seg(0), seg(12), seg(40), seg(41), seg(300)];

test("逐段露出：光标之前的都算已播出，光标停在锚点上算这一条已经播出", () => {
  assert.deepEqual(revealedSegments(SEGS, 0).map((s) => s.i), [0]);
  assert.deepEqual(revealedSegments(SEGS, 11).map((s) => s.i), [0]);
  assert.deepEqual(revealedSegments(SEGS, 12).map((s) => s.i), [0, 12]);
  assert.deepEqual(revealedSegments(SEGS, 299).map((s) => s.i), [0, 12, 40, 41]);
  assert.deepEqual(revealedSegments(SEGS, 1000).map((s) => s.i), [0, 12, 40, 41, 300]);
});

test("当前段 = 最后一条已播出的；还没开播时为 null", () => {
  assert.equal(currentSegment(SEGS, -1), null, "光标在 0 之前（理论上不存在）不该有当前段");
  assert.equal(currentSegment(SEGS, 0)?.i, 0);
  assert.equal(currentSegment(SEGS, 39)?.i, 12, "两条之间时要停在前面一条");
  assert.equal(currentSegment(SEGS, 41)?.i, 41);
  assert.equal(currentSegment(SEGS, 9999)?.i, 300);
  assert.equal(currentSegment([], 100), null, "空稿子不该崩");
});

test("计数与定位：已播段数单调不减；segmentIndex 找不到返回 -1", () => {
  assert.equal(revealedCount(SEGS, -1), 0);
  assert.equal(revealedCount(SEGS, 0), 1);
  assert.equal(revealedCount(SEGS, 40), 3);
  assert.equal(revealedCount(SEGS, 9999), 5);
  assert.equal(segmentIndex(SEGS, currentSegment(SEGS, 41)!), 3);
  assert.equal(segmentIndex(SEGS, null), -1);
  assert.equal(segmentIndex(SEGS, seg(777)), -1);
});

test("乱序/重复的稿子也不能出错：只看 i，顺序由调用方保证", () => {
  const messy: CommentarySegment[] = [seg(50), seg(10), seg(50)];
  assert.deepEqual(revealedSegments(messy, 50).map((s) => s.i), [50, 10, 50]);
  assert.equal(currentSegment(messy, 50)?.i, 50);
});