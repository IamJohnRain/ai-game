// apps/web/src/commentaryView.ts —— 解说稿的"播出进度"计算（纯函数，可单测）
//
// 解说稿是**整场一次生成**的（赛后异步），但观看者看到的是逐事件推进的光标。
// 这里只回答三个问题：哪些段已经播出、当前在说哪一段、某一段在第几个（供自动滚动定位）。
import type { CommentarySegment } from "./api.ts";

/** 已经播出的段：锚点 i ≤ 当前光标 */
export function revealedSegments(segments: readonly CommentarySegment[], cursor: number): CommentarySegment[] {
  return segments.filter((s) => s.i <= cursor);
}

/** 当前正在"说"的那一段 = 最后一条已播出的；还没开播时返回 null */
export function currentSegment(segments: readonly CommentarySegment[], cursor: number): CommentarySegment | null {
  let cur: CommentarySegment | null = null;
  for (const s of segments) {
    if (s.i > cursor) break;
    cur = s;
  }
  return cur;
}

/** 某一段在（全量）列表里的下标；找不到返回 -1 */
export function segmentIndex(segments: readonly CommentarySegment[], target: CommentarySegment | null): number {
  if (!target) return -1;
  return segments.findIndex((s) => s.i === target.i);
}

/** 光标落在第几段之后（0 基）；用于"已播 N/共 M"这类读数 */
export function revealedCount(segments: readonly CommentarySegment[], cursor: number): number {
  let n = 0;
  for (const s of segments) if (s.i <= cursor) n += 1;
  return n;
}