// apps/web/src/scene3d/BattleScene3D.tsx —— 三维战场：把事件流搬进一个有相机、有光影的立体场景
//
// 与二维渲染的分工（components/BattleCanvas.tsx）：
//   二维是"仪表盘"：一屏看全、格子对齐、读数精确；三维是"现场"：有高度、有视点、有音画。
//   两者共用同一份 BattleView 与同一套管地形的 Terrain，所以切来切去不会出现"看到的不一样"。
//
// 三条关键口径（都对齐二维，否则同一个回放看两遍会得出两种结论）：
//   1) 视野：切比雪夫距离 ≤ visionRadius 且通视；敌人在森林里要更近才看得见（forestStealthRadius）；
//      视野外的敌人不画实体，只留"最后目击位置"（超过 lastKnownMemoryRounds 回合就遗忘）。
//   2) 朝向：事件流没有朝向字段，炮口方向只能从位移推断（与二维同一个办法）。
//   3) 状态是跳变的：事件以 20 次/秒的节拍到达，而这里按 60fps 渲染 —— 位置与朝向都做指数逼近，
//      视觉上就是"坦克驶过一格"。拖动时间轴（一次跳几千条事件）时不做插值，直接落位。
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { chebyshev, type GameMap, type Ruleset } from "@ai-game/protocol";
import { visibleTiles, type BattleView, type Terrain, type TankView } from "@ai-game/engine";
import { SEAT_COLORS_3D, buildWorld, type WorldBuild, type WorldModels } from "./world.ts";
import { loadModel, setModelTextures } from "./models.ts";
import { buildTankModel, type TankModel } from "./tankModel.ts";
import { MODEL_API } from "./assets.ts";
import { TankRig } from "./tanks.ts";
import { FxSystem } from "./effects.ts";
import { type FxCommand, type GridPos } from "./fxPlan.ts";
import {
  applyDrag, damp, fitDistance, followCamera, gunnerCamera, lerp, orbitPosition, panTarget,
} from "./cameraMath.ts";

export type CameraMode =
  | { kind: "orbit" }
  | { kind: "follow"; seat: number }
  | { kind: "gunner"; seat: number };

export interface SceneListener {
  x: number;
  z: number;
  rightX: number;
  rightZ: number;
}

export interface BattleScene3DProps {
  map: GameMap;
  terrain: Terrain;
  rules: Ruleset;
  /** 当前画面（复用对象，靠 version 触发重算） */
  view: BattleView;
  /** 本帧的视听指令（由 BattleStage 用 planFx 统一编排，画面与声音共用一份） */
  commands: readonly FxCommand[];
  /** true 表示这一帧发生过跳转（拖时间轴/极速）：只落位，不演出 */
  snap: boolean;
  viewpoint: number | null;
  camera: CameraMode;
  /** 归约版本号：view 是复用对象，靠它判断"状态变了" */
  version: number;
  /** 相机监听者变化（音效做立体声定位用） */
  onListener?: (listener: SceneListener) => void;
}

const ORBIT_FOV = 50;
const GUNNER_FOV = 62;

interface RigState {
  mode: CameraMode;
  yaw: number;
  pitch: number;
  dist: number;
  yawOff: number;
  pitchOff: number;
  targetX: number;
  targetZ: number;
  pos: THREE.Vector3;
  look: THREE.Vector3;
  initialized: boolean;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: WorldBuild;
  fx: FxSystem;
  rigs: Map<number, TankRig>;
  rig: RigState;
  raf: number;
  last: number;
  lastFrameAt: number;
  elapsed: number;
  maskKey: string;
  mask: Uint8Array | null;
  ghosts: Map<number, { x: number; y: number; round: number }>;
  lastRound: number;
  shake: number;
  shakeUntil: number;
  snap: boolean;
  baseDist: number;
  nodeRemaining: Map<string, number>;
  listenerTick: number;
  listener: SceneListener | null;
  heightPx: number;
  dragging: 0 | 1 | 2; // 0=无 1=转视角 2=平移
  dragX: number;
  dragY: number;
}

