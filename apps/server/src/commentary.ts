// apps/server/src/commentary.ts —— 上帝视角解说：把事件流压缩成"关键行为时间线"，再交给外部模型写成解说词
//
// 为什么是"先压缩、再分段调用"而不是把 737 条事件原样丢给模型：
//   1) 一条 move 事件对人来说是噪音，对 token 预算是纯浪费 —— 时间线只留"人想看的事"
//      （交火与命中、阵亡与死因、提交得分、布雷/踩雷、举盾、被盾弹开、补给见底、无效动作、比分变化）；
//   2) 逐行事实都带 [i=<事件下标>] 锚点，模型只负责"给这行配一句解说"，UI 就能按回放光标逐段露出；
//      锚点由提示词强制原样返回，模型不听话时按"就近吸附"兜底，绝不让稿子锚到不存在的事件上。
//
// 生成是**事后异步**的（比赛跑完立刻排队，整机 1 并发）：观战/回放本质是"按节拍播放已算完的事件流"，
// 所以稿子一就绪，观看者就会随着光标一点点看到解说，而不需要平台在比赛过程中阻塞等模型。
import { DEFAULT_RULESET, resolveRulesVariant, type GameMap, type MatchEvent, type PlayerStats, type Ruleset } from "@ai-game/protocol";
import type { CommentarySegment, CommentaryUsage, Store } from "./store.ts";
import { chat, type LlmMessage } from "./llmClient.ts";
import { isAutoEnabled, loadLlmSettings } from "./commentarySettings.ts";

// ---------------------------------------------------------------- 时间线

export interface TimelineEntry {
  /** 事件流下标：解说的锚点 */
  i: number;
  round: number;
  kind: "intro" | "fight" | "death" | "econ" | "mine" | "defend" | "penalty" | "quiet" | "quiet-range" | "end";
  text: string;
}

export interface TimelineInput {
  map: GameMap;
  players: { seat: number; name: string; modelId: string }[];
  events: MatchEvent[];
  ranking: PlayerStats[];
  rules: Ruleset;
}

/** 条目上限与调用上限：长局也不能把额度一次打光 */
export const MAX_ENTRIES = 200;
export const MAX_CALLS = 6;

/** 规则版本 → Ruleset（"1.2-scout" 这种变体也能解析出来；认不出就用默认规则） */
export function rulesetForVersion(version: string): Ruleset {
  const variant = version.replace(/^\d+\.\d+-/, "");
  return variant === version ? DEFAULT_RULESET : (resolveRulesVariant(variant) ?? DEFAULT_RULESET);
}

/**
 * 事件流 → 关键行为时间线（纯函数，可单测）。
 * 每条 i 都是该行**最早**引用的事件下标：UI 用"当前光标 ≥ i"决定这一段是否已经播出。
 */
