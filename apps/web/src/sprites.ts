// apps/web/src/sprites.ts —— 战场素材（矢量 SVG + Kenney 位图）的加载、着色与栅格缓存
//
// 为什么要有这一层：
//   1) 素材既不都是矢量也不都是位图：地形/设施用手绘 SVG（矢量、任意格子尺寸都清晰），
//      地面/树/坦克用 Kenney 的 CC0 位图（见 assets/ATTRIBUTION.md，美术质量更高）。
//      这里统一成"图片地址"一种口径，缓存与就绪通知对两者一视同仁。
//   2) 位图/ SVG 都是异步解码的：首帧可能还没就绪。此时调用方拿到 null 就退回纯色块，
//      素材就绪后通过 onSpritesReady() 通知页面重绘一帧——不会白屏、不会闪。
//   3) 同一个格子可以有多个变体（地面草地/沙地、大小两种树），按格子坐标取伪随机一个，
//      于是整片地面不会像贴了同一张壁纸。
import floorSvg from "./assets/tiles/floor.svg?raw";
import wallSvg from "./assets/tiles/wall.svg?raw";
import waterSvg from "./assets/tiles/water.svg?raw";
import spawnSvg from "./assets/tiles/spawn.svg?raw";
import ammoSvg from "./assets/tiles/ammo.svg?raw";
import resourceSvg from "./assets/tiles/resource.svg?raw";
import depositSvg from "./assets/tiles/deposit.svg?raw";
import dirtUrl from "./assets/tiles-kenney/ground-dirt.png";
import sandUrl from "./assets/tiles-kenney/ground-sand.png";
import grassUrl from "./assets/tiles-kenney/ground-grass.png";
import treeLargeUrl from "./assets/tiles-kenney/tree-large.png";
import treeSmallUrl from "./assets/tiles-kenney/tree-small.png";
import barrelRedUrl from "./assets/tiles-kenney/barrel-red.png";
import tankRedUrl from "./assets/tiles-kenney/tank-red.png";
import tankBlueUrl from "./assets/tiles-kenney/tank-blue.png";
import tankGreenUrl from "./assets/tiles-kenney/tank-green.png";
import tankBeigeUrl from "./assets/tiles-kenney/tank-beige.png";

/** SVG 文本 → data URI（同源、无 CORS 问题，可直接画进 canvas 并读取像素；也是位图与矢量统一口径的桥） */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 地形/设施 → 素材地址数组（多张即变体）。
 * - 地面 `.`：泥地为主、约四分之一铺沙地，看起来像打了整场仗的场地；
 * - 森林 `f`：大小两种树交错（Kenney Top-down Tanks 素材）；
 * - 墙/水/出生点/弹药/资源/提交点仍是手绘 SVG：这三样要"一眼看出是硬障碍/硬资源"，
 *   矢量块的锐利边缘比卡通位图更清楚（也保证没有外部素材时整套画风不会塌）。
 */
export const TILE_SRC: Record<string, string[]> = {
  ".": [dirtUrl, dirtUrl, dirtUrl, sandUrl],
  "#": [svgDataUrl(wallSvg)],
  "~": [svgDataUrl(waterSvg)],
  f: [treeLargeUrl, treeSmallUrl],
  S: [svgDataUrl(spawnSvg)],
  A: [svgDataUrl(ammoSvg)],
  B: [svgDataUrl(ammoSvg)],
  G: [barrelRedUrl],
  R: [svgDataUrl(resourceSvg)],
  D: [svgDataUrl(depositSvg)],
};

/** 设施格下面的地面（设施图标叠在它上面，和二维"设施站在什么地形上"的口径一致） */
export const FLOOR_SRC: string[] = [dirtUrl, sandUrl];

/** 森林格的地面：树是带透明通道的位图，底下必须自己铺一层，否则会露出深色画布底 */
export const FOREST_FLOOR_SRC: string[] = [grassUrl, grassUrl, grassUrl, dirtUrl];

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
  ".": "#4a3b2a",
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

/** 座位 → 俯视坦克素材（Kenney 的五色坦克里取四色：红/蓝/绿/米黄） */
const TANK_SRC: Record<number, string> = {
  1: tankRedUrl,
  2: tankBlueUrl,
  3: tankGreenUrl,
  4: tankBeigeUrl,
};

export function tankSrc(seat: number): string {
  return TANK_SRC[seat] ?? tankBeigeUrl;
}

/** 稳定伪随机（按格子坐标）：同一张图每次刷新都要长一样 */
function hash01(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 取某个格子该用哪张素材（变体由格子坐标决定，不随帧变化） */
export function tileSrc(ch: string, x: number, y: number): string | null {
  const list = TILE_SRC[ch] ?? TILE_SRC["."]!;
  if (list.length === 1) return list[0]!;
  return list[Math.floor(hash01(x, y, 7) * list.length)] ?? list[0]!;
}

/** 森林格的地面底图（草地为主） */
export function forestFloorSrc(x: number, y: number): string {
  return FOREST_FLOOR_SRC[Math.floor(hash01(x, y, 9) * FOREST_FLOOR_SRC.length)] ?? FOREST_FLOOR_SRC[0]!;
}

/** 设施格的地面底图 */
export function floorSrc(x: number, y: number): string {
  return FLOOR_SRC[Math.floor(hash01(x, y, 8) * FLOOR_SRC.length)] ?? FLOOR_SRC[0]!;
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

function entryOf(src: string): Entry {
  const hit = entries.get(src);
  if (hit) return hit;
  const img = new Image();
  const entry: Entry = { img, ready: false, failed: false, rasters: new Map() };
  entries.set(src, entry);
  img.onload = () => {
    entry.ready = true;
    for (const cb of listeners) cb();
  };
  img.onerror = () => {
    // 素材坏了就永远退回首帧的色块，不要让画面反复闪烁
    entry.failed = true;
  };
  img.src = src;
  return entry;
}

/**
 * 取一张已栅格化的素材；未就绪时返回 null（调用方退回首帧色块，并在 onSpritesReady 后重绘）。
 * sizePx 一般是格子边长，dpr 传 window.devicePixelRatio。
 */
export function rasterSprite(src: string, sizePx: number, dpr: number): HTMLCanvasElement | null {
  const size = Math.max(4, Math.round(sizePx));
  const ratio = Math.max(1, Math.min(dpr, 3));
  const entry = entryOf(src);
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
  // 位图素材（Kenney）自带边距与透明通道：等比铺满整格，边缘留白自然形成"物件小巧"的观感
  ctx.drawImage(entry.img, 0, 0, canvas.width, canvas.height);
  // 缓存上限保护：观战页可能经历放大/缩小若干档，超过 8 档就清空重来（下一次重绘会重建）
  if (entry.rasters.size >= 8) entry.rasters.clear();
  entry.rasters.set(key, canvas);
  return canvas;
}

/** 供 <img> 直接使用的素材地址（图例、编辑器调色板用） */
export function spriteSrc(src: string): string {
  return src;
}

/** 预热：进入观战/编辑器时一次性把要用的素材挂到内存，减少首帧色块的时间 */
export function preloadSprites(extra: string[] = []): void {
  for (const src of [...Object.values(TILE_SRC).flat(), ...FLOOR_SRC, ...FOREST_FLOOR_SRC, ...extra, ...[1, 2, 3, 4].map(tankSrc)]) {
    entryOf(src);
  }
}