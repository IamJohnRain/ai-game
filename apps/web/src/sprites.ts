// apps/web/src/sprites.ts —— 战场素材（SVG）的加载、着色与栅格缓存
//
// 为什么要有这一层：
//   1) 素材是矢量 SVG，直接每帧 drawImage 会让浏览器反复栅格化 → 这里按 (素材, 像素尺寸, DPR) 缓存成
//      离屏 canvas，之后每帧只是一次普通的位图拷贝（32×24 的图就是 768 次抽图，60fps 无压力）。
//   2) SVG 以 data URI 加载是异步的：首帧可能还没就绪。此时调用方拿到 null 就会退回纯色块，
//      素材就绪后通过 onSpritesReady() 通知页面重绘一帧——观战时只会看到"一瞬间的色块"，不会白屏。
//   3) 坦克车体颜色是每个座位不同的：素材里用 __BODY__ / __BODY_DARK__ 占位，在这里替换成座位色。
import floorSvg from "./assets/tiles/floor.svg?raw";
import wallSvg from "./assets/tiles/wall.svg?raw";
import waterSvg from "./assets/tiles/water.svg?raw";
import forestSvg from "./assets/tiles/forest.svg?raw";
import spawnSvg from "./assets/tiles/spawn.svg?raw";
import ammoSvg from "./assets/tiles/ammo.svg?raw";
import fuelSvg from "./assets/tiles/fuel.svg?raw";
import resourceSvg from "./assets/tiles/resource.svg?raw";
import depositSvg from "./assets/tiles/deposit.svg?raw";
import tankSvgRaw from "./assets/tiles/tank.svg?raw";
import { SEAT_COLORS } from "./ui";

/** 地形/设施字符 → 素材。与 protocol 的 TileChar 对齐（A 与 B 都是弹药补给点） */
export const TILE_SVG: Record<string, string> = {
  ".": floorSvg,
  "#": wallSvg,
  "~": waterSvg,
  f: forestSvg,
  S: spawnSvg,
  A: ammoSvg,
  B: ammoSvg,
  G: fuelSvg,
  R: resourceSvg,
  D: depositSvg,
};

/** 图例（与地图 JSON 的 legend 口径一致，供观战/编辑器共用） */
export const TILE_LABEL: Record<string, string> = {
  "#": "墙（挡移动+视线）",
  "~": "水（挡移动）",
  f: "森林（挡视线+掩体）",
  S: "出生点",
  B: "弹药补给点",
  G: "加油点",
  R: "资源点",
  D: "提交点",
};

/** 纯色兜底：素材还没加载完时先按这些颜色铺底，避免"黑屏一瞬" */
export const TILE_FALLBACK_FILL: Record<string, string> = {
  ".": "#2f3742",
  "#": "#171b23",
  "~": "#1d4b78",
  f: "#1f4a2e",
  S: "#2f3742",
  A: "#2f3742",
  B: "#2f3742",
  G: "#2f3742",
  R: "#2f3742",
  D: "#2f3742",
};

/** 座位色 → 暗色（用于车体描边）。手写 HSL 变暗而不是引库：只需要"够暗、同色相"。 */
function darken(hex: string, factor = 0.45): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#0b0e14";
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * factor));
  return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** 把坦克素材里的占位符替换成座位配色 */
export function tankSvg(seat: number): string {
  const body = SEAT_COLORS[seat] ?? "#94a3b8";
  return tankSvgRaw.replace(/__BODY_DARK__/g, darken(body)).replace(/__BODY__/g, body);
}

/** SVG 文本 → data URI（同源、无 CORS 问题，可直接画进 canvas 并读取像素） */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------- 缓存

interface Entry {
  img: HTMLImageElement;
  ready: boolean;
  failed: boolean;
  /** key = `${px}@${dpr}` */
  rasters: Map<string, HTMLCanvasElement>;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

/** 素材就绪（首次加载完成）时回调；返回取消订阅函数 */
export function onSpritesReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function entryOf(svg: string): Entry {
  const hit = entries.get(svg);
  if (hit) return hit;
  const img = new Image();
  const entry: Entry = { img, ready: false, failed: false, rasters: new Map() };
  entries.set(svg, entry);
  img.onload = () => {
    entry.ready = true;
    for (const cb of listeners) cb();
  };
  img.onerror = () => {
    // 素材坏了就永远退回首帧的色块，不要让画面反复闪烁
    entry.failed = true;
  };
  img.src = svgDataUrl(svg);
  return entry;
}

/**
 * 取一张已栅格化的素材；未就绪时返回 null（调用方退回首帧色块，并在 onSpritesReady 后重绘）。
 * sizePx 一般是格子边长，dpr 传 window.devicePixelRatio。
 */
export function rasterSprite(svg: string, sizePx: number, dpr: number): HTMLCanvasElement | null {
  const size = Math.max(4, Math.round(sizePx));
  const ratio = Math.max(1, Math.min(dpr, 3));
  const entry = entryOf(svg);
  if (entry.failed) return null;
  const key = `${size}@${ratio}`;
  const cached = entry.rasters.get(key);
  if (cached) return cached;
  if (!entry.ready) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size * ratio));
  canvas.height = Math.max(1, Math.round(size * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(entry.img, 0, 0, canvas.width, canvas.height);
  // 缓存上限保护：观战页可能经历放大/缩小若干档，超过 8 档就清空重来（下一次重绘会重建）
  if (entry.rasters.size >= 8) entry.rasters.clear();
  entry.rasters.set(key, canvas);
  return canvas;
}

/** 供 <img> 直接使用的素材地址（图例、编辑器调色板用） */
export function spriteSrc(svg: string): string {
  return svgDataUrl(svg);
}

/** 预热：进入观战/编辑器时一次性把要用的素材挂到内存，减少首帧色块的时间 */
export function preloadSprites(extra: string[] = []): void {
  for (const svg of [...Object.values(TILE_SVG), ...extra, tankSvg(1), tankSvg(2), tankSvg(3), tankSvg(4)]) {
    entryOf(svg);
  }
}