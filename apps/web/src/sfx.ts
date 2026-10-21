// apps/web/src/sfx.ts —— 战场音效：WebAudio 现场合成（零素材、零依赖）
//
// 为什么合成而不是播放大音频文件：
//   1) 仓库不允许引入 .wav/.mp3 之类的二进制素材，而观战/回放要覆盖 14 类事件音，
//      现场合成是唯一能"零素材"覆盖全部音效的做法；
//   2) 事件音必须跟着相机走：左右方位（pan）与离相机距离的衰减（gain）都由渲染层算好传进来，
//      合成路径可以直接把它们写进 StereoPanner 与包络峰值；素材方案反而要额外做变速变调；
//   3) 全部使用 WebAudio 原生节点，白噪声 buffer 只生成一次，常驻开销只有"当前活跃声部"那几个节点。
//
// 生命周期（观战页是长跑应用，音效层必须守住的几条线）：
//   - 浏览器只允许在"用户手势"之后出声：先 unlock()（创建并 resume AudioContext），之后 play() 才真的发声；
//   - 未 unlock / 环境不支持（纯 Node、被浏览器拒绝）时，play() 是静默 no-op，绝不抛异常、绝不留下节点；
//   - 同一 kind 在 minIntervalMs 窗口内只出声一次（极限速度回放时事件会成串到达，调用方已做同帧合并，
//     这里只做最后的限流）；并发声部硬上限 MAX_VOICES，超出直接丢弃而不是排队；
//   - masterGain 之后挂 DynamicsCompressor 防止多声部叠加削波；volume=0 只把主增益归 0、不关 context；
//   - 每个声部都在 source.onended（拆各自链路的叶子节点）与收尾定时器（拆总线/声像并归还名额）
//     两条路径上清理，长局回放不会泄漏节点；
//   - 本文件在纯 Node 里 import 必须安全：所有浏览器 API 只在 unlock()/play() 内部惰性触碰。

/** 战场音效类型。命名跟随"玩家能听到的事"，而不是引擎内部事件名。 */
export type SfxKind =
  | "fire" | "hit" | "miss" | "collect" | "deposit" | "refuel" | "loadAmmo"
  | "death" | "respawn" | "invalid" | "disqualified" | "tread" | "end" | "ui";

/**
 * 全部 kind（供测试遍历、也供观战页的音效开关列表使用）。
 * SPEC_TABLE 的 Record<SfxKind, ...> 类型会强制补齐实现，这里的数组则保证"运行期可枚举"。
 */
export const SFX_KINDS: readonly SfxKind[] = [
  "fire", "hit", "miss", "collect", "deposit", "refuel", "loadAmmo",
  "death", "respawn", "invalid", "disqualified", "tread", "end", "ui",
];

/**
 * 音效规格。
 * minIntervalMs：同一 kind 的限流窗口——快进回放时同一事件会成串到达，全部发声只会糊成噪音；
 * baseGain：该音效的基准峰值（调用方传入的 gain 在此之上再乘），取值时保证"多声部叠加也不明显削波"；
 * desc：人话说明，供观战页的音效说明/调参面板直接展示，避免文档与实现漂移。
 */
export interface SfxSpec {
  minIntervalMs: number;
  baseGain: number;
  desc: string;
}

/**
 * 规格表：play() 内部与测试取的是同一张表（走 sfxSpec 查询），
 * 因此"限流窗口 / 基准增益"只有一处定义，调参与验收不会各说各话。
 */
