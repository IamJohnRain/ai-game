// ============================================================================
// 赤羽·疾风（Crimson Rush） —— AI 坦克对战平台 1v1 策略脚本
// 风格：aggressive 激进抢分流 ／ 协议 p1.0 ／ ruleset-1.1 ／ QuickJS 沙箱
// 每回合状态机（最多 RULES.apPerTurn 个动作，按优先级）：
//   [提交] 站在提交点且带货 -> deposit（落袋为安：死亡会清零载货）
//   [补给] 站在加油点/弹药点且库存偏低 -> refuel / loadAmmo（AP 够就补满）
//   [采集] 站在资源点且有货有仓位 -> collect（单次 3 单位，一趟最多装满 5）
//   [交火] 能一发带走 / 对方带货 / 刚被射击 / 贴身 -> 每次只打一发（另 1 AP 留给采集）
//   [机动] 按任务走 BFS 最短路：中央高收益点 -> 提交 -> 前哨 -> 补给 -> 蹲点等回充
// 得分路径：中央资源点紧贴唯一提交点，采满 5 单位只需走 1 步 = +50 分/趟；
//   击杀 +20 且对方停机 3 轮；死亡 -20 且载货清零 —— 所以绝不带着货去送死，
//   远距离低命中率不浪费弹药（一次采集 30 分 >> 一发 30% 的炮弹）。
// 硬约束：<=600 行；只用 MAP / RULES / API 与标准 JSON/Math；无 Date/Math.random。
// ============================================================================
const META = {
  name: "赤羽·疾风",
  style: "aggressive",
  note: "抢中央高收益点、满载即交；只打残血/带货/贴身目标；弹油见底回就近补给点续命",
};

// 方向向量：N E S W
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const DIR4 = ["N", "E", "S", "W"];

// ---------------- 模块级记忆（整场比赛持续存在；无记忆也能正确工作） ----------------
let SEAT = 1, W = 1, H = 1;
let SPAWN = { x: 0, y: 0 };
let ALLNODES = [];      // {id,x,y,kind,capacity,regen,initial}
let CENTERS = [];       // 高收益中央资源点
let HOMES = [];         // 低收益前哨资源点
let NODEBYID = {}, NODECELL = {};   // id -> node ; "x,y" -> node
let DEPOSITS = [], FUELS = [], AMMOS = [];
let NODEINFO = {};      // id -> { rem, round } 最后一次可见的余量
let OBJ = null;         // 当前任务 { kind, id, x, y, ax, ay }
let OBJ_AGE = 0, KILLED_ROUND = 0;
// ============================ 地形与基础工具 ============================
function cellAt(x, y) {
  if (y < 0 || y >= H || x < 0 || x >= W) return "#";
  const row = MAP.grid[y];
  return row ? row.charAt(x) : "#";
}
function walkable(x, y) {
  const c = cellAt(x, y);
  return c !== "#" && c !== "~";
}
function cheb(a, b) {
  let dx = a.x - b.x; if (dx < 0) dx = -dx;
  let dy = a.y - b.y; if (dy < 0) dy = -dy;
  return dx > dy ? dx : dy;
}
function num(v, fallback) {
  return (typeof v === "number" && v === v) ? v : fallback;
}
function onAny(list, p) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].x === p.x && list[i].y === p.y) return true;
  }
  return false;
}
function idxOf(x, y) { return y * W + x; }
function distOf(fld, x, y) {
  if (!fld) return -1;
  if (x < 0 || y < 0 || x >= W || y >= H) return -1;
  const arr = fld.dist ? fld.dist : fld;   // 兼容 BFS 结果对象与裸距离数组
  const v = arr[idxOf(x, y)];
  return (typeof v === "number" && v >= 0) ? v : -1;
}

