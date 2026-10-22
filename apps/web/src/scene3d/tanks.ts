// apps/web/src/scene3d/tanks.ts —— 三维坦克：车体/炮塔/炮管、朝向推断、平滑插值、阵亡残骸与最后目击
//
// 与二维渲染口径一致的三件事（对齐 components/BattleCanvas.tsx）：
//   1) 事件流里没有"朝向"字段，炮口方向只能从位移推断；这里同样用"上一次的格子"推方向；
//   2) 阵亡单位不可见，取而代之的是残骸（二维画的是虚线框 + 半透明车体）；
//   3) 座位视角下，消失的敌人留下"最后目击位置"（二维是虚线圈 + ?），三维里是一个半透明轮廓。
//
// 平滑：状态是以事件为节拍跳变的（最快 20 次/秒），直接跟着跳会"瞬移"。
//   所以位置与朝向都做指数逼近：状态给目标，渲染读当前值，视觉上就是坦克在驶过一个格子。
import * as THREE from "three";
import type { TankView } from "@ai-game/engine";
import { damp, lerpAngle } from "./cameraMath.ts";
import { shadowTexture } from "./textures.ts";
import { type TankModel } from "./tankModel.ts";
import { attachParts } from "./models.ts";

/** 车体尺寸：一个格子放得下，且留出缝隙能看出两辆车贴在一起时是两辆 */
const HULL = { w: 0.62, h: 0.24, d: 0.8 };
const TRACK_X = 0.33;
/** 过程式炮塔的抬升：素材炮塔自带真实高度，换装后必须归零（否则炮塔整体浮在车体上方） */
const TURRET_Y = 0.34;
/** 过程式炮口在炮塔局部坐标里的位置（+Z 为车头方向）；用素材时会被素材算出的炮口替换 */
const MUZZLE_LOCAL = new THREE.Vector3(0, 0, 0.68);
/** 位置/朝向的收敛速度（每秒）；位置比朝向略快，转弯时看起来像"先到位再转正" */
const POS_K = 16;
const YAW_K = 12;
const TURRET_K = 7;

export interface TankRigInit {
  seat: number;
  color: number;
  shadows: boolean;
  /** 低模坦克素材（可选）：有就用真模型，没有就退回过程式几何（保证离线/加载失败时依然能看） */
  tankModel?: TankModel | null;
}

export class TankRig {
  readonly seat: number;
  /** 阴影开关：素材网格与过程式几何口径要一致 */
  private readonly shadows: boolean;
  readonly group = new THREE.Group();
  /** 车体部分（含细节与履带）：被淘汰或隐藏时整体开关 */
  private readonly bodyGroup = new THREE.Group();
  /** 素材模式的车体容器（承载车头翻转这一层变换） */
  private readonly bodyModel = new THREE.Group();
  /** 素材模式的炮塔容器（同理，炮塔转向会叠加在它外层） */
  private readonly turretModel = new THREE.Group();
  private readonly hull: THREE.Mesh;
  private readonly tracks: THREE.Mesh[] = [];
  private readonly turretGroup = new THREE.Group();
  private readonly wreck: THREE.Group;
  private readonly ghost: THREE.Group;
  private readonly marker: THREE.Mesh;
  private readonly decal: THREE.Mesh;
  private readonly label: THREE.Sprite;
  private readonly labelCanvas: HTMLCanvasElement;
  /** 炮口（炮塔局部坐标）：过程式坦克是固定的，模型坦克按素材炮管端点算 */
  private readonly muzzleLocal = MUZZLE_LOCAL.clone();
  /** 换装时用的素材模型（保留引用，便于在调试钩子里核对炮口与朝向） */
  appliedModel: TankModel | null = null;
  private labelKey = "";
  private readonly bodyMats: THREE.MeshStandardMaterial[] = [];
  private readonly edgeMat: THREE.MeshStandardMaterial;

  // —— 动画状态 ——
  private tx = 0; private tz = 0;           // 目标世界坐标
  private cx = 0; private cz = 0;           // 当前世界坐标
  private targetYaw = 0; private yaw = 0;   // 车体朝向
  private targetTurretYaw = 0; private turretYaw = 0;
  private turretHoldMs = 0;                 // 开火后炮塔朝目标锁定一会儿
  private recoil = 0;
  private flash = 0;
  private pop = 1;                          // 复活/登场时的缩放动画
  private dead = false;
  private ready = false;
  private lastTile: { x: number; y: number } | null = null;