const SPEC_TABLE: Record<SfxKind, SfxSpec> = {
  fire: { minIntervalMs: 45, baseGain: 0.5, desc: "开炮：低频冲击（正弦 120→50Hz）+ 带通噪声爆裂（1600→400Hz）" },
  hit: { minIntervalMs: 45, baseGain: 0.45, desc: "命中装甲：高通噪声金属脆响 + 三角波泛音（880/1320Hz）+ 一记短闷响" },
  miss: { minIntervalMs: 60, baseGain: 0.38, desc: "未命中/弹着地面：低通噪声闷响（500→120Hz）" },
  collect: { minIntervalMs: 50, baseGain: 0.3, desc: "采集资源：三角波双音上扬（660→990Hz）" },
  deposit: { minIntervalMs: 80, baseGain: 0.34, desc: "提交资源：金币叮当（三角波 1046.5/1568Hz，两声间隔约 70ms）" },
  refuel: { minIntervalMs: 120, baseGain: 0.26, desc: "加油：带通噪声灌注（300→1500Hz，先渐强后收）+ 三声短滴" },
  loadAmmo: { minIntervalMs: 80, baseGain: 0.3, desc: "装弹：机械双响（两次极短噪声 click，低通 2500Hz，间隔约 80ms）" },
  death: { minIntervalMs: 100, baseGain: 0.55, desc: "阵亡：大爆炸（低通噪声 900→70Hz 约 800ms + 正弦下沉）+ 碎屑噼啪" },
  respawn: { minIntervalMs: 80, baseGain: 0.34, desc: "复活：上扬扫频（300→820Hz，约 400ms）" },
  invalid: { minIntervalMs: 150, baseGain: 0.2, desc: "无效动作：方波嗡嗡 150Hz 两声（低通削掉尖刺）" },
  disqualified: { minIntervalMs: 200, baseGain: 0.38, desc: "淘汰：下行双音（620→310Hz）" },
  tread: { minIntervalMs: 220, baseGain: 0.08, desc: "履带：极轻的低频 rumble（60ms 低通噪声，纯背景存在感）" },
  end: { minIntervalMs: 500, baseGain: 0.32, desc: "比赛结束：三音上行 C5-E5-G5（523/659/784Hz 三角波）" },
  ui: { minIntervalMs: 40, baseGain: 0.18, desc: "界面点击：极短的一下（低通噪声 click）" },
};

/** 表外 kind 的兜底（例如旧版本事件名）：给一声安静的音效，而不是让调用方拿到 undefined */
const FALLBACK_SPEC: SfxSpec = { minIntervalMs: 100, baseGain: 0.2, desc: "未知音效（兜底）" };

/** 查询音效规格；play() 与测试共用这一入口，保证同源 */
export function sfxSpec(kind: SfxKind): SfxSpec {
  const spec = SPEC_TABLE[kind] as SfxSpec | undefined;
  return spec ?? FALLBACK_SPEC;
}

// ---------------------------------------------------------------- 常量与小工具

/** 白噪声只生成一次（1 秒单声道），所有"爆裂/摩擦/灌注"类音效共享；每次播放只新建一个 BufferSource */
const NOISE_SECONDS = 1;

/** 包络的最小非零值：指数段两端必须 > 0；收尾再用线性段落到 0，声部才能确定性地停在 0（断开时不会"咔"一声） */
const MIN_GAIN = 0.0001;

/** 并发声部上限：超出直接丢弃新声部——宁可少听一声，也不能让声部堆积到"声音比画面晚一拍" */
const MAX_VOICES = 24;

/** 声部结束后的收尾延时（毫秒）：留给浏览器跑完包络的最后一点尾巴 */
const TAIL_MS = 60;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 参数净化：undefined / NaN / Infinity 一律退回 fallback，再夹到 [lo, hi]。
 * pan/gain 来自渲染层（相机方位、距离衰减），不能假设它一定算出了好数。
 */
function sanitize(v: number | undefined, fallback: number, lo: number, hi: number): number {
  return clamp(typeof v === "number" && Number.isFinite(v) ? v : fallback, lo, hi);
}

/** 限流用的单调时钟；performance 不可用的环境（老 Node）退回 Date.now */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** 轻微随机抖动：只用于音高（音分）与噪声速率，让重复的炮声/点击不呆板；不参与任何导出常量 */
function jitter(amount: number): number {
  return (Math.random() * 2 - 1) * amount;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Safari 只有 webkitAudioContext；window 不存在（Node / SSR）时返回 null，import 本模块不受影响 */
function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** 断开节点；已经断开时静默忽略（onended 与收尾定时器可能都走到这里） */
function safeDisconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // 已断开：重复 disconnect 在部分实现里会抛，忽略即可
  }
}

