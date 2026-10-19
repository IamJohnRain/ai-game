// =============================================================================
// 银翼·游猎 —— 机动伏击流（脚本协议 p1.0 / ruleset 1.1）
// 这是得分游戏，不是歼灭游戏：收入 = 提交资源 + 击杀奖励，支出 = 补给与阵亡。
// 状态机：SUPPLY(弹油后勤) -> GATHER(资源循环) -> STRIKE(有利交火) -> PULLOUT(带伤脱离)
// 交火原则：只在"交换比占优/必杀/对方载货"时开火；站森林吃半伤、用掩体换命中；
//           得手或血量落后立刻脱离，绝不为了人头送命。
// 只使用 MAP / RULES / API 与标准 JSON / Math / 数组 / 字符串；
// 所有坐标与数值均从 ctx.map / 全局 MAP / RULES 派生，绝不写死。
// =============================================================================

const META = {
  name: "银翼·游猎",
  style: "skirmisher",
  note: "机动伏击：掩体接近、快采快交；有利才开火、得手即脱离，绝不无谓阵亡",
};

// ----------------------------------------------------------------- 常量与状态
const DIRS = ["N", "E", "S", "W"];
let READY = false;
let SEAT = 1;
let SPAWN = { x: 1, y: 1 };
let NODES = [];        // {id,x,y,kind,capacity,dep}  dep=到最近提交点的步数（预计算）
let DEPOSITS = [];     // 提交点
let FUELS = [];        // 加油点
let AMMOS = [];        // 弹药点
let MEM = {};          // 敌人记忆（视野内 + 引擎 lastKnown）
let GOAL = null;       // 当前任务 {kind,x,y,id}
let CLAIM = null;      // 采集点粘性 id
let PREV = null;       // 上一回合起点（防抖）
let STAND = 0;         // 连续原地回合数（解卡）
let ROUND = 0;         // 本轮轮次
let ENEMY_HINT = null; // 对手大致所在方向（无情报时用"最远出生点"兜底）
let COVER = null;      // 本回合已选定的掩体（走完它，别半路折返）

// ----------------------------------------------------------------- 基础工具
function num(v, d) { return typeof v === "number" && v - v === 0 ? v : d; }
function rule(name, d) {
  const v = RULES ? RULES[name] : undefined;
  return typeof v === "number" && v - v === 0 ? v : d;
}
function cheb(a, b) { return (!a || !b) ? 999 : Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
function same(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y; }

function terrainAt(x, y) {
  if (x < 0 || y < 0 || !MAP || x >= MAP.width || y >= MAP.height) return "#";
  const row = MAP.grid ? MAP.grid[y] : null;
  const c = row ? row[x] : "#";
  return typeof c === "string" ? c : "#";
}
function walkChar(c) {
  return c === "." || c === "f" || c === "S" || c === "B" || c === "A" || c === "G" || c === "R" || c === "D";
}
function isForest(x, y) { return terrainAt(x, y) === "f"; }
function stepFrom(p, dir) {
  if (dir === "N") return { x: p.x, y: p.y - 1 };
  if (dir === "S") return { x: p.x, y: p.y + 1 };
  if (dir === "E") return { x: p.x + 1, y: p.y };
  if (dir === "W") return { x: p.x - 1, y: p.y };
  return { x: p.x, y: p.y };
}
function safeLOS(a, b) {
  if (!a || !b) return false;
  try { return API.hasLOS({ x: a.x, y: a.y }, { x: b.x, y: b.y }) === true; } catch (e) { return false; }
}
function readPts(list) {
  const out = [];
  const arr = list || [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (p && typeof p.x === "number" && typeof p.y === "number") out.push({ x: p.x, y: p.y });
  }
  return out;
}
function nearestPos(list, from) {
  let best = null, bd = 1e9;
  const arr = list || [];
  for (let i = 0; i < arr.length; i++) {
    const d = cheb(from, arr[i]);
    if (d < bd) { bd = d; best = arr[i]; }
  }
  return best;
}
// 对手大致方位：可见 > 新鲜记忆 > 最远出生点（1v1 时就是对手出生点）
function enemyAnchor(state, enem) {
  if (enem) return { x: enem.x, y: enem.y };
  let best = null;
  for (const k in MEM) {
    const m = MEM[k];
    if (!m || m.x < 0) continue;
    if (ROUND - m.round > 6) continue;
    if (!best || m.round > best.round) best = m;
  }
  if (best) return { x: best.x, y: best.y };
  return ENEMY_HINT;
}
function threatAt(p, anchor) {
  if (!p || !anchor) return 0;
  const d = cheb(anchor, p);
  if (d <= 2) return 6;
  if (d <= 4) return 3;
  if (d <= 6) return 1;
  return 0;
}
// 后勤点选择：近 + 远离威胁（补给点常是拦截点，弹尽油尽时更致命）
function pickSupply(list, from, anchor, bonus) {
  let best = null, bs = 1e9;
  const arr = list || [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    let s = cheb(from, p) + threatAt(p, anchor) - (bonus || 0);
    if (s < bs) { bs = s; best = p; }
  }
  return best;
}

// 命中率 / 伤害：从 RULES 的命中分档推导，绝不写死
function hitChance(d, inForest) {
  let c = rule("minHitChance", 10);
  const bands = (RULES && RULES.hitChanceBands) || [];
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b && d <= num(b.maxDistance, 0)) { c = num(b.chance, c); break; }
  }
  if (inForest) c -= rule("forestHitPenalty", 0);
  const min = rule("minHitChance", 5);
  return c < min ? min : c;
}
function shotDamage(inForest) {
  const base = rule("shellDamage", 20);
  return inForest ? Math.round(base * rule("forestDamageMult", 1)) : base;
}