export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const { map, players, events, ranking, rules } = input;
  void players; // 名单由提示词头部给出，事实行里一律用 P1/P2 短名
  const raw: TimelineEntry[] = [];
  const hp = new Map<number, number>();
  const cargo = new Map<number, number>();
  const score = new Map<number, number>();
  const firsts = new Set<string>(); // `${seat}:${kind}` 的首标记（首杀/首提交/首雷/首盾）
  const lowHpNoted = new Map<number, Set<number>>();

  const takeFirst = (seat: number, kind: string): boolean => {
    const key = `${seat}:${kind}`;
    if (firsts.has(key)) return false;
    firsts.add(key);
    return true;
  };

  interface Bucket {
    round: number;
    startIndex: number;
    moves: Map<number, number>;
    collects: Map<number, number>;
    loads: Map<number, { rounds: number; mines: number }>;
    refuels: Map<number, number>;
    fires: Map<number, { shots: number; hits: number; dmg: number; blocked: number }>;
    invalids: Map<number, number>;
    notes: TimelineEntry[];
  }
  let bucket: Bucket | null = null;
  let round = 0;

  const sorted = <V>(m: Map<number, V>): [number, V][] => [...m.entries()].sort((a, b) => a[0] - b[0]);
  const note = (i: number, kind: TimelineEntry["kind"], text: string) => {
    if (bucket) bucket.notes.push({ i, round: bucket.round, kind, text });
    else raw.push({ i, round, kind, text });
  };

  /** 把当前回合的"常规动作"合成一行经济/走位描述（大事已经在 notes 里单独成行） */
  function flushBucket(): void {
    const b = bucket;
    bucket = null;
    if (!b) return;
    const parts: string[] = [];
    for (const [seat, n] of sorted(b.moves)) parts.push(`P${seat} 移动 ${n} 格`);
    for (const [seat, n] of sorted(b.collects)) parts.push(`P${seat} 采集 ${n} 单位`);
    for (const [seat, rec] of sorted(b.loads)) {
      const bits = [rec.rounds > 0 ? `装弹 ${rec.rounds} 发` : "", rec.mines > 0 ? `取雷 ${rec.mines} 枚` : ""].filter(Boolean).join("、");
      if (bits) parts.push(`P${seat} 到弹药点补给（${bits}）`);
    }
    for (const [seat, f] of sorted(b.refuels)) parts.push(`P${seat} 加油 ${f}`);
    for (const [seat, rec] of sorted(b.fires)) {
      parts.push(
        `P${seat} 开火 ${rec.shots} 次（命中 ${rec.hits}${rec.blocked > 0 ? `、被弹开 ${rec.blocked}` : ""}${rec.dmg > 0 ? `、造成 ${rec.dmg} 伤害` : ""}）`,
      );
    }
    for (const [seat, n] of sorted(b.invalids)) parts.push(`P${seat} 出现 ${n} 次无效动作`);
    const econ = parts.length > 0 ? `R${b.round}：${parts.join("，")}` : "";
    if (econ) raw.push({ i: b.startIndex, round: b.round, kind: "econ", text: econ });
    for (const n of b.notes) raw.push(n);
    if (!econ && b.notes.length === 0) {
      raw.push({ i: b.startIndex, round: b.round, kind: "quiet", text: `R${b.round}：双方按兵不动` });
    }
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    switch (e.t) {
      case "match_start": {
        const roster = e.seats.map((s) => `P${s.seat}（${s.name}）`).join(" vs ");
        raw.push({ i, round: 0, kind: "intro", text: `比赛开始：${roster}，地图 ${map.mapId}@${map.version}（${map.width}×${map.height}）` });
        break;
      }
      case "turn_begin": {
        flushBucket();
        round = e.round;
        bucket = {
          round, startIndex: i,
          moves: new Map(), collects: new Map(), loads: new Map(), refuels: new Map(),
          fires: new Map(), invalids: new Map(), notes: [],
        };
        break;
      }
      case "move": {
        if (bucket) bucket.moves.set(e.seat, (bucket.moves.get(e.seat) ?? 0) + 1);
        break;
      }
      case "fire": {
        if (bucket) {
          const rec = bucket.fires.get(e.seat) ?? { shots: 0, hits: 0, dmg: 0, blocked: 0 };
          rec.shots += 1;
          if (e.hit) rec.hits += 1;
          rec.dmg += e.damage;
          if (e.blocked) rec.blocked += 1;
          bucket.fires.set(e.seat, rec);
        }
        if (takeFirst(e.seat, "fire")) note(i, "fight", `P${e.seat} 打出了本场第一发炮弹`);
        if (e.hit && e.targetSeat !== null) {
          const before = hp.get(e.targetSeat) ?? rules.initial.hp;
          const after = Math.max(0, before - e.damage);
          hp.set(e.targetSeat, after);
          if (e.blocked) {
            note(i, "defend", `P${e.targetSeat} 的防御把 P${e.seat} 的炮弹弹开了（0 伤害）`);
          } else {
            const frac = rules.hpMax > 0 ? after / rules.hpMax : 1;
            const noted = lowHpNoted.get(e.targetSeat) ?? new Set<number>();
            const step = frac <= 0.2 ? 20 : 50;
            if (frac <= 0.5 && !noted.has(step)) {
              noted.add(step);
              lowHpNoted.set(e.targetSeat, noted);
              note(i, "fight", `P${e.targetSeat} 血量掉到 ${after}/${rules.hpMax}${frac <= 0.2 ? "（再挨一下就没了）" : ""}`);
            }
          }
        }
        break;
      }
      case "death": {
        const co = cargo.get(e.seat) ?? 0;
        const how = e.cause === "mine"
          ? (e.killerSeat !== null && e.killerSeat !== e.seat ? `踩了 P${e.killerSeat} 埋的地雷` : "踩上了自己埋的地雷")
          : (e.killerSeat !== null ? `被 P${e.killerSeat} 击毁` : "被击毁");
        const first = takeFirst(e.seat, "blood") ? "（本场首杀）" : "";
        raw.push({
          i, round, kind: "death",
          text: `P${e.seat} 阵亡：${how}${first}${co > 0 ? `，丢掉 ${co} 单位货` : ""}，停机 ${rules.respawnRounds} 回合`,
        });
        hp.set(e.seat, 0);
        cargo.set(e.seat, 0);
        score.set(e.seat, e.scoreAfter);
        if (e.killerSeat !== null && e.killerSeat !== e.seat) score.set(e.killerSeat, (score.get(e.killerSeat) ?? 0) + rules.killReward);
        lowHpNoted.set(e.seat, new Set());
        break;
      }
      case "respawn": {
        hp.set(e.seat, rules.respawn.hp);
        cargo.set(e.seat, rules.respawn.cargo);
        note(i, "econ", `P${e.seat} 在出生点复活`);
        break;
      }
      case "collect": {
        if (bucket) bucket.collects.set(e.seat, (bucket.collects.get(e.seat) ?? 0) + e.amount);
        cargo.set(e.seat, e.cargoAfter);
        break;
      }
      case "deposit": {
        const first = takeFirst(e.seat, "deposit") ? "（本场第一次提交）" : "";
        score.set(e.seat, e.scoreAfter);
        cargo.set(e.seat, 0);
        raw.push({ i, round, kind: "econ", text: `P${e.seat} 提交 ${e.units} 单位资源 +${e.scoreDelta} 分${first}，总分 ${e.scoreAfter}` });
        break;
      }
      case "load_ammo": {
        if (bucket) {
          const rec = bucket.loads.get(e.seat) ?? { rounds: 0, mines: 0 };
          rec.rounds += e.rounds;
          rec.mines += e.mines ?? 0;
          bucket.loads.set(e.seat, rec);
        }
        score.set(e.seat, e.scoreAfter);
        break;
      }
      case "refuel": {
        if (bucket) bucket.refuels.set(e.seat, (bucket.refuels.get(e.seat) ?? 0) + e.fuelAdded);
        score.set(e.seat, e.scoreAfter);
        break;
      }
      case "defend": {
        const first = takeFirst(e.seat, "defend") ? "（本场第一次举盾）" : "";
        note(i, "defend", `P${e.seat} 停止行动举盾：${e.rounds} 轮内炮弹打不动（对手看不到）${first}`);
        break;
      }
      case "deploy_mine": {
        const first = takeFirst(e.seat, "mine") ? "（本场第一枚地雷）" : "";
        raw.push({ i, round, kind: "mine", text: `P${e.seat} 在 (${e.x},${e.y}) 埋下一枚地雷（全场不可见，身上还剩 ${e.minesAfter} 枚）${first}` });
        break;
      }
      case "mine_trigger": {
        raw.push({ i, round, kind: "mine", text: `${e.seat === e.owner ? "P" + e.seat + " 踩响了自己埋的地雷" : `P${e.seat} 踩响 P${e.owner} 埋的地雷`}（${e.x},${e.y}）：血量直接清空` });
        break;
      }
      case "invalid_action": {
        if (bucket) bucket.invalids.set(e.seat, (bucket.invalids.get(e.seat) ?? 0) + 1);
        break;
      }
      case "strike": {
        raw.push({ i, round, kind: "penalty", text: `P${e.seat} 记一次异常（${e.kind}）：${e.detail.slice(0, 60)}` });
        break;
      }
      case "disqualified": {
        raw.push({ i, round, kind: "penalty", text: `P${e.seat} 因连续异常被强制待机，直到终局` });
        break;
      }
      case "match_end": {
        flushBucket();
        const final = e.ranking.map((r) => `#${r.rank} P${r.seat} ${r.score} 分`).join("，");
        const stats = ranking
          .map((r) => `P${r.seat} 提交 ${r.unitsDeposited} 单位 / 击杀 ${r.kills} / 阵亡 ${r.deaths}${r.minesDeployed > 0 ? ` / 布雷 ${r.minesDeployed}（被踩响 ${r.mineKills}）` : ""}`)
          .join("；");
        raw.push({ i, round, kind: "end", text: `比赛结束：${final}。全场数据：${stats}` });
        break;
      }
      default:
        break;
    }
  }
  flushBucket();
  raw.sort((a, b) => a.i - b.i);
  return mergeQuiet(raw);
}