// ---------------------------------------------------------------- 增益包络

/**
 * 打击型 ADSR：0 → peak（attack 秒内线性起音）→ 指数式衰减 → 尾段线性归零。
 * 衰减用指数而不是线性：真实撞击的能量衰减本来就是"先快后慢"，线性衰减听起来像被人把音量拉下来。
 * 指数段两端都必须 > 0，所以用 MIN_GAIN 兜底；最后的线性段保证声部一定停在 0。
 */
function perc(param: AudioParam, t0: number, dur: number, peak: number, attack: number): void {
  const a = Math.min(Math.max(attack, 0.0005), dur * 0.4);
  const decayAt = t0 + Math.max(a, dur * 0.6);
  param.setValueAtTime(MIN_GAIN, t0);
  param.linearRampToValueAtTime(Math.max(peak, MIN_GAIN), t0 + a);
  if (decayAt > t0 + a) param.exponentialRampToValueAtTime(Math.max(peak * 0.02, MIN_GAIN), decayAt);
  param.linearRampToValueAtTime(0, t0 + dur);
}

/**
 * 折线包络：按 (相对秒, 值) 控制点逐段线性连接。
 * 用于"加油灌注"这种先渐强后收的形状——perc 的"起音即峰值"表达不了它。
 */
function shape(param: AudioParam, t0: number, points: readonly (readonly [number, number])[]): void {
  const first = points[0];
  if (!first) return;
  param.setValueAtTime(Math.max(first[1], MIN_GAIN), t0 + first[0]);
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    param.linearRampToValueAtTime(Math.max(p[1], 0), t0 + p[0]);
  }
}

// ---------------------------------------------------------------- 声部

interface ToneOptions {
  type: OscillatorType;
  /** 起始频率；给了 to 就整段做指数扫频（听感上是音高"均匀滑动"） */
  from: number;
  to?: number;
  /** 时长（秒），整条配方都必须 ≤ 1s */
  dur: number;
  /** 峰值增益（已含 baseGain 与调用方的距离衰减） */
  gain: number;
  attack?: number;
  /** 显式失谐（音分）；缺省时自动加一点随机抖动 */
  detune?: number;
  filter?: { type: BiquadFilterType; from: number; to?: number; q?: number };
}

interface NoiseOptions {
  dur: number;
  gain: number;
  filter: BiquadFilterType;
  from: number;
  to?: number;
  q?: number;
  attack?: number;
  /** "swell"：先渐强后收（灌注类）；缺省是打击型 ADSR */
  env?: "perc" | "swell";
  /** 显式播放速率；缺省时自动加一点随机抖动 */
  rate?: number;
}

/**
 * 一个声部 = 一条总线（bus 包络 → panner）+ 若干振荡器/噪声成分。
 * 各成分自带 ADSR 写在自己的增益节点上：配方里成分的起止时刻各不相同，只有分开成形才自然；
 * 总线包络只负责两件事——起音不从 0 直跳（防爆音）、结束前确定性归零（收尾断开时无残留）。
 * 高层的对外链路是：source → 各成分包络 → bus（该音效的总增益包络）→ panner → masterGain → 压缩器 → 输出。
 */