// ----------------------------------------------------------------- 地图/状态读取
function freeTile(p, state) {
  if (!walkChar(terrainAt(p.x, p.y))) return false;
  const en = (state && state.enemies) || [];
  for (let i = 0; i < en.length; i++) {
    const e = en[i];
    if (e && e.pos && e.pos.x === p.x && e.pos.y === p.y) return false;
  }
  return true;
}
function nodeViewAt(state, x, y) {
  const list = (state && state.resourceNodes) || [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v && v.x === x && v.y === y) return v;
  }
  return null;
}
function nodeById(id) {
  for (let i = 0; i < NODES.length; i++) if (NODES[i].id === id) return NODES[i];
  return null;
}
function claimEmpty(state) {
  if (!CLAIM) return true;
  const n = nodeById(CLAIM);
  if (!n) return true;
  const v = nodeViewAt(state, n.x, n.y);
  return !!v && v.remaining === 0;
}

function updateMem(state) {
  const next = {};
  const lk = (state && state.lastKnownEnemies) || [];
  for (let i = 0; i < lk.length; i++) {
    const e = lk[i];
    if (!e || !e.pos) continue;
    next[e.seat] = {
      seat: e.seat, x: num(e.pos.x, -1), y: num(e.pos.y, -1),
      hp: num(e.hp, 100), cargo: 0, round: num(e.seenRound, 0), live: false,
    };
  }
  const en = (state && state.enemies) || [];
  for (let i = 0; i < en.length; i++) {
    const e = en[i];
    if (!e || !e.pos) continue;
    next[e.seat] = {
      seat: e.seat, x: num(e.pos.x, -1), y: num(e.pos.y, -1),
      hp: num(e.hp, 100), cargo: num(e.cargo, 0), round: num(state.round, 0), live: true,
    };
  }
  MEM = next;
}
function nearestEnemy(state) {
  const list = (state && state.enemies) || [];
  let best = null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || !e.pos) continue;
    const p = { x: num(e.pos.x, -1), y: num(e.pos.y, -1) };
    if (p.x < 0 || p.y < 0) continue;
    const d = cheb(state.self.pos, p);
    if (!best || d < best.d) {
      best = { seat: num(e.seat, 0), x: p.x, y: p.y, hp: num(e.hp, 100), cargo: num(e.cargo, 0), d: d };
    }
  }
  return best;
}
// 记忆里的"猎物"：不可见但刚见过、且已残血 —— 追击能拿到击杀奖励
function freshPrey(state, maxAge) {
  let best = null;
  for (const k in MEM) {
    const m = MEM[k];
    if (!m || m.live) continue;
    if (m.hp > 45) continue;
    if (ROUND - m.round > (maxAge || 3)) continue;
    if (!best || m.hp < best.hp) best = m;
  }
  return best;
}