/** 把连续的"按兵不动"并成一段：长局里 R40–R55 这种没必要逐回合念 */
function mergeQuiet(entries: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (e.kind === "quiet" && last && (last.kind === "quiet" || last.kind === "quiet-range")) {
      const from = last.text.match(/^R(\d+)/)?.[1] ?? String(last.round);
      out[out.length - 1] = { i: last.i, round: last.round, kind: "quiet-range", text: `R${from}–R${e.round}：双方各自来回走位，没有交手` };
      continue;
    }
    out.push(e);
  }
  return out;
}

/** 条目太多时按"重要性"裁剪：死亡/踩雷/举盾/结束一定留，中间的经济行等间隔抽稀 */
export function clampEntries(entries: TimelineEntry[]): TimelineEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  const keep = new Set<TimelineEntry["kind"]>(["intro", "death", "mine", "defend", "penalty", "end"]);
  const important = entries.filter((e) => keep.has(e.kind));
  const rest = entries.filter((e) => !keep.has(e.kind));
  const budget = Math.max(1, MAX_ENTRIES - important.length);
  const step = Math.max(1, Math.ceil(rest.length / budget));
  const sampled = rest.filter((_, idx) => idx % step === 0);
  return [...important, ...sampled].sort((a, b) => a.i - b.i);
}