export function BattleScene3D(props: BattleScene3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<SceneState | null>(null);
  const propsRef = useRef<BattleScene3DProps>(props);
  propsRef.current = props;
  /** 座位集合决定了要建几辆车、建哪几个标签：换比赛重建场景（同图不同局也要重建） */
  const seatKey = Object.keys(props.view.tanks).map(Number).sort((a, b) => a - b).join(",");

  // ---- 一次性建场（换地图/换归约器时重建） ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const spanX = props.map.width;
    const spanZ = props.map.height;
    const span = Math.max(spanX, spanZ);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, span > 40 ? 1.35 : 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 阴影只在中小地图上开：地图一大，同样的 shadow map 分辨率摊到 64 格上就只剩噪点
    const shadows = span <= 32;
    if (shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070a10);
    scene.fog = new THREE.FogExp2(0x070a10, span > 40 ? 0.006 : 0.009);

    const camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1.6, 0.1, 400);
    const hemi = new THREE.HemisphereLight(0xa8bedd, 0x333a45, 1.55);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffeede, 2.35);
    key.position.set(-span * 0.35, span * 0.7 + 8, -span * 0.28);
    key.target.position.set(0, 0, 0);
    scene.add(key.target);
    if (shadows) {
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      const cam = key.shadow.camera as THREE.OrthographicCamera;
      const r = span * 0.62 + 2;
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 1; cam.far = span * 2.2 + 20;
      cam.updateProjectionMatrix();
      key.shadow.bias = -0.0008;
    }
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x6f8fd0, 0.55);
    fill.position.set(span * 0.3, span * 0.35, span * 0.4);
    scene.add(fill);

    // 素材（CC0，见 apps/web/src/assets/ATTRIBUTION.md）：只在这里引用一次，
    // 具体"哪个格子用哪个模型"由 assets.ts 统一声明，世界与坦克各取所需。
    // 素材加载失败时会自动退回过程式几何——战场永远画得出来。
    setModelTextures(MODEL_API.textures);
    // 素材就绪后补一帧：模型是异步到的，而 rAF 在后台标签页里可能迟迟不触发
    const onAssetReady = () => {
      const st = stateRef.current;
      if (st) poke(st, propsRef.current);
    };
    const world = buildWorld(props.map, props.terrain, { shadows, models: MODEL_API.world, onModelReady: onAssetReady });
    const tankModelRef: { current: TankModel | null } = { current: null };
    if (MODEL_API.tank) {
      void loadModel(MODEL_API.tank.url).then((asset) => {
        if (!asset || !stateRef.current) return;
        tankModelRef.current = buildTankModel(asset, 0xffffff, MODEL_API.tank!.span);
        // 模型到位后把每辆车换成模型（车体/炮塔分别挂，炮塔照样能独立转向）
        for (const [seat, rig] of stateRef.current.rigs) {
          rig.useModel(buildTankModel(asset, SEAT_COLORS_3D[seat] ?? 0x94a3b8, MODEL_API.tank!.span));
        }
        poke(stateRef.current, propsRef.current);
      });
    }
    scene.add(world.group);
    const fx = new FxSystem();
    scene.add(fx.group);

    const rigs = new Map<number, TankRig>();
    for (const seat of Object.keys(props.view.tanks).map(Number).sort((a, b) => a - b)) {
      const rig = new TankRig({ seat, color: SEAT_COLORS_3D[seat] ?? 0x94a3b8, shadows, tankModel: tankModelRef.current });
      scene.add(rig.group);
      rigs.set(seat, rig);
    }

    const box = mount.getBoundingClientRect();
    const aspect = Math.max(0.2, box.width / Math.max(1, box.height));
    const state: SceneState = {
      renderer, scene, camera, world, fx, rigs,
      rig: {
        mode: props.camera,
        yaw: 0.65, pitch: 0.68, dist: fitDistance(spanX, spanZ, ORBIT_FOV, aspect),
        yawOff: 0, pitchOff: 0.35, targetX: 0, targetZ: 0,
        pos: new THREE.Vector3(), look: new THREE.Vector3(), initialized: false,
      },
      raf: 0, last: performance.now(), lastFrameAt: performance.now(), elapsed: 0,
      maskKey: "", mask: null,
      ghosts: new Map(), lastRound: 0,
      shake: 0, shakeUntil: 0, snap: true,
      baseDist: fitDistance(spanX, spanZ, ORBIT_FOV, aspect),
      nodeRemaining: new Map(),
      listenerTick: 0, listener: null,
      heightPx: Math.max(240, box.height),
      dragging: 0, dragX: 0, dragY: 0,
    };
    stateRef.current = state;
    // 调试钩子：带 ?debug3d=1 打开页面时把场景挂到 window 上，
    // 便于在控制台或自动化里核对"模型到底有没有画出来"（平时不挂，避免污染全局）
    if (new URLSearchParams(window.location.search).has("debug3d")) {
      (window as unknown as { __scene3d?: SceneState }).__scene3d = state;
    }

    // ---- 尺寸 ----
    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(120, Math.floor(rect.height));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      state.heightPx = h;
      state.baseDist = fitDistance(spanX, spanZ, ORBIT_FOV, camera.aspect);
      // 尺寸变了就补一帧：rAF 被节流时（后台标签页）画面会停在旧尺寸上，进全屏尤其明显
      poke(state, propsRef.current, true);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // ---- 交互：拖拽转视角/平移、滚轮缩放、双击回正 ----
    const el = renderer.domElement;
    el.style.touchAction = "none";
    el.style.cursor = "grab";
    const onPointerDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      // 左键 = 转视角（跟随/炮手模式下是转头）；右键、中键、按住 Shift 拖拽 = 平移 —— 与提示一致
      state.dragging = e.button === 0 && !e.shiftKey ? 1 : 2;
      state.dragX = e.clientX;
      state.dragY = e.clientY;
      el.style.cursor = "grabbing";
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!state.dragging) return;
      const r = state.rig;
      const dx = e.clientX - state.dragX;
      const dy = e.clientY - state.dragY;
      state.dragX = e.clientX;
      state.dragY = e.clientY;
      if (r.mode.kind === "orbit") {
        if (state.dragging === 2) {
          // 平移：按当前距离缩放位移量，否则拉远后鼠标拖不动
          const moved = panTarget(r.targetX, r.targetZ, r.yaw, dx, dy, r.dist, state.heightPx);
          const lim = Math.max(spanX, spanZ);
          r.targetX = Math.max(-lim, Math.min(lim, moved.x));
          r.targetZ = Math.max(-lim, Math.min(lim, moved.z));
        } else {
          const next = applyDrag(r.yaw, r.pitch, dx, dy, state.heightPx);
          r.yaw = next.yaw;
          r.pitch = next.pitch;
        }
      } else {
        const next = applyDrag(r.yawOff, r.pitchOff, dx, dy, state.heightPx, 1.9);
        r.yawOff = next.yaw;
        r.pitchOff = next.pitch;
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      state.dragging = 0;
      el.style.cursor = "grab";
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = state.rig;
      const f = Math.exp(e.deltaY * 0.0012);
      if (r.mode.kind === "gunner") {
        camera.fov = Math.max(26, Math.min(78, camera.fov * f));
        camera.updateProjectionMatrix();
      } else {
        // 跟随视角允许贴得很近（看车尾），自由视角至少要能看到半张图
        const min = r.mode.kind === "follow" ? 2.5 : Math.max(6, span * 0.35);
        const max = Math.max(24, span * 2.2);
        r.dist = Math.max(min, Math.min(max, r.dist * f));
      }
    };
    const onDblClick = () => {
      const r = state.rig;
      r.yawOff = 0; r.pitchOff = r.mode.kind === "gunner" ? 0 : 0.35;
      r.yaw = 0.65; r.pitch = 0.68;
      r.targetX = 0; r.targetZ = 0;
      r.dist = state.baseDist;
      camera.fov = r.mode.kind === "gunner" ? GUNNER_FOV : ORBIT_FOV;
      camera.updateProjectionMatrix();
    };
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("dblclick", onDblClick);

    // ---- 主循环 ----
    const frame = () => {
      state.raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.0005, (now - state.last) / 1000));
      state.last = now;
      state.lastFrameAt = now;
      state.elapsed += dt;
      step(state, propsRef.current, dt);
    };
    // 先手动推进一帧：rAF 在后台/被节流的标签页里可能迟迟不触发，
    // 而"第一帧"决定了坦克是否站在出生点、相机是否对准棋盘——不能等。
    state.last = performance.now();
    state.lastFrameAt = state.last;
    step(state, propsRef.current, 1 / 60);
    state.raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("dblclick", onDblClick);
      for (const rig of rigs.values()) rig.dispose();
      world.dispose();
      fx.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      stateRef.current = null;
    };
    // view.tanks 的座位集合是建场时定下的：换比赛（座位数可能不同）必须重建场景
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.map, props.terrain, seatKey]);

  // ---- 指令 → 特效（每次状态推进做一次；演出在 RAF 里自己走完） ----
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    if (props.snap) {
      // 跳转（拖动时间轴/极速跑完）：不做演出，只把位姿与迷雾落位
      state.snap = true;
      state.ghosts.clear();
      return;
    }
    state.snap = false;
    if (props.commands.length === 0) {
      poke(state, props);
      return;
    }
    for (const cmd of props.commands) applyCommand(state, props, cmd);
    poke(state, props);
  }, [props.version, props.commands, props.snap, props.view, props.map, props.rules, props.terrain]);

  // ---- 机位切换：进入跟随/炮手时把 FOV 与距离调到该模式舒适的档位 ----
  const modeKind = props.camera.kind;
  const modeSeat = props.camera.kind === "orbit" ? 0 : props.camera.seat;
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const r = state.rig;
    const prev = r.mode;
    const moved = prev.kind !== props.camera.kind || (props.camera.kind !== "orbit" && (prev.kind === "orbit" || prev.seat !== props.camera.seat));
    r.mode = props.camera;
    if (!moved) return;
    if (props.camera.kind === "gunner") {
      state.camera.fov = GUNNER_FOV;
      r.pitchOff = 0;
    } else {
      state.camera.fov = ORBIT_FOV;
      if (props.camera.kind === "follow") {
        r.dist = Math.min(r.dist, Math.max(5, state.baseDist * 0.45));
        r.pitchOff = 0.32;
      } else {
        r.dist = state.baseDist;
      }
    }
    state.camera.updateProjectionMatrix();
    r.initialized = false; // 换机位时不做插值过渡，直接切过去（否则相机会划一道弧线）
    poke(state, propsRef.current);
  }, [props.camera, modeKind, modeSeat]);

  return <div className="scene3d" ref={mountRef} />;
}