// ----------------------------------------------------------------- 移动
function greedyStep(from, to, state) {
  let best = null, bestScore = 1e9;
  const jitter = STAND >= 2 ? API.randomInt(0, 1) * 0.4 : 0;
  for (let i = 0; i < DIRS.length; i++) {
    const n = stepFrom(from, DIRS[i]);
    if (!freeTile(n, state)) continue;
    let s = cheb(n, to) + jitter * i;
    if (PREV && n.x === PREV.x && n.y === PREV.y) s += 1.6;   // 不要来回摇摆
    if (s < bestScore) { bestScore = s; best = DIRS[i]; }
  }
  return best;
}
function pathStep(from, to, state) {
  if (!to || !from) return null;
  let path = null;
  try { path = API.pathFind({ x: from.x, y: from.y }, { x: to.x, y: to.y }, { avoidUnits: true, maxNodes: 2000 }); }
  catch (e) { path = null; }
  if (path && path.length > 0 && typeof path[0] === "string") {
    const d0 = path[0];
    if (d0 === "N" || d0 === "E" || d0 === "S" || d0 === "W") {
      if (freeTile(stepFrom(from, d0), state)) return d0;
    }
  }
  return greedyStep(from, to, state);
}
function mkGoal(kind, x, y, id) { return { kind: kind, x: x, y: y, id: id || null }; }
function reached(pos, g) { return !!g && pos.x === g.x && pos.y === g.y; }

// ----------------------------------------------------------------- 经济：选资源点
// 效率 = 可采单位 x 单位分值 / 行动数（走近 + 采集 + 回撤提交），并对威胁打折
function pickNode(state, W, self, enem) {
  const cargoMax = Math.max(1, num(self.cargoMax, rule("cargoMax", 5)));
  const room = cargoMax - W.cargo;
  if (room <= 0 || !NODES.length) return null;
  const per = rule("depositScorePerUnit", 10);
  const dep = nearestPos(DEPOSITS, W.pos);
  const prey = freshPrey(state, 2);
  let best = null, bestScore = -1e9;
  for (let i = 0; i < NODES.length; i++) {
    const n = NODES[i];
    const v = nodeViewAt(state, n.x, n.y);
    let stock;
    if (v && typeof v.remaining === "number") stock = v.remaining;
    else stock = Math.max(2, Math.min(n.capacity, 5));   // 看不见就按"还有点货"估
    if (stock <= 0) continue;
    const take = Math.min(stock, room);
    const dMe = cheb(W.pos, n);
    const dDep = dep ? cheb(n, dep) : n.dep;
    let eff = (take * per) / (dMe + dDep + 3);
    if (enem) {
      const de = cheb({ x: enem.x, y: enem.y }, n);
      if (de <= 2) eff *= 0.55;
      else if (de <= 4) eff *= 0.80;
      else if (de <= 6) eff *= 0.94;
      // 带伤时避开威胁：游猎的命比一趟货值钱
      if (W.hp <= 45 && de <= 5 && enem.hp > W.hp) eff *= 0.6;
      if (W.hp <= 20 && de <= 8) eff *= 0.6;
    }
    if (CLAIM && n.id === CLAIM) eff *= 1.12;                       // 粘性：别来回改主意
    if (W.hp <= 25 && enem && enem.hp >= W.hp + 50 && enem.d <= 8) {
      if (cheb(n, enem) <= 5) eff *= 0.55;                          // 带伤远离威胁
    }
    if (prey && prey.hp <= 25 && cheb(n, prey) <= 4) eff *= 1.2;     // 顺手逼近猎物
    if (eff > bestScore) { bestScore = eff; best = n; }
  }
  if (best) CLAIM = best.id;
  return best;
}

