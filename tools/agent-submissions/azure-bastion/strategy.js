// =======================================================================
// 青甲·磐石 (Azure Bastion) —— 稳健防守流 · 1v1（协议 p1.0 / ruleset-1.1）
// 坐标与数值全部来自 MAP / RULES / state，不写死；1v1 与多人局通用。
// 打法：① 开局先把油/弹补到安全线；② 守自家近端资源点与必经的提交点，不主动深入敌方半场；
// ③ 只在“看得见 + 有视线 + 有弹药 +（血量占优 / 被攻击过 / 贴身自保 / 林木掩体）”时开火，
// 否则退回掩体、守住一个资源点吃满回充等对方撞上来：一趟满载 ≈ cargoMax × 每单位分数，
// 死亡要扣分 + 停机 + 清货，所以“活着持续产出”优先于赌博式对枪。
// =======================================================================

const META = {
  name: "青甲·磐石",
  style: "defensive",
  note: "稳健防守：先补油弹再产出，守自家资源点与必经提交点，只在占优或自保时开火",
};

const DIRS = ["N", "E", "S", "W"], DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

// ---------------- 模块级记忆（整场比赛持续存在） ----------------
let READY = false;                 // 世界是否已初始化
let MY = { seat: 1, spawn: { x: 0, y: 0 } };
let GW = 0, GH = 0, FIELDS_OK = false;
let NODES = [];                    // 资源点 {id,x,y,cap,regen,tier,dDepot}
let DEPOSITS = [], FUELS = [], AMMOS = [];
let F_SPAWN = null, F_DEPOT = null, F_FUEL = null, F_AMMO = null;   // 静态距离场
let mission = null;                // 当前任务 {kind,x,y,id,created}
let blocked = {};                  // "kind:x,y" -> 失效到第几轮
let hostileUntil = {};             // seat -> 最后攻击我们的轮次
let lastFoeRound = -999, lastDeaths = -1, lastRound = -999, movedLastTurn = false, stuck = 0;
let lastPos = null, bootDone = false, memoRound = -999, memoF = null, lastEvade = -99;
let nodeMemo = {};                 // id -> {s: 最近一次看到的余量, r: 轮次}（看不见时按回充速率外推）
let campId = null;                 // 当前蹲守的资源点 id（稳健防守的核心：守住一个点吃满回充）

// ---------------- 通用小工具 ----------------
function logIt(msg) { try { API.log("[磐石] " + msg); } catch (e) { /* 忽略 */ } }
function isNum(v) { return typeof v === "number" && v === v && v !== Infinity && v !== -Infinity; }
function num(v, d) { return isNum(v) ? v : d; }
function clampN(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function arr(v) { return Object.prototype.toString.call(v) === "[object Array]" ? v : []; }
function cellOf(p) { return { x: num(p && p.x, 0), y: num(p && p.y, 0) }; }
function eq(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y; }
function distTo(field, p, from) { const d = fieldAt(field, p); return d >= 0 ? d : cheb(from, p); }
function cheb(a, b) {
  if (!a || !b) return 99;
  const dx = Math.abs(num(a.x, 0) - num(b.x, 0)), dy = Math.abs(num(a.y, 0) - num(b.y, 0));
  return dx > dy ? dx : dy;
}
function inMap(p) { return !!p && p.x >= 0 && p.y >= 0 && p.x < GW && p.y < GH; }
function isBlocked(kind, t, round) { return round < num(blocked[kind + ":" + t.x + "," + t.y], -1); }
function blockTarget(kind, t, round) { if (t) blocked[kind + ":" + t.x + "," + t.y] = round + 14; }

// 通行性只用地图地形判断（墙/水阻挡；其它坦克另外单独判）
function walkable(x, y) {
  if (x < 0 || y < 0 || x >= GW || y >= GH) return false;
  const row = arr(MAP && MAP.grid)[y];
  if (typeof row !== "string") return false;
  const c = row.charAt(x);
  return c !== "#" && c !== "~" && c !== "";
}

// 多源 BFS：每格到最近源点的步数（-1 不可达）
function bfs(sources) {
  const n = GW * GH, dist = new Array(n), q = [];
  for (let i = 0; i < n; i++) dist[i] = -1;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!inMap(s) || !walkable(s.x, s.y)) continue;
    const idx = s.y * GW + s.x;
    if (dist[idx] === 0) continue;
    dist[idx] = 0; q.push(idx);
  }
  let head = 0;
  while (head < q.length) {
    const cur = q[head]; head += 1;
    const cx = cur % GW, cy = (cur - cx) / GW, d = dist[cur];
    for (let k = 0; k < 4; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const ni = ny * GW + nx;
      if (dist[ni] !== -1 || !walkable(nx, ny)) continue;
      dist[ni] = d + 1; q.push(ni);
    }
  }
  return dist;
}
function fieldAt(field, p) {
  if (!field || !inMap(p)) return -1;
  return isNum(field[p.y * GW + p.x]) ? field[p.y * GW + p.x] : -1;
}
function fieldHere(pos, round) {                       // 本回合以自身为起点的距离场
  if (memoRound === round && memoF) return memoF;
  memoRound = round; memoF = FIELDS_OK ? bfs([pos]) : null;
  return memoF;
}
function stepsFromHere(pos, t, round) { return distTo(fieldHere(pos, round), t, pos); }
function stepsDepot(p) { return distTo(F_DEPOT, p, { x: Math.floor(GW / 2), y: Math.floor(GH / 2) }); }
function toPosList(raw) {
  const out = [], list = arr(raw);
  for (let i = 0; i < list.length; i++) { const p = cellOf(list[i]); if (inMap(p)) out.push(p); }
  return out;
}