// ---------------------------------------------------------------- 每帧推进

/**
 * 状态变了就补一帧（rAF 被节流时的兜底）。
 * 为什么不能只依赖 rAF：标签页被切到后台或被遮挡时，浏览器会节流甚至完全停掉 rAF，
 * 而回放的节拍（定时器）还在走 —— 等用户切回前台，画面会停在几百个事件之前的那一幕。
 * 这里只在"rAF 超过 120ms 没跑"时才手动推一帧，并且直接落位；前台下 rAF 每秒 60 次，这个分支不会触发。
 */
function poke(state: SceneState, props: BattleScene3DProps, force = false): void {
  const now = performance.now();
  // force：尺寸变化（进/出全屏）这类"必须立刻看到结果"的场合，跳过节流直接画一帧
  if (!force && now - state.lastFrameAt < 120) return;
  state.last = now;
  state.lastFrameAt = now;
  state.snap = true; // 停了这么久，别让坦克从旧位置"滑"过来
  state.elapsed += 0.016;
  step(state, props, 0.016);
}

function step(state: SceneState, props: BattleScene3DProps, dt: number): void {
  const { view, rules, terrain, map } = props;
  const W = map.width;
  const H = map.height;
  const worldX = (x: number) => x - (W - 1) / 2;
  const worldZ = (y: number) => y - (H - 1) / 2;

  // 1) 迷雾掩码（只在观察者换格/半径变化时重算，与二维同一套 visibleTiles）
  const viewer = props.viewpoint === null ? null : view.tanks[props.viewpoint] ?? null;
  const key = props.viewpoint === null ? "" : viewer ? `${viewer.x},${viewer.y},${rules.visionRadius}` : "none";
  if (key !== state.maskKey) {
    state.maskKey = key;
    state.mask = key === "" ? null : viewer ? visibleTiles(terrain, { x: viewer.x, y: viewer.y }, rules.visionRadius) : new Uint8Array(W * H);
    state.world.setVisibility(state.mask);
  }
  const mask = state.mask;
  const canSeeTank = (t: TankView): boolean => {
    if (!viewer || !t.alive) return false;
    if (mask && mask[terrain.index(t.x, t.y)] !== 1) return false;
    const d = chebyshev({ x: viewer.x, y: viewer.y }, { x: t.x, y: t.y });
    const inForest = terrain.forest[terrain.index(t.x, t.y)] === 1;
    return !(inForest && d > rules.forestStealthRadius);
  };

  // 2) 资源点剩余量（提示：二维里用数字，这里用晶体体积 + 飘字时点）
  for (const [id, n] of Object.entries(view.nodes)) {
    const visual = state.world.nodes.get(id);
    if (!visual) continue;
    const vis = props.viewpoint === null || !mask || mask[terrain.index(n.x, n.y)] === 1;
    const shown = vis ? n.remaining : Math.round(n.capacity * 0.5);
    if (state.nodeRemaining.get(id) !== shown) {
      state.nodeRemaining.set(id, shown);
      visual.remaining = shown;
      state.world.refreshNode(visual);
    }
  }

  // 3) 坦克位姿、铭牌、视野可见性
  if (view.round < state.lastRound) state.ghosts.clear(); // 拖回过去 → 目击记忆失效
  state.lastRound = view.round;
  const snap = state.snap;
  for (const rig of state.rigs.values()) {
    const t = view.tanks[rig.seat];
    if (!t) {
      rig.group.visible = false;
      continue;
    }
    rig.setTarget(t, worldX(t.x), worldZ(t.y), snap);
    rig.update(dt);
    rig.setDead(!t.alive);
    rig.setDisqualified(t.disqualified);

    const isSelf = props.viewpoint !== null && rig.seat === props.viewpoint;
    if (props.viewpoint === null) rig.group.visible = true; // 上帝视角：阵亡也留残骸（二维同样画虚线框）
    else rig.group.visible = isSelf || canSeeTank(t);
    rig.setObserver(isSelf);
    rig.setLabel(t.hp / rules.hpMax, isSelf ? "self" : t.alive ? "enemy" : "dead");
    rig.setLabelSize(state.camera.position.distanceTo(rig.group.position));

    if (props.viewpoint !== null && !isSelf) {
      if (canSeeTank(t)) {
        state.ghosts.set(rig.seat, { x: t.x, y: t.y, round: view.round });
        rig.setGhost(null);
      } else {
        const g = state.ghosts.get(rig.seat);
        if (g && view.round - g.round <= rules.lastKnownMemoryRounds) rig.setGhost(worldX(g.x), worldZ(g.y));
        else {
          rig.setGhost(null);
          state.ghosts.delete(rig.seat);
        }
      }
    } else {
      rig.setGhost(null);
    }
  }
  state.snap = false;

  // 4) 相机
  const cam = state.camera;
  const r = state.rig;
  const tankRig = r.mode.kind === "orbit" ? null : state.rigs.get(r.mode.seat) ?? null;
  const tmp = TMP_A;
  let desiredPos: THREE.Vector3;
  let desiredLook: THREE.Vector3;
  if (r.mode.kind === "orbit" || !tankRig) {
    const target = TMP_B.set(r.targetX, 0, r.targetZ);
    const o = orbitPosition({ x: target.x, y: 0, z: target.z }, r.yaw, r.pitch, r.dist);
    desiredPos = TMP_C.set(o.x, o.y, o.z);
    desiredLook = TMP_D.set(target.x, 0, target.z);
  } else {
    tankRig.position(tmp);
    const pos3 = { x: tmp.x, y: 0, z: tmp.z };
    if (r.mode.kind === "follow") {
      const cam2 = followCamera(pos3, tankRig.bodyYaw, r.yawOff, r.pitchOff, r.dist);
      desiredPos = TMP_C.set(cam2.pos.x, cam2.pos.y, cam2.pos.z);
      desiredLook = TMP_D.set(cam2.look.x, cam2.look.y, cam2.look.z);
    } else {
      const cam2 = gunnerCamera(pos3, tankRig.turretYawValue, r.yawOff, r.pitchOff);
      desiredPos = TMP_C.set(cam2.pos.x, cam2.pos.y, cam2.pos.z);
      desiredLook = TMP_D.set(cam2.look.x, cam2.look.y, cam2.look.z);
    }
  }

  if (!r.initialized) {
    r.pos.copy(desiredPos);
    r.look.copy(desiredLook);
    r.initialized = true;
  } else {
    // 炮手视角要"跟得紧"，跟随/自由视角可以柔一点
    const kPos = r.mode.kind === "gunner" ? 26 : r.mode.kind === "follow" ? 9 : 6;
    const kLook = r.mode.kind === "gunner" ? 30 : 12;
    const tp = damp(kPos, dt);
    const tl = damp(kLook, dt);
    r.pos.x = lerp(r.pos.x, desiredPos.x, tp);
    r.pos.y = lerp(r.pos.y, desiredPos.y, tp);
    r.pos.z = lerp(r.pos.z, desiredPos.z, tp);
    r.look.x = lerp(r.look.x, desiredLook.x, tl);
    r.look.y = lerp(r.look.y, desiredLook.y, tl);
    r.look.z = lerp(r.look.z, desiredLook.z, tl);
  }

  // 屏幕抖动：贴在相机上的一点点随机位移，命中/爆炸时更有冲击力
  let shakeX = 0, shakeY = 0;
  if (state.shake > 0.001) {
    state.shake = Math.max(0, state.shake - dt * 3.2);
    const amp = state.shake * 0.16;
    shakeX = (Math.random() - 0.5) * amp;
    shakeY = (Math.random() - 0.5) * amp;
  }
  cam.position.set(r.pos.x + shakeX, Math.max(0.35, r.pos.y + shakeY), r.pos.z);
  cam.lookAt(r.look);

  // 5) 特效与资源点动画
  state.fx.update(dt, cam, state.heightPx);
  state.world.update(dt, state.elapsed);

  state.renderer.render(state.scene, cam);

  // 6) 汇报相机监听者（音效做立体声定位）。每 10 帧一次：声音不需要 60Hz 的空间精度
  if (props.onListener && ++state.listenerTick % 10 === 0) {
    const dir = TMP_A.set(0, 0, 0); // 相机右向量 = 视线方向 × 世界上方向
    cam.getWorldDirection(dir);
    props.onListener({
      x: cam.position.x,
      z: cam.position.z,
      rightX: -dir.z,
      rightZ: dir.x,
    });
  }
}