// ----------------------------------------------------------------- 任务选择
function chooseGoal(state, W, self, enem) {
  const cargoMax = Math.max(1, num(self.cargoMax, rule("cargoMax", 5)));
  const dep = nearestPos(DEPOSITS, W.pos);
  const anchor = enemyAnchor(state, enem);
  const maxR = rule("maxRounds", 150);
  const late = ROUND >= maxR - 4;

  // 1) 提交：满载必交；带伤/近敌/采集点枯竭/残局都要先把货兑成分（死掉会丢货）
  if (W.cargo > 0 && dep) {
    const half = Math.max(2, Math.ceil(cargoMax * 0.6));
    const danger = !!enem && enem.d <= 4;
    const hurt = W.hp <= 40 && !!enem && enem.d <= 8;
    const camped = !!enem && same(enem, dep) && W.hp <= 40;   // 对方蹲在提交点上且我虚弱
    if (!camped && (W.cargo >= cargoMax || late || danger || hurt || (W.cargo >= half && claimEmpty(state)))) {
      return mkGoal("deposit", dep.x, dep.y, null);
    }
  }
  // 2) 燃油：保证走到最近加油站还有余量（应急移动每格扣分，尽量不触发）
  const mfc = rule("moveFuelCost", 2);
  const fs = pickSupply(FUELS, W.pos, anchor, 0);
  if (fs && W.fuel < cheb(W.pos, fs) * mfc + mfc * 3) return mkGoal("fuel", fs.x, fs.y, null);
  // 3) 弹药：没弹就没法游猎，也没法保护采集循环
  const as = pickSupply(AMMOS, W.pos, anchor, 0);
  if (as) {
    const need = W.ammo <= 0 || (enem && W.ammo <= 2) || (W.ammo <= 3 && cheb(W.pos, as) <= 4);
    if (need) return mkGoal("ammo", as.x, as.y, null);
  }
  // 4) 采集
  const node = pickNode(state, W, self, enem);
  if (node) return mkGoal("node", node.x, node.y, node.id);
  // 5) 兜底（无资源点的地图）：补给点 / 提交点
  if (fs) return mkGoal("fuel", fs.x, fs.y, null);
  if (as) return mkGoal("ammo", as.x, as.y, null);
  if (dep) return mkGoal("deposit", dep.x, dep.y, null);
  return null;
}

// ----------------------------------------------------------------- 站桩动作（设施上）
function groundAction(state, W, self, enem) {
  const p = W.pos;
  const cargoMax = Math.max(1, num(self.cargoMax, rule("cargoMax", 5)));
  // 提交：1 AP 换 10 分/单位，永远先做（死了会丢货）
  if (W.cargo > 0 && terrainAt(p.x, p.y) === "D") return { type: "deposit" };
  // 采集：贴着敌人时别站着挨打（先交给战斗逻辑决定打还是撤）
  const pressed = !!enem && enem.d <= 2 && W.hp <= 50;
  const inPeril = !!enem && enem.d <= rule("fireRange", 8) && W.hp <= 20;
  if (W.cargo < cargoMax && terrainAt(p.x, p.y) === "R" && !pressed && !inPeril) {
    const v = nodeViewAt(state, p.x, p.y);
    const seen = v && typeof v.remaining === "number" ? v.remaining : -1;
    const used = W.taken ? num(W.taken[p.x + "," + p.y], 0) : 0;   // 本回合已采走的量
    const rem = seen >= 0 ? seen - used : 1;
    if (rem > 0) return { type: "collect" };
  }
  // 加油：油便宜，站在站上就把油箱补到上限附近
  if (terrainAt(p.x, p.y) === "G") {
    const fm = num(self.fuelMax, rule("fuelMax", 100));
    if (W.fuel <= fm - rule("refuelPerAction", 30) * 0.7) return { type: "refuel" };
  }
  // 补弹：顺路装填，避免为补弹专程跑远路
  if (terrainAt(p.x, p.y) === "B" || terrainAt(p.x, p.y) === "A") {
    const am = num(self.ammoMax, rule("ammoMax", 20));
    if (W.ammo <= Math.min(am - 1, Math.max(4, am - 6))) return { type: "loadAmmo" };
  }
  return null;
}

