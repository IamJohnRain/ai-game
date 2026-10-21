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

/** 视野外实例颜色的线性缩放系数（线性空间乘 0.12 ≈ 感知亮度剩三分之一，能看到轮廓但读不出细节） */
const TILE_DIM = 0.12;

/** 每个座位在三维里的兵种色，与 ui.tsx 的 SEAT_COLORS 一致（同色不同源会让人以为是两支队伍） */
export const SEAT_COLORS_3D: Record<number, number> = {
  1: 0xef4444,
  2: 0x3b82f6,
  3: 0x22c55e,
  4: 0xeab308,
};

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
  /** 剩余量：null 表示未知（例如座位视角下还没探索到） */
  remaining: number;
  x: number;
  y: number;
  phase: number;
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

export function buildWorld(map: GameMap, terrain: Terrain, opts: { shadows: boolean }): WorldBuild {
  const group = new THREE.Group();
  group.name = "world";
  const dimmed: Dimmed[] = [];
  const disposables: { dispose(): void }[] = [];
  const W = map.width;
  const H = map.height;

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

  /** 建一批实例；colorOf 返回该实例的基准色（线性空间） */
  const buildInstanced = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    tiles: { xs: number[]; ys: number[]; idx: number[] },
    colorOf: (i: number, x: number, y: number) => THREE.Color,
    transform?: (i: number, x: number, y: number) => { quat?: THREE.Quaternion; scale?: THREE.Vector3; y?: number },
    castShadow = true,
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
    for (let i = 0; i < n; i++) {
      const x = tiles.xs[i]!;
      const y = tiles.ys[i]!;
      const extra = transform?.(i, x, y);
      pos.set(worldX(x), extra?.y ?? 0, worldZ(y));
      quat.copy(extra?.quat ?? new THREE.Quaternion());
      scale.copy(extra?.scale ?? new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(i, mat.compose(pos, quat, scale));
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
    return mesh;
  };

  /** 稳定伪随机（按格子坐标）：森林的高低疏密、地板的明暗差异要"每次刷新都一样" */
  const hash01 = (x: number, y: number, salt = 0): number => {
    let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // ---------------- 地板 + 水 ----------------
  // 设施格先用平地铺底（和二维一样"设施站在什么地形上看得清楚"）
  const FACILITIES = "SABGRD";
  const floorTiles = tilesOf((ch) => ch !== "~" && ch !== "f");
  const floorGeo = new THREE.PlaneGeometry(1, 1);
  floorGeo.rotateX(-Math.PI / 2);
  const floorCol = new THREE.Color();
  buildInstanced(
    floorGeo,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    floorTiles,
    (i, x, y) => {
      const ch = map.grid[y]?.[x] ?? ".";
      // 地板做细微明暗变化，避免 4096 块纯色拼成一片"塑料板"
      const shade = 0.86 + hash01(x, y, 1) * 0.2;
      const rgb = FACILITIES.includes(ch) ? 0x4b5666 : 0x46525f;
      return floorCol.setHex(rgb).multiplyScalar(shade);
    },
    undefined,
    false,
  );

  const waterCol = new THREE.Color();
  buildInstanced(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.86, roughness: 0.12, metalness: 0.45 }),
    tilesOf((ch) => ch === "~"),
    (_i, x, y) => waterCol.setHex(0x1f5a8f).multiplyScalar(0.9 + hash01(x, y, 2) * 0.25),
    () => ({ y: 0.015 }),
    false,
  );

  // ---------------- 地形 ----------------
  const wallGeo = new THREE.BoxGeometry(1, 1.15, 1);
  wallGeo.translate(0, 0.575, 0);
  const wallCol = new THREE.Color();
  buildInstanced(
    wallGeo,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    tilesOf((ch) => ch === "#"),
    (_i, x, y) => wallCol.setHex(0x3a4553).multiplyScalar(0.9 + hash01(x, y, 3) * 0.22),
  );

  const upQuat = new THREE.Quaternion();
  const forestTiles = tilesOf((ch) => ch === "f");
  const coneGeo = new THREE.ConeGeometry(0.44, 1.05, 7);
  coneGeo.translate(0, 0.55, 0);
  buildInstanced(
    coneGeo,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    forestTiles,
    (_i, x, y) => new THREE.Color().setHex(0x2f7a45).multiplyScalar(0.8 + hash01(x, y, 4) * 0.4),
    (i, x, y) => ({
      quat: upQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(x, y, 5) * Math.PI * 2),
      scale: new THREE.Vector3(1, 0.8 + hash01(x, y, 6) * 0.5, 1),
    }),
  );
  const trunkGeo = new THREE.CylinderGeometry(0.07, 0.09, 0.3, 5);
  trunkGeo.translate(0, 0.15, 0);
  buildInstanced(
    trunkGeo,
    new THREE.MeshLambertMaterial({ color: 0x4a3624 }),
    forestTiles,
    () => new THREE.Color(0x4a3624).multiplyScalar(1),
  );

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
    // 资源点晶体与底座用的是独立材质，单独调
    for (const n of nodes.values()) {
      const vis = mask === null || mask[terrain.index(n.x, n.y)] === 1;
      const crystalMat = n.crystal.material as THREE.MeshStandardMaterial;
      const padMat = n.pad.material as THREE.MeshStandardMaterial;
      crystalMat.emissiveIntensity = vis ? 1 : 0.05;
      applyDim(padMat, vis);
      applyDim(crystalMat, vis);
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
  }

  function dispose(): void {
    for (const d of disposables) d.dispose();
    group.clear();
  }

  return { group, nodes, setVisibility, refreshNode, update, dispose };
}