// ---------------------------------------------------------------- 提示词与解析

const SYSTEM_PROMPT = [
  "你是一位电竞比赛的解说员，正在解说一场坦克对战（1v1 或多人混战）。你看的是上帝视角，比选手知道得多。",
  "你会拿到一份**已经压缩过的事实时间线**：每行以 [i=事件下标][R回合] 开头，后面是该回合发生的关键行为。",
  "请为这些事实写解说词，要求：",
  "1) 只说事实行里写明的信息，不要虚构没出现的动作、位置或数值；",
  "2) 有节奏：走动与补给一句带过，阵亡 / 踩雷 / 举盾 / 被盾弹开 / 比分反超 要写成关键时刻；",
  "3) 点出双方的意图与后果（例如“他举盾换一轮喘息”“这一趟提交把比分反超”），不吹不黑；",
  "4) 一行事实写一句，也可以把相邻两三行合并成一句；但**不要遗漏阵亡、踩雷、举盾、提交这四类**；",
  "5) 每条最多 120 个汉字，不要复述规则、不要输出 Markdown。",
  "",
  '输出必须是严格 JSON：{"segments":[{"i":<照抄事实行的 i>,"round":<回合数>,"seat":<0=中立/1/2/3/4>,"tone":"calm|hot|fun","text":"解说词"}]}',
  "i 必须是输入事实行里出现过的整数，不要自己编，也不要输出 JSON 之外的任何内容。",
].join("\n");

export function chunkEntries(entries: TimelineEntry[]): TimelineEntry[][] {
  if (entries.length === 0) return [];
  const calls = Math.min(MAX_CALLS, Math.max(1, Math.ceil(entries.length / 18)));
  const size = Math.ceil(entries.length / calls);
  const chunks: TimelineEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) chunks.push(entries.slice(i, i + size));
  return chunks;
}