// ---------------- 世界初始化（onInit） ----------------
function initWorld(spawnOverride, playerCount) {
  GW = Math.max(0, Math.floor(num(MAP && MAP.width, 0)));
  GH = Math.max(0, Math.floor(num(MAP && MAP.height, 0)));
  if (GW < 3 || GH < 3) { READY = false; return; }
  FIELDS_OK = GW * GH <= 60000;
  let s = spawnOverride && inMap(spawnOverride) ? spawnOverride : null;
  if (!s) { const sps = arr(MAP.spawns); if (sps.length > 0) s = cellOf(sps[0]); }
  if (!s || !inMap(s)) s = { x: 1, y: 1 };
  MY.spawn = s;
  DEPOSITS = toPosList(MAP.depositPoints);
  FUELS = toPosList(MAP.fuelStations);
  AMMOS = toPosList(MAP.ammoDepots);
  F_SPAWN = FIELDS_OK ? bfs([MY.spawn]) : null;
  F_DEPOT = FIELDS_OK ? bfs(DEPOSITS) : null;
  F_FUEL = FIELDS_OK ? bfs(FUELS) : null;
  F_AMMO = FIELDS_OK ? bfs(AMMOS) : null;
  // 判断资源点是“自家近端 / 中立 / 敌方半场”。关键：只能把**本局实际参战**的出生点当敌人
  // —— 1v1 必须按地图声明的 spawnsFor1v1 取，否则没用上的空出生点会把中央误判成敌区。
  const spawns = arr(MAP.spawns);
  let myIdx = -1;
  for (let i = 0; i < spawns.length; i++) if (eq(cellOf(spawns[i]), MY.spawn)) { myIdx = i; break; }
  const f1v1 = arr(MAP.spawnsFor1v1);
  const pc = Math.floor(num(playerCount, 0));
  const duel = (pc === 2 || pc === 0) && f1v1.length === 2 && myIdx >= 0
    && (f1v1[0] - 1 === myIdx || f1v1[1] - 1 === myIdx);
  const useIdx = [];
  if (duel) {
    for (let i = 0; i < f1v1.length; i++) if (f1v1[i] - 1 !== myIdx) useIdx.push(f1v1[i] - 1);
  } else {
    for (let i = 0; i < spawns.length; i++) if (i !== myIdx) useIdx.push(i);
  }
  const foeSpawns = [], foeFields = [];
  for (let i = 0; i < useIdx.length; i++) {
    const p = cellOf(spawns[useIdx[i]]);
    if (!inMap(p) || eq(p, MY.spawn)) continue;
    foeSpawns.push(p);
    foeFields.push(FIELDS_OK ? bfs([p]) : null);
  }
  NODES = [];
  const nodes = arr(MAP.resourceNodes);
  for (let i = 0; i < nodes.length; i++) {
    const raw = nodes[i], p = cellOf(raw);
    if (!inMap(p)) continue;
    const dS = distTo(F_SPAWN, p, MY.spawn);
    let dF = 9999;
    for (let k = 0; k < foeFields.length; k++) dF = Math.min(dF, distTo(foeFields[k], p, foeSpawns[k]));
    let tier = 1;
    if (dF < 9000) { if (dS + 2 <= dF) tier = 0; else if (dF + 2 <= dS) tier = 2; }
    NODES.push({
      id: typeof raw.id === "string" ? raw.id : "n" + i, x: p.x, y: p.y, tier: tier,
      cap: Math.max(1, Math.floor(num(raw.capacity, num(raw.initial, 4)))),
      regen: Math.max(1, Math.floor(num(raw.regenEveryRounds, 8))),
      dDepot: stepsDepot(p),
    });
  }
  READY = true;
  logIt("init seat=" + MY.seat + " spawn=" + MY.spawn.x + "," + MY.spawn.y + " nodes=" + NODES.length);
}