class Voice {
  /** 创建过的节点：收尾时统一断开；source.onended 会先把各自链路的叶子节点拆掉 */
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onDone: (() => void) | null = null;
  private dead = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly buffer: AudioBuffer,
    readonly bus: GainNode,
    readonly panner: StereoPannerNode,
    private readonly startAt: number,
  ) {}

  private track(...nodes: AudioNode[]): void {
    for (const n of nodes) this.nodes.push(n);
  }

  /** 振荡器成分：扫频 + 可选二阶滤波 + 打击型 ADSR；返回它的绝对结束时刻 */
  tone(t0: number, o: ToneOptions): number {
    const end = t0 + o.dur;
    const parts: AudioNode[] = [];
    const osc = this.ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(Math.max(1, o.from), t0);
    if (o.to !== undefined && o.to !== o.from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), end);
    osc.detune.value = o.detune ?? jitter(8);
    osc.start(t0);
    osc.stop(end);
    this.sources.push(osc);
    parts.push(osc);
    let head: AudioNode = osc;
    const spec = o.filter;
    if (spec) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = spec.type;
      filter.frequency.setValueAtTime(Math.max(1, spec.from), t0);
      if (spec.to !== undefined && spec.to !== spec.from) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), end);
      }
      if (spec.q !== undefined) filter.Q.value = spec.q;
      head.connect(filter);
      head = filter;
      parts.push(filter);
    }
    const gain = this.ctx.createGain();
    perc(gain.gain, t0, o.dur, o.gain, o.attack ?? 0.004);
    head.connect(gain);
    gain.connect(this.bus);
    parts.push(gain);
    this.track(...parts);
    // onended 是"拆节点"的第一责任人：源一停就拆掉自己那一段链路，即使后台标签页把定时器节流也不会留下节点
    osc.onended = () => {
      for (const n of parts) safeDisconnect(n);
    };
    return end;
  }

  /** 白噪声成分：共享 buffer、每次新建 BufferSource；滤波塑形 + 包络；返回它的绝对结束时刻 */
  noise(t0: number, o: NoiseOptions): number {
    const end = t0 + o.dur;
    const parts: AudioNode[] = [];
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    // 共享 buffer 只有 1s，任何配方都够用；开 loop 只是兜底（速率抖动或极端时长也不会把 buffer 读空）
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1 + jitter(0.06);
    const filter = this.ctx.createBiquadFilter();
    filter.type = o.filter;
    filter.frequency.setValueAtTime(Math.max(1, o.from), t0);
    if (o.to !== undefined && o.to !== o.from) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), end);
    }
    if (o.q !== undefined) filter.Q.value = o.q;
    const gain = this.ctx.createGain();
    if (o.env === "swell") {
      // 灌注类形状：渐强 → 稳住 → 收干；峰值在 35% 处是为了让"灌满"的感觉落在时长中段
      shape(gain.gain, t0, [
        [0, MIN_GAIN],
        [o.dur * 0.35, o.gain],
        [o.dur * 0.72, o.gain * 0.6],
        [o.dur, 0],
      ]);
    } else {
      perc(gain.gain, t0, o.dur, o.gain, o.attack ?? 0.002);
    }
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.bus);
    src.start(t0);
    src.stop(end);
    this.sources.push(src);
    parts.push(src, filter, gain);
    this.track(...parts);
    src.onended = () => {
      for (const n of parts) safeDisconnect(n);
    };
    return end;
  }

  /**
   * 收尾：写总线包络，并排定"断开定时器"。
   * 定时器是主路径（保证节点一定被拆、名额一定归还），onended 是兜底；两条路都幂等，重复到达不会打架。
   */
  arm(endAt: number, onDone: () => void): void {
    this.onDone = onDone;
    const dur = Math.max(0.02, endAt - this.startAt);
    const attackEnd = this.startAt + Math.min(0.005, dur * 0.3);
    const releaseAt = endAt - Math.min(0.045, dur * 0.35);
    const env = this.bus.gain;
    env.setValueAtTime(0, this.startAt);
    env.linearRampToValueAtTime(1, attackEnd);
    if (releaseAt > attackEnd) env.setValueAtTime(1, releaseAt);
    env.linearRampToValueAtTime(0, endAt);
    const ms = Math.max(20, (endAt - this.ctx.currentTime) * 1000 + TAIL_MS);
    this.timer = setTimeout(() => this.teardown(), ms);
  }

  /** 拆除声部：停源、断节点、交还名额；幂等（定时器、dispose、异常路径都可能调到这里） */
  teardown(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // 已经停过：重复 stop 在部分实现里会抛，忽略即可
      }
    }
    for (const n of this.nodes) safeDisconnect(n);
    this.nodes.length = 0;
    this.sources.length = 0;
    const done = this.onDone;
    this.onDone = null;
    if (done) done();
  }
}

