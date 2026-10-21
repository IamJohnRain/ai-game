// apps/web/src/components/BattleStage.tsx —— 战场呈现层：在"二维仪表盘"和"三维现场"之间切换，并统一出声
//
// 为什么要包这一层：
//   1) 观战页与回放页共用同一块战场区域，切换只应影响"怎么画"，不该影响"画什么"——
//      二维与三维读的是同一个 BattleView、同一份 Terrain，所以随时切换不会看到两种战况；
//   2) 音效不该只为三维服务：二维是精确棋盘，声音反而是"发生了什么"的主要提示，
//      因此音效在这里统一驱动，二维/三维都听得到；
//   3) 三维依赖 three.js（几百 KB）—— 用 React.lazy 懒加载，只选二维的人一个字节都不用下。
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameMap, MatchEvent, PlayerStats, Ruleset } from "@ai-game/protocol";
import type { BattleView, Terrain } from "@ai-game/engine";
import type { MatchPlayer } from "../api";
import { BattleCanvas, BattleLegend } from "./BattleCanvas";
import { ScoreCards } from "./ScoreCards";
import { sfx, type SfxPlayOptions } from "../sfx";
import { MAX_FX_EVENTS } from "../battleState";
import { impactSound, planFx, soundFor, type FxCommand, type GridPos } from "../scene3d/fxPlan";
import type { CameraMode, SceneListener } from "../scene3d/BattleScene3D";

// three.js 只在真的切到三维时才下载
const BattleScene3D = lazy(() => import("../scene3d/BattleScene3D").then((m) => ({ default: m.BattleScene3D })));

export interface BattleStageProps {
  map: GameMap;
  terrain: Terrain;
  rules: Ruleset;
  /** 当前画面（复用对象，靠 version 触发重绘） */
  view: BattleView;
  /** 本帧新应用的事件（末尾最多 64 条） */
  batch: readonly MatchEvent[];
  /** 批次实际应用的事件总数：> batch.length 说明发生过跳转 */
  batchCount: number;
  /** null = 上帝视角；数字 = 该座位视角（战争迷雾） */
  viewpoint: number | null;
  onViewpointChange: (viewpoint: number | null) => void;
  version: number;
  /** 关掉三维入口（例如未来的嵌入式展示）；默认开启 */
  allow3d?: boolean;
  /** 座位卡用的参赛者信息（模型名、状态、校验）；全屏时悬浮在左上角 */
  players?: MatchPlayer[];
  /** 服务端名次（观战有，回放没有）；缺省时按当前分数自排名 */
  ranking?: PlayerStats[];
}

type RenderMode = "2d" | "3d";
/** 全屏形态：native = 浏览器全屏 API；overlay = 拿不到 API（如 iPhone Safari）时用铺满视口的浮层顶上 */
type FullscreenMode = "off" | "native" | "overlay";

const LS_MODE = "ai-game.stage.mode";
const LS_SOUND = "ai-game.sound.on";
const LS_VOLUME = "ai-game.sound.volume";

