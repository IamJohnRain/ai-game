// apps/web/src/scene3d/world.ts —— 把二维地图"立起来"：地板、墙、水、森林、出生点、设施、资源点
//
// 设计取舍：
// 1) 一律用 InstancedMesh：64×64 的图上，地板就是 4096 个实例，但只有 1 次 draw call；
//    地形是静态的，唯一需要每帧变的是资源点的呼吸和迷雾的明暗。
// 2) 迷雾不做"黑幕罩"，而是**直接改实例颜色**：二维里用一层 82% 黑罩住，立体画面里
//    如果贴一张黑幕，墙体会从幕布里戳出来，看着穿帮。改颜色对地形与设施一视同仁，
//    且只需要在观察者换格时重算一次。
// 3) 颜色一律经过 THREE.Color（sRGB→线性）拿基准值：three 的实例颜色缓冲被当作线性值使用，
//    所以"调暗"是在线性空间乘系数，看到的效果比二维里同样系数更暗——系数因此取得比二维小。
import * as THREE from "three";
import type { GameMap } from "@ai-game/protocol";
import type { Terrain } from "@ai-game/engine";
import { attachParts, loadModel, normalizeParts } from "./models.ts";
import { offsetVariants, shadowTexture, surfaceTexture } from "./textures.ts";

/** 视野外实例颜色的线性缩放系数（线性空间乘 0.12 ≈ 感知亮度剩三分之一，能看到轮廓但读不出细节） */
const TILE_DIM = 0.12;

/** 资源点耗尽时材质推向的灰色 */
const GREY = new THREE.Color(0x6b6f76);

/** 每个座位在三维里的兵种色，与 ui.tsx 的 SEAT_COLORS 一致（同色不同源会让人以为是两支队伍） */
export const SEAT_COLORS_3D: Record<number, number> = {
  1: 0xef4444,
  2: 0x3b82f6,
  3: 0x22c55e,
  4: 0xeab308,
};

/** 铺实例时复用的单位四元数（没有旋转的实例不该每格 new 一个） */
const IDENTITY_QUAT = new THREE.Quaternion();

interface Dimmed {
  mesh: THREE.InstancedMesh;
  /** 实例 i 对应地图上的第几格（terrain 的线性下标） */
  tiles: Int32Array;
  /** 基准色（线性空间，3 个 float 一组） */
  base: Float32Array;
}

export interface NodeVisual {
  id: string;
  /** 晶体本体（随剩余量缩放、耗尽后熄灭） */
  crystal: THREE.Mesh;
  pad: THREE.Mesh;
  capacity: number;
  /** 素材模式下的整组（拿模型替代过程式晶体时用） */
  decor?: THREE.Group;
  /** 剩余量：null 表示未知（例如座位视角下还没探索到） */
  remaining: number;
  x: number;
  y: number;
  phase: number;
}

/** 一个格子的某类地物用哪个低模素材（span = 占几格） */
export interface WorldModelSpec {
  url: string;
  span: number;
}

export interface WorldModels {
  /** 针叶树（森林主形态） */
  tree?: WorldModelSpec;
  /** 阔叶树（森林副形态） */
  treeLarge?: WorldModelSpec;
  /** 岩块（墙） */
  rocks?: WorldModelSpec;
  /** 水晶（资源点） */
  crystal?: WorldModelSpec;
}