// ---------------------------------------------------------------- 声音配方

/**
 * 声音配方：按 kind 把若干成分挂到声部总线上，返回声部的绝对结束时刻（秒）。
 * 每条配方都控制在 1 秒以内——观战是事件流驱动的，音效太长会盖住后面的事件。
 * 各成分的频率/时长数字都写死在配方里（而不是做成参数表）：音效是"听感设计"，直接读数字比多一层配置更清楚。
 */
function renderRecipe(voice: Voice, kind: SfxKind, t0: number, scale: number): number {
  switch (kind) {
    case "fire": {
      // 低频冲击给"炮口压力"，宽带爆裂给"膛音"；爆裂比冲击短，听起来才是一声炮响而不是一团噪音
      const thump = voice.tone(t0, { type: "sine", from: 120, to: 50, dur: 0.14, gain: 0.9 * scale, attack: 0.002 });
      const burst = voice.noise(t0, { filter: "bandpass", from: 1600, to: 400, dur: 0.09, gain: 0.6 * scale, q: 0.9, attack: 0.001 });
      return Math.max(thump, burst);
    }
    case "hit": {
      // 金属脆响（高通噪声 + 两个三角波泛音）说明"打中装甲"，随后一记短闷响说明"装甲板被砸到"
      const cling = voice.noise(t0, { filter: "highpass", from: 1200, dur: 0.11, gain: 0.45 * scale, attack: 0.001 });
      const overtoneA = voice.tone(t0, { type: "triangle", from: 880, dur: 0.1, gain: 0.28 * scale });
      const overtoneB = voice.tone(t0, { type: "triangle", from: 1320, dur: 0.08, gain: 0.2 * scale });
      const thud = voice.noise(t0 + 0.02, { filter: "lowpass", from: 500, to: 180, dur: 0.12, gain: 0.3 * scale });
      return Math.max(cling, overtoneA, overtoneB, thud);
    }
    case "miss": {
      // 弹着地面：只有一记被泥土吸掉高频的闷响，和命中的"金属味"区分开来
      return voice.noise(t0, { filter: "lowpass", from: 500, to: 120, dur: 0.18, gain: 0.4 * scale, q: 1.1 });
    }
    case "collect": {
      // 采到资源：两段上行三角波，起音干脆，是"东西已经拿到手"的正反馈
      const low = voice.tone(t0, { type: "triangle", from: 660, dur: 0.06, gain: 0.3 * scale, attack: 0.002 });
      const high = voice.tone(t0 + 0.05, { type: "triangle", from: 990, dur: 0.06, gain: 0.3 * scale, attack: 0.002 });
      return Math.max(low, high);
    }
    case "deposit": {
      // 金币叮当：C6+G6 的高频三角波，两枚金币相隔 70ms 落下，第二枚稍轻，避免听成一次双击
      const first = Math.max(
        voice.tone(t0, { type: "triangle", from: 1046.5, dur: 0.12, gain: 0.26 * scale, attack: 0.001 }),
        voice.tone(t0, { type: "triangle", from: 1568, dur: 0.1, gain: 0.18 * scale, attack: 0.001 }),
      );
      const second = Math.max(
        voice.tone(t0 + 0.07, { type: "triangle", from: 1046.5, dur: 0.12, gain: 0.22 * scale, attack: 0.001 }),
        voice.tone(t0 + 0.07, { type: "triangle", from: 1568, dur: 0.1, gain: 0.15 * scale, attack: 0.001 }),
      );
      return Math.max(first, second);
    }
    case "refuel": {
      // 液体灌注：带通噪声先渐强后收（"油箱在灌"），中途两三个短滴负责"快满了"的节奏感
      const pour = voice.noise(t0, { filter: "bandpass", from: 300, to: 1500, dur: 0.5, gain: 0.35 * scale, q: 0.7, env: "swell" });
      const dripA = voice.tone(t0 + 0.12, { type: "sine", from: 720, dur: 0.04, gain: 0.18 * scale, attack: 0.001 });
      const dripB = voice.tone(t0 + 0.24, { type: "sine", from: 840, dur: 0.04, gain: 0.18 * scale, attack: 0.001 });
      const dripC = voice.tone(t0 + 0.34, { type: "sine", from: 960, dur: 0.04, gain: 0.16 * scale, attack: 0.001 });
      return Math.max(pour, dripA, dripB, dripC);
    }
    case "loadAmmo": {
      // 机械双响：两次极短的噪声 click（低通 2500Hz 去掉刺耳的高频），第二下稍轻稍长，像"卡进去又锁上"
      const clickIn = voice.noise(t0, { filter: "lowpass", from: 2500, dur: 0.022, gain: 0.4 * scale, attack: 0.0008 });
      const clickLock = voice.noise(t0 + 0.08, { filter: "lowpass", from: 2500, dur: 0.028, gain: 0.34 * scale, attack: 0.0008 });
      return Math.max(clickIn, clickLock);
    }
    case "death": {
      // 大爆炸：长低通噪声（900→70Hz 的"轰"）+ 正弦下沉，尾部几粒碎屑说明"装甲散架"
      const boom = voice.noise(t0, { filter: "lowpass", from: 900, to: 70, dur: 0.8, gain: 0.55 * scale, q: 0.8 });
      const sink = voice.tone(t0, { type: "sine", from: 80, to: 30, dur: 0.5, gain: 0.35 * scale, attack: 0.004 });
      const debrisA = voice.noise(t0 + 0.22, { filter: "highpass", from: 2200, dur: 0.05, gain: 0.12 * scale, attack: 0.001 });
      const debrisB = voice.noise(t0 + 0.4, { filter: "highpass", from: 2600, dur: 0.04, gain: 0.1 * scale, attack: 0.001 });
      const debrisC = voice.noise(t0 + 0.58, { filter: "highpass", from: 3000, dur: 0.04, gain: 0.08 * scale, attack: 0.001 });
      return Math.max(boom, sink, debrisA, debrisB, debrisC);
    }
    case "respawn": {
      // 复活：一记上扬扫频，和阵亡的下沉正相反，听觉上就是"从地上站起来"
      return voice.tone(t0, { type: "triangle", from: 300, to: 820, dur: 0.4, gain: 0.32 * scale, attack: 0.01 });
    }
    case "invalid": {
      // 无效动作：方波嗡嗡两声，低通把方波的尖刺削掉，听感是"被拒绝"而不是"报错弹窗"
      const buzzA = voice.tone(t0, { type: "square", from: 150, dur: 0.09, gain: 0.18 * scale, attack: 0.004, filter: { type: "lowpass", from: 900, q: 0.7 } });
      const buzzB = voice.tone(t0 + 0.12, { type: "square", from: 150, dur: 0.07, gain: 0.16 * scale, attack: 0.004, filter: { type: "lowpass", from: 900, q: 0.7 } });
      return Math.max(buzzA, buzzB);
    }
    case "disqualified": {
      // 淘汰：下行双音，比 invalid 更长更"重"——它是一次性事件的语气，不能听成小提示
      const high = voice.tone(t0, { type: "triangle", from: 620, dur: 0.16, gain: 0.3 * scale, attack: 0.004, filter: { type: "lowpass", from: 1800 } });
      const low = voice.tone(t0 + 0.16, { type: "triangle", from: 310, dur: 0.24, gain: 0.32 * scale, attack: 0.006, filter: { type: "lowpass", from: 1200 } });
      return Math.max(high, low);
    }
    case "tread": {
      // 履带：60ms 的极低通噪声；baseGain 已经压到 0.08，它是"背景存在感"，绝不能抢事件音
      return voice.noise(t0, { filter: "lowpass", from: 180, to: 120, dur: 0.06, gain: scale });
    }
    case "end": {
      // 比赛结束：C5-E5-G5 三音上行，末音拖长收尾；间隔 0.14s 让三个音能分辨（更快就糊成扫频了）
      const noteC = voice.tone(t0, { type: "triangle", from: 523.25, dur: 0.18, gain: 0.26 * scale, attack: 0.006 });
      const noteE = voice.tone(t0 + 0.14, { type: "triangle", from: 659.25, dur: 0.18, gain: 0.26 * scale, attack: 0.006 });
      const noteG = voice.tone(t0 + 0.28, { type: "triangle", from: 783.99, dur: 0.3, gain: 0.3 * scale, attack: 0.006 });
      return Math.max(noteC, noteE, noteG);
    }
    case "ui": {
      // 界面点击：就是"一下"，几乎不留尾音（否则连点时会糊成一片嗡嗡声）
      return voice.noise(t0, { filter: "lowpass", from: 1800, to: 900, dur: 0.02, gain: 0.5 * scale, attack: 0.0006 });
    }
    default: {
      // 表外的 kind（旧事件名）：退回一声 UI 点击，而不是让声部空转
      return voice.noise(t0, { filter: "lowpass", from: 1500, to: 900, dur: 0.02, gain: 0.4 * scale, attack: 0.0008 });
    }
  }
}