export function BattleStage(props: BattleStageProps) {
  const [webgl] = useState(() => hasWebGL() && props.allow3d !== false);
  const [mode, setMode] = useState<RenderMode>(() => {
    if (!hasWebGL() || props.allow3d === false) return "2d";
    return readLS(LS_MODE) === "2d" ? "2d" : "3d";
  });
  const [camera, setCamera] = useState<CameraMode>({ kind: "orbit" });
  const [sound, setSound] = useState(() => readLS(LS_SOUND) !== "0");
  const [volume, setVolume] = useState(() => {
    const v = Number(readLS(LS_VOLUME));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.7;
  });

  const listenerRef = useRef<SceneListener | null>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [fs, setFs] = useState<FullscreenMode>("off");
  const seats = useMemo(() => Object.keys(props.view.tanks).map(Number).sort((a, b) => a - b), [props.version, props.view]);

  // ---- 音效：主音量、首次手势解锁 ----
  useEffect(() => {
    sfx.setVolume(volume);
  }, [volume]);
  useEffect(() => {
    // 浏览器要求"用户手势后才能出声"：第一次点击/按键时解锁，并且只在开着音效时解
    const unlock = () => {
      if (soundRef.current) void sfx.unlock();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // ---- 全屏观战 ----
  // 全屏的对象是整块 stage（控制条 + 战场）而不是画布本身：全屏里仍然要能切机位、关音效，
  // 而"退出"这件事交给浏览器自己的 Esc（浮层模式下我们自己接 Esc）。
  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (fs === "native") {
      const doc = document as Document & { webkitExitFullscreen?: () => void };
      (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
      return;
    }
    if (fs === "overlay") {
      setFs("off");
      return;
    }
    // 前缀 API 的类型各不相同，统一按"可传可不传参数"取用
    const host = el as unknown as {
      requestFullscreen?: (opts?: FullscreenOptions) => Promise<void> | void;
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    const ask = host.requestFullscreen ?? host.webkitRequestFullscreen;
    if (!ask) {
      setFs("overlay");
      return;
    }
    Promise.resolve(ask.call(el, { navigationUI: "hide" })).then(
      () => setFs("native"),
      // 被策略拒绝（比如没有用户手势）也别白按一下：照样铺满视口
      () => setFs("overlay"),
    );
  }, [fs]);

  // 全屏可能被 Esc/F11 或者浏览器自己退出，且不一定经过我们的按钮：用事件把状态追回来
  useEffect(() => {
    const sync = () => {
      const active = Boolean(document.fullscreenElement) && document.fullscreenElement === stageRef.current;
      setFs((prev) => (active ? "native" : prev === "native" ? "off" : prev));
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // 浮层模式盖住了整页：禁掉背后的滚动，免得全屏里还能拖动页面
  useEffect(() => {
    if (fs !== "overlay") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [fs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return; // 按住不放别把全屏开开关关
      if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+F 之类是浏览器自己的事
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.code === "Escape" && fs === "overlay") {
        setFs("off"); // 原生全屏的 Esc 由浏览器接管，只有浮层需要我们收
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen, fs]);

  // ---- 事件批次 → 指令（画面与声音共用同一份，避免两边理解不一致） ----
  const snap = props.batchCount > MAX_FX_EVENTS;
  const commands = useMemo<FxCommand[]>(() => {
    if (props.batchCount === 0 || snap) return [];
    const seatsNow: Record<number, GridPos> = {};
    for (const [seat, t] of Object.entries(props.view.tanks)) seatsNow[Number(seat)] = { x: t.x, y: t.y };
    const nodes: Record<string, GridPos> = {};
    for (const [id, n] of Object.entries(props.view.nodes)) nodes[id] = { x: n.x, y: n.y };
    return planFx({ batch: props.batch, seats: seatsNow, nodes });
  }, [props.batch, props.batchCount, props.view, snap]);

  // 出声：同一条指令只播一次，靠 version 去重（React 重渲染不该重复出声）
  const playedRef = useRef(-1);
  useEffect(() => {
    if (props.version === playedRef.current) return;
    playedRef.current = props.version;
    if (!soundRef.current || !sfx.unlocked || commands.length === 0) return;
    const pending: { delay: number; play: () => void }[] = [];
    for (const cmd of commands) {
      const mapped = soundFor(cmd);
      if (mapped) {
        const opts = spatialOf(commandGrid(cmd), props.map, listenerRef.current);
        sfx.play(mapped.kind, opts);
      }
      if (cmd.kind === "fire") {
        // 命中/脱靶的"落点音"跟着弹丸走：稍微延后，才有"打出去了→打中了"的因果感
        const opts = spatialOf(cmd.to, props.map, listenerRef.current);
        const kind = impactSound(cmd.hit);
        pending.push({ delay: 130, play: () => sfx.play(kind, opts) });
      }
    }
    if (pending.length === 0) return;
    const timers = pending.map((p) => window.setTimeout(p.play, p.delay));
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [props.version, commands, props.map]);

  // ---- 机位与视角联动：看谁的视角就切到谁的车后/炮口（"以双方的视角查看"） ----
  const viewpointRef = useRef(props.viewpoint);
  viewpointRef.current = props.viewpoint;
  useEffect(() => {
    const seat = camera.kind === "orbit" ? null : camera.seat;
    if (seat !== null && viewpointRef.current !== seat) props.onViewpointChange(seat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);
  useEffect(() => {
    const v = props.viewpoint;
    setCamera((prev) => {
      if (v === null) return prev.kind === "orbit" ? prev : { kind: "orbit" };
      if (prev.kind !== "orbit" && prev.seat === v) return prev;
      return { kind: "follow", seat: v };
    });
  }, [props.viewpoint]);

  const onListener = useCallback((l: SceneListener) => {
    listenerRef.current = l;
  }, []);

  const pickMode = (m: RenderMode) => {
    setMode(m);
    writeLS(LS_MODE, m);
  };
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    writeLS(LS_SOUND, next ? "1" : "0");
    if (next) {
      // 这一次点击本身就是用户手势，正好可以把 AudioContext 打开
      void sfx.unlock();
    }
  };

  const three = mode === "3d" && webgl;
  const isFs = fs !== "off";
  const hint = three
    ? camera.kind === "orbit"
      ? "左键拖拽转视角 · 右键/Shift 拖拽平移 · 滚轮缩放 · 双击回正"
      : camera.kind === "follow"
        ? "左键拖拽绕车转 · 滚轮拉远拉近 · 双击回正"
        : "左键拖拽转头 · 滚轮变焦 · 双击回正"
    : "点击「3D 战场」可切换成可自由转动的立体视角";

  return (
    <div className={`stage${isFs ? " stage-fs" : ""}${fs === "overlay" ? " stage-fs-fixed" : ""}`} ref={stageRef}>
      <div className="stage-bar">
        <div className="control-group">
          <span className="field-label">呈现</span>
          <button className={`chip ${!three ? "chip-on" : ""}`} onClick={() => pickMode("2d")} title="固定俯视的二维棋盘，读数最清楚">
            2D 俯视
          </button>
          {webgl ? (
            <button className={`chip ${three ? "chip-on" : ""}`} onClick={() => pickMode("3d")} title="带光影与自由相机的三维战场">
              3D 战场
            </button>
          ) : (
            <span className="muted small">当前浏览器不支持 WebGL，只能用 2D</span>
          )}
        </div>

        {three ? (
          <div className="control-group">
            <span className="field-label">机位</span>
            <button className={`chip ${camera.kind === "orbit" ? "chip-on" : ""}`} onClick={() => setCamera({ kind: "orbit" })} title="绕棋盘自由转动">
              自由
            </button>
            {seats.map((seat) => (
              <span className="chip-pair" key={seat}>
                <button
                  className={`chip ${camera.kind === "follow" && camera.seat === seat ? "chip-on" : ""}`}
                  onClick={() => setCamera({ kind: "follow", seat })}
                  title={`跟在 P${seat} 车后，随它一起转向`}
                >
                  跟 P{seat}
                </button>
                <button
                  className={`chip ${camera.kind === "gunner" && camera.seat === seat ? "chip-on" : ""}`}
                  onClick={() => setCamera({ kind: "gunner", seat })}
                  title={`坐在 P${seat} 的炮塔上向前看`}
                >
                  炮 P{seat}
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="control-group">
          <button
            className={`chip ${isFs ? "chip-on" : ""}`}
            onClick={toggleFullscreen}
            title={isFs ? "退出全屏（Esc 或再按一次 F）" : "全屏观战：只留战场，看得更大（快捷键 F）"}
          >
            {isFs ? "⤢ 退出全屏" : "⛶ 全屏"}
          </button>
        </div>

        <div className="control-group">
          <button
            className={`chip ${sound ? "chip-on" : ""}`}
            onClick={toggleSound}
            title={sound ? "关闭战场音效" : "开启战场音效（开炮/命中/采集/加油/装弹…）"}
          >
            {sound ? "🔊 音效开" : "🔇 音效关"}
          </button>
          {sound ? (
            <input
              className="volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                writeLS(LS_VOLUME, String(v));
              }}
              title="音量"
            />
          ) : null}
          <span className="muted small">{hint}</span>
        </div>
      </div>

      {/* 全屏里侧栏（赛事信息、得分看板、事件流）都看不见了：得分的座位卡在这里补一份，
          悬浮在战场左上角，二维/三维都跟着走 */}
      <div className="stage-view">
        {isFs ? (
          <aside className="seat-float cards-narrow" aria-label="得分看板（全屏悬浮）">
            <ScoreCards view={props.view} rules={props.rules} players={props.players} ranking={props.ranking} />
          </aside>
        ) : null}

        {three ? (
          <div className="board">
            <Suspense fallback={<div className="scene3d scene3d-loading">正在加载三维战场 …</div>}>
              <BattleScene3D
                map={props.map}
                terrain={props.terrain}
                rules={props.rules}
                view={props.view}
                commands={commands}
                snap={snap}
                viewpoint={props.viewpoint}
                camera={camera}
                version={props.version}
                onListener={onListener}
              />
            </Suspense>
            <BattleLegend />
          </div>
        ) : (
          <BattleCanvas
            map={props.map}
            terrain={props.terrain}
            view={props.view}
            rules={props.rules}
            viewpoint={props.viewpoint}
            version={props.version}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 细节

/** 指令落在哪个格子（音效定位用）：开火用落点更符合直觉——"响在被打的地方" */
function commandGrid(cmd: FxCommand): GridPos | null {
  switch (cmd.kind) {
    case "fire":
      return cmd.to;
    case "move":
      return cmd.to;
    case "collect":
    case "deposit":
    case "loadAmmo":
    case "refuel":
    case "death":
    case "respawn":
    case "invalid":
    case "disqualified":
    case "regen":
      return cmd.at;
    case "end":
      return null;
  }
}

/**
 * 声源 → 立体声参数。
 * 三维下用相机右向量投影算出左右、按距离衰减；二维下没有相机，就按棋盘横向归一化——
 * 反正二维的"左右"玩家自己也知道（棋盘就在眼前）。
 */
function spatialOf(p: GridPos | null, map: GameMap, listener: SceneListener | null): SfxPlayOptions {
  if (!p) return {};
  const wx = p.x - (map.width - 1) / 2;
  const wz = p.y - (map.height - 1) / 2;
  if (listener) {
    const dx = wx - listener.x;
    const dz = wz - listener.z;
    const pan = clamp((dx * listener.rightX + dz * listener.rightZ) / 6, -1, 1);
    const dist = Math.hypot(dx, dz);
    return { pan, gain: clamp(1 - dist / 30, 0.22, 1) };
  }
  return { pan: clamp(wx / (map.width / 2), -1, 1) * 0.85, gain: 1 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function readLS(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLS(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式/禁用存储：记不住偏好不影响看回放
  }
}

/** 有没有可用的 WebGL 上下文（有 WebGL 才把三维入口摆出来） */
function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return Boolean(gl);
  } catch {
    return false;
  }
}