// 从 (sx,sy) 出发的 BFS（4 邻），blockers 为可见敌车占位（与引擎对"可见单位"的判定一致）
// 返回 { dist, prev }，均为 W*H 的扁平数组；-1 表示不可达。
function bfsFrom(sx, sy, blockers) {
  const n = W * H;
  const dist = new Array(n);
  const prev = new Array(n);
  for (let i = 0; i < n; i++) { dist[i] = -1; prev[i] = -1; }
  if (!walkable(sx, sy)) return { dist: dist, prev: prev };
  const start = idxOf(sx, sy);
  dist[start] = 0;
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head]; head += 1;
    const cx = cur % W, cy = (cur - cx) / W;
    const nd = dist[cur] + 1;
    for (let k = 0; k < 4; k++) {
      const nx = cx + DX[k];
      const ny = cy + DY[k];
      if (!walkable(nx, ny)) continue;
      const ni = idxOf(nx, ny);
      if (dist[ni] >= 0) continue;
      if (blockedAt(blockers, nx, ny)) continue;
      dist[ni] = nd;
      prev[ni] = cur;
      queue.push(ni);
    }
  }
  return { dist: dist, prev: prev };
}
function blockedAt(blockers, x, y) {
  for (let i = 0; i < blockers.length; i++) {
    if (blockers[i].x === x && blockers[i].y === y) return true;
  }
  return false;
}
// 从 BFS 结果里还原 (from -> to) 的方向序列；不可达返回 null
function pathTo(fld, from, to) {
  if (!fld) return null;
  const fi = idxOf(from.x, from.y);
  const ti = idxOf(to.x, to.y);
  if (to.x < 0 || to.y < 0 || to.x >= W || to.y >= H) return null;
  if (fld.dist[ti] < 0) return null;
  const cells = [ti];
  let cur = ti;
  let guard = 0;
  while (cur !== fi && guard <= W * H) {
    cur = fld.prev[cur];
    if (cur < 0) return null;
    cells.push(cur);
    guard += 1;
  }
  if (cur !== fi) return null;
  const dirs = [];
  for (let i = cells.length - 1; i > 0; i--) {
    const a = cells[i], b = cells[i - 1];
    const ax = a % W, ay = (a - ax) / W, bx = b % W, by = (b - bx) / W;
    for (let k = 0; k < 4; k++) {
      if (ax + DX[k] === bx && ay + DY[k] === by) { dirs.push(DIR4[k]); break; }
    }
  }
  return dirs;
}
// ============================ 世界认知 ============================
function observe(state, round) {
  const nodes = state.resourceNodes || [];
  for (let i = 0; i < nodes.length; i++) {
    const v = nodes[i]; if (!v || !v.id) continue;
    if (typeof v.remaining === "number") NODEINFO[v.id] = { rem: v.remaining, round: round };
  }
}
// 资源点余量估计：可见用真值；不可见按"上次看到 + 回充速率"外推（上限为容量）
function estRemaining(node, round) {
  if (!node) return 0;
  const inf = NODEINFO[node.id];
  if (!inf) return Math.min(node.capacity, node.initial, 4);
  if (inf.round >= round) return inf.rem;
  const regen = node.regen > 0 ? node.regen : 999;
  const gain = Math.floor((round - inf.round) / regen);
  return Math.min(node.capacity, inf.rem + gain);
}
// 站在资源点上时余量必然可见（距离 0）；宁可看到真值
function visibleRemaining(state, node) {
  const nodes = state.resourceNodes || [];
  for (let i = 0; i < nodes.length; i++) {
    const v = nodes[i];
    if (v && v.id === node.id) return (typeof v.remaining === "number") ? v.remaining : -1;
  }
  return -1;
}
function nodeAt(p) { return NODECELL[p.x + "," + p.y] || null; }
function visibleEnemies(state, pos) {
  const list = state.enemies || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || !e.pos) continue;
    out.push({
      seat: e.seat, pos: { x: num(e.pos.x, 0), y: num(e.pos.y, 0) },
      hp: num(e.hp, 100), cargo: num(e.cargo, 0),
      dist: num(e.distance, cheb({ x: num(e.pos.x, 0), y: num(e.pos.y, 0) }, pos)),
    });
  }
  return out;
}
function enemyIndexAt(list, x, y) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].pos.x === x && list[i].pos.y === y) return i;
  }
  return -1;
}
function nearestEnemyDist(vis, pos) {
  let best = 99;
  for (let i = 0; i < vis.length; i++) {
    const d = cheb(pos, vis[i].pos);
    if (d < best) best = d;
  }
  return best;
}
// 本回合是否被射击过（命中或未命中）—— 用于"刚被打就还手"
function underFire(state) {
  const evs = state.events || [];
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (!ev) continue;
    if (ev.type === "hit" && ev.targetSeat === SEAT) return true;
    if (ev.type === "miss" && ev.by !== SEAT) return true;
  }
  return false;
}
// ============================ 任务选择 ============================
function clearObj() { OBJ = null; OBJ_AGE = 0; }
function setObj(o) { OBJ = o; OBJ_AGE = 0; return o; }
function nearest(list, fld, from) {
  let best = null, bd = 1e9;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const d = distOf(fld, p.x, p.y);
    // 只认 BFS 真能走到的格子：被敌车占住的设施不算"可达"（否则会原地卡死）
    if (d >= 0 && d < bd) { bd = d; best = p; }
  }
  return best ? { pt: best, d: bd } : null;
}
// 目标格被敌车占住（BFS 视为障碍）时，退到"隔壁可达格"—— 站过去震慑/下手
function resolveTarget(fld, x, y) {
  if (distOf(fld, x, y) >= 0) return { x: x, y: y };
  let best = null, bd = 1e9;
  for (let k = 0; k < 4; k++) {
    const nx = x + DX[k], ny = y + DY[k];
    const d = distOf(fld, nx, ny);
    if (d >= 0 && d < bd) { bd = d; best = { x: nx, y: ny }; }
  }
  return best;
}
function fuelMust(self, pos, fld) {
  const f = nearest(FUELS, fld, pos);
  const need = f ? f.d : 6;
  return num(self.fuel, 0) < need * RULES.moveFuelCost + 8;
}
function wantFuel(self) {
  return num(self.fuel, 0) <= 45;   // 只在油箱过半以下才占用 AP 加油（补一次 +30）
}
function wantAmmo(self) {
  return num(self.ammo, 0) <= num(self.ammoMax, RULES.ammoMax) - 12;
}
function pickNode(state, self, pos, fld, round) {
  const cargo = num(self.cargo, 0);
  const cargoMax = num(self.cargoMax, RULES.cargoMax);
  const space = cargoMax - cargo;
  if (space <= 0) return null;
  let best = null, bestScore = -1e9;
  for (let i = 0; i < ALLNODES.length; i++) {
    const n = ALLNODES[i];
    const d = distOf(fld, n.x, n.y);
    if (d < 0) continue;
    const est = estRemaining(n, round);
    if (est <= 0) continue;
    const take = Math.min(est, RULES.collectPerAction * 2, space);
    if (take <= 0) continue;
    // 价值 = 这一趟能采到的分 - 路程机会成本（去程全额 + 采完去提交的半程）
    // 中央点额外加权：紧贴提交点、回充快（2 轮 +1），是长期收益的主产地
    const cycle = d + (n.dep < 900 ? n.dep * 0.5 : 4);
    const score = take * RULES.depositScorePerUnit - cycle * 6 + (n.kind === "center" ? 25 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { kind: n.kind === "center" ? "node" : "home", id: n.id, x: n.x, y: n.y };
    }
  }
  return best;
}
// 已在中央广场附近时：先顺手把货补满，再走 1 步提交
function nearCenterStock(state, fld, round, maxD) {
  let best = null, bestEst = 0;
  for (let i = 0; i < CENTERS.length; i++) {
    const n = CENTERS[i];
    const d = distOf(fld, n.x, n.y);
    if (d < 0 || d > maxD) continue;
    const est = estRemaining(n, round);
    if (est > bestEst) { bestEst = est; best = { kind: "node", id: n.id, x: n.x, y: n.y }; }
  }
  return best;
}
function chooseObjective(state, self, pos, fld, round, vis) {
  const cargo = num(self.cargo, 0);
  const cargoMax = num(self.cargoMax, RULES.cargoMax);
  const hp = num(self.hp, 100);

  // A) 沿用既有任务（带有效性检查，避免每回合摇摆）
  if (OBJ && OBJ_AGE <= 24) {
    let keep = true;
    if (OBJ.kind === "node" || OBJ.kind === "home") {
      const n = NODEBYID[OBJ.id];
      if (!n || estRemaining(n, round) <= 0) keep = false;
      else if (cargo >= cargoMax) keep = false;     // 已装满：别再守着采点，去提交
    } else if (OBJ.kind === "deposit") {
      if (cargo <= 0) keep = false;
    } else if (OBJ.kind === "fuel") {
      if (num(self.fuel, 0) >= 70) keep = false;
      else if (!fuelMust(self, pos, fld)) keep = false;
    } else if (OBJ.kind === "ammo") {
      if (num(self.ammo, 0) >= 10) keep = false;
    }
    if (keep) {
      const r = resolveTarget(fld, OBJ.x, OBJ.y);
      if (r) { OBJ.ax = r.x; OBJ.ay = r.y; OBJ_AGE += 1; return OBJ; }
    }
    clearObj();
  }

  // B) 带货：先在近处中央点补满；补不动就立刻去提交
  if (cargo > 0) {
    const threatened = nearestEnemyDist(vis, pos) <= 4 || num(self.hp, 100) <= 30;
    if (cargo < cargoMax && !threatened) {
      const near = nearCenterStock(state, fld, round, 3);
      if (near) return setObj(near);
    }
    if (cargo < 3 && !threatened && cargo > 0) {
      const near2 = nearCenterStock(state, fld, round, 5);
      if (near2) return setObj(near2);   // 不足 3 单位先别跑一趟提交
    }
    const dep = nearest(DEPOSITS, fld, pos);
    if (dep) { setObj({ kind: "deposit", x: dep.pt.x, y: dep.pt.y }); OBJ.ax = OBJ.x; OBJ.ay = OBJ.y; return OBJ; }
  }

  // C) 燃油硬性不足：先去加油（应急移动要扣分）
  if (fuelMust(self, pos, fld)) {
    const f = nearest(FUELS, fld, pos);
    if (f) { setObj({ kind: "fuel", x: f.pt.x, y: f.pt.y }); OBJ.ax = OBJ.x; OBJ.ay = OBJ.y; return OBJ; }
  }
  // D) 弹尽不专门跑补给点：弹药只在"顺路"时补（一次跑 8 格 = 4 轮采集，得不偿失）

  // E) 采集：按"收益 - 路程成本"挑点（中央优先，中央空则回前哨）
  const nd = pickNode(state, self, pos, fld, round);
  if (nd) {
    setObj(nd);
    const r = resolveTarget(fld, nd.x, nd.y);
    if (r) { OBJ.ax = r.x; OBJ.ay = r.y; }
    return OBJ;
  }

  // F) 无货可采：顺路补给，或回中央蹲点等回充（同时盯住提交点）
  if (num(self.fuel, 0) <= 35 || hp <= 25) {
    const wantA = false;
    const wantF = num(self.fuel, 0) <= 35;
    let a = wantA ? nearest(AMMOS, fld, pos) : null;
    let f = wantF ? nearest(FUELS, fld, pos) : null;
    let pick = null;
    if (a && f) pick = (a.d <= f.d) ? { kind: "ammo", x: a.pt.x, y: a.pt.y } : { kind: "fuel", x: f.pt.x, y: f.pt.y };
    else if (a) pick = { kind: "ammo", x: a.pt.x, y: a.pt.y };
    else if (f) pick = { kind: "fuel", x: f.pt.x, y: f.pt.y };
    if (pick) { setObj(pick); OBJ.ax = OBJ.x; OBJ.ay = OBJ.y; return OBJ; }
  }
  const hold = nearest(CENTERS.length ? CENTERS : ALLNODES, fld, pos);
  if (hold) { setObj({ kind: "node", id: hold.pt.id, x: hold.pt.x, y: hold.pt.y }); OBJ.ax = OBJ.x; OBJ.ay = OBJ.y; return OBJ; }
  return null;
}
// ============================ 交火决策 ============================
function hitBandChance(d) {
  const bands = RULES.hitChanceBands || [];
  const minChance = num(RULES.minHitChance, 10);
  let chance = minChance;
  for (let i = 0; i < bands.length; i++) {
    if (d <= bands[i].maxDistance) { chance = bands[i].chance; break; }
  }
  if (chance < minChance) chance = minChance;
  return chance;
}
function pickTarget(vis, pos, shellDmg) {
  let best = null, bestScore = -1e9;
  for (let i = 0; i < vis.length; i++) {
    const e = vis[i];
    const d = cheb(pos, e.pos);
    let score = 100 - d;
    if (e.hp <= shellDmg) score += 60;                 // 一发带走
    if (e.cargo >= 3) score += 45;                     // 带货：打掉就是 30+ 分的净值
    else if (e.cargo > 0) score += 10;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}
// 返回本回合要打的射击动作（0~ap 个）
function planShots(state, self, pos, ap, vis) {
  const out = [];
  if (ap <= 0) return out;
  const ammo = num(self.ammo, 0);
  if (ammo <= 0) return out;
  const shellDmg = num(RULES.shellDamage, 20);
  const e = pickTarget(vis, pos, shellDmg);
  if (!e) return out;
  const t = e.pos;
  if (t.x === pos.x && t.y === pos.y) return out;
  if (t.x < 0 || t.y < 0 || t.x >= W || t.y >= H) return out;
  const d = cheb(pos, t);
  if (d > num(RULES.fireRange, 8)) return out;
  let los = false;
  try { los = API.hasLOS(pos, t); } catch (err) { los = false; }
  if (!los) return out;

  const inForest = cellAt(t.x, t.y) === "f";
  let chance = hitBandChance(d);
  if (inForest) chance -= num(RULES.forestHitPenalty, 20);
  const minChance = num(RULES.minHitChance, 10);
  if (chance < minChance) chance = minChance;
  const mult = num(RULES.forestDamageMult, 0.5);
  const dmg = inForest ? Math.round(shellDmg * mult) : shellDmg;
  const myHp = num(self.hp, 100);
  const fired = underFire(state);
  const lethal = e.hp <= dmg;

  let want = false;
  const carrying = num(self.cargo, 0) >= 3;              // 带货时先落袋，不为打架押上 30+ 分
  let depBlocked = false;                                // 对方蹲在提交点上：先清路，别干等
  for (let i = 0; i < vis.length; i++) { if (onAny(DEPOSITS, vis[i].pos)) { depBlocked = true; break; } }
  if (lethal && ammo >= 1) {
    want = true;                                         // 一发带走：+20 且对方停机 3 轮
  } else if (carrying && !depBlocked) {
    want = false;
  } else if (depBlocked && d <= 4 && ammo >= 2) {
    want = true;                                         // 堵我提交点：直接开火
  } else if (e.cargo >= 3 && d <= 4 && ammo >= 2) {
    want = true;                                         // 拦下带货者（打掉就是 30+ 分净值）
  } else if (fired && d <= 3 && ammo >= 2) {
    want = true;                                         // 刚被打：一枪还手，不让对方白嫖
  } else if (d <= 2 && ammo >= 3) {
    want = true;                                         // 贴身 90%：一枪换一枪
  }
  if (!want) return out;
  // 一次只打一发：另一点 AP 留给采集/提交（采一次 30 分 >> 一发炮弹的期望收益）
  out.push({ type: "fire", target: { x: t.x, y: t.y } });
  return out;
}
// 追击条件：对方残血、我有弹药、且身上没货（不拿收入去赌）
function shouldChase(self, vis, round) {
  if (num(self.cargo, 0) > 0) return null;
  if (num(self.ammo, 0) < 3) return null;
  if (num(self.hp, 100) < 50) return null;
  if (round - KILLED_ROUND < 3) return null;   // 刚杀完先回中央收割，别追进对方半场
  let best = null;
  for (let i = 0; i < vis.length; i++) {
    const e = vis[i];
    if (e.hp > 40) continue;
    const d = cheb(self.pos, e.pos);
    if (d < 4 || d > 7) continue;
    if (!best || e.hp < best.hp) best = e;
  }
  return best;
}
// ============================ 行动组装 ============================
function walkTo(fld, pos, obj, ap, vis, acts) {
  const dirs = pathTo(fld, { x: pos.x, y: pos.y }, { x: obj.ax, y: obj.ay });
  if (!dirs || !dirs.length) return 0;
  let cur = { x: pos.x, y: pos.y };
  let moved = 0;
  for (let i = 0; i < dirs.length && moved < ap; i++) {
    let nx = cur.x, ny = cur.y;
    for (let k = 0; k < 4; k++) {
      if (DIR4[k] === dirs[i]) { nx = cur.x + DX[k]; ny = cur.y + DY[k]; break; }
    }
    if (!walkable(nx, ny)) break;
    if (enemyIndexAt(vis, nx, ny) >= 0) break;   // 敌车占位：不撞上去（撞上算无效动作）
    acts.push({ type: "move", dir: dirs[i] });
    cur = { x: nx, y: ny };
    moved += 1;
  }
  return moved;
}
function onInit(ctx) {
  try {
    W = num(MAP.width, 1);
    H = num(MAP.height, 1);
    SEAT = (ctx && num(ctx.seat, 1)) || 1;
    if (ctx && ctx.mySpawn) SPAWN = { x: num(ctx.mySpawn.x, 0), y: num(ctx.mySpawn.y, 0) };
    else if (MAP.spawns && MAP.spawns.length) SPAWN = { x: MAP.spawns[0].x, y: MAP.spawns[0].y };

    ALLNODES = []; CENTERS = []; HOMES = []; NODEBYID = {}; NODECELL = {}; NODEINFO = {};
    const raws = MAP.resourceNodes || [];
    for (let i = 0; i < raws.length; i++) {
      const n = raws[i];
      if (!n || !n.id) continue;
      const rec = {
        id: n.id, x: num(n.x, 0), y: num(n.y, 0),
        kind: n.kind === "center" ? "center" : "home",
        capacity: num(n.capacity, 6),
        initial: num(n.initial, num(n.capacity, 6)),
        regen: num(n.regenEveryRounds, 8),
      };
      ALLNODES.push(rec);
      NODEBYID[rec.id] = rec;
      NODECELL[rec.x + "," + rec.y] = rec;
      if (rec.kind === "center") CENTERS.push(rec); else HOMES.push(rec);
    }
    DEPOSITS = (MAP.depositPoints || []).slice(); FUELS = (MAP.fuelStations || []).slice(); AMMOS = (MAP.ammoDepots || []).slice();
    // 预算：每个资源点到最近提交点的步数（大图上"贴着提交点"比"离我近"更重要）
    for (let i = 0; i < ALLNODES.length; i++) ALLNODES[i].dep = 9999;
    for (let di = 0; di < DEPOSITS.length; di++) {
      const f = bfsFrom(DEPOSITS[di].x, DEPOSITS[di].y, []);
      for (let i = 0; i < ALLNODES.length; i++) { const v = distOf(f, ALLNODES[i].x, ALLNODES[i].y); if (v >= 0 && v < ALLNODES[i].dep) ALLNODES[i].dep = v; }
    }
    clearObj();
    KILLED_ROUND = -99;
    API.log("init " + META.name + " seat=" + SEAT + " spawn=" + SPAWN.x + "," + SPAWN.y +
      " nodes=" + ALLNODES.length + " deposit=" + DEPOSITS.length);
  } catch (err) {
    try { API.log("onInit error: " + (err && err.message ? err.message : err)); } catch (e2) {}
  }
}
function onTurn(state) {
  try {
    if (!state || !state.self) return [];
    const self = state.self;
    const round = num(state.round, 1);
    const pos = { x: num(self.pos && self.pos.x, SPAWN.x), y: num(self.pos && self.pos.y, SPAWN.y) };
    const cargoMax = num(self.cargoMax, RULES.cargoMax);
    const acts = [];
    let ap = num(RULES.apPerTurn, 2);

    observe(state, round);
    const vis = visibleEnemies(state, pos);
    const evs = state.events || [];
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (ev && ev.type === "death" && ev.killerSeat === SEAT) KILLED_ROUND = round;
    }

    // ---- 1) 站在提交点且带货：先落袋为安（死亡清空载货）
    if (ap > 0 && num(self.cargo, 0) > 0 && onAny(DEPOSITS, pos)) {
      acts.push({ type: "deposit" });
      ap -= 1;
      self.cargo = 0;
      API.log("deposit round=" + round);
      clearObj();
    }
    // ---- 2) 站在加油点且油量偏低：加满（AP 够就连续加）
    while (ap > 0 && onAny(FUELS, pos) && wantFuel(self)) {
      const add = Math.min(RULES.refuelPerAction, num(self.fuelMax, RULES.fuelMax) - num(self.fuel, 0));
      if (add <= 0) break;
      acts.push({ type: "refuel" });
      ap -= 1;
      self.fuel = num(self.fuel, 0) + add;
      if (OBJ && OBJ.kind === "fuel") clearObj();
    }
    // ---- 3) 站在弹药点且弹药偏低：装填
    while (ap > 0 && onAny(AMMOS, pos) && wantAmmo(self)) {
      const add = Math.min(RULES.loadAmmoPerAction, num(self.ammoMax, RULES.ammoMax) - num(self.ammo, 0));
      if (add <= 0) break;
      acts.push({ type: "loadAmmo" });
      ap -= 1;
      self.ammo = num(self.ammo, 0) + add;
      if (OBJ && OBJ.kind === "ammo") clearObj();
    }
    // ---- 4) 站在资源点上：采集（余量本地递减，避免第二个 collect 超采被判无效）
    const myNode = nodeAt(pos); let myHave = -1;
    while (ap > 0 && num(self.cargo, 0) < cargoMax && myNode) {
      if (myHave < 0) { myHave = visibleRemaining(state, myNode); if (myHave < 0) myHave = estRemaining(myNode, round); }
      if (myHave <= 0) {
        if (OBJ && OBJ.id === myNode.id) clearObj();
        break;
      }
      const take = Math.min(RULES.collectPerAction, myHave, cargoMax - num(self.cargo, 0));
      if (take <= 0) break;
      acts.push({ type: "collect" });
      ap -= 1;
      self.cargo = num(self.cargo, 0) + take;
      myHave -= take;
      NODEINFO[myNode.id] = { rem: myHave, round: round };
    }
    // ---- 5) 交火（经济动作做完后把剩余 AP 用来输出）
    const shots = planShots(state, self, pos, ap, vis);
    for (let i = 0; i < shots.length && ap > 0; i++) { acts.push(shots[i]); ap -= 1; }

    // ---- 6) 机动：选任务 -> BFS 最短路推进
    if (ap > 0) {
      let blockers = [];
      const chase = shouldChase(self, vis, round);
      for (let i = 0; i < vis.length; i++) { if (!chase || vis[i].seat !== chase.seat) blockers.push(vis[i].pos); }
      const fld = bfsFrom(pos.x, pos.y, blockers);
      let obj = null;
      if (chase) {
        obj = { kind: "chase", x: chase.pos.x, y: chase.pos.y };
        const r = resolveTarget(fld, obj.x, obj.y);
        if (r) { obj.ax = r.x; obj.ay = r.y; } else { obj = null; }
      }
      if (!obj) {
        obj = chooseObjective(state, self, pos, fld, round, vis);
        if (obj && (typeof obj.ax !== "number" || typeof obj.ay !== "number")) {
          const r = resolveTarget(fld, obj.x, obj.y);
          if (r) { obj.ax = r.x; obj.ay = r.y; } else { clearObj(); obj = null; }
        }
      }
      if (obj) {
        // 目标被敌车堵住且我已无处可去（双方互相堵门的僵局）：改去最近可达资源点，别原地僵住
        if (obj.ax === pos.x && obj.ay === pos.y && (obj.x !== pos.x || obj.y !== pos.y)) {
          const rm = nearest(ALLNODES, fld, pos);
          if (rm && (rm.pt.x !== pos.x || rm.pt.y !== pos.y)) {
            obj = { kind: "node", id: rm.pt.id, x: rm.pt.x, y: rm.pt.y, ax: rm.pt.x, ay: rm.pt.y };
          }
        }
        walkTo(fld, pos, obj, ap, vis, acts);
      }
    }

    if (!acts.length) return [{ type: "wait" }];
    return acts.slice(0, num(RULES.apPerTurn, 2));
  } catch (err) {
    try { API.log("onTurn error: " + (err && err.message ? err.message : err)); } catch (e2) {}
    return [];
  }
}