/** 宽容地取出 JSON：模型常带 ```json 围栏或前后废话，甚至只回一个平衡的数组/对象 */
export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => typeof c === "string");
  for (const c of candidates) {
    const trimmed = c.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      /* 继续做括号配对 */
    }
    const start = trimmed.search(/[[{]/);
    if (start < 0) continue;
    const open = trimmed[start]!;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

const TONES = new Set(["calm", "hot", "fun"]);

/**
 * 把模型返回的一段内容变成校验过的 segments：
 * - i 不在本批锚点里 → 吸附到"不大于它的最近锚点"（再不行用本批第一个）：宁可位置略偏，也不让稿子挂到不存在的事件上；
 * - text 去空白并截断；tone/seat 不在允许集合就回落到默认；
 * - 同一锚点只留第一条。
 */
export function normalizeSegments(raw: unknown, anchors: TimelineEntry[], fallbackRound: number): CommentarySegment[] {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === "object" && Array.isArray((raw as { segments?: unknown }).segments) ? (raw as { segments: unknown[] }).segments : []);
  const out: CommentarySegment[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const seg = item as { i?: unknown; round?: unknown; seat?: unknown; tone?: unknown; text?: unknown };
    const text = typeof seg.text === "string" ? seg.text.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    if (text.length === 0) continue;
    const wanted = Math.round(Number(seg.i));
    let anchor: TimelineEntry | undefined;
    if (Number.isFinite(wanted)) {
      anchor = anchors.find((a) => a.i === wanted) ?? [...anchors].reverse().find((a) => a.i <= wanted) ?? anchors[0];
    } else {
      anchor = anchors[0];
    }
    if (!anchor || seen.has(anchor.i)) continue;
    seen.add(anchor.i);
    const roundNum = Math.round(Number(seg.round));
    const round = Number.isFinite(roundNum) && roundNum > 0 ? roundNum : (anchor.round || fallbackRound);
    const seatNum = Math.round(Number(seg.seat));
    const seat = Number.isFinite(seatNum) && seatNum >= 0 && seatNum <= 4 ? seatNum : 0;
    const tone = typeof seg.tone === "string" && TONES.has(seg.tone) ? (seg.tone as CommentarySegment["tone"]) : "calm";
    out.push({ i: anchor.i, round, seat, tone, text });
  }
  return out.sort((a, b) => a.i - b.i);
}

// ---------------------------------------------------------------- 生成（配置 + 排队）

export interface CommentaryDeps {
  store: Store;
  masterKey: Buffer;
  /** 地图注册表取图（编辑器自制图也要能解说） */
  getMap: (mapId: string) => GameMap | null;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void } | null;
}