function onInit(ctx) {
  try {
    READY = false;
    MY = { seat: num(ctx && ctx.seat, 1), spawn: { x: 0, y: 0 } };
    mission = null; blocked = {}; hostileUntil = {}; campId = null;
    lastFoeRound = -999; lastDeaths = -1; lastPos = null; lastRound = -999;
    movedLastTurn = false; stuck = 0; bootDone = false; memoRound = -999; memoF = null; lastEvade = -99; campId = null;
    initWorld(ctx && ctx.mySpawn ? cellOf(ctx.mySpawn) : null, num(ctx && ctx.playerCount, 2));
  } catch (e) { READY = false; }
}

// ---------------- 状态读取（字段缺失/类型异常一律兜底） ----------------
function nodeViewAt(state, p) {
  const list = arr(state && state.resourceNodes);
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v && cellOf(v).x === p.x && cellOf(v).y === p.y) return v;
  }
  return null;
}
function nodeViewById(state, id) {
  if (typeof id !== "string") return null;
  const list = arr(state && state.resourceNodes);
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
  return null;
}
// 可见余量：数字=已知；null/缺失=未知（按“可能还有货”处理）
function nodeStock(state, n) {
  const v = nodeViewById(state, n.id);
  return v && isNum(v.remaining) ? v.remaining : null;
}
// 估算余量：看得见就用真值并记进备忘；看不见就按备忘 + 回充外推；从没见过则乐观估一趟满载
function estimateStock(state, n, round) {
  const v = nodeViewById(state, n.id);
  if (v && isNum(v.remaining)) {
    nodeMemo[n.id] = { s: v.remaining, r: round };
    return v.remaining;
  }
  const m = nodeMemo[n.id];
  if (m && isNum(m.s)) {
    const grew = Math.floor(Math.max(0, round - num(m.r, round)) / n.regen);
    return Math.min(n.cap, m.s + grew);
  }
  return Math.min(n.cap, Math.max(1, num(RULES.cargoMax, 5)));
}

// ---------------- 威胁与敌情记忆 ----------------
function scanFoes(state, round) {
  const self = state.self, me = cellOf(self.pos), vis = [], raw = arr(state.enemies);
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || !e.pos) continue;
    const ep = cellOf(e.pos);
    if (!inMap(ep)) continue;
    vis.push({ seat: num(e.seat, 0), pos: ep, hp: num(e.hp, 100), cargo: num(e.cargo, 0), dist: cheb(me, ep) });
  }
  vis.sort(function (a, b) { return a.dist - b.dist; });
  const risk = [];
  for (let i = 0; i < vis.length; i++) risk.push({ x: vis[i].pos.x, y: vis[i].pos.y, w: 1.15 });
  const mem = arr(state.lastKnownEnemies);
  for (let i = 0; i < mem.length; i++) {
    const m = mem[i];
    if (!m || !m.pos) continue;
    const mp = cellOf(m.pos);
    if (!inMap(mp)) continue;
    const age = round - num(m.seenRound, round);
    if (age > num(RULES.lastKnownMemoryRounds, 12)) continue;
    let dup = false;
    for (let k = 0; k < vis.length; k++) if (vis[k].seat === num(m.seat, -1)) { dup = true; break; }
    if (dup) continue;
    risk.push({ x: mp.x, y: mp.y, w: age <= 4 ? 0.6 : 0.25 });
  }
  if (vis.length > 0) lastFoeRound = round;
  // 记仇：事件队列是按座位私发的，"by 不是自己"的 miss 就是别人在打我
  const mySeat = num(self.seat, -2);
  let attacked = false;
  const evs = arr(state.events);
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (!ev || typeof ev.type !== "string") continue;
    const by = num(ev.by, -1);
    if (ev.type === "hit" && num(ev.targetSeat, -1) === mySeat) { hostileUntil[by] = round; attacked = true; }
    else if (ev.type === "miss" && by >= 0 && by !== mySeat) { hostileUntil[by] = round; attacked = true; }
  }
  let grudge = attacked;
  for (const k in hostileUntil) if (round - num(hostileUntil[k], -999) <= num(RULES.lastKnownMemoryRounds, 12)) grudge = true;
  return { vis: vis, nearest: vis.length ? vis[0] : null, risk: risk, attacked: attacked, grudge: grudge };
}