// ----------------------------------------------------------------- 战斗
function findCover(state, W, enem) {
  const maxD = Math.min(rule("fireRange", 8), 6);
  let best = null, bestScore = -1e9;
  for (let y = W.pos.y - 4; y <= W.pos.y + 4; y++) {
    for (let x = W.pos.x - 4; x <= W.pos.x + 4; x++) {
      if (!isForest(x, y)) continue;
      const p = { x: x, y: y };
      const d = cheb(p, enem);
      if (d < 3 || d > maxD) continue;
      if (!safeLOS(p, enem)) continue;
      const s = 8 - cheb(p, W.pos) * 2 - Math.abs(d - 4);
      if (s > bestScore) { bestScore = s; best = p; }
    }
  }
  return best;
}
function escapeStep(state, W, enem) {
  let best = null, bestScore = -1e9;
  for (let i = 0; i < DIRS.length; i++) {
    const n = stepFrom(W.pos, DIRS[i]);
    if (!freeTile(n, state)) continue;
    let s = cheb(n, enem) * 1.2;
    if (!safeLOS(n, enem)) s += 3.0;                  // 断视线 = 真正脱离
    if (isForest(n.x, n.y)) s += 1.0;
    if (s > bestScore) { bestScore = s; best = DIRS[i]; }
  }
  return best ? { type: "move", dir: best } : null;
}
// 交火评估：双方"每回合期望伤害"与"击杀所需回合数"，只在交换比不吃亏时才站桩对射
function combatAction(state, W, self, enem) {
  if (!enem) return null;
  const range = rule("fireRange", 8);
  const stealth = rule("forestStealthRadius", 3);
  const d = enem.d;
  const tForest = isForest(enem.x, enem.y);
  const myForest = isForest(W.pos.x, W.pos.y);
  const los = d <= range && safeLOS(W.pos, enem);
  const canShoot = los && W.ammo >= 1 && !same(W.pos, enem);
  const myChance = hitChance(d, tForest);
  const myDmg = shotDamage(tForest);
  const hidden = myForest && d > stealth;            // 我在森林且 >3 格：对方看不见我
  const thChance = hidden ? 0 : hitChance(d, myForest);
  const thDmg = shotDamage(myForest);
  const hp = W.hp, ehp = enem.hp;
  const myRate = (myChance * myDmg) / 100;
  const thRate = (thChance * thDmg) / 100;
  const myTTK = myRate > 0 ? ehp / myRate : 99;
  const thTTK = thRate > 0 ? hp / thRate : 99;
  const fire = { type: "fire", target: { x: enem.x, y: enem.y } };

  // 0) 必杀一击 / 隐蔽冷枪：几乎零风险，白拿击杀奖励与对方 3 回合停机
  if (canShoot && ehp <= myDmg) return fire;
  if (canShoot && hidden && d <= 6 && (W.ammo >= 3 || ehp <= 40)) return fire;

  // 1) 剥夺：对方载货（一笔 30~50 分）值得优先打断
  if (canShoot && enem.cargo >= 3 && myTTK <= thTTK + 2 && W.ammo >= 2) return fire;

  // 2) 交换比占优才开火；远距离只打"有理由的目标"，省弹药
  if (canShoot) {
    const reason = ehp <= 60 || enem.cargo >= 2 || d <= 4;
    if (myTTK + 0.5 < thTTK && hp > 20 && reason) return fire;
    // 贴身/中距离的均势对射：速战速决，拖长了就是弹药黑洞
    if (myTTK <= thTTK + 0.5 && d <= 3 && hp > 35 && W.ammo >= 2) return fire;
  }
  // 3) 交换比不利：先抢掩体（森林：伤害减半 + 命中 -20%），保持能打到对方
  const dep = nearestPos(DEPOSITS, W.pos);
  const depBlocked = !!enem && same(enem, dep);
  const banking = W.cargo > 0 && dep && cheb(W.pos, dep) <= 3 && (!depBlocked || hp > 40);
  const losing = thTTK < myTTK || hp <= 45;
  if (W.ammo >= 1 && !myForest && los && losing && hp > 45 && !banking) {
    const spot = findCover(state, W, enem);
    if (spot && !reached(W.pos, spot)) {
      const dir = pathStep(W.pos, spot, state);
      if (dir) { COVER = spot; return { type: "move", dir: dir }; }
    }
  }
  // 4) 失血过多：脱离接触，退到远离威胁的采集点（不硬拼、也不白送人头）
  if (!banking && ((hp <= 45 && thTTK <= 4) || thTTK <= 2)) {
    GOAL = null; CLAIM = null;
    const far = pickNode(state, W, self, enem);
    if (far) {
      const dir = pathStep(W.pos, { x: far.x, y: far.y }, state);
      if (dir) { GOAL = mkGoal("node", far.x, far.y, far.id); return { type: "move", dir: dir }; }
    }
    const esc = escapeStep(state, W, enem);
    if (esc) return esc;
  }
  // 5) 兜底还击：跑不掉/正在兑现货物时，站着挨打是最差的选项
  if (canShoot && W.ammo >= 1 && d <= 4 && hp <= 60) return fire;
  // 6) 收尾：对方一发可带走且我血线安全时，贴上去拿人头
  if (ehp <= 20 && hp >= 60 && W.ammo >= 1 && d > 3 && d <= range + 2) {
    const dir = pathStep(W.pos, { x: enem.x, y: enem.y }, state);
    if (dir) return { type: "move", dir: dir };
  }
  return null;
}