// ---------------------------------------------------------------- 对外的音效机

/** play() 的可选参数；两项都由渲染层按"声源相对相机"算好 */
export interface SfxPlayOptions {
  /** -1（左）..1（右）：由相机与声源方位算出的立体声位置 */
  pan?: number;
  /** 0..1：已按"离相机距离"算好的额外衰减 */
  gain?: number;
}

/**
 * 战场音效机（单例见文件末尾的 sfx）。
 * 状态机：idle（未手势解锁）→ ready（可发声）/ unavailable（环境不支持或浏览器拒绝，之后永远静默）→ disposed（已关闭）。
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** 当前活跃声部；activeVoices 就是它的大小 */
  private readonly voices = new Set<Voice>();
  /** kind → 上次出声时刻（performance.now()），限流窗口用 */
  private readonly lastAt = new Map<SfxKind, number>();
  private vol = 0.8;
  private state: "idle" | "ready" | "unavailable" | "disposed" = "idle";
  /** unlock 的缓存 Promise：多次调用必须返回同一结果（幂等），失败的尝试也不重试 */
  private pending: Promise<boolean> | null = null;

  /** 是否已经解锁（true 时 play() 才会真的发声） */
  get unlocked(): boolean {
    return this.state === "ready";
  }

  /** 主音量 0..1 */
  get volume(): number {
    return this.vol;
  }

  /** 当前活跃声部数（调试/测试用） */
  get activeVoices(): number {
    return this.voices.size;
  }

  /** 调主音量：0 只是静音（主增益归 0），不关 context——关掉再恢复会有明显启动延迟 */
  setVolume(v: number): void {
    this.vol = sanitize(v, this.vol, 0, 1);
    if (this.master) this.master.gain.value = this.vol;
  }

  /**
   * 在首次用户手势时调用：惰性创建 AudioContext、resume()、建好主链路。
   * 环境不可用（无 AudioContext / 被浏览器拒绝）时 resolve(false) 并把实例标记为不可用；
   * 幂等：并发或重复调用共享同一个 Promise，结果一致。
   */
  unlock(): Promise<boolean> {
    if (this.state === "ready") return Promise.resolve(true);
    if (this.state === "unavailable" || this.state === "disposed") return Promise.resolve(false);
    if (!this.pending) this.pending = this.open();
    return this.pending;
  }

  /** play() 内部（以及 dispose）都会走这里；任何异常都被吞掉 */
  private async open(): Promise<boolean> {
    const Ctor = audioContextCtor();
    if (!Ctor) return this.markUnavailable();
    try {
      const ctx = new Ctor();
      // 主链路：各声部 → masterGain（音量）→ 压缩器 → 输出。
      // 压缩器是"最后一道保险"：极限速度回放时同一帧可能叠十几个声部，没有它就会削波（听感是"炸麦"）。
      const master = ctx.createGain();
      master.gain.value = this.vol;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 12;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.004;
      limiter.release.value = 0.18;
      master.connect(limiter);
      limiter.connect(ctx.destination);
      // resume 必须在用户手势的调用栈里尽快完成，否则 Safari 会直接拒绝
      await ctx.resume();
      if (this.state === "disposed") {
        // unlock 还没回来就被 dispose 了：把刚建的 context 关掉，不要留一个后台音源
        void ctx.close().catch(() => undefined);
        return false;
      }
      this.ctx = ctx;
      this.master = master;
      this.noiseBuffer = makeNoiseBuffer(ctx);
      this.state = "ready";
      return true;
    } catch {
      // 被浏览器拒绝 / 构造失败：一律当作"这台机器没有声音"，而不是把异常抛给调用方
      return this.markUnavailable();
    }
  }

  private markUnavailable(): false {
    this.state = "unavailable";
    return false;
  }

  /**
   * 播一个音效。
   * 绝不抛异常：未 unlock、参数非法、声部已满、限流窗口内——都是静默 no-op。
   * 同帧的多个同类事件由调用方先合并，这里只保留"限流 + 声部上限"两道闸。
   */
  play(kind: SfxKind, opts?: SfxPlayOptions): void {
    try {
      const ctx = this.ctx;
      const master = this.master;
      const buffer = this.noiseBuffer;
      if (this.state !== "ready" || !ctx || !master || !buffer) return;
      const spec = sfxSpec(kind);
      const now = nowMs();
      const last = this.lastAt.get(kind) ?? Number.NEGATIVE_INFINITY;
      if (now - last < spec.minIntervalMs) return;
      this.lastAt.set(kind, now);
      // 声部上限：丢弃新声部而不是排队——排队会让声音比画面越来越晚（回放听起来就是"音画不同步"）
      if (this.voices.size >= MAX_VOICES) return;
      this.spawn(ctx, master, buffer, kind, spec.baseGain, opts);
    } catch {
      // 音效层永远不能把异常带进渲染循环
    }
  }

  /** 建一个声部并跑配方；t0 留一点提前量，见下方注释 */
  private spawn(ctx: AudioContext, master: GainNode, buffer: AudioBuffer, kind: SfxKind, baseGain: number, opts?: SfxPlayOptions): void {
    // 提前 4ms 起音：把所有包络控制点放到"未来"，否则第一个控制点落在当前时刻会被立即生效而爆音
    const t0 = ctx.currentTime + 0.004;
    const pan = sanitize(opts?.pan, 0, -1, 1);
    const scale = baseGain * sanitize(opts?.gain, 1, 0, 1);
    const bus = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    bus.connect(panner);
    panner.connect(master);
    const voice = new Voice(ctx, buffer, bus, panner, t0);
    this.voices.add(voice);
    try {
      const endAt = renderRecipe(voice, kind, t0, scale);
      voice.arm(endAt, () => {
        this.voices.delete(voice);
      });
    } catch {
      // 配方异常（理论上不会发生）：立刻拆掉这个声部，宁可没声音也不能留下悬挂节点
      voice.teardown();
      this.voices.delete(voice);
    }
  }

  /** 彻底关闭：停掉全部声部、关闭 AudioContext；之后实例不再可用。长跑观战页卸载/热更新时调用 */
  dispose(): void {
    if (this.state === "disposed") return;
    for (const v of [...this.voices]) v.teardown();
    this.voices.clear();
    this.lastAt.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.state = "disposed";
    if (ctx) void ctx.close().catch(() => undefined);
  }
}

/** 白噪声源：只生成一次（1 秒单声道），之后所有噪声成分共享它 */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** 单例：观战/回放页共用一个音效机（AudioContext 数量在浏览器里是有限资源） */
export const sfx: Sfx = new Sfx();