// 复用向量，避免每帧产生垃圾
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_C = new THREE.Vector3();
const TMP_D = new THREE.Vector3();
const TMP_E = new THREE.Vector3();

// ---------------------------------------------------------------- 指令 → 三维演出

function applyCommand(state: SceneState, props: BattleScene3DProps, cmd: FxCommand): void {
  const W = props.map.width;
  const H = props.map.height;
  const w = (x: number) => x - (W - 1) / 2;
  const z = (y: number) => y - (H - 1) / 2;
  const at = (p: GridPos) => TMP_A.set(w(p.x), 0.18, z(p.y));
  const rigOf = (seat: number | null) => (seat === null ? null : state.rigs.get(seat) ?? null);
  const colorOf = (seat: number | null) => SEAT_COLORS_3D[seat ?? 1] ?? 0x94a3b8;

  switch (cmd.kind) {
    case "fire": {
      const rig = rigOf(cmd.seat);
      if (rig) rig.aimAt(w(cmd.to.x), z(cmd.to.y));
      const muzzle = rig ? rig.muzzleWorld(TMP_B.clone()) : at(cmd.from).clone().setY(0.4);
      const target = TMP_C.set(w(cmd.to.x), 0.22, z(cmd.to.y));
      state.fx.tracer(muzzle, target, colorOf(cmd.seat));
      state.fx.muzzle(muzzle, colorOf(cmd.seat));
      const hit = cmd.hit;
      // 弹丸命中点：打在坦克上就落到目标高度，打空就落到地面
      const victim = rigOf(cmd.targetSeat);
      const impactAt = victim && hit ? victim.position(TMP_E.clone()).setY(0.3) : target.clone();
      state.fx.shell(muzzle.clone(), impactAt.clone(), colorOf(cmd.seat), () => {
        state.fx.impact(impactAt, hit);
        if (victim && hit) victim.hit();
      });
      shakeNear(state, props, at(cmd.from), hit ? 0.85 : 0.45);
      break;
    }
    case "move": {
      if (!cmd.emergency) break;
      const rig = rigOf(cmd.seat);
      state.fx.dust(at(cmd.to));
      state.fx.ring(at(cmd.from), 0xf59e0b, 0.9, 0.45);
      if (rig) rig.hit(); // 应急移动会扣分：给车体一个小闪，暗示"代价"
      break;
    }
    case "collect": {
      const node = state.world.nodes.get(cmd.node);
      const from = node ? TMP_B.set(node.pad.position.x, 0.3, node.pad.position.z) : at(cmd.at);
      const rig = rigOf(cmd.seat);
      const to = rig ? rig.position(TMP_C.clone()).setY(0.45) : at(cmd.at);
      state.fx.beam(from.clone(), to.clone(), 0xa78bfa);
      state.fx.ring(from.clone(), 0xa78bfa, 1.3, 0.5);
      state.fx.text(from.clone().setY(0.85), `+${cmd.amount}`, "#c4b5fd");
      break;
    }
    case "deposit": {
      state.fx.ring(at(cmd.at), 0xf2c14e, 1.9, 0.6);
      state.fx.text(at(cmd.at).setY(0.9), `+${cmd.units}`, "#fde68a");
      const rig = rigOf(cmd.seat);
      if (rig) rig.hit();
      break;
    }
    case "loadAmmo": {
      state.fx.ring(at(cmd.at), 0xf0b452, 1.1, 0.5);
      state.fx.text(at(cmd.at).setY(0.9), `弹 +${cmd.rounds}`, "#fcd34d");
      break;
    }
    case "refuel": {
      state.fx.ring(at(cmd.at), 0x34d399, 1.1, 0.5);
      state.fx.text(at(cmd.at).setY(0.9), `油 +${cmd.fuelAdded}`, "#6ee7b7");
      break;
    }
    case "death": {
      const p = at(cmd.at).setY(0.35);
      state.fx.explosion(p, 1);
      shakeNear(state, props, at(cmd.at), 1.6);
      const rig = rigOf(cmd.seat);
      if (rig) rig.setGhost(null);
      break;
    }
    case "respawn": {
      state.fx.respawnBeam(at(cmd.at), colorOf(cmd.seat));
      shakeNear(state, props, at(cmd.at), 0.35);
      break;
    }
    case "invalid": {
      state.fx.invalidMark(at(cmd.at));
      break;
    }
    case "disqualified": {
      state.fx.explosion(at(cmd.at).setY(0.3), 0.8);
      state.fx.ring(at(cmd.at), 0xff5470, 2.2, 0.7);
      state.fx.text(at(cmd.at).setY(1.0), "淘汰", "#ff8fa3");
      shakeNear(state, props, at(cmd.at), 0.9);
      break;
    }
    case "regen": {
      const node = state.world.nodes.get(cmd.node);
      const p = node ? TMP_B.set(node.pad.position.x, 0.25, node.pad.position.z) : at(cmd.at);
      state.fx.ring(p.clone(), 0x8b5cf6, 1.0, 0.5);
      state.fx.text(p.clone().setY(0.85), `+${cmd.remaining}`, "#c4b5fd");
      break;
    }
    case "end":
      break;
  }
}

/** 抖动强度按"离相机关注点有多远"衰减：地图另一头的爆炸不该把镜头晃翻 */
function shakeNear(state: SceneState, props: BattleScene3DProps, pos: THREE.Vector3, amount: number): void {
  const focus = state.rig.mode.kind === "orbit" ? TMP_D : state.rig.look;
  const d = Math.hypot(pos.x - focus.x, pos.z - focus.z);
  const atten = Math.max(0.06, Math.min(1, 1 - d / 26));
  // 战斗焦点全在远处时保留一点"轰"的感觉，但不要失焦
  state.shake = Math.min(2.2, state.shake + amount * atten);
}