// ----------------------------------------------------------------- 每步决策
function decide(state, W, self) {
  const enem = nearestEnemy(state);
  const g = groundAction(state, W, self, enem);
  if (g) return g;
  const c = combatAction(state, W, self, enem);
  if (c) return c;
  // 本回合已进入掩体机动：走完它，避免"出掩体又折返"的空转
  if (COVER && enem && !reached(W.pos, COVER)) {
    const dir = pathStep(W.pos, COVER, state);
    if (dir) return { type: "move", dir: dir };
    COVER = null;
  }
  return travelAction(state, W, self, enem);
}
// 目标管理：每步重算，硬需求（提交/加油/补弹）可以立刻打断当前任务；
// 采集点来回摇摆由 pickNode 的粘性（CLAIM）抑制。
function travelAction(state, W, self, enem) {
  const fresh = chooseGoal(state, W, self, enem);
  if (!fresh) { GOAL = null; return null; }
  GOAL = fresh;
  if (reached(W.pos, GOAL)) { GOAL = null; return null; }
  const dir = pathStep(W.pos, GOAL, state);
  if (dir) return { type: "move", dir: dir };
  if (GOAL.kind === "node") CLAIM = null;         // 走不通就换个目标：绝不发出注定无效的移动
  GOAL = null;
  return null;
}
function applyVirtual(W, a) {
  if (!a || !a.type) return;
  if (a.type === "move") {
    W.pos = stepFrom(W.pos, a.dir);
    W.fuel = Math.max(0, W.fuel - rule("moveFuelCost", 2));
  } else if (a.type === "fire") {
    W.ammo = Math.max(0, W.ammo - 1);
  } else if (a.type === "collect") {
    const per = rule("collectPerAction", 3);
    W.cargo = Math.min(W.cargoMax, W.cargo + per);
    const k = W.pos.x + "," + W.pos.y;
    if (!W.taken) W.taken = {};
    W.taken[k] = num(W.taken[k], 0) + per;                 // 记账：本回合在同一格采走的量
  } else if (a.type === "deposit") {
    W.cargo = 0;
  } else if (a.type === "loadAmmo") {
    W.ammo = Math.min(W.ammoMax, W.ammo + rule("loadAmmoPerAction", 6));
  } else if (a.type === "refuel") {
    W.fuel = Math.min(W.fuelMax, W.fuel + rule("refuelPerAction", 30));
  }
}