export interface WorldBuild {
  group: THREE.Group;
  nodes: Map<string, NodeVisual>;
  /** 按可见掩码调暗/恢复（mask=null → 全可见）；只在观察者换格时调用 */
  setVisibility(mask: Uint8Array | null): void;
  /** 让资源点剩余量变化时立刻反映到晶体上（不必等下一帧的呼吸动画） */
  refreshNode(node: NodeVisual): void;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export function buildWorld(
  map: GameMap,
  terrain: Terrain,
  opts: { shadows: boolean; models?: WorldModels; onModelReady?: () => void },
): WorldBuild {
  const group = new THREE.Group();
  group.name = "world";
  const dimmed: Dimmed[] = [];
  const disposables: { dispose(): void }[] = [];
  const W = map.width;
  const H = map.height;
  /** 当前可见掩码：模型是异步替换进来的，替换后要按"此刻"的迷雾状态补一次调暗 */
  let currentMask: Uint8Array | null = null;
  let disposed = false;

  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // ---------------- 通用工具 ----------------
  const worldX = (x: number) => x - (W - 1) / 2;
  const worldZ = (y: number) => y - (H - 1) / 2;
  const tilesOf = (predicate: (ch: string, x: number, y: number) => boolean): { xs: number[]; ys: number[]; idx: number[] } => {
    const xs: number[] = [], ys: number[] = [], idx: number[] = [];
    for (let y = 0; y < H; y++) {
      const row = map.grid[y] ?? "";
      for (let x = 0; x < W; x++) {
        const ch = row[x] ?? ".";
        if (!predicate(ch, x, y)) continue;
        xs.push(x); ys.push(y); idx.push(terrain.index(x, y));
      }
    }
    return { xs, ys, idx };
  };

  /** 建一批实例；colorOf 返回该实例的基准色（线性空间）；
 *  model 给定时先用过程式几何占位，模型加载完成后整体替换（保证首帧不空窗，也不怕模型加载失败）。 */
  const buildInstanced = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    tiles: { xs: number[]; ys: number[]; idx: number[] },
    colorOf: (i: number, x: number, y: number) => THREE.Color,
    transform?: (i: number, x: number, y: number) => { quat?: THREE.Quaternion; scale?: THREE.Vector3; y?: number },
    castShadow = true,
    model?: { url: string; span: number },
  ): THREE.InstancedMesh | null => {
    const n = tiles.xs.length;
    if (n === 0) return null;
    keep(geometry);
    keep(material);
    const mesh = new THREE.InstancedMesh(geometry, material, n);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const mat = new THREE.Matrix4();
    const matrices: THREE.Matrix4[] = [];
    for (let i = 0; i < n; i++) {
      const x = tiles.xs[i]!;
      const y = tiles.ys[i]!;
      const extra = transform?.(i, x, y);
      pos.set(worldX(x), extra?.y ?? 0, worldZ(y));
      quat.copy(extra?.quat ?? new THREE.Quaternion());
      scale.copy(extra?.scale ?? new THREE.Vector3(1, 1, 1));
      const m = mat.compose(pos, quat, scale);
      mesh.setMatrixAt(i, m);
      matrices.push(m.clone());
    }
    mesh.instanceMatrix.needsUpdate = true;
    // setColorAt 会分配 instanceColor（并填成 1）；之后再整块写入基准色，避免每格一次 Color 对象
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    const attr = mesh.instanceColor!;
    const base = new Float32Array(n * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < n; i++) {
      tmp.copy(colorOf(i, tiles.xs[i]!, tiles.ys[i]!));
      base[i * 3] = tmp.r; base[i * 3 + 1] = tmp.g; base[i * 3 + 2] = tmp.b;
    }
    (attr.array as Float32Array).set(base);
    attr.needsUpdate = true;
    mesh.castShadow = castShadow && opts.shadows;
    mesh.receiveShadow = opts.shadows;
    group.add(mesh);
    dimmed.push({ mesh, tiles: new Int32Array(tiles.idx), base });

    if (model) {
      void loadModel(model.url).then((asset) => {
        if (!asset || disposed) return;
        const parts = normalizeParts(asset, model.span);
        const partMeshes: THREE.InstancedMesh[] = [];
        for (const part of parts) {
          // 部件材质按实例克隆：模型里的材质是模板共享的，直接改色调会串到所有同类物件上
          const partMat = part.material.clone();
          keep(partMat);
          const partMesh = new THREE.InstancedMesh(part.geometry, partMat, n);
          const combined = new THREE.Matrix4();
          for (let i = 0; i < n; i++) partMesh.setMatrixAt(i, combined.multiplyMatrices(matrices[i]!, part.matrix));
          partMesh.instanceMatrix.needsUpdate = true;
          // 模型贴图既要保留原色，也要能被迷雾调暗 —— 于是基准色取白，调暗即"乘一个灰度"
          partMesh.setColorAt(0, new THREE.Color(1, 1, 1));
          (partMesh.instanceColor!.array as Float32Array).fill(1);
          partMesh.instanceColor!.needsUpdate = true;
          partMesh.castShadow = castShadow && opts.shadows;
          partMesh.receiveShadow = opts.shadows;
          group.add(partMesh);
          dimmed.push({ mesh: partMesh, tiles: new Int32Array(tiles.idx), base: new Float32Array(n * 3).fill(1) });
          partMeshes.push(partMesh);
        }
        mesh.visible = false; // 占位退场（保留在场景里以便随时回退，成本只是几个 draw call 的开关）
        if (currentMask !== null) setVisibility(currentMask);
        // 素材是异步到的：必须主动通知上层补一帧，否则后台/被节流的标签页里模型不会出现
        opts.onModelReady?.();
        void partMeshes;
      });
    }
    return mesh;
  };