  constructor(init: TankRigInit) {
    this.seat = init.seat;
    this.shadows = init.shadows;
    this.group.name = `tank-${init.seat}`;
    this.group.add(this.bodyGroup);
    const body = new THREE.Color(init.color);
    const dark = body.clone().multiplyScalar(0.45);

    const mkMat = (color: THREE.Color, roughness: number, metalness: number): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive: new THREE.Color(0x000000) });
      this.bodyMats.push(m);
      return m;
    };

    this.hull = new THREE.Mesh(new THREE.BoxGeometry(HULL.w * 0.86, HULL.h * 0.7, HULL.d * 0.94), mkMat(body, 0.6, 0.3));
    this.hull.position.y = 0.13;
    this.hull.castShadow = init.shadows;
    this.bodyGroup.add(this.hull);

    // —— 车体细节：倾斜首上装甲 / 发动机舱盖 / 挡泥板 ——
    // 只靠两个盒子看不出是坦克，加上这几块"斜面 + 舱盖"就有了坦克的剪影
    const deckMat = mkMat(body.clone().multiplyScalar(1.18), 0.45, 0.4);
    const glacis = new THREE.Mesh(new THREE.BoxGeometry(HULL.w * 0.84, 0.09, 0.34), deckMat);
    glacis.position.set(0, 0.2, HULL.d * 0.26);
    glacis.rotation.x = -0.62; // 前倾斜面
    glacis.castShadow = init.shadows;
    const engineDeck = new THREE.Mesh(new THREE.BoxGeometry(HULL.w * 0.76, 0.07, 0.3), deckMat);
    engineDeck.position.set(0, 0.24, -HULL.d * 0.28);
    engineDeck.castShadow = init.shadows;
    const grilleMat = mkMat(new THREE.Color(0x2b2f36), 0.85, 0.15);
    const fenders = new THREE.Group();
    for (const side of [-1, 1]) {
      const fender = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, HULL.d * 0.92), deckMat);
      fender.position.set(side * (TRACK_X - 0.03), 0.27, 0);
      fender.castShadow = init.shadows;
      fenders.add(fender);
    }
    this.bodyGroup.add(glacis, engineDeck, fenders);

    const trackGeo = new THREE.BoxGeometry(0.16, 0.26, HULL.d + 0.06);
    for (const side of [-1, 1]) {
      const tr = new THREE.Mesh(trackGeo, mkMat(dark, 0.9, 0.1));
      tr.position.set(side * TRACK_X, 0.13, 0);
      tr.castShadow = init.shadows;
      this.tracks.push(tr);
      this.bodyGroup.add(tr);
      // 负重轮：侧面看过去的一排轮子，比纯方块 "有机械感"
      for (let i = 0; i < 3; i++) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.19, 10).rotateZ(Math.PI / 2), grilleMat);
        wheel.position.set(side * TRACK_X, 0.13, (i - 1) * 0.24);
        fenders.add(wheel);
      }
      // 履带纹：压在最外侧的一小条更亮的胶面
      const tread = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, HULL.d * 0.9), grilleMat);
      tread.position.set(side * (TRACK_X + 0.085), 0.13, 0);
      fenders.add(tread);
    }

    // —— 炮塔：多边形座圈 + 斜面炮塔本体 + 炮管（含炮口制退器）——
    const turretMat = mkMat(body.clone().multiplyScalar(1.12), 0.5, 0.45);
    const turretMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.23, 0.16, 10), turretMat);
    turretMesh.castShadow = init.shadows;
    // 炮塔前脸做成斜面：圆柱 + 斜置的楔形块，读起来更像炮塔而不是罐头
    const turretFront = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.26), turretMat);
    turretFront.position.set(0, 0.01, 0.14);
    turretFront.rotation.x = -0.22;
    turretFront.castShadow = init.shadows;
    const mantlet = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 10).rotateX(Math.PI / 2), grilleMat);
    mantlet.position.set(0, 0.01, 0.26);
    const cupola = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.08, 0.07, 10), mkMat(body.clone().multiplyScalar(0.9), 0.55, 0.4));
    cupola.position.set(-0.07, 0.11, -0.06);
    cupola.castShadow = init.shadows;
    const barrelMat = mkMat(dark.clone().multiplyScalar(1.6), 0.4, 0.6);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.62, 8).rotateX(Math.PI / 2), barrelMat);
    barrel.position.set(0, 0, 0.36);
    barrel.castShadow = init.shadows;
    const muzzleBrake = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.09, 8).rotateX(Math.PI / 2), barrelMat);
    muzzleBrake.position.set(0, 0, 0.62);
    this.turretGroup.position.y = TURRET_Y;
    this.turretGroup.add(turretMesh, turretFront, mantlet, cupola, barrel, muzzleBrake);
    // 素材模式的容器：过程式部件留在原地，素材挂到这两个空组里（必须挂进场景图，否则永远不渲染）
    this.bodyGroup.add(this.bodyModel);
    this.turretGroup.add(this.turretModel);
    this.group.add(this.turretGroup);

    // 素材可能比场景晚到（异步加载）：先把过程式几何摆上，模型到了再换装
    if (init.tankModel) this.useModel(init.tankModel);

    // —— 阵亡残骸：车身压扁、颜色焦黑，停在原地直到复活 ——
    this.edgeMat = mkMat(new THREE.Color(0x2a2a2e), 0.95, 0.05);
    this.wreck = new THREE.Group();
    const wreckHull = new THREE.Mesh(new THREE.BoxGeometry(HULL.w * 1.02, 0.16, HULL.d * 0.98), mkMat(new THREE.Color(0x24262b), 0.95, 0.1));
    wreckHull.position.y = 0.08;
    const wreckTurret = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.14, 10), this.edgeMat);
    wreckTurret.position.set(0.06, 0.1, -0.05);
    wreckTurret.rotation.z = 0.5;
    this.wreck.add(wreckHull, wreckTurret);
    this.wreck.visible = false;
    this.wreck.castShadow = init.shadows;
    this.group.add(this.wreck);

    // —— 最后目击：半透明线框 + 地面虚线圈 ——
    this.ghost = new THREE.Group();
    const wire = new THREE.Mesh(
      new THREE.BoxGeometry(HULL.w * 1.1, HULL.h * 1.3, HULL.d * 1.1),
      new THREE.MeshBasicMaterial({ color: init.color, wireframe: true, transparent: true, opacity: 0.35 }),
    );
    wire.position.y = 0.18;
    const ghostRing = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.42, 18).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: init.color, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
    );
    ghostRing.position.y = 0.04;
    this.ghost.add(wire, ghostRing);
    this.ghost.visible = false;
    this.group.add(this.ghost);

    // —— 被观察座位自身的标记圈 ——
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.44, 0.52, 22).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xf5c542, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    this.marker.position.y = 0.05;
    this.marker.visible = false;
    this.group.add(this.marker);

    // —— 脚下接触阴影：没有它，坦克在俯视镜头里像贴纸；有了它，一眼就有"落地"的重量 ——
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.55, color: 0x05070c,
    });
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.15).rotateX(-Math.PI / 2), shadowMat);
    decal.position.y = 0.022;
    decal.renderOrder = 1;
    this.decal = decal;
    this.group.add(decal);

    // —— 头顶铭牌：座位号 + 血条（Sprite 永远面向相机，省掉一堆广告牌矩阵） ——
    this.labelCanvas = document.createElement("canvas");
    this.labelCanvas.width = 128;
    this.labelCanvas.height = 56;
    const tex = new THREE.CanvasTexture(this.labelCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    this.label.center.set(0.5, 0);
    this.label.position.y = 1.05;
    this.label.scale.set(1.0, 0.44, 1);
    this.group.add(this.label);
  }

  /**
   * 铭牌尺寸随"离相机多远"变：写死世界尺寸的话，全局视角下它只有几个像素（读不出是谁），
   * 贴脸时又糊住半个屏幕。按距离缩放后，屏幕上基本恒定高度（≈26px）。
   */
  setLabelSize(dist: number): void {
    const h = Math.max(0.34, Math.min(1.7, dist * 0.045));
    this.label.scale.set(h * (128 / 56), h, 1);
    this.label.position.y = 0.95 + h * 0.42;
  }

  /**
   * 换装成低模素材：车体与炮塔分别挂进各自的容器，炮口按素材炮管端面重算。
   * 过程式几何只是隐藏、不销毁 —— 素材出问题时把 visible 翻回来就能立刻回退。
   */
  useModel(model: TankModel): void {
    for (const child of [...this.bodyGroup.children]) if (child !== this.bodyModel) child.visible = false;
    for (const child of [...this.turretGroup.children]) if (child !== this.turretModel) child.visible = false;
    for (const child of [...this.bodyModel.children]) this.bodyModel.remove(child);
    for (const child of [...this.turretModel.children]) this.turretModel.remove(child);
    // 车头对齐：素材声明的车头方向可能不是 +Z（甚至朝后），用一层只做 Y 轴旋转的组把它扳正。
    // 车体与炮塔必须转同一个角度，否则炮塔的"零位"会和车体错开。
    this.bodyModel.rotation.y = model.yawOffset;
    this.turretModel.rotation.y = model.yawOffset;
    // 素材部件的矩阵里已经带着各自真实的高度（buildAsset 把"底面贴地"烘进去了）：
    // 过程式炮塔那 0.34 的抬升必须归零，否则素材炮塔会浮在车体上方、和履带之间留一道空缝。
    this.turretGroup.position.y = 0;
    attachParts(this.bodyModel, model.bodyParts, { shadows: this.shadows });
    attachParts(this.turretModel, model.turretParts, { shadows: this.shadows });
    this.muzzleLocal.copy(model.muzzle);
    this.appliedModel = model;
    this.group.updateMatrixWorld(true);
  }

  /** 是否已经拿到过位置（没拿到之前不要把它当成"在原点"渲染） */
  get placed(): boolean {
    return this.ready;
  }

  /** 当前世界坐标（相机跟随用） */
  position(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.cx, 0, this.cz);
  }

  get bodyYaw(): number {
    return this.yaw;
  }

  get turretYawValue(): number {
    return this.turretYaw;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /**
   * 每帧同步目标位姿。格子变化 → 推断朝向；
   * snap=true（拖动时间轴/跳转）直接落位，不做插值——否则会看到坦克横穿地图。
   */
  setTarget(t: TankView, x: number, z: number, snap: boolean): void {
    this.tx = x;
    this.tz = z;
    if (!this.ready || snap) {
      this.cx = x; this.cz = z;
      this.ready = true;
      this.lastTile = { x: t.x, y: t.y };
    } else {
      const prev = this.lastTile;
      if (prev && (prev.x !== t.x || prev.y !== t.y)) {
        const yaw = Math.atan2(Math.sign(t.x - prev.x), Math.sign(t.y - prev.y));
        if (Number.isFinite(yaw)) this.targetYaw = yaw;
      }
      this.lastTile = { x: t.x, y: t.y };
    }
  }

  /** 开火：炮塔转向目标并后坐（炮口方向是玩法信息，这里顺带把它"演"出来） */
  aimAt(x: number, z: number): void {
    const yaw = Math.atan2(x - this.cx, z - this.cz);
    if (Number.isFinite(yaw)) {
      this.targetTurretYaw = yaw;
      this.turretHoldMs = 900;
    }
    this.recoil = 1;
  }

  /** 被命中：整车闪一下白 */
  hit(): void {
    this.flash = 1;
  }

  setDead(dead: boolean): void {
    if (dead === this.dead) return;
    this.dead = dead;
    if (dead) {
      this.wreck.visible = true;
      this.wreck.position.set(this.cx, 0, this.cz);
    } else {
      // 复活：从地面"弹"出来，给玩家一个明确的重新入场信号
      this.wreck.visible = false;
      this.pop = 0;
    }
  }

  /** 是否被淘汰（车辆隐藏，只留铭牌与标记圈）。注意 group.visible 由场景统一控制（迷雾），这里不碰。 */
  setDisqualified(flag: boolean): void {
    for (const m of this.bodyMats) {
      m.transparent = flag;
      m.opacity = flag ? 0.45 : 1;
    }
    this.bodyGroup.visible = !flag;
    this.turretGroup.visible = !flag;
  }

  setObserver(flag: boolean): void {
    this.marker.visible = flag;
  }

  /** 最后目击位置（座位视角下敌人消失时留在这里） */
  setGhost(x: number | null, z = 0): void {
    if (x === null) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.visible = true;
    this.ghost.position.set(x, 0, z);
  }

  /** 头顶铭牌：座位号 + 血条；内容不变就不重画纹理 */
  setLabel(hpFrac: number, tone: "self" | "enemy" | "dead"): void {
    const hp = Math.round(Math.max(0, Math.min(1, hpFrac)) * 10);
    const key = `${this.seat}|${hp}|${tone}`;
    if (key === this.labelKey) return;
    this.labelKey = key;
    const ctx = this.labelCanvas.getContext("2d");
    if (!ctx) return;
    const W = this.labelCanvas.width;
    const H = this.labelCanvas.height;
    ctx.clearRect(0, 0, W, H);
    // 座位号：白字描深边，压在任何地形上都读得清
    ctx.font = "700 30px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(4,6,11,0.92)";
    ctx.fillStyle = tone === "self" ? "#f5c542" : tone === "dead" ? "#94a3b8" : "#e8eef7";
    const text = `P${this.seat}`;
    ctx.strokeText(text, 4, 20);
    ctx.fillText(text, 4, 20);
    // 血条：满格绿 → 半血黄 → 残血红（与二维棋盘同一套配色）
    const bx = 4, by = 40, bw = 118, bh = 12;
    ctx.fillStyle = "rgba(4,6,11,0.8)";
    ctx.fillRect(bx, by, bw, bh);
    const frac = Math.max(0, Math.min(1, hpFrac));
    ctx.fillStyle = frac > 0.5 ? "#34d399" : frac > 0.25 ? "#fbbf24" : "#f87171";
    ctx.fillRect(bx + 1, by + 1, (bw - 2) * frac, bh - 2);
    ctx.strokeStyle = "rgba(226,232,240,0.4)";
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
    const map = (this.label.material as THREE.SpriteMaterial).map;
    if (map) map.needsUpdate = true;
  }

  /** 炮口世界坐标（开炮特效的起点） */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return this.turretGroup.localToWorld(out.copy(this.muzzleLocal));
  }

  /** 车头方向的世界角度（相机跟随用；取"当前"而不是目标，避免相机先于车身转） */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  update(dt: number): void {
    if (this.ready) {
      const kp = damp(POS_K, dt);
      this.cx += (this.tx - this.cx) * kp;
      this.cz += (this.tz - this.cz) * kp;
      this.yaw = lerpAngle(this.yaw, this.targetYaw, damp(YAW_K, dt));
    }
    // 炮塔：开火后锁定目标一小会儿，然后回到车体朝向（表示"重新看正前方"）
    this.turretHoldMs = Math.max(0, this.turretHoldMs - dt * 1000);
    if (this.turretHoldMs <= 0) this.targetTurretYaw = this.yaw;
    this.turretYaw = lerpAngle(this.turretYaw, this.targetTurretYaw, damp(TURRET_K, dt));

    this.recoil = Math.max(0, this.recoil - dt * 4);
    this.flash = Math.max(0, this.flash - dt * 6);
    this.pop = Math.min(1, this.pop + dt * 3);

    this.group.position.set(this.cx, 0, this.cz);
    this.group.rotation.y = this.yaw;
    // 炮塔用"世界角度"记录（跟车体、跟目标都是同一个坐标系），但写进 three 的却是**局部**旋转：
    // 必须减掉车体角度，否则车体一转，炮口就多转一倍（车头朝西时炮口会指向南）。
    const turretRel = this.turretYaw - this.yaw;
    this.turretGroup.rotation.y = turretRel;
    // 后坐：沿**炮管方向**缩回一点（turretGroup 的位置写在车体坐标系里，
    // 所以要按炮塔相对车体的角度把 -Z 转过去；否则侧向开炮时炮塔会朝车尾滑）
    this.turretGroup.position.x = -0.06 * this.recoil * Math.sin(turretRel);
    this.turretGroup.position.z = -0.06 * this.recoil * Math.cos(turretRel);
    const s = 0.86 + 0.14 * this.pop;
    this.group.scale.set(s, this.pop < 1 ? Math.max(0.3, s) : 1, s);
    this.marker.rotation.y += dt * 0.9;

    // 命中闪白：直接改材质自发光，比后处理便宜且不会被抗锯齿糊掉
    const f = this.flash;
    for (const m of this.bodyMats) m.emissive.setRGB(f * 0.8, f * 0.6, f * 0.5);
    this.edgeMat.emissive.setRGB(f * 0.5, f * 0.35, f * 0.3);
    if (this.dead) {
      this.wreck.rotation.y = this.yaw;
      this.decal.scale.setScalar(1.25); // 残骸摊得更开，阴影圈跟着放大一点
    } else {
      this.decal.scale.setScalar(1);
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh & { material?: THREE.Material | THREE.Material[]; geometry?: THREE.BufferGeometry };
      mesh.geometry?.dispose?.();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        const withMap = m as THREE.Material & { map?: THREE.Texture | null };
        withMap.map?.dispose();
        m.dispose();
      }
    });
  }
}