// ----------------------------------------------------------------- 初始化
function initFromMap() {
  NODES = [];
  const rn = (MAP && MAP.resourceNodes) || [];
  for (let i = 0; i < rn.length; i++) {
    const n = rn[i];
    if (!n) continue;
    NODES.push({
      id: typeof n.id === "string" ? n.id : "R" + i,
      x: num(n.x, 0), y: num(n.y, 0),
      kind: n.kind === "center" ? "center" : "home",
      capacity: Math.max(1, num(n.capacity, 6)),
      dep: 0,
    });
  }
  DEPOSITS = readPts(MAP && MAP.depositPoints);
  FUELS = readPts(MAP && MAP.fuelStations);
  AMMOS = readPts(MAP && MAP.ammoDepots);
  for (let i = 0; i < NODES.length; i++) {
    const n = NODES[i];
    const d = nearestPos(DEPOSITS, n);
    n.dep = d ? cheb(n, d) : 8;
  }
  // 无情报时的对手方位兜底：离自己出生点最远的出生点（1v1 就是对手出生点）
  ENEMY_HINT = null;
  const sps = (MAP && MAP.spawns) || [];
  let far = 0;
  for (let i = 0; i < sps.length; i++) {
    const p = sps[i];
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
    const d = cheb(p, SPAWN);
    if (d > far) { far = d; ENEMY_HINT = { x: p.x, y: p.y }; }
  }
}
function onInit(ctx) {
  try {
    SEAT = num(ctx && ctx.seat, 1);
    const sp = ctx && ctx.mySpawn ? ctx.mySpawn : null;
    if (sp && typeof sp.x === "number" && typeof sp.y === "number") SPAWN = { x: sp.x, y: sp.y };
    initFromMap();
    MEM = {}; GOAL = null; CLAIM = null; PREV = null; STAND = 0; ROUND = 0;
    READY = true;
    API.log("silver-hunter init: seat=" + SEAT + " spawn=" + SPAWN.x + "," + SPAWN.y +
      " nodes=" + NODES.length + " dep=" + DEPOSITS.length);
  } catch (e) {
    READY = true;   // 初始化失败也不能抛：空数组兜底后按最简行为运行
  }
}

// ----------------------------------------------------------------- 主循环
function onTurn(state) {
  try {
    if (!READY) { try { initFromMap(); } catch (e0) {} READY = true; }
    if (!state || !state.self) return [{ type: "wait" }];
    const self = state.self;
    ROUND = num(state.round, ROUND + 1);
    updateMem(state);

    const W = {
      pos: { x: num(self.pos && self.pos.x, SPAWN.x), y: num(self.pos && self.pos.y, SPAWN.y) },
      hp: num(self.hp, 100),
      ammo: num(self.ammo, 0),
      fuel: num(self.fuel, 0),
      cargo: num(self.cargo, 0),
      cargoMax: Math.max(1, num(self.cargoMax, rule("cargoMax", 5))),
      ammoMax: Math.max(1, num(self.ammoMax, rule("ammoMax", 20))),
      fuelMax: Math.max(1, num(self.fuelMax, rule("fuelMax", 100))),
    };
    if (PREV && same(PREV, W.pos)) STAND += 1; else STAND = 0;
    PREV = { x: W.pos.x, y: W.pos.y };
    COVER = null;                                   // 每回合重选掩体机动
    if (!walkChar(terrainAt(W.pos.x, W.pos.y))) {   // 理论不会发生：兜底给个安全朝向
      GOAL = null; CLAIM = null;
    }

    const acts = [];
    const ap = Math.max(1, Math.min(4, rule("apPerTurn", 2)));
    for (let i = 0; i < ap; i++) {
      const a = decide(state, W, self);
      if (!a) break;
      if (acts.length >= ap) break;
      acts.push(a);
      applyVirtual(W, a);
    }
    if (!acts.length) return [{ type: "wait" }];
    return acts;
  } catch (e) {
    return [];
  }
}