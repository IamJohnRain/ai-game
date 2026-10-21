// apps/web/src/scene3d/effects.ts —— 三维特效池：曳光弹、炮口火光、命中/脱靶、爆炸、烟尘、飘字、光束
//
// 为什么用"池 + 固定上限"而不是随用随建：
//   一局坦克战可以打出上千发炮弹，而极速回放时这些事件会挤在几秒内。若每次开火都 new Mesh，
//   GC 抖动会直接表现为掉帧。这里每种特效都预先建好一批对象循环使用，全部用满时**抢占最老的一个**
//   （宁可少一次火花，也不要为了完整性把内存和帧率拖垮）。
//
// 视觉口径：
//   命中 → 火花 + 火球 + 屏幕外也能看见的冲击环；脱靶 → 尘土 + 弹坑圈，颜色刻意做成土黄，
//   这样"打空了"和"打中了"不用看数字也能分辨——这正是回放最需要传达的信息。
//   粒子用自写 shader 的 Points（逐点大小/透明度/颜色），比一堆 Sprite 便宜一个数量级。
import * as THREE from "three";
import { radialTexture, smokeTexture, textTexture } from "./textures.ts";

interface Entry {
  obj: THREE.Object3D;
  ttl: number;
  life: number;
  a: number;
  b: number;
  c: number;
  color: THREE.Color;
  from?: THREE.Vector3;
  to?: THREE.Vector3;
  onEnd?: () => void;
}

/** 从池里取一个可用的对象；满了就抢占存活最久的一个 */
function acquire(list: Entry[], make: () => THREE.Object3D, max: number): Entry {
  if (list.length < max) {
    const obj = make();
    const entry: Entry = { obj, ttl: 0, life: 0, a: 0, b: 0, c: 0, color: new THREE.Color() };
    list.push(entry);
    return entry;
  }
  let oldest = list[0]!;
  for (const e of list) if (e.ttl > 0 && e.life / Math.max(0.001, e.ttl) > oldest.life / Math.max(0.001, oldest.ttl)) oldest = e;
  return oldest;
}

function release(list: Entry[], entry: Entry): void {
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  entry.obj.visible = false;
  entry.obj.parent?.remove(entry.obj);
  entry.ttl = 0;
  entry.life = 0;
}

const SPARK_VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const SPARK_FRAG = `
uniform sampler2D uTex;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uTex, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vColor * a, a);
}`;

/** 火花/碎屑粒子池：位置与速度都在 CPU 上积分，逐帧写回属性缓冲 */
class SparkPool {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly life: Float32Array;
  private readonly ttl: Float32Array;
  private count = 0;
  private readonly material: THREE.ShaderMaterial;

  /** 当前活跃粒子数（性能自检用） */
  get active(): number {
    return this.count;
  }