// 脱离接触：本游戏没有修理，带伤就永久带伤，“带伤长期避战”等于把资源点白送对手
// （对手复活即满血）；所以只在“贴身且被打残”时短暂脱离，且带冷却。
function assess(foes, st) {
  const e = foes.nearest; let forced = false, reason = "";
  if (e && st.round - num(lastEvade, -99) > 8) {
    const behind = e.hp - st.hp;
    if (e.dist <= 2 && behind >= 40) { forced = true; reason = "重伤脱离"; }
    else if (e.dist <= 1 && st.hp <= 25) { forced = true; reason = "残血脱离"; }
  }
  const worried = !!e && (e.hp >= st.hp + 20 || st.hp <= Math.round(st.hpMax * 0.6));
  return { forced: forced, reason: reason, worried: worried, e: e };
}

// ---------------- 机动 ----------------
function occupiedByVisible(p, foes) {
  for (let i = 0; i < foes.vis.length; i++) if (eq(foes.vis[i].pos, p)) return true;
  return false;
}
// 沿 A* 路径走最多 budget 步；每步自查地形与可见占位，绝不发出注定无效的 move
function movesToward(state, pos, target, budget, foes) {
  const out = [];
  if (!target || budget <= 0 || eq(pos, target)) return out;
  let path = null;
  try { path = API.pathFind(pos, { x: target.x, y: target.y }, { avoidUnits: true, maxNodes: 4000 }); }
  catch (e1) { path = null; }
  if (!path || !path.length) {
    try { path = API.pathFind(pos, { x: target.x, y: target.y }, { avoidUnits: false, maxNodes: 4000 }); }
    catch (e2) { path = null; }
  }
  const dirs = arr(path), cur = { x: pos.x, y: pos.y };
  for (let i = 0; i < dirs.length && out.length < budget; i++) {
    if (DIRS.indexOf(dirs[i]) < 0) break;
    let nx = null;
    try { nx = cellOf(API.step(cur, dirs[i])); } catch (e3) { nx = null; }
    if (!nx || !inMap(nx) || !walkable(nx.x, nx.y) || occupiedByVisible(nx, foes)) break;
    out.push(dirs[i]); cur.x = nx.x; cur.y = nx.y;
  }
  return out;
}
// 脱离接触：远离敌人，优先林木掩体与自家半场，避免钻进死胡同
function evadeMoves(pos, ap, foes) {
  const e = foes.nearest, out = [];
  if (!e) return out;
  const cur = { x: pos.x, y: pos.y };
  for (let step = 0; step < ap; step++) {
    let best = null, bestScore = -1e9;
    for (let k = 0; k < 4; k++) {
      const nx = cur.x + DX[k], ny = cur.y + DY[k];
      if (!walkable(nx, ny)) continue;
      const np = { x: nx, y: ny };
      if (occupiedByVisible(np, foes)) continue;
      const before = cheb(cur, e.pos), after = cheb(np, e.pos);
      let sc = (after - before) * 10;
      if (after >= num(RULES.visionRadius, 6) + 1) sc += 6;
      let forest = false;
      try { forest = API.isForest(nx, ny); } catch (e1) { forest = false; }
      if (forest) sc += 9;
      const hb = fieldAt(F_SPAWN, cur), ha = fieldAt(F_SPAWN, np);
      if (ha >= 0 && hb >= 0 && ha < hb) sc += 3;
      let exits = 0;
      for (let q = 0; q < 4; q++) if (walkable(nx + DX[q], ny + DY[q])) exits += 1;
      sc += exits * 1.5;
      if (sc > bestScore) { bestScore = sc; best = np; }
    }
    if (!best || bestScore < -60) break;
    let d = null;
    try { d = API.dirTo(cur, best); } catch (e2) { d = null; }
    if (!d || DIRS.indexOf(d) < 0) break;
    out.push(d); cur.x = best.x; cur.y = best.y;
  }
  return out;
}

