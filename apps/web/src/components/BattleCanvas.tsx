// apps/web/src/components/BattleCanvas.tsx —— 战场渲染（原生 Canvas 2D + SVG 素材，无第三方渲染库）
//
// 为什么用 Canvas 2D 而不是 DOM 网格：32×24=768 格 + 每格素材 + 迷雾遮罩，
// 以 60fps 重绘时 Canvas 只需一次 drawImage 合成，DOM 会触发成千上万次样式重算。
//
// 素材策略（apps/web/src/sprites.ts）：
// - 地形与设施用矢量 SVG 素材（墙/水/森林/出生点/弹药/加油/资源/提交点），按格子像素尺寸栅格化后缓存；
// - 素材未就绪的那一两帧退回到纯色块，就绪后由 onSpritesReady 触发一次重绘 —— 不会白屏、不会闪；
// - 坦克素材的车体颜色按座位替换（__BODY__ / __BODY_DARK__），炮管仍由 Canvas 按推断朝向画线，
//   因为"炮口朝哪"是玩法信息（事件流里没有朝向字段，只能从位移推断）。
//
// 迷雾（座位视角）的渲染时机与规则：
// - 每帧用引擎的 visibleTiles(terrain, from, visionRadius) 计算一次可见格位图（按观察者位置缓存）；
// - 与引擎 match.ts 的 visibleBy() 口径保持一致：切比雪夫距离 ≤ visionRadius、有视线、
//   且敌人若站在森林中则距离必须 ≤ forestStealthRadius 才可见；阵亡单位不可见；
// - 视野外的"最后目击位置"由本组件维护（与服务端的 lastKnownEnemies 同规则：过期即遗忘），
//   所以拖回时间轴更早的位置时必须清空记忆，否则会泄露未来信息。
import { useEffect, useRef, useState } from "react";
import { chebyshev, type GameMap, type Pos, type Ruleset } from "@ai-game/protocol";
import { visibleTiles, type BattleView, type TankView, type Terrain } from "@ai-game/engine";
import { SEAT_COLORS } from "../ui";
import {
  TILE_FALLBACK_FILL, TILE_LABEL, TILE_SVG,
  onSpritesReady, preloadSprites, rasterSprite, spriteSrc, tankSvg,
} from "../sprites";

interface BattleCanvasProps {
  map: GameMap;
  terrain: Terrain;
  view: BattleView;
  rules: Ruleset;
  /** null = 上帝视角；数字 = 该座位视角（战争迷雾） */
  viewpoint: number | null;
  /** 归约版本号：view 是复用对象，靠它触发重绘 */
  version: number;
}

const FOG_FILL = "rgba(4, 6, 11, 0.82)";
const HP_GOOD = "#34d399";
const HP_WARN = "#fbbf24";
const HP_BAD = "#f87171";
/** 视野外设施的暗化程度（不做迷雾的纯黑，保留"这里有个点"的轮廓感） */
const UNSEEN_ALPHA = 0.4;

type Ghost = { x: number; y: number; round: number };