  constructor(private readonly max: number, tex: THREE.Texture) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.ttl = new Float32Array(max);
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uScale: { value: 300 } },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  setScale(v: number): void {
    this.material.uniforms["uScale"]!.value = v;
  }

  /** 在一点上炸开一簇粒子；spread 是初始速度范围，gravity 让碎屑落下 */
  burst(at: THREE.Vector3, color: THREE.Color, n: number, spread: number, ttl: number, sizeMin: number, sizeMax: number): void {
    for (let k = 0; k < n; k++) {
      if (this.count >= this.max) return;
      const i = this.count++;
      // 半球状散开，且略偏向上：贴地爆炸的火星往外飞才好看
      const theta = Math.random() * Math.PI * 2;
      const up = 0.25 + Math.random() * 0.8;
      const horiz = Math.sqrt(Math.max(0, 1 - up * up));
      const speed = spread * (0.4 + Math.random() * 0.9);
      this.pos[i * 3] = at.x; this.pos[i * 3 + 1] = at.y; this.pos[i * 3 + 2] = at.z;
      this.vel[i * 3] = Math.cos(theta) * horiz * speed;
      this.vel[i * 3 + 1] = up * speed;
      this.vel[i * 3 + 2] = Math.sin(theta) * horiz * speed;
      this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
      this.size[i] = sizeMin + Math.random() * (sizeMax - sizeMin);
      this.alpha[i] = 1;
      this.life[i] = 0;
      this.ttl[i] = ttl * (0.55 + Math.random() * 0.7);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      this.life[i] = this.life[i]! + dt;
      if (this.life[i]! >= this.ttl[i]!) {
        // 用末尾元素填坑：粒子顺序无所谓，但缓冲区要紧凑
        const last = --this.count;
        if (i !== last) {
          for (let c = 0; c < 3; c++) {
            this.pos[i * 3 + c] = this.pos[last * 3 + c]!;
            this.vel[i * 3 + c] = this.vel[last * 3 + c]!;
            this.col[i * 3 + c] = this.col[last * 3 + c]!;
          }
          this.size[i] = this.size[last]!;
          this.alpha[i] = this.alpha[last]!;
          this.life[i] = this.life[last]!;
          this.ttl[i] = this.ttl[last]!;
        }
        i--;
        continue;
      }
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! - 9.2 * dt; // 重力
      const drag = 1 - Math.min(0.5, dt * 2.2);
      this.vel[i * 3] = this.vel[i * 3]! * drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! * drag;
      this.vel[i * 3 + 2] = this.vel[i * 3 + 2]! * drag;
      this.pos[i * 3] = this.pos[i * 3]! + this.vel[i * 3]! * dt;
      this.pos[i * 3 + 1] = this.pos[i * 3 + 1]! + this.vel[i * 3 + 1]! * dt;
      this.pos[i * 3 + 2] = this.pos[i * 3 + 2]! + this.vel[i * 3 + 2]! * dt;
      if (this.pos[i * 3 + 1]! < 0.02) {
        this.pos[i * 3 + 1] = 0.02;
        this.vel[i * 3 + 1] = Math.abs(this.vel[i * 3 + 1]!) * 0.25; // 落地反弹一点点
      }
      this.alpha[i] = Math.max(0, 1 - this.life[i]! / this.ttl[i]!);
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, this.count);
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aAlpha") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

export class FxSystem {
  readonly group = new THREE.Group();
  private readonly spark: SparkPool;
  private readonly glowTex: THREE.Texture;
  private readonly smokeTex: THREE.Texture;
  private readonly tracers: Entry[] = [];
  private readonly shells: Entry[] = [];
  private readonly rings: Entry[] = [];
  private readonly beams: Entry[] = [];
  private readonly flashes: Entry[] = [];
  private readonly fireballs: Entry[] = [];
  private readonly smokes: Entry[] = [];
  private readonly texts: Entry[] = [];
  private readonly textCache = new Map<string, THREE.Texture>();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly vecA = new THREE.Vector3();
  private readonly vecB = new THREE.Vector3();
  /** 单点光源：爆炸时短暂照亮地面。多光源不划算，最新的爆炸抢到它 */
  private readonly flashLight: THREE.PointLight;
  private flashLightLife = 0;
  private flashLightTtl = 0;

  constructor() {
    this.group.name = "fx";
    this.glowTex = radialTexture("rgba(255,255,255,1)");
    this.smokeTex = smokeTexture();
    this.spark = new SparkPool(640, this.glowTex);
    this.group.add(this.spark.points);
    this.flashLight = new THREE.PointLight(0xffb066, 0, 16, 2);
    this.flashLight.visible = false;
    this.group.add(this.flashLight);
  }

  // ---------------- 开火 ----------------
  /** 炮口火光：亮一下就好，长了大炮看着像喷火器 */
  muzzle(at: THREE.Vector3, color: number): void {
    const e = acquire(this.flashes, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.group.add(s);
      return s;
    }, 14);
    const sprite = e.obj as THREE.Sprite;
    e.ttl = 0.11; e.life = 0; e.a = 0.55 + Math.random() * 0.25;
    e.color.setHex(color).lerp(new THREE.Color(0xffd9a0), 0.55);
    sprite.visible = true;
    sprite.position.copy(at);
    sprite.scale.setScalar(0.85);
    sprite.material.color.copy(e.color);
    this.spark.burst(at, new THREE.Color(0xffcf8a), 8, 2.6, 0.32, 0.05, 0.12);
    this.light(at, 0xffa24d, 3.2, 0.12, 6);
  }

  /** 曳光弹：开火瞬间的一道线，让"谁打谁"在大地图上也看得见 */
  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const e = acquire(this.tracers, () => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.disposables.push(m.geometry, m.material);
      this.group.add(m);
      return m;
    }, 18);
    const mesh = e.obj as THREE.Mesh;
    e.ttl = 0.16; e.life = 0; e.a = 0.9;
    e.color.setHex(color).lerp(new THREE.Color(0xffffff), 0.45);
    this.orient(mesh, from, to);
    (mesh.material as THREE.MeshBasicMaterial).color.copy(e.color).multiplyScalar(e.a);
    mesh.visible = true;
    // 曳光弹本身带一簇细小火星，看起来像弹道而不是一根棍子
    this.spark.burst(to, new THREE.Color(color), 3, 1.1, 0.18, 0.03, 0.06);
  }

  /** 弹丸：飞快的一颗小球从炮口飞到落点，比曳光弹更有"实体感" */
  shell(from: THREE.Vector3, to: THREE.Vector3, color: number, onEnd?: () => void): void {
    const e = acquire(this.shells, () => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xfff2c0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
      );
      this.disposables.push(m.geometry, m.material);
      this.group.add(m);
      return m;
    }, 18);
    const mesh = e.obj as THREE.Mesh;
    e.ttl = 0.14; e.life = 0; e.color.setHex(color).lerp(new THREE.Color(0xfff6d8), 0.7);
    e.from = (e.from ?? new THREE.Vector3()).copy(from);
    e.to = (e.to ?? new THREE.Vector3()).copy(to);
    e.onEnd = onEnd;
    mesh.visible = true;
    mesh.position.copy(from);
    (mesh.material as THREE.MeshBasicMaterial).color.copy(e.color);
  }

  /** 命中 / 脱靶：同样是"打中了"，命中的是火与金属火花，脱靶的是土 */
  impact(at: THREE.Vector3, hit: boolean): void {
    if (hit) {
      this.spark.burst(at, new THREE.Color(0xffd27a), 26, 5.2, 0.5, 0.06, 0.16);
      this.spark.burst(at, new THREE.Color(0xffffff), 10, 3.4, 0.3, 0.03, 0.1);
      this.fireball(at, 0.55, 0.34);
      this.ring(at, 0xff9a3c, 1.1, 0.45);
      this.smokePuff(at, 1.0, 0.9);
      this.light(at, 0xffb066, 3.6, 0.26, 9);
    } else {
      this.spark.burst(at, new THREE.Color(0xb99a6b), 16, 3.2, 0.6, 0.05, 0.13);
      this.smokePuff(at, 1.3, 0.75);
      this.ring(at, 0xc9a978, 0.75, 0.5);
    }
  }

  /** 爆炸（阵亡、大威力击中）：火球 + 大量碎屑 + 浓烟 + 冲击环 + 一次照明 */
  explosion(at: THREE.Vector3, scale = 1): void {
    this.fireball(at, 1.35 * scale, 0.6);
    this.fireball(at, 0.9 * scale, 0.9);
    this.spark.burst(at, new THREE.Color(0xffb347), 60, 8.5 * scale, 0.85, 0.09, 0.28);
    this.spark.burst(at, new THREE.Color(0xfff0c0), 24, 5 * scale, 0.5, 0.05, 0.14);
    this.spark.burst(at, new THREE.Color(0x6b6f78), 30, 4.2 * scale, 1.3, 0.1, 0.3);
    for (let i = 0; i < 3; i++) this.smokePuff(at, 2.0 + i * 0.7, 1.4 + i * 0.35);
    this.ring(at, 0xff8a2b, 3.2 * scale, 0.8);
    this.light(at, 0xffa24d, 7 * scale, 0.5, 16);
  }

  /** 冲击环：贴地的扩散圈，采集/提交/复活/命中都用它做"这里发生了事"的标记 */
  ring(at: THREE.Vector3, color: number, radius: number, ttl = 0.6): void {
    const e = acquire(this.rings, () => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.5, 26).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.disposables.push(m.geometry, m.material);
      this.group.add(m);
      return m;
    }, 24);
    const mesh = e.obj as THREE.Mesh;
    e.ttl = ttl; e.life = 0; e.a = radius; e.b = 1;
    e.color.setHex(color);
    mesh.visible = true;
    mesh.position.set(at.x, Math.max(0.03, at.y * 0.15 + 0.03), at.z);
    mesh.scale.setScalar(0.3);
    (mesh.material as THREE.MeshBasicMaterial).color.copy(e.color);
  }

  /** 采集光束：从资源点连到坦克，让"在哪采的"一目了然 */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const e = acquire(this.beams, () => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 1, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.disposables.push(m.geometry, m.material);
      this.group.add(m);
      return m;
    }, 12);
    const mesh = e.obj as THREE.Mesh;
    e.ttl = 0.45; e.life = 0; e.a = 1;
    e.color.setHex(color);
    this.orient(mesh, from, to);
    mesh.visible = true;
    (mesh.material as THREE.MeshBasicMaterial).color.copy(e.color);
  }

  /** 复活：从天而降的光柱，配合"弹出来"的缩放动画 */
  respawnBeam(at: THREE.Vector3, color: number): void {
    const e = acquire(this.beams, () => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.75, 8, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      this.disposables.push(m.geometry, m.material);
      this.group.add(m);
      return m;
    }, 12);
    const mesh = e.obj as THREE.Mesh;
    e.ttl = 0.85; e.life = 0; e.a = 2;
    e.color.setHex(color);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.position.set(at.x, 4, at.z);
    mesh.visible = true;
    (mesh.material as THREE.MeshBasicMaterial).color.copy(e.color);
    this.ring(at, color, 1.6, 0.7);
    this.spark.burst(at, e.color.clone(), 22, 3.6, 0.7, 0.06, 0.16);
  }

  /** 履带扬尘：太小的一撮，只为让移动"有重量" */
  dust(at: THREE.Vector3): void {
    this.smokePuff(at, 0.6, 0.5, 0x8a8578);
  }

  /** 无效动作：红色叉号 + 一圈警示环（这是"模型写错了"的现场证据，值得显眼） */
  invalidMark(at: THREE.Vector3): void {
    this.ring(at, 0xff5470, 0.9, 0.5);
    this.text(at, "✕", "#ff6b81");
  }

  /** 飘字：+6、-2、装弹 … 直接压在事件发生的位置上方 */
  text(at: THREE.Vector3, text: string, color: string, ttl = 1.25): void {
    const e = acquire(this.texts, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
      this.group.add(s);
      return s;
    }, 20);
    const sprite = e.obj as THREE.Sprite;
    const key = `${text}|${color}`;
    let tex = this.textCache.get(key);
    if (!tex) {
      tex = textTexture(text, color);
      if (this.textCache.size >= 48) {
        const first = this.textCache.keys().next().value;
        if (first !== undefined) {
          this.textCache.get(first)?.dispose();
          this.textCache.delete(first);
        }
      }
      this.textCache.set(key, tex);
    }
    e.ttl = ttl; e.life = 0; e.a = 0;
    sprite.visible = true;
    sprite.material.map = tex;
    sprite.material.needsUpdate = true;
    sprite.position.copy(at);
    sprite.scale.set(0.95, 0.32, 1);
  }

  // ---------------- 内部构件 ----------------
  private fireball(at: THREE.Vector3, scale: number, ttl: number): void {
    const e = acquire(this.fireballs, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.group.add(s);
      return s;
    }, 18);
    const sprite = e.obj as THREE.Sprite;
    e.ttl = ttl; e.life = 0; e.a = scale;
    e.color.setHex(0xffb257).lerp(new THREE.Color(0xfff3cf), 0.35);
    sprite.visible = true;
    sprite.position.copy(at);
    sprite.position.y += 0.2 * scale;
    sprite.scale.setScalar(scale * 0.6);
    sprite.material.color.copy(e.color);
  }

  private smokePuff(at: THREE.Vector3, scale: number, ttl: number, color = 0x555049): void {
    const e = acquire(this.smokes, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, depthWrite: false, opacity: 0.55 }));
      this.group.add(s);
      return s;
    }, 40);
    const sprite = e.obj as THREE.Sprite;
    e.ttl = ttl; e.life = 0;
    e.a = scale; e.b = 0.5 + Math.random() * 0.6; e.c = Math.random() * Math.PI * 2;
    e.color.setHex(color);
    sprite.visible = true;
    sprite.position.copy(at);
    sprite.position.x += (Math.random() - 0.5) * 0.3;
    sprite.position.y += 0.25;
    sprite.position.z += (Math.random() - 0.5) * 0.3;
    sprite.scale.setScalar(scale * 0.5);
    sprite.material.color.copy(e.color);
    sprite.material.opacity = 0.55;
  }

  private light(at: THREE.Vector3, color: number, intensity: number, ttl: number, range: number): void {
    this.flashLight.visible = true;
    this.flashLight.position.copy(at);
    this.flashLight.position.y += 0.5;
    this.flashLight.color.setHex(color);
    this.flashLight.intensity = intensity;
    this.flashLight.distance = range;
    this.flashLightLife = 0;
    this.flashLightTtl = ttl;
  }

  /** 把一根单位圆柱摆成 from→to 的线段 */
  private orient(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
    const dir = this.vecA.subVectors(to, from);
    const len = dir.length() || 0.001;
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(this.up, this.vecB.copy(dir).divideScalar(len));
  }

  /** 每帧推进：相机位置用于更新粒子点尺寸（点尺寸依赖视口高度与 fov） */
  update(dt: number, camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    const fov = (camera.fov * Math.PI) / 180;
    this.spark.setScale(viewportHeightPx / (2 * Math.tan(fov / 2)));
    this.spark.update(dt);

    for (const list of [this.tracers, this.shells, this.rings, this.beams, this.flashes, this.fireballs, this.smokes, this.texts]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i]!;
        e.life += dt;
        const p = Math.min(1, e.life / e.ttl);
        if (list === this.tracers) {
          const mat = (e.obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = 1 - p;
          mat.transparent = true;
        } else if (list === this.shells) {
          (e.obj as THREE.Mesh).position.lerpVectors(e.from!, e.to!, p);
        } else if (list === this.rings) {
          const mesh = e.obj as THREE.Mesh;
          mesh.scale.setScalar(0.3 + (e.a - 0.3) * Math.sqrt(p));
          (mesh.material as THREE.MeshBasicMaterial).opacity = 1 - p;
          (mesh.material as THREE.MeshBasicMaterial).transparent = true;
        } else if (list === this.beams) {
          const mesh = e.obj as THREE.Mesh;
          const mat = mesh.material as THREE.MeshBasicMaterial;
          // 光柱：先亮后收，同时整体抬起（复活光柱往上抽走）
          mat.opacity = (1 - p) * (0.65 + 0.35 * Math.sin(e.life * 26));
          mesh.position.y += e.a * dt;
          mesh.scale.x = mesh.scale.z = Math.max(0.05, 1 - p * 0.7);
        } else if (list === this.flashes) {
          const sprite = e.obj as THREE.Sprite;
          sprite.material.opacity = 1 - p;
          sprite.scale.setScalar(e.a * (0.6 + p * 1.1));
        } else if (list === this.fireballs) {
          const sprite = e.obj as THREE.Sprite;
          sprite.material.opacity = Math.pow(1 - p, 1.6);
          sprite.scale.setScalar(e.a * (0.55 + p * 1.5));
          sprite.material.color.copy(e.color).lerp(FIREBALL_END, p * 0.7);
        } else if (list === this.smokes) {
          const sprite = e.obj as THREE.Sprite;
          sprite.material.opacity = 0.55 * Math.pow(1 - p, 1.2);
          sprite.scale.setScalar(e.a * (0.5 + p * 1.6));
          sprite.position.y += dt * 0.45 * e.b;
          sprite.material.rotation = e.c;
        } else {
          const sprite = e.obj as THREE.Sprite;
          // 飘字同样按距离缩放：远处也要读得出"+6"，近处不能糊住半个屏幕
          const dist = sprite.position.distanceTo(camera.position);
          const h = Math.max(0.32, Math.min(1.6, dist * 0.043));
          sprite.scale.set(h * (256 / 80), h, 1);
          sprite.position.y += dt * 0.75;
          sprite.material.opacity = p < 0.15 ? p / 0.15 : Math.pow(1 - (p - 0.15) / 0.85, 1.4);
        }
        if (p >= 1) {
          if (list === this.shells && e.onEnd) e.onEnd();
          release(list, e);
        }
      }
    }

    if (this.flashLight.visible) {
      this.flashLightLife += dt;
      const p = this.flashLightLife / this.flashLightTtl;
      if (p >= 1) {
        this.flashLight.visible = false;
        this.flashLight.intensity = 0;
      } else {
        this.flashLight.intensity *= 1 - Math.min(0.6, dt * 6);
      }
    }
  }

  /** 当前活跃对象数（性能自检/调试用） */
  get activeCount(): number {
    return this.spark.active + this.tracers.length + this.shells.length + this.rings.length
      + this.beams.length + this.flashes.length + this.fireballs.length + this.smokes.length + this.texts.length;
  }

  dispose(): void {
    this.spark.dispose();
    for (const d of this.disposables) d.dispose();
    for (const t of this.textCache.values()) t.dispose();
    this.textCache.clear();
    this.glowTex.dispose();
    this.smokeTex.dispose();
    this.group.clear();
  }
}

const FIREBALL_END = new THREE.Color(0x6b3a10);