  /** 铺实例时复用的朝向四元数与上方向（模型要随机转向，又不想每格 new） */
  const upQuatWall = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);

  /** 稳定伪随机（按格子坐标）：森林的高低疏密、地板的明暗差异要"每次刷新都一样" */
  const hash01 = (x: number, y: number, salt = 0): number => {
    let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  /**
   * 铺一整类地形，但把格子按伪随机分给若干"UV 错位"的材质：
   * 同一块几何配 4 份偏移不同的材质，重复的噪点图案就被打散了 ——
   * 否则 4096 格平铺同一张纹理，肉眼能看出明显的网格重复。
   */
  const buildSurface = (
    geometry: THREE.BufferGeometry,
    materials: THREE.Material[],
    tiles: { xs: number[]; ys: number[]; idx: number[] },
    colorOf: (i: number, x: number, y: number) => THREE.Color,
    transform?: (i: number, x: number, y: number) => { quat?: THREE.Quaternion; scale?: THREE.Vector3; y?: number },
    castShadow = true,
    model?: { url: string; span: number },
  ): void => {
    // 有素材时不分桶：模型自带贴图细节，UV 错位没有意义，多建几套实例反而浪费
    if (model) {
      buildInstanced(geometry, materials[0]!, tiles, colorOf, transform, castShadow, model);
      return;
    }
    const buckets = materials.map(() => ({ xs: [] as number[], ys: [] as number[], idx: [] as number[] }));
    for (let i = 0; i < tiles.xs.length; i++) {
      const x = tiles.xs[i]!;
      const y = tiles.ys[i]!;
      const q = Math.min(materials.length - 1, Math.floor(hash01(x, y, 31) * materials.length));
      buckets[q]!.xs.push(x);
      buckets[q]!.ys.push(y);
      buckets[q]!.idx.push(tiles.idx[i]!);
    }
    buckets.forEach((bucket, k) => {
      buildInstanced(geometry, materials[k]!, bucket, colorOf, transform, castShadow);
    });
  };

  /**
   * 接触阴影（软落地投影）：物体脚下压一片会渐隐的暗斑。
   * 为什么值得单做一层：平行光的阴影贴图只在中小地图上开（大地图上精度不够），
   * 而没有这一层时，树/墙/箱子在俯视镜头里都像"飘在地板上"。这是最便宜、也最有效的一招。
   */
  const shadowTex = keep(shadowTexture());
  const decalGeometry = keep(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const decalMaterial = keep(new THREE.MeshBasicMaterial({
    map: shadowTex, transparent: true, depthWrite: false, opacity: 0.5, color: 0x05070c,
  }));
  const buildDecals = (
    tiles: { xs: number[]; ys: number[]; idx: number[] },
    radius: (x: number, y: number) => number,
    salt: number,
  ): void => {
    const n = tiles.xs.length;
    if (n === 0) return;
    const mesh = new THREE.InstancedMesh(decalGeometry, decalMaterial, n);
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const x = tiles.xs[i]!;
      const y = tiles.ys[i]!;
      const r = radius(x, y);
      pos.set(worldX(x) + (hash01(x, y, salt) - 0.5) * 0.12, 0.019, worldZ(y) + (hash01(x, y, salt + 1) - 0.5) * 0.12);
      scale.set(r * 2, 1, r * 2);
      mesh.setMatrixAt(i, m.compose(pos, IDENTITY_QUAT, scale));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 1; // 压在地板之上、物体之下
    group.add(mesh);
  };

  // ---------------- 地板 + 水 ----------------
  // 设施格先用平地铺底（和二维一样"设施站在什么地形上看得清楚"）
  const FACILITIES = "SABGRD";
  // 森林格也要铺地板：树是独立模型，底下空着会直接露出深色地面
  const floorTiles = tilesOf((ch) => ch !== "~");
  const floorGeo = new THREE.PlaneGeometry(1, 1);
  floorGeo.rotateX(-Math.PI / 2);
  keep(floorGeo);
  const floorCol = new THREE.Color();
  // 一张中性噪点贴图 + 四份 UV 错位 + 每格色调：地面不再是纯色板，也不会有肉眼可见的图案重复
  const surfaceTex = keep(surfaceTexture({ size: 256, grain: 0.18, pebbles: 110, streaks: 18 }));
  const floorMats = offsetVariants(surfaceTex, (t) => keep(new THREE.MeshLambertMaterial({ color: 0xffffff, map: t })), 2);
  buildSurface(
    floorGeo,
    floorMats,
    floorTiles,
    (i, x, y) => {
      const ch = map.grid[y]?.[x] ?? ".";
      // 地板做细微明暗变化，避免 4096 块纯色拼成一片"塑料板"
      const shade = 0.86 + hash01(x, y, 1) * 0.2;
      // 森林格铺草地色调（与二维同口径："树站在草地上"），设施格铺亮一点的场地色
      const rgb = ch === "f" ? 0x4e6f42 : FACILITIES.includes(ch) ? 0x69737f : 0x64707c;
      return floorCol.setHex(rgb).multiplyScalar(shade);
    },
    undefined,
    false,
  );

  const waterCol = new THREE.Color();
  // 水面加一层缓慢漂移的波纹贴图：静态平面在俯视镜头里像块蓝玻璃，动起来才像水
  const waterTex = keep(surfaceTexture({ size: 256, grain: 0.05, pebbles: 30, streaks: 46 }));
  const waterMat = keep(new THREE.MeshStandardMaterial({
    color: 0xffffff, map: waterTex, transparent: true, opacity: 0.9, roughness: 0.16, metalness: 0.55,
  }));
  buildInstanced(
    new THREE.PlaneGeometry(1.02, 1.02).rotateX(-Math.PI / 2),
    waterMat,
    tilesOf((ch) => ch === "~"),
    (_i, x, y) => waterCol.setHex(0x2b6fa8).multiplyScalar(0.9 + hash01(x, y, 2) * 0.25),
    () => ({ y: 0.02 }),
    false,
  );

  // ---------------- 地形 ----------------
  const wallGeo = new THREE.BoxGeometry(1, 1.15, 1);
  wallGeo.translate(0, 0.575, 0);
  keep(wallGeo);
  const wallCol = new THREE.Color();
  const wallMats = offsetVariants(surfaceTex, (t) => keep(new THREE.MeshLambertMaterial({ color: 0xffffff, map: t })), 2);
  buildSurface(
    wallGeo,
    wallMats,
    tilesOf((ch) => ch === "#"),
    (_i, x, y) => wallCol.setHex(opts.models?.rocks ? 0xffffff : 0x55606e).multiplyScalar(0.9 + hash01(x, y, 3) * 0.22),
    // 有素材：整体缩放 + 随机转向（模型不能被拉伸，否则岩块会变形）；岩块本色来自素材贴图，染色取白
    // 无素材：只改高度，一排墙看起来像起伏的岩脊/断墙，而不是等高的一块板
    opts.models?.rocks
      ? (_i, x, y) => ({
          quat: upQuatWall.setFromAxisAngle(UP, hash01(x, y, 42) * Math.PI * 2),
          scale: new THREE.Vector3(0.9 + hash01(x, y, 41) * 0.28, 0.9 + hash01(x, y, 41) * 0.28, 0.9 + hash01(x, y, 41) * 0.28),
        })
      : (_i, x, y) => ({ scale: new THREE.Vector3(1, 0.82 + hash01(x, y, 41) * 0.55, 1) }),
    true,
    opts.models?.rocks,
  );

  const upQuat = new THREE.Quaternion();
  const forestTiles = tilesOf((ch) => ch === "f");
  // 森林分两种形态：约七成针叶（三层塔状）、三成阔叶（一团冠球）。
  // 单层圆锥一排铺开像"路障"，两种形态交错才有林子的味道。
  const coniferTiles = { xs: [] as number[], ys: [] as number[], idx: [] as number[] };
  const broadleafTiles = { xs: [] as number[], ys: [] as number[], idx: [] as number[] };
  for (let i = 0; i < forestTiles.xs.length; i++) {
    const x = forestTiles.xs[i]!;
    const y = forestTiles.ys[i]!;
    const bucket = hash01(x, y, 51) < 0.7 ? coniferTiles : broadleafTiles;
    bucket.xs.push(x);
    bucket.ys.push(y);
    bucket.idx.push(forestTiles.idx[i]!);
  }
  const forestTransform = (i: number, x: number, y: number) => ({
    quat: upQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(x, y, 5) * Math.PI * 2),
    scale: new THREE.Vector3(1, 0.8 + hash01(x, y, 6) * 0.5, 1),
  });
  // 针叶：三层锥体（下宽上窄、颜色逐层提亮），叠出"塔"的层次
  const coniferLayers: { r: number; h: number; y: number; color: number }[] = [
    { r: 0.46, h: 0.52, y: 0.42, color: 0x245f36 },
    { r: 0.36, h: 0.48, y: 0.72, color: 0x2c7040 },
    { r: 0.24, h: 0.42, y: 1.0, color: 0x35824a },
  ];
  for (const layer of coniferLayers) {
    const geo = new THREE.ConeGeometry(layer.r, layer.h, 7);
    geo.translate(0, layer.y, 0);
    buildInstanced(
      geo,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      coniferTiles,
      (_i, x, y) => new THREE.Color().setHex(layer.color).multiplyScalar(0.82 + hash01(x, y, 4) * 0.36),
      forestTransform,
      true,
      opts.models?.tree,
    );
  }
  // 阔叶：低模冠球（二十面体压扁）+ 更粗的树干，与针叶形成剪影差异
  const blobGeo = new THREE.IcosahedronGeometry(0.46, 0);
  blobGeo.scale(1, 0.82, 1);
  blobGeo.translate(0, 0.74, 0);
  buildInstanced(
    blobGeo,
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    broadleafTiles,
    (_i, x, y) => new THREE.Color().setHex(0x3f7f3a).multiplyScalar(0.82 + hash01(x, y, 4) * 0.36),
    forestTransform,
    true,
    opts.models?.treeLarge,
  );
  // 素材自带树干与冠层，过程式的就不铺了（无素材时照旧）
  if (!opts.models?.tree && !opts.models?.treeLarge) {
    const trunkGeo = new THREE.CylinderGeometry(0.07, 0.09, 0.3, 5);
    trunkGeo.translate(0, 0.15, 0);
    buildInstanced(
      trunkGeo,
      new THREE.MeshLambertMaterial({ color: 0x4a3624 }),
      forestTiles,
      () => new THREE.Color(0x4a3624).multiplyScalar(1),
    );
  }
  // 阔叶树还有个"影子色"的小底座（比树干宽些），让冠球不至于像悬空（素材模式不需要）
  if (!opts.models?.treeLarge) {
    const blobBaseGeo = new THREE.CylinderGeometry(0.12, 0.16, 0.42, 6);
    blobBaseGeo.translate(0, 0.21, 0);
    buildInstanced(
      blobBaseGeo,
      new THREE.MeshLambertMaterial({ color: 0x3a2a1c }),
      broadleafTiles,
      () => new THREE.Color(0x3a2a1c),
    );
  }

  // ---- 接触阴影：墙、树、设施脚下各压一片暗斑（详见 buildDecals 的说明） ----
  buildDecals(tilesOf((ch) => ch === "#"), () => 0.78, 21);
  buildDecals(forestTiles, (x, y) => 0.4 + hash01(x, y, 6) * 0.22, 22);
  buildDecals(tilesOf((ch) => "SABGDR".includes(ch) && ch !== "S"), () => 0.62, 23);

  // ---------------- 设施 ----------------
  const ringGeo = new THREE.RingGeometry(0.32, 0.44, 22);
  ringGeo.rotateX(-Math.PI / 2);
  buildInstanced(
    ringGeo,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    tilesOf((ch) => ch === "S"),
    () => new THREE.Color(0x7aa2ff),
    () => ({ y: 0.03 }),
  );

  const ammoCol = new THREE.Color();
  buildInstanced(
    new THREE.BoxGeometry(0.72, 0.3, 0.72).translate(0, 0.15, 0),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.2 }),
    tilesOf((ch) => ch === "A" || ch === "B"),
    (_i, x, y) => ammoCol.setHex(0xd98a2b).multiplyScalar(0.9 + hash01(x, y, 7) * 0.2),
  );
  buildInstanced(
    new THREE.BoxGeometry(0.44, 0.2, 0.44).translate(0, 0.4, 0),
    new THREE.MeshStandardMaterial({ color: 0xf0b452, roughness: 0.5, metalness: 0.3 }),
    tilesOf((ch) => ch === "A" || ch === "B"),
    () => new THREE.Color(0xf0b452),
  );

  const fuelCol = new THREE.Color();
  buildInstanced(
    new THREE.CylinderGeometry(0.26, 0.3, 0.5, 12).translate(0, 0.25, 0),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.35 }),
    tilesOf((ch) => ch === "G"),
    (_i, x, y) => fuelCol.setHex(0x2fa36a).multiplyScalar(0.9 + hash01(x, y, 8) * 0.2),
  );
  buildInstanced(
    new THREE.CylinderGeometry(0.34, 0.36, 0.06, 14).translate(0, 0.03, 0),
    new THREE.MeshStandardMaterial({ color: 0x1d6f4b, roughness: 0.7 }),
    tilesOf((ch) => ch === "G"),
    () => new THREE.Color(0x1d6f4b),
  );

  // 提交点：金板 + 四角立柱，让"值得抢的目标"远看就认得出
  const depositCol = new THREE.Color();
  buildInstanced(
    new THREE.BoxGeometry(1, 0.1, 1).translate(0, 0.05, 0),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.6 }),
    tilesOf((ch) => ch === "D"),
    (_i, x, y) => depositCol.setHex(0xf2c14e).multiplyScalar(0.92 + hash01(x, y, 9) * 0.16),
  );
  const postGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.42, 6).translate(0, 0.21, 0);
  buildInstanced(
    postGeo,
    new THREE.MeshStandardMaterial({ color: 0xc99a2e, roughness: 0.4, metalness: 0.6 }),
    tilesOf((ch) => ch === "D"),
    () => new THREE.Color(0xc99a2e),
  );

  // ---------------- 资源点（带实例的动画状态） ----------------
  const nodes = new Map<string, NodeVisual>();
  for (const def of map.resourceNodes) {
    const padMat = keep(new THREE.MeshStandardMaterial({ color: 0x63499a, roughness: 0.6, metalness: 0.3 }));
    const crystalMat = keep(new THREE.MeshStandardMaterial({ color: 0x9b6bf0, roughness: 0.25, metalness: 0.2, emissive: 0x3b1f7a, emissiveIntensity: 1 }));
    const pad = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.34, 0.4, 0.1, 14)), padMat);
    pad.position.set(worldX(def.x), 0.05, worldZ(def.y));
    pad.receiveShadow = opts.shadows;
    const crystal = new THREE.Mesh(keep(new THREE.OctahedronGeometry(0.3)), crystalMat);
    crystal.position.set(worldX(def.x), 0.42, worldZ(def.y));
    crystal.castShadow = opts.shadows;
    group.add(pad, crystal);
    const visual: NodeVisual = {
      id: def.id, crystal, pad, capacity: def.capacity, remaining: def.initial, x: def.x, y: def.y,
      phase: hash01(def.x, def.y, 11) * Math.PI * 2,
    };
    nodes.set(def.id, visual);
    refreshNode(visual);
    // 素材模式：模型到了就把过程式晶体换成模型（过程式的留在原处，只是不再显示，便于回退）
    if (opts.models?.crystal) {
      void loadModel(opts.models.crystal.url).then((asset) => {
        if (!asset || disposed) return;
        const decor = new THREE.Group();
        attachParts(decor, normalizeParts(asset, opts.models?.crystal?.span ?? 0.85), { shadows: opts.shadows });
        decor.position.set(worldX(def.x), 0.1, worldZ(def.y));
        group.add(decor);
        visual.decor = decor;
        crystal.visible = false;
        refreshNode(visual);
        if (currentMask !== null) setVisibility(currentMask);
        opts.onModelReady?.();
      });
    }
  }

  // ---------------- 棋盘外框（大地图边缘不做围墙时，给一条低矮的边框把"战场范围"圈住） ----------------
  const spanX = W + 1.6;
  const spanZ = H + 1.6;
  const rimMat = keep(new THREE.MeshStandardMaterial({ color: 0x1a2130, roughness: 0.8, metalness: 0.2 }));
  const rimGeoH = keep(new THREE.BoxGeometry(spanX, 0.24, 0.5));
  const rimGeoV = keep(new THREE.BoxGeometry(0.5, 0.24, spanZ));
  for (const [geo, x, z] of [
    [rimGeoH, 0, -(H / 2 + 0.55)],
    [rimGeoH, 0, H / 2 + 0.55],
  ] as [THREE.BufferGeometry, number, number][]) {
    const m = new THREE.Mesh(geo, rimMat);
    m.position.set(x, 0.12, z);
    group.add(m);
  }
  for (const [geo, x, z] of [
    [rimGeoV, -(W / 2 + 0.55), 0],
    [rimGeoV, W / 2 + 0.55, 0],
  ] as [THREE.BufferGeometry, number, number][]) {
    const m = new THREE.Mesh(geo, rimMat);
    m.position.set(x, 0.12, z);
    group.add(m);
  }

  // 棋盘外的大地面：给跟随/炮手视角一点纵深，不然远处是纯黑
  const groundMat = keep(new THREE.MeshLambertMaterial({ color: 0x0c1119 }));
  const ground = new THREE.Mesh(keep(new THREE.PlaneGeometry(Math.max(spanX, spanZ) * 4, Math.max(spanX, spanZ) * 4).rotateX(-Math.PI / 2)), groundMat);
  ground.position.y = -0.02;
  ground.receiveShadow = opts.shadows;
  group.add(ground);

  // ---------------- 对外接口 ----------------
  function setVisibility(mask: Uint8Array | null): void {
    currentMask = mask;
    for (const d of dimmed) {
      const arr = d.mesh.instanceColor!.array as Float32Array;
      for (let i = 0; i < d.tiles.length; i++) {
        const f = mask === null || mask[d.tiles[i]!] === 1 ? 1 : TILE_DIM;
        arr[i * 3] = d.base[i * 3]! * f;
        arr[i * 3 + 1] = d.base[i * 3 + 1]! * f;
        arr[i * 3 + 2] = d.base[i * 3 + 2]! * f;
      }
      d.mesh.instanceColor!.needsUpdate = true;
    }
    // 资源点晶体与底座用的是独立材质，单独调；素材模式的模型也要一起调
    for (const n of nodes.values()) {
      const vis = mask === null || mask[terrain.index(n.x, n.y)] === 1;
      const crystalMat = n.crystal.material as THREE.MeshStandardMaterial;
      const padMat = n.pad.material as THREE.MeshStandardMaterial;
      crystalMat.emissiveIntensity = vis ? 1 : 0.05;
      applyDim(padMat, vis);
      applyDim(crystalMat, vis);
      if (n.decor) {
        for (const child of n.decor.children) {
          const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (mat) applyDim(mat, vis);
        }
      }
    }
  }

  /** 晶体/底座的"看不见就变暗"：首次调用时记下基准色，供恢复时还原 */
  function applyDim(mat: THREE.MeshStandardMaterial, vis: boolean): void {
    if (mat.userData["baseColor"] === undefined) mat.userData["baseColor"] = mat.color.clone();
    const base = mat.userData["baseColor"] as THREE.Color;
    if (vis) mat.color.copy(base);
    else mat.color.copy(base).multiplyScalar(TILE_DIM);
  }

  function refreshNode(node: NodeVisual): void {
    const frac = node.capacity > 0 ? Math.max(0, Math.min(1, node.remaining / node.capacity)) : 0;
    if (node.decor) {
      // 素材模式：整组缩放表达剩余量，材质往灰里推（空了就是一堆灰石头，一眼看得出没货）
      node.decor.scale.setScalar(0.6 + 0.55 * frac);
      for (const child of node.decor.children) {
        const mat = (child as THREE.Mesh).material;
        if (!mat || !(mat as THREE.MeshStandardMaterial).color) continue;
        const std = mat as THREE.MeshStandardMaterial;
        if (std.userData["baseColor"] === undefined) std.userData["baseColor"] = std.color.clone();
        const base = std.userData["baseColor"] as THREE.Color;
        std.color.copy(base).lerp(GREY, (1 - frac) * 0.8);
      }
      return;
    }
    const mat = node.crystal.material as THREE.MeshStandardMaterial;
    // 剩余量映射到体积与亮度：空了就是一坨灰石头，一眼看得出这里没货了
    const s = 0.34 + 0.66 * frac;
    node.crystal.scale.setScalar(Math.max(0.34, s));
    mat.color.setHex(0x9b6bf0).lerp(new THREE.Color(0x555a63), 1 - frac);
    mat.emissive.setHex(0x3b1f7a).multiplyScalar(0.25 + 0.75 * frac);
    // 颜色变了 → 迷雾的基准色要跟着更新，否则下次恢复可见会退回旧色
    mat.userData["baseColor"] = mat.color.clone();
  }

  function update(_dt: number, elapsed: number): void {
    for (const n of nodes.values()) {
      const frac = n.capacity > 0 ? Math.max(0, Math.min(1, n.remaining / n.capacity)) : 0;
      const bob = Math.sin(elapsed * 1.6 + n.phase) * (0.05 + 0.08 * frac);
      n.crystal.position.y = 0.42 + bob;
      n.crystal.rotation.y = elapsed * 0.6 + n.phase;
      n.crystal.rotation.x = Math.sin(elapsed * 0.4 + n.phase) * 0.12;
    }
    // 水面缓慢漂移：只是 UV 在动，每帧成本几乎为零，但"水"立刻从一块蓝玻璃变成流动的
    waterTex.offset.set(Math.sin(elapsed * 0.22) * 0.015, elapsed * 0.028);
  }

  function dispose(): void {
    disposed = true;
    for (const d of disposables) d.dispose();
    group.clear();
  }

  return { group, nodes, setVisibility, refreshNode, update, dispose };
}