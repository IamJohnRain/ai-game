// packages/engine/src/los.ts —— 视线：格心到格心的体素遍历，墙与森林阻挡，目标格自身不算阻挡
import type { Pos } from "@ai-game/protocol";
import type { Terrain } from "./terrain.ts";

/** 返回从 a 到 b 经过的格序列（含两端），采用 Amanatides & Woo 体素遍历 */
export function lineCells(a: Pos, b: Pos): Pos[] {
  let x = a.x, y = a.y;
  const dx = b.x - a.x, dy = b.y - a.y;
  const cells: Pos[] = [{ x, y }];
  if (dx === 0 && dy === 0) return cells;
  const stepX = Math.sign(dx), stepY = Math.sign(dy);
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY;
  let tMaxX = dx !== 0 ? Math.abs(0.5 / dx) : Number.POSITIVE_INFINITY;
  let tMaxY = dy !== 0 ? Math.abs(0.5 / dy) : Number.POSITIVE_INFINITY;
  // 最多走 |dx|+|dy|+2 步，防止浮点异常导致死循环
  const guard = Math.abs(dx) + Math.abs(dy) + 2;
  for (let i = 0; i < guard && (x !== b.x || y !== b.y); i++) {
    if (tMaxX < tMaxY) { x += stepX; tMaxX += tDeltaX; }
    else if (tMaxY < tMaxX) { y += stepY; tMaxY += tDeltaY; }
    else { x += stepX; y += stepY; tMaxX += tDeltaX; tMaxY += tDeltaY; } // 正好穿过格点：按直穿处理
    cells.push({ x, y });
  }
  return cells;
}

/** 目标格自身不算阻挡：只检查严格中间的格子 */
export function hasLOS(terrain: Terrain, a: Pos, b: Pos): boolean {
  const cells = lineCells(a, b);
  for (let i = 1; i < cells.length - 1; i++) {
    const c = cells[i]!;
    if (terrain.blocksSight(c.x, c.y)) return false;
  }
  return true;
}