export interface GenerateOptions {
  /** 忽略"已有稿子/自动开关"，强制重生成（用户点“重新生成”时用） */
  force?: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 每场比赛最多一次在跑；整机串行（1 并发），避免一次赛事把额度打满 */
const inFlight = new Set<string>();
let queue: Promise<void> = Promise.resolve();

export function commentaryBusy(): boolean {
  return inFlight.size > 0;
}

/** 真正的生成（写库）。抛出的一切都会被调用方落到 match_commentary.error 上 */
export async function generateCommentary(deps: CommentaryDeps, matchId: string): Promise<{ ok: boolean; error?: string; segments?: number }> {
  const { store, masterKey } = deps;
  const settings = loadLlmSettings(store, masterKey);
  if (!settings) return { ok: false, error: "还没有配置解说模型（baseUrl / modelId / apiKey）" };
  const replay = store.getReplay(matchId);
  const match = store.getMatch(matchId);
  if (!replay || !match) return { ok: false, error: "这场比赛没有回放事件流" };
  const map = deps.getMap(match.mapId);
  if (!map) return { ok: false, error: `找不到地图 ${match.mapId}` };

  const players = store.listPlayers(matchId).map((p) => ({ seat: p.seat, name: p.name, modelId: p.modelId }));
  const rules = rulesetForVersion(match.rulesetVersion);
  const timeline = clampEntries(buildTimeline({ map, players, events: replay.events, ranking: replay.ranking, rules }));
  if (timeline.length === 0) return { ok: false, error: "事件流里没有可解说的内容" };

  const roster = players.map((p) => `P${p.seat} = ${p.name}（模型 ${p.modelId}）`).join("；");
  const chunks = chunkEntries(timeline);
  const segments: CommentarySegment[] = [];
  const usage: CommentaryUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, ms: 0 };

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;
    const lines = chunk.map((e) => `[i=${e.i}][R${e.round}] ${e.text}`).join("\n");
    const history = segments.slice(-4).map((s) => `（你刚才说过：${s.text}）`).join("\n");
    const messages: LlmMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `本场对阵：${roster}；地图 ${map.mapId}@${map.version}；规则版本 ${match.rulesetVersion}。`,
          `这是第 ${ci + 1}/${chunks.length} 段事实（按时间顺序；不要重复前面已经说过的事）。`,
          history,
          lines,
        ].filter(Boolean).join("\n"),
      },
    ];
    let reply;
    try {
      reply = await chat(settings, messages, { temperature: settings.temperature, maxTokens: settings.maxTokens });
    } catch (err) {
      // 调用失败就把原因交回去（不抛）：路由/UI 只认返回值，队列也只需要落库
      return { ok: false, error: `第 ${ci + 1}/${chunks.length} 段调用失败：${errText(err)}` };
    }
    usage.calls += 1;
    usage.ms += reply.ms;
    if (reply.usage) {
      usage.promptTokens += reply.usage.promptTokens;
      usage.completionTokens += reply.usage.completionTokens;
      usage.totalTokens += reply.usage.totalTokens;
    }
    const parsed = extractJson(reply.text);
    if (parsed === null) {
      // 模型没按 JSON 回：把整段文本当一条解说挂在本批第一个锚点上，总比整场失败好
      const first = chunk[0]!;
      segments.push({ i: first.i, round: first.round, seat: 0, tone: "calm", text: reply.text.replace(/\s+/g, " ").trim().slice(0, 140) });
      continue;
    }
    segments.push(...normalizeSegments(parsed, chunk, chunk[0]!.round));
  }

  const dedup = new Map<number, CommentarySegment>();
  for (const s of segments) if (!dedup.has(s.i)) dedup.set(s.i, s);
  const final = [...dedup.values()].sort((a, b) => a.i - b.i);
  if (final.length === 0) return { ok: false, error: "模型没有返回可用的解说内容" };

  store.finishCommentary(matchId, { segments: final, usage, baseUrl: settings.baseUrl, modelId: settings.modelId });
  deps.logger?.info?.(`解说已生成：${matchId}（${final.length} 段 / ${chunks.length} 次调用）`);
  return { ok: true, segments: final.length };
}

/**
 * 排队生成（不阻塞调用方）：赛事跑完一场后调用。
 * 只有"已配置 + 自动开关打开 + 这一场还没有稿子（或上次失败）"才会真的排队；force = 强制重生成。
 * 队列串行；失败写进库，前端能看到原因。
 */
export function scheduleCommentary(deps: CommentaryDeps, matchId: string, opts: GenerateOptions = {}): { queued: boolean; reason?: string } {
  const { store } = deps;
  if (!loadLlmSettings(store, deps.masterKey)) return { queued: false, reason: "未配置解说模型" };
  if (!opts.force && !isAutoEnabled(store)) return { queued: false, reason: "自动解说已关闭（可在解说设置里打开，或手动点生成）" };
  const existing = store.getCommentary(matchId);
  if (!opts.force && existing && (existing.status === "ready" || existing.status === "generating")) {
    return { queued: false, reason: existing.status === "ready" ? "已有解说稿" : "正在生成中" };
  }
  if (inFlight.has(matchId)) return { queued: false, reason: "正在生成中" };

  const settings = loadLlmSettings(store, deps.masterKey)!;
  inFlight.add(matchId);
  store.beginCommentary(matchId, { baseUrl: settings.baseUrl, modelId: settings.modelId });
  queue = queue
    .then(async () => {
      try {
        const res = await generateCommentary(deps, matchId);
        if (!res.ok) store.failCommentary(matchId, res.error ?? "生成失败");
      } catch (err) {
        store.failCommentary(matchId, errText(err).slice(0, 500));
        deps.logger?.warn?.(`解说生成失败：${matchId} ${errText(err)}`);
      } finally {
        inFlight.delete(matchId);
      }
    })
    .catch(() => { /* 队列不能断链：单个任务里的异常已经在里面处理 */ });
  return { queued: true };
}