// apps/web/src/scene3d/models.ts —— 三维模型素材的加载与实例化（glTF/GLB）
//
// 为什么要有这一层：
//   1) 场景是"按格子铺实例"的（最多 4096 格），所以素材必须以 InstancedMesh 的方式使用；
//      一个 GLB 里可能有多个图元（树干+树冠、车体+履带），这里把它拆成"可实例化的部件"列表，
//      每部件一份几何+材质+局部变换，调用方只需按格填实例矩阵；
//   2) 加载是异步的，而场景是同步建的：调用方先用过程式几何当占位（保证首帧不空窗），
//      模型就绪后再整体替换（与二维素材 sprites.ts 的"未就绪先用色块"是同一套思路）；
//   3) 素材可能加载失败（离线开发、文件损坏、CDN 挂了），这里统一吞异常并保留占位几何，
//      绝不让一个模型把整个战场拖黑屏。
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** 一个可实例化的部件：几何 + 材质 + 在模型内的局部变换 */
export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** 部件相对模型原点的变换（例如树冠在树干上方 0.6 处） */
  matrix: THREE.Matrix4;
}

export interface ModelAsset {
  url: string;
  /** 模板对象：克隆它得到一个个独立的模型实例（坦克用；因为它们要各自转炮塔） */
  template: THREE.Group;
  /** 拆好的部件：铺格子用（树木、石头、箱子…这些只按实例矩阵摆放即可） */
  parts: ModelPart[];
  /** 模型自带包围盒（尺寸归一化用：不同来源的模型大小差很多，一律按格子大小缩放） */
  size: THREE.Vector3;
}

const cache = new Map<string, Promise<ModelAsset | null>>();
let loader: GLTFLoader | null = null;
/** Kenney 的模型共用一张 colormap：GLB 里写的是相对路径 Textures/colormap.png，
 *  但打包后那个路径不存在（资源会被 Vite 改名），所以统一重定向到我们随包发布的那张。 */
let textureMap: Record<string, string> = {};

/** 注册"GLB 内引用的贴图名 → 实际 URL"的映射（在加载任何模型之前调用一次即可） */
export function setModelTextures(map: Record<string, string>): void {
  textureMap = map;
  loader = null; // 换映射要重建 loader（URL 修饰器挂在 LoadingManager 上）
}

function loaderOf(): GLTFLoader {
  if (!loader) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      for (const [name, target] of Object.entries(textureMap)) {
        if (url.includes(name)) return target;
      }
      return url;
    });
    loader = new GLTFLoader(manager);
  }
  return loader;
}

/**
 * 加载一个 GLB/GLTF。失败返回 null（调用方保留占位几何），永不抛。
 * 结果按 URL 缓存：同一模型被多个格子/多个座位用，只下载解析一次。
 */
export function loadModel(url: string): Promise<ModelAsset | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const task = loaderOf()
    .loadAsync(url)
    .then((gltf) => buildAsset(url, gltf.scene))
    .catch((err: unknown) => {
      console.warn(`[scene3d] 模型加载失败，保留过程式占位：${url}`, err);
      return null;
    });
  cache.set(url, task);
  return task;
}

function buildAsset(url: string, root: THREE.Object3D): ModelAsset {
  root.updateMatrixWorld(true);
  const parts: ModelPart[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone();
    // 把"到模型原点"的变换烘进图元矩阵：实例化时整棵树都共用同一套格子矩阵
    const matrix = mesh.matrixWorld.clone();
    const material = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
    parts.push({ geometry, material, matrix });
  });
  // 包围盒：用于把任意来源的模型缩放到"一格大小"
  const box = new THREE.Box3().setFromObject(root);
  const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
  // 原点对齐到"底面中心"：模型作者习惯不一（有的原点在脚底、有的在几何中心），
  // 统一挪到底面中心后，铺格子时 y=0 就是地面，不必每个模型单独调。
  const center = box.getCenter(new THREE.Vector3());
  const shift = new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z);
  for (const part of parts) part.matrix.premultiply(shift);
  // 克隆用模板：外面再套一层只做平移的 Group，于是"template 的世界矩阵"与"部件的烘入矩阵"口径一致
  const template = new THREE.Group();
  template.add(root);
  template.position.set(-center.x, -box.min.y, -center.z);
  return { url, template, parts, size };
}

/** 取一份独立副本（坦克这类需要各自动画/换色的用；几何与材质按需克隆） */
export function cloneModel(asset: ModelAsset, opts: { cloneMaterials?: boolean } = {}): THREE.Group {
  const group = asset.template.clone(true);
  if (opts.cloneMaterials) {
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.clone())
        : mesh.material.clone();
    });
  }
  return group;
}

/**
 * 按"一格多少世界单位"归一化部件矩阵。
 * 美术给的是 1 米还是 100 厘米无从得知，所以一律按包围盒缩放到目标格子尺寸：
 * 只要模型内部比例正确，铺出来的战场就不会出现"树比坦克大十倍"。
 */
export function normalizeParts(asset: ModelAsset, targetSpan: number): ModelPart[] {
  const maxSpan = Math.max(asset.size.x, asset.size.z, 0.0001);
  const k = targetSpan / maxSpan;
  const scale = new THREE.Matrix4().makeScale(k, k, k);
  return asset.parts.map((part) => ({
    geometry: part.geometry,
    material: part.material,
    matrix: part.matrix.clone().premultiply(scale),
  }));
}

/** 释放所有已加载素材（离开三维场景时调用） */
export function attachParts(
  group: THREE.Object3D,
  parts: ModelPart[],
  opts: { shadows?: boolean } = {},
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const part of parts) {
    const mesh = new THREE.Mesh(part.geometry, part.material);
    // 矩阵是烘好的（含"原点对齐底面中心"的平移），别让 three 每帧用 position/rotation 覆盖它
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(part.matrix);
    // 关掉 matrixAutoUpdate 之后必须自己声明"矩阵变了"：否则 three 不会重算 matrixWorld，
    // 部件会停在上一帧（或单位矩阵）上——表现为"模型根本不见"。
    mesh.matrixWorldNeedsUpdate = true;
    mesh.castShadow = Boolean(opts.shadows);
    mesh.receiveShadow = Boolean(opts.shadows);
    group.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

export function disposeModels(): void {
  for (const task of cache.values()) {
    void task.then((asset) => {
      if (!asset) return;
      for (const part of asset.parts) {
        part.geometry.dispose();
        disposeMaterial(part.material);
      }
    });
  }
  cache.clear();
  loader = null;
}

function disposeMaterial(material: THREE.Material): void {
  const withMaps = material as THREE.Material & {
    map?: THREE.Texture | null;
    normalMap?: THREE.Texture | null;
    roughnessMap?: THREE.Texture | null;
    metalnessMap?: THREE.Texture | null;
    emissiveMap?: THREE.Texture | null;
    aoMap?: THREE.Texture | null;
  };
  for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"] as const) {
    withMaps[key]?.dispose();
  }
  material.dispose();
}