export function BattleCanvas({ map, terrain, view, rules, viewpoint, version }: BattleCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  /** 素材首次加载完成 → 触发一次重绘（把首帧的色块换成素材） */
  const [spritesTick, setSpritesTick] = useState(0);

  // 每帧渲染时维护的小型"观察者记忆"，不放进 React state（高频更新，且不需要触发渲染）
  const maskCache = useRef<{ key: string; mask: Uint8Array } | null>(null);
  const ghostRef = useRef<Map<number, Ghost>>(new Map());
  const lastRoundRef = useRef(0);
  const lastPosRef = useRef<Map<number, Pos>>(new Map());
  const faceRef = useRef<Map<number, Pos>>(new Map());

  // 素材预热 + 就绪通知
  useEffect(() => {
    let first = true;
    const off = onSpritesReady(() => {
      if (first) {
        first = false;
        setSpritesTick((t) => t + 1);
      }
    });
    preloadSprites();
    setSpritesTick((t) => t + 1); // 可能已经就绪（缓存命中），补一次重绘
    return off;
  }, []);

  // 容器尺寸变化 → 重算格子边长
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setBox({ w: Math.max(0, Math.floor(rect.width)), h: Math.max(0, Math.floor(rect.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 切换视角时遗忘旧的目击记忆
  useEffect(() => {
    ghostRef.current.clear();
    maskCache.current = null;
  }, [viewpoint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || box.w < 40 || box.h < 40) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width: W, height: H } = map;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cell = Math.max(4, Math.floor(Math.min(box.w / W, box.h / H)));
    const boardW = cell * W;
    const boardH = cell * H;
    const offX = Math.floor((box.w - boardW) / 2);
    const offY = Math.floor((box.h - boardH) / 2);

    canvas.width = Math.max(1, Math.round(boardW * dpr));
    canvas.height = Math.max(1, Math.round(boardH * dpr));
    canvas.style.width = `${boardW}px`;
    canvas.style.height = `${boardH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boardW, boardH);

    const px = (x: number) => offX + x * cell;
    const py = (y: number) => offY + y * cell;

    /** 素材绘制：未就绪返回 false，调用方接着画纯色兜底 */
    const drawSprite = (svg: string, x: number, y: number, alpha = 1): boolean => {
      const raster = rasterSprite(svg, cell, dpr);
      if (!raster) return false;
      if (alpha !== 1) ctx.globalAlpha = alpha;
      ctx.drawImage(raster, px(x), py(y), cell, cell);
      if (alpha !== 1) ctx.globalAlpha = 1;
      return true;
    };

    // ---------- 1. 视野掩码 ----------
    const viewer = viewpoint === null ? null : view.tanks[viewpoint] ?? null;
    let mask: Uint8Array | null = null;
    if (viewpoint !== null) {
      const key = viewer ? `${viewer.x},${viewer.y},${rules.visionRadius}` : "none";
      if (maskCache.current?.key !== key) {
        maskCache.current = {
          key,
          mask: viewer
            ? visibleTiles(terrain, { x: viewer.x, y: viewer.y }, rules.visionRadius)
            : new Uint8Array(W * H), // 该座位不存在 → 全黑
        };
      }
      mask = maskCache.current.mask;
    } else {
      maskCache.current = null;
    }
    const visibleAt = (x: number, y: number) => mask === null || mask[terrain.index(x, y)] === 1;

    // 与引擎 match.ts visibleBy() 同口径的"看得见某个敌方坦克"
    const canSeeTank = (t: TankView): boolean => {
      if (!viewer || !t.alive) return false;
      if (!visibleAt(t.x, t.y)) return false;
      const d = chebyshev({ x: viewer.x, y: viewer.y }, { x: t.x, y: t.y });
      const inForest = terrain.forest[terrain.index(t.x, t.y)] === 1;
      if (inForest && d > rules.forestStealthRadius) return false;
      return true;
    };

    // ---------- 2. 地形（素材铺底，未就绪时用色块） ----------
    // 设施格（S/B/G/R/D）先铺一层平地素材，再在上面叠设施图标，这样"设施站在什么地形上"看得清楚。
    for (let y = 0; y < H; y++) {
      const row = map.grid[y] ?? "";
      for (let x = 0; x < W; x++) {
        const ch = row[x] ?? ".";
        const isFacility = "SABGRD".includes(ch);
        const svg = isFacility ? TILE_SVG["."]! : TILE_SVG[ch];
        if (!svg || !drawSprite(svg, x, y)) {
          ctx.fillStyle = TILE_FALLBACK_FILL[ch] ?? TILE_FALLBACK_FILL["."]!;
          ctx.fillRect(px(x), py(y), cell, cell);
        }
      }
    }

    // 网格线（格子太小就不画，避免糊成一片）
    if (cell >= 10) {
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x++) {
        const gx = Math.round(px(x)) + 0.5;
        ctx.moveTo(gx, offY);
        ctx.lineTo(gx, offY + boardH);
      }
      for (let y = 0; y <= H; y++) {
        const gy = Math.round(py(y)) + 0.5;
        ctx.moveTo(offX, gy);
        ctx.lineTo(offX + boardW, gy);
      }
      ctx.stroke();
    }

    // ---------- 3. 地图设施（SVG 图标；视野外整体暗化，不隐藏） ----------
    const facilityPass = (svg: string, list: { x: number; y: number }[], alpha = 1) => {
      for (const p of list) {
        const vis = visibleAt(p.x, p.y);
        const a = vis ? alpha : alpha * UNSEEN_ALPHA;
        if (!drawSprite(svg, p.x, p.y, a)) {
          ctx.globalAlpha = a;
          ctx.fillStyle = "rgba(226,232,240,0.35)";
          ctx.fillRect(px(p.x) + cell * 0.25, py(p.y) + cell * 0.25, cell * 0.5, cell * 0.5);
          ctx.globalAlpha = 1;
        }
      }
    };
    facilityPass(TILE_SVG["S"]!, map.spawns, 0.9);
    facilityPass(TILE_SVG["B"]!, map.ammoDepots);
    facilityPass(TILE_SVG["G"]!, map.fuelStations);
    facilityPass(TILE_SVG["D"]!, map.depositPoints);

    // 资源点：素材 + 剩余量数字（视野外显示 ?，与引擎给出的 null 语义一致）
    const resourceSvg = TILE_SVG["R"]!;
    for (const node of Object.values(view.nodes)) {
      const vis = visibleAt(node.x, node.y);
      if (!drawSprite(resourceSvg, node.x, node.y, vis ? 1 : UNSEEN_ALPHA)) {
        ctx.fillStyle = vis ? "rgba(139,92,246,0.55)" : "rgba(139,92,246,0.22)";
        ctx.fillRect(px(node.x), py(node.y), cell, cell);
      }
      // 数字压在最上层才能读：先描一圈深色底，再写白字
      if (cell >= 14) {
        const cx = px(node.x) + cell / 2;
        const cy = py(node.y) + cell * 0.78;
        const text = vis ? String(node.remaining) : "?";
        ctx.font = `600 ${Math.max(9, Math.floor(cell * 0.34))}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(2, cell * 0.12);
        ctx.strokeStyle = "rgba(6,8,12,0.85)";
        ctx.strokeText(text, cx, cy);
        ctx.fillStyle = vis ? "#f5f3ff" : "#a1a1aa";
        ctx.fillText(text, cx, cy);
      }
    }

    // 提交点是"值得抢的目标"：多格提交区画一圈金边，把广场的边界讲清楚
    if (map.depositPoints.length > 1) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of map.depositPoints) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      ctx.strokeStyle = "rgba(245,197,66,0.75)";
      ctx.lineWidth = Math.max(1, cell * 0.07);
      ctx.strokeRect(
        Math.round(px(minX)) + 0.5,
        Math.round(py(minY)) + 0.5,
        Math.round((maxX - minX + 1) * cell) - 1,
        Math.round((maxY - minY + 1) * cell) - 1,
      );
    }

    // ---------- 4. 开火特效 ----------
    const fire = view.lastFire;
    if (fire && view.turn - fire.turn <= 1) {
      const shooter = view.tanks[fire.seat];
      if (shooter) {
        ctx.strokeStyle = SEAT_COLORS[fire.seat] ?? "#fff";
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = Math.max(1.5, cell * 0.1);
        ctx.beginPath();
        ctx.moveTo(px(shooter.x) + cell / 2, py(shooter.y) + cell / 2);
        ctx.lineTo(px(fire.target.x) + cell / 2, py(fire.target.y) + cell / 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const cx = px(fire.target.x) + cell / 2;
        const cy = py(fire.target.y) + cell / 2;
        if (fire.hit) {
          // 命中：一团爆炸 + 四道冲击短划
          ctx.fillStyle = "rgba(248,113,113,0.85)";
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(254,226,226,0.9)";
          ctx.lineWidth = Math.max(1.5, cell * 0.08);
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const ang = (Math.PI / 4) + (i * Math.PI) / 2;
            ctx.moveTo(cx + Math.cos(ang) * cell * 0.22, cy + Math.sin(ang) * cell * 0.22);
            ctx.lineTo(cx + Math.cos(ang) * cell * 0.44, cy + Math.sin(ang) * cell * 0.44);
          }
          ctx.stroke();
        } else {
          // 未命中：虚线弹着点
          ctx.strokeStyle = "rgba(250,204,21,0.9)";
          ctx.setLineDash([cell * 0.2, cell * 0.18]);
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // ---------- 5. 坦克 ----------
    // 朝向由"上一次绘制时的位置差"推断：事件流里没有朝向字段（move 事件只有 from/to）
    const tanks = Object.values(view.tanks).sort((a, b) => a.seat - b.seat);
    for (const t of tanks) {
      const prev = lastPosRef.current.get(t.seat);
      if (!prev || prev.x !== t.x || prev.y !== t.y) {
        if (prev) {
          const dx = Math.sign(t.x - prev.x);
          const dy = Math.sign(t.y - prev.y);
          if (dx !== 0 || dy !== 0) faceRef.current.set(t.seat, { x: dx, y: dy });
        }
        lastPosRef.current.set(t.seat, { x: t.x, y: t.y });
      }
    }

    // 座位视角：先画"最后目击"幽灵，再按可见性画实体
    if (viewpoint !== null) {
      if (view.round < lastRoundRef.current) ghostRef.current.clear(); // 拖回过去 → 记忆失效
      lastRoundRef.current = view.round;
      for (const t of tanks) {
        if (t.seat === viewpoint) continue;
        if (canSeeTank(t)) {
          ghostRef.current.set(t.seat, { x: t.x, y: t.y, round: view.round });
          continue;
        }
        const ghost = ghostRef.current.get(t.seat);
        if (!ghost) continue;
        if (view.round - ghost.round > rules.lastKnownMemoryRounds) {
          ghostRef.current.delete(t.seat);
          continue;
        }
        const gx = px(ghost.x) + cell / 2;
        const gy = py(ghost.y) + cell / 2;
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = SEAT_COLORS[t.seat] ?? "#94a3b8";
        ctx.setLineDash([cell * 0.16, cell * 0.14]);
        ctx.lineWidth = Math.max(1, cell * 0.09);
        ctx.beginPath();
        ctx.arc(gx, gy, cell * 0.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (cell >= 16) {
          ctx.fillStyle = "rgba(226,232,240,0.75)";
          ctx.font = `${Math.max(8, Math.floor(cell * 0.32))}px ui-monospace, Menlo, Consolas, monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("?", gx, gy);
        }
        ctx.globalAlpha = 1;
      }
    } else {
      ghostRef.current.clear();
      lastRoundRef.current = view.round;
    }

    for (const t of tanks) {
      const isSelf = viewpoint !== null && t.seat === viewpoint;
      if (viewpoint !== null && !isSelf && !canSeeTank(t)) continue;

      const color = SEAT_COLORS[t.seat] ?? "#94a3b8";
      const cx = px(t.x) + cell / 2;
      const cy = py(t.y) + cell / 2;

      // 车体素材（按座位着色）；未就绪时退回圆角色块
      const faded = t.disqualified ? 0.35 : t.alive ? 1 : 0.4;
      if (!t.alive) {
        // 阵亡待复活：只留一圈虚线轮廓 + 暗色车体，和"在场"一眼可分
        ctx.globalAlpha = 0.45;
        drawSprite(tankSvg(t.seat), t.x, t.y, 0.5);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.setLineDash([cell * 0.18, cell * 0.14]);
        ctx.lineWidth = Math.max(1.5, cell * 0.07);
        ctx.strokeRect(px(t.x) + cell * 0.08, py(t.y) + cell * 0.08, cell * 0.84, cell * 0.84);
        ctx.setLineDash([]);
      } else if (!drawSprite(tankSvg(t.seat), t.x, t.y, faded)) {
        ctx.globalAlpha = faded;
        ctx.fillStyle = color;
        roundRectPath(ctx, px(t.x) + cell * 0.18, py(t.y) + cell * 0.22, cell * 0.64, cell * 0.66, Math.max(2, cell * 0.16));
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = 1;
      }

      // 炮管：朝向由位置变化推断，未知则默认朝北（车体素材不含炮管，炮口方向是玩法信息）
      if (t.alive) {
        const face = faceRef.current.get(t.seat) ?? { x: 0, y: -1 };
        const len = cell * 0.42;
        ctx.strokeStyle = "#0b0e14";
        ctx.lineWidth = Math.max(2, cell * 0.15);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + face.x * len, cy + face.y * len);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, cell * 0.07);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + face.x * len * 0.95, cy + face.y * len * 0.95);
        ctx.stroke();
        ctx.lineCap = "butt";
      }

      // HP 条压在格子顶部（自己的血量是已知的；敌人血量只在其可见时才会画到这里）
      const barH = Math.max(2, cell * 0.12);
      const bx = px(t.x) + cell * 0.08;
      const by = py(t.y) + cell * 0.05;
      const bw = cell * 0.84;
      const frac = Math.max(0, Math.min(1, t.hp / rules.hpMax));
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(bx, by, bw, barH);
      ctx.fillStyle = frac > 0.5 ? HP_GOOD : frac > 0.25 ? HP_WARN : HP_BAD;
      ctx.fillRect(bx, by, bw * frac, barH);

      // 座位号：格子够大时写在格底，加一圈暗描边保证在素材上也读得清
      if (cell >= 16) {
        const label = `P${t.seat}`;
        ctx.font = `700 ${Math.max(9, Math.floor(cell * 0.3))}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(2, cell * 0.11);
        ctx.strokeStyle = "rgba(6,8,12,0.9)";
        ctx.strokeText(label, cx, py(t.y) + cell * 0.9);
        ctx.fillStyle = "#f8fafc";
        ctx.fillText(label, cx, py(t.y) + cell * 0.9);
      }

      // 被观察的座位本身：加一圈金边，方便在迷雾里一眼找到"谁在看"
      if (isSelf) {
        ctx.strokeStyle = "rgba(245,197,66,0.9)";
        ctx.lineWidth = Math.max(1, cell * 0.07);
        ctx.strokeRect(px(t.x) + 1, py(t.y) + 1, cell - 2, cell - 2);
      }
    }

    // ---------- 6. 迷雾遮罩 ----------
    if (mask !== null) {
      ctx.fillStyle = FOG_FILL;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (mask[terrain.index(x, y)] === 1) continue;
          ctx.fillRect(px(x), py(y), cell, cell);
        }
      }
      // 视野边界：把可见区的边缘描一圈，视觉上"这是一双眼睛能看到的范围"
      ctx.strokeStyle = "rgba(122,162,255,0.25)";
      ctx.lineWidth = 1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (mask[terrain.index(x, y)] !== 1) continue;
          if (x > 0 && mask[terrain.index(x - 1, y)] === 0) edge(px(x), py(y), px(x), py(y) + cell);
          if (x < W - 1 && mask[terrain.index(x + 1, y)] === 0) edge(px(x) + cell, py(y), px(x) + cell, py(y) + cell);
          if (y > 0 && mask[terrain.index(x, y - 1)] === 0) edge(px(x), py(y), px(x) + cell, py(y));
          if (y < H - 1 && mask[terrain.index(x, y + 1)] === 0)
            edge(px(x), py(y) + cell, px(x) + cell, py(y) + cell);
        }
      }
    }

    function edge(x1: number, y1: number, x2: number, y2: number) {
      ctx!.beginPath();
      ctx!.moveTo(x1, y1);
      ctx!.lineTo(x2, y2);
      ctx!.stroke();
    }

    // 棋盘外框
    ctx.strokeStyle = "rgba(148,163,184,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(offX + 0.5, offY + 0.5, boardW - 1, boardH - 1);
  }, [box, map, terrain, view, rules, viewpoint, version, spritesTick]);

  return (
    <div className="board">
      <div className="board-canvas" ref={wrapRef} style={{ aspectRatio: `${map.width} / ${map.height}` }}>
        <canvas ref={canvasRef} />
      </div>
      <div className="legend">
        {Object.entries(TILE_LABEL).map(([ch, label]) => (
          <span className="legend-item" key={ch}>
            <img className="legend-icon" src={spriteSrc(TILE_SVG[ch]!)} alt="" />
            {label}
          </span>
        ))}
        {[1, 2, 3, 4].map((seat) => (
          <span className="legend-item" key={seat}>
            <img className="legend-icon" src={spriteSrc(tankSvg(seat))} alt="" />
            P{seat}
          </span>
        ))}
      </div>
    </div>
  );
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  // 老浏览器兜底：直角矩形
  ctx.rect(x, y, w, h);
}