// ---------------- 目标选择 ----------------
// 风险折算成“分/回合”的扣减，跟资源点的收益同一个量纲
function riskPenalty(score, pos, foes) {
  let sc = score;
  for (let i = 0; i < foes.risk.length; i++) {
    const d = cheb(foes.risk[i], pos), w = foes.risk[i].w;
    if (d <= 1) sc -= 12 * w;
    else if (d <= 3) sc -= 0.6 * w;
    else if (d <= 6) sc -= (7 - d) * 0.15 * w;
  }
  return sc;
}
function bestDeposit(pos, foes, st) {
  let best = null, bestScore = -1e9;
  for (let i = 0; i < DEPOSITS.length; i++) {
    const d = DEPOSITS[i];
    const sc = riskPenalty(100 - stepsFromHere(pos, d, st.round) * 3, d, foes);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  return best;
}
function bestFacility(list, pos, foes, st) {
  let best = null, bestScore = -1e9;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const sc = riskPenalty(40 - stepsFromHere(pos, f, st.round) * 3, f, foes);
    if (sc > bestScore) { bestScore = sc; best = f; }
  }
  return best;
}
// 资源点打分：折算成“分/回合”的产出速率，再减去敌情风险。
// 速率 = 一趟收益 / 这一趟要花几个回合（赶路 + 采集 + 提交），因此贴着提交点的
// 中央资源点天然占优；自家近端加成，敌方半场几乎不去。
function bestNode(state, pos, foes, st, allowEmpty) {
  let best = null, bestScore = -1e9;
  for (let i = 0; i < NODES.length; i++) {
    const n = NODES[i];
    if (isBlocked("node", n, st.round)) continue;
    const est = estimateStock(state, n, st.round);
    if (est <= 0 && !allowEmpty) continue;
    const dGo = stepsFromHere(pos, n, st.round);
    // 长期产出由回充速率决定（中央点 5 分/回合，前哨 1.25 分/回合），现存余量算一笔“存量红利”；
    // 守点是长跑，赶路代价只做轻量折算。
    const lasting = st.depositScore / n.regen;
    const stockNow = est > 0 ? Math.min(est, n.cap) : 0;
    let rate = lasting + (stockNow * st.depositScore) / 40 - dGo * 0.2;
    if (n.tier === 0) rate += 0.8;                        // 自家近端：稳健防守的默认产区
    if (n.tier === 2) rate -= 40;                         // 敌方半场：非必要不深入
    rate = riskPenalty(rate, n, foes);
    if (rate > bestScore) { bestScore = rate; best = n; }
  }
  return best;
}

// 找一个 id 对应的资源点定义
function nodeById(id) {
  for (let i = 0; i < NODES.length; i++) if (NODES[i].id === id) return NODES[i];
  return null;
}
// 蹲守点：守住一个点把回充吃干榨净（中央点紧贴提交点，收益/风险比最好）；只有当前点
// 空着且别处明显有货/更近时才挪窝 —— 频繁换点会把回充白白浪费。
function chooseNodeTarget(state, pos, foes, st) {
  const cur = campId ? nodeById(campId) : null;
  const curOk = cur && !isBlocked("node", cur, st.round);
  const curEst = curOk ? estimateStock(state, cur, st.round) : -1;
  const curDist = curOk ? stepsFromHere(pos, cur, st.round) : 99;
  if (curOk && curEst > 0 && curDist <= 3) {
    // 守在点上：只有别处“明显有货且很近”才换（例如邻近点刚被对手喂满）
    const alt = bestNode(state, pos, foes, st, false);
    if (!alt || alt.id === cur.id) return cur;
    const altEst = estimateStock(state, alt, st.round);
    const altDist = stepsFromHere(pos, alt, st.round);
    if (altEst >= 4 && altDist <= 2 && curEst <= 0) return alt;
    return cur;
  }
  const best = bestNode(state, pos, foes, st, false) || bestNode(state, pos, foes, st, true);
  if (best) return best;
  return cur;
}

// ---------------- 任务调度 ----------------
// 维持机动所需的最低油量：够走到最近的加油站 + 一点点余量
function fuelWant(pos, foes, st) {
  const fSt = bestFacility(FUELS, pos, foes, st);
  if (!fSt) return 0;
  const dF = stepsFromHere(pos, fSt, st.round);
  const back = distTo(F_FUEL, fSt, fSt);
  return (dF + (back >= 0 ? back : dF)) * st.fuelCost + 8;
}

function invalidate(state, pos, st, foes) {
  if (!mission) return;
  if (st.round - num(mission.created, st.round) > 40) { mission = null; return; }
  if (stuck >= 2) { stuck = 0; blockTarget(mission.kind, mission, st.round); mission = null; return; }
  // 燃油安全线优先于任何“去干活”的任务（否则会在半路烧光油、被迫应急移动扣分）
  if (mission.kind !== "fuel" && st.fuel < fuelWant(pos, foes, st)) { mission = null; return; }
  if (mission.kind === "node") {
    if (st.cargo >= st.cargoMax) { mission = null; return; }
    const stock = nodeStock(state, { id: mission.id });
    if (stock !== null && stock <= 0) {
      if (!eq(pos, mission)) { mission = null; return; }
      // 站在空点上：只有对手贴上来才撤（蹲守等回充本身是有收益的）
      if (foes.nearest && foes.nearest.dist <= 2 && foes.nearest.hp >= st.hp + 30) { mission = null; return; }
    }
  } else if (mission.kind === "deposit") {
    if (st.cargo <= 0) { mission = null; return; }
    if (st.round - num(mission.created, st.round) > 10) { mission = null; return; }   // 长期到不了就重选
  } else if (mission.kind === "fuel") {
    if (st.fuel > st.fuelMax - 20) { mission = null; return; }
  } else if (mission.kind === "ammo") {
    if (st.ammo > Math.min(st.ammoMax, 8)) { mission = null; return; }
  }
  // 被强敌逼近：正在去的目标若贴着敌人，放弃并改退守
  if (mission && foes.forced && (mission.kind === "node" || mission.kind === "deposit")
    && foes.nearest && cheb(mission, foes.nearest.pos) <= 3) mission = null;
}

function chooseMission(state, pos, foes, st) {
  const dep = bestDeposit(pos, foes, st);
  const depOk = dep && !isBlocked("deposit", dep, st.round);
  const depDist = dep ? stepsFromHere(pos, dep, st.round) : 99;
  // 1) 提交点就在脚边且身上有货：先落袋为安（1 步换一趟收益）
  if (st.cargo > 0 && depOk && depDist <= 1)
    return { kind: "deposit", x: dep.x, y: dep.y, id: "dep", created: st.round };
  // 2) 燃油安全线：没油会被迫应急移动扣分，比任何一趟活都优先（满载也一样）
  const fSt = bestFacility(FUELS, pos, foes, st);
  if (fSt && !isBlocked("fuel", fSt, st.round)) {
    if (st.fuel < (bootDone ? fuelWant(pos, foes, st) : st.fuelMax * 0.55))
      return { kind: "fuel", x: fSt.x, y: fSt.y, id: "fuel", created: st.round };
  }
  // 3) 提交：满载必交；带 3 单位且顺路也交；被打退时先落袋
  if (st.cargo > 0 && depOk) {
    if (st.cargo >= st.cargoMax || (st.cargo >= 3 && depDist <= 3) || (foes.forced && depDist <= 4))
      return { kind: "deposit", x: dep.x, y: dep.y, id: "dep", created: st.round };
  }
  // 4) 弹药：见底必补；有敌情时提早；开局顺手补到安全线
  const aSt = bestFacility(AMMOS, pos, foes, st);
  if (aSt) {
    const dA = stepsFromHere(pos, aSt, st.round);
    const urgent = st.ammo <= 2, wary = st.ammo <= 5 && (foes.recent || !!foes.nearest);
    const bootUp = !bootDone && st.ammo <= Math.max(6, st.ammoInit) && dA <= 3;
    if ((st.ammo <= 1 || bootUp) && !isBlocked("ammo", aSt, st.round))
      return { kind: "ammo", x: aSt.x, y: aSt.y, id: "ammo", created: st.round };
  }
  // 5) 采集：守住蹲守点吃回充；实在没得守才换点或回家
  const n = chooseNodeTarget(state, pos, foes, st);
  if (n) { campId = n.id; return { kind: "node", x: n.x, y: n.y, id: n.id, created: st.round }; }
  // 6) 兜底：回出生点附近待机
  return { kind: "home", x: MY.spawn.x, y: MY.spawn.y, id: "home", created: st.round };
}

// ---------------- 开火判定（稳健：占优或自保才打） ----------------
function decideFire(pos, foes, st, ap) {
  const shots = [], e = foes.nearest;
  if (!e || ap <= 0 || st.ammo <= 0 || e.dist < 1 || e.dist > num(RULES.fireRange, 8)) return shots;
  let los = false, myForest = false, foeForest = false;
  try { los = API.hasLOS(pos, e.pos); } catch (e1) { los = false; }
  if (!los) return shots;                              // 无视线：打出去只会浪费弹药
  try { myForest = API.isForest(pos.x, pos.y); foeForest = API.isForest(e.pos.x, e.pos.y); }
  catch (e2) { myForest = false; foeForest = false; }
  const d = e.dist;
  const hpEdge = st.hp >= e.hp + 10;                                   // 血量占优
  const finish = e.hp <= num(RULES.shellDamage, 20) * 2;                // 对方已残：收人头
  const pointBlank = e.dist <= 2;                                      // 贴身：必须自保
  const grudge = foes.grudge;                                          // 被攻击过：自卫反击
  const coverTrade = myForest && !foeForest && st.hp >= e.hp && e.dist <= 4;  // 掩体下的公平交换
  const worth = pointBlank || (hpEdge && d <= 4) || (grudge && d <= 3) || (finish && d <= 4) || (coverTrade && d <= 4);
  if (!worth) return shots;
  shots.push({ type: "fire", target: { x: e.pos.x, y: e.pos.y } });
  if (ap >= 2 && st.ammo >= 2 && e.hp <= num(RULES.shellDamage, 20) && (hpEdge || pointBlank || grudge))
    shots.push({ type: "fire", target: { x: e.pos.x, y: e.pos.y } });  // 残血补枪拿击杀
  return shots;
}

// ---------------- 每回合决策 ----------------
function onTurn(state) {
  try {
    if (!state || !state.self || !state.self.pos) return [{ type: "wait" }];
    const self = state.self, pos = cellOf(self.pos);
    if (!READY) {
      // onInit 没被调用（或当时失败）时的兜底初始化：优先自己的出生点，其次当前位置
      let seed = null;
      if (self.spawn) { const sp = cellOf(self.spawn); if (inMap(sp) && walkable(sp.x, sp.y)) seed = sp; }
      if (!seed && inMap(pos) && walkable(pos.x, pos.y)) seed = cellOf(pos);
      initWorld(seed, 2);
    }
    if (!READY || !inMap(pos)) return [{ type: "wait" }];
    const round = Math.max(1, Math.floor(num(state.round, 1)));
    const st = {
      round: round,
      hp: clampN(num(self.hp, 100), 0, num(self.hpMax, 100)),
      hpMax: Math.max(1, num(self.hpMax, 100)),
      ammoMax: Math.max(1, num(self.ammoMax, num(RULES.ammoMax, 20))),
      ammoInit: Math.max(0, Math.floor(num(RULES.initial && RULES.initial.ammo, 6))),
      fuelMax: Math.max(1, num(self.fuelMax, num(RULES.fuelMax, 100))),
      cargoMax: Math.max(1, num(self.cargoMax, num(RULES.cargoMax, 5))),
      fuelCost: Math.max(0, num(RULES.moveFuelCost, 2)),
      depositScore: num(RULES.depositScorePerUnit, 10),
      collectPerAction: Math.max(1, num(RULES.collectPerAction, 3)),
      cargo: 0, ammo: 0, fuel: 0,
    };
    let cargo = clampN(num(self.cargo, 0), 0, st.cargoMax), ammo = clampN(num(self.ammo, 0), 0, st.ammoMax);
    let fuel = clampN(num(self.fuel, 0), 0, st.fuelMax), stockLeft = null;   // stockLeft：本回合站在资源点上的本地余量
    st.cargo = cargo; st.ammo = ammo; st.fuel = fuel;
    const deaths = num(self.deaths, 0);
    if (lastDeaths >= 0 && deaths > lastDeaths) { mission = null; blocked = {}; stuck = 0; }  // 复活后重来
    lastDeaths = deaths;
    // 卡死检测：上一回合发了 move 却原地没动
    if (lastPos && lastRound === round - 1 && movedLastTurn && eq(lastPos, pos)) stuck += 1; else stuck = 0;
    lastPos = cellOf(pos); lastRound = round; movedLastTurn = false;
    const foes = scanFoes(state, round), threat = assess(foes, st), acts = [];
    let ap = Math.max(0, Math.floor(num(RULES.apPerTurn, 2)));
    if (ap <= 0) return [{ type: "wait" }];
    // ---- A. 就地设施动作（同格优先，别把 AP 浪费在来回走上） ----
    if (cargo > 0 && API.isDeposit(pos.x, pos.y)) { acts.push({ type: "deposit" }); ap -= 1; cargo = 0; mission = null; }
    while (ap > 0 && cargo < st.cargoMax && API.isResource(pos.x, pos.y)) {
      const view = nodeViewAt(state, pos);
      let stock = view && isNum(view.remaining) ? view.remaining : 1;
      if (isNum(stockLeft)) stock = Math.min(stock, stockLeft);   // 扣掉本回合已经采走的部分
      if (stock <= 0) break;                       // 采空：交给任务层换点，不原地等回复
      const take = Math.min(num(RULES.collectPerAction, 3), stock, st.cargoMax - cargo);
      if (take <= 0) break;
      acts.push({ type: "collect" }); ap -= 1; cargo += take;
      stockLeft = isNum(stockLeft) ? stockLeft - take : stock - take;
    }
    if (ap > 0 && API.isFuel(pos.x, pos.y) && fuel <= st.fuelMax - 20) {
      acts.push({ type: "refuel" }); ap -= 1;      // 油便宜：站在加油点上就补
      fuel += Math.min(num(RULES.refuelPerAction, 30), st.fuelMax - fuel);
    }
    if (ap > 0 && API.isAmmo(pos.x, pos.y) && ammo <= 6 && ammo < st.ammoMax) {
      acts.push({ type: "loadAmmo" }); ap -= 1; ammo += Math.min(num(RULES.loadAmmoPerAction, 6), st.ammoMax - ammo);
    }
    st.cargo = cargo; st.ammo = ammo; st.fuel = fuel;
    if (!bootDone && (round > 14 || (fuel >= st.fuelMax * 0.55 && ammo >= Math.max(6, st.ammoInit)))) bootDone = true;
    // ---- B. 开火（占优或自保才打） ----
    const shots = decideFire(pos, foes, st, ap);
    for (let i = 0; i < shots.length && ap > 0; i++) { acts.push(shots[i]); ap -= 1; ammo -= 1; }
    st.ammo = ammo;
    // ---- C. 机动：先脱战，再按任务推进 ----
    if (ap > 0) {
      let moves = [];
      if (threat.forced) {
        moves = evadeMoves(pos, ap, foes);
        if (moves.length) { lastEvade = round; logIt("R" + round + " 脱战:" + threat.reason); }
      }
      if (!moves.length) {
        invalidate(state, pos, st, foes);
        if (!mission) { mission = chooseMission(state, pos, foes, st); }
        if (mission) {
          if (eq(pos, mission)) {
            // 已站在目标格上：资源点就地收涓流；设施点说明没活了 → 下回合重选
            if (mission.kind !== "node") mission = null;
          } else {
            moves = movesToward(state, pos, mission, ap, foes);
            if (!moves.length) {
              if (mission.kind !== "deposit") blockTarget(mission.kind, mission, round);
              if (mission.kind === "node") {
                const alt = bestNode(state, pos, foes, st, true);
                if (alt && !eq(alt, mission)) {
                  const altMoves = movesToward(state, pos, alt, ap, foes);
                  if (altMoves.length) { moves = altMoves; mission = { kind: "node", x: alt.x, y: alt.y, id: alt.id, created: round }; }
                }
              }
              if (!moves.length && mission.kind !== "deposit") mission = null;
            }
          }
        }
      }
      for (let i = 0; i < moves.length && ap > 0; i++) { acts.push({ type: "move", dir: moves[i] }); ap -= 1; movedLastTurn = true; }
    }
    if (!acts.length) return [{ type: "wait" }];
    return acts.slice(0, Math.max(1, Math.floor(num(RULES.apPerTurn, 2))));
  } catch (err) {
    try { API.log("onTurn 异常: " + (err && err.message ? err.message : err)); } catch (e2) { /* 忽略 */ }
    return [];
  }
}