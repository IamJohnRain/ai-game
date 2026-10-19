// packages/protocol/src/pos.ts —— 坐标与方向的唯一实现（引擎、脚本 API、前端共用同一套语义）
export interface Pos { x: number; y: number }
export type Dir = "N" | "E" | "S" | "W";

export const DIRS: readonly Dir[] = ["N", "E", "S", "W"] as const;
export const DIR_VECTORS: Record<Dir, Pos> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};
export const OPPOSITE: Record<Dir, Dir> = { N: "S", S: "N", E: "W", W: "E" };

export function isDir(v: unknown): v is Dir {
  return v === "N" || v === "E" || v === "S" || v === "W";
}

export function step(p: Pos, d: Dir): Pos {
  const v = DIR_VECTORS[d];
  return { x: p.x + v.x, y: p.y + v.y };
}

export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function manhattan(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function euclid(a: Pos, b: Pos): number {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 10) / 10;
}

export function posEquals(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

/** 主方向：|dx| >= |dy| 时给 E/W，否则给 N/S；同格返回 null。与协议正文（docs/prompts/protocol-core.md）的描述一致。 */
export function dirTo(from: Pos, to: Pos): Dir | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "E" : "W";
  return dy > 0 ? "S" : "N";
}