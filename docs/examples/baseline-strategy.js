// baseline-strategy.js —— 平台基线机器人（同时作为任务书里的参考实现骨架）
// 设计：任务制规划（mission）+ 燃油预判 + 持续争夺高收益资源点，避免"每回合重新决策"导致的来回摇摆。
// 面向"任何一张合规地图"：所有目标点都从 MAP 现取，距离用 API.pathFind 实测，绝不写死坐标。
// 两条实测结论（见 docs/02 §9）：
//   1) 本游戏**没有回血**：一旦残血就永远残血，躲回角落只会把资源点拱手让人，而且再也打不动；
//      阵亡只扣 20 分、3 回合后满血满弹复活 —— 所以残血的正确选择是继续争夺，而不是苟活。
//   2) 资源点被采空后**不要原地等回充**（回充是每 N 回合 +1 单位），要立刻换目标；
//      提交点在哪、有几个都要从 MAP.resourceNodes / MAP.depositPoints 现算（有的图只有一个，有的图每个象限各一个）。
// 规则书：docs/02-游戏规则-v1.md  ／ 协议：docs/03-AI接入协议.md
// 注意：本文件在 QuickJS 沙箱中运行，只能使用 MAP / RULES / API 三个全局对象。

const META = {
  name: "Baseline-玄武",
  style: "mission-planner",
  note: "任务制：锁定 补给→采集→提交 的循环；优先中央高收益资源点，采空即换点，低弹必补弹",
};

// 是否允许为高收益冒险去中央资源点（改成 false 就退化为"只守近端资源点"的保守流派）
const ALLOW_CENTER = true;

// ---------- 模块级记忆（整场比赛持续存在）----------
let SEAT = 1;
let SPAWN = null;
let HOME_NODES = [];        // 近端资源点（可能为空：有些地图只有中央资源点）
let HOME_NODE = null;       // 兜底采集目标（没有近端点时退回中央节点）
let CENTER_NODES = [];      // 中央资源点（收益高，但四家都会来）
let ALL_FUEL = [];          // 全部加油点
let ALL_DEPOT = [];         // 全部弹药补给点
let ALL_DEPOSIT = [];       // 全部提交点
const SEEN = {};            // seat -> {x, y, hp, round}
let mission = null;         // { kind: "fuel"|"ammo"|"node"|"deposit", x, y, id }

// ---------- 小工具 ----------
function cheb(a, b) { return API.chebyshev(a, b); }

function pickNearest(list, from) {
  let best = null, bestD = 1e9;
  for (let i = 0; i < list.length; i++) {
    const d = cheb(from, list[i]);
    if (d < bestD) { bestD = d; best = list[i]; }
  }
  return best;
}

// 在候选资源点里挑"近且还有货"的；看不见的点按"可能还有货"估算，已确认采空的直接跳过
function pickStocked(nodes, state, from) {
  let best = null, bestScore = -1e9;
  for (const n of nodes) {
    const view = state.resourceNodes.filter(function (r) { return r.id === n.id; })[0];
    if (view && view.remaining === 0) continue;
    const remain = view && view.remaining !== null ? view.remaining : 3;
    const score = remain - cheb(from, n) * 0.6;
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best;
}

function nearestFuel(from) { return pickNearest(ALL_FUEL, from); }
function nearestDepot(from) { return pickNearest(ALL_DEPOT, from); }
function nearestDeposit(from) { return pickNearest(ALL_DEPOSIT, from); }

// 燃油是否紧张到必须先加油：连走到最近加油点都不够
function fuelTight(self, from) {
  return self.fuel < cheb(from, nearestFuel(from)) * RULES.moveFuelCost + 8;
}
// 去 target 干完活还回得来找油吗（按 1.5 倍余量估算）
function fuelNeeded(self, pos, target) {
  const back = cheb(target, nearestFuel(target));
  return (cheb(pos, target) + back) * RULES.moveFuelCost * 1.5 + 8;
}

function isOccupied(x, y) {
  for (const k in SEEN) { const s = SEEN[k]; if (s.x === x && s.y === y) return true; }
  return false;
}

// 沿路径走最多 budget 步；逐步校验地形与占位，绝不发出注定无效的 move
function moveToward(from, target, budget) {
  const acts = [];
  if (!from || !target || budget <= 0) return { acts: acts, pos: from };
  let path = null;
  try { path = API.pathFind(from, target, { avoidUnits: true, maxNodes: 4000 }); } catch (e) { path = null; }
  if (!path || path.length === 0) return { acts: acts, pos: from };
  let p = { x: from.x, y: from.y };
  for (let i = 0; i < path.length && acts.length < budget; i++) {
    const n = API.step(p, path[i]);
    if (n.x < 0 || n.y < 0 || n.x >= MAP.width || n.y >= MAP.height) break;
    if (!API.isPassable(n.x, n.y, { ignoreUnits: true })) break;
    if (isOccupied(n.x, n.y)) break;
    acts.push({ type: "move", dir: path[i] });
    p = n;
  }
  return { acts: acts, pos: p };
}

function updateMemory(state) {
  for (const k in SEEN) delete SEEN[k];
  for (const e of (state.enemies || [])) SEEN[e.seat] = { x: e.pos.x, y: e.pos.y, hp: e.hp, round: state.round };
  for (const e of (state.lastKnownEnemies || [])) {
    if (!SEEN[e.seat]) SEEN[e.seat] = { x: e.pos.x, y: e.pos.y, hp: e.hp, round: e.seenRound };
  }
}

function nearestVisibleEnemy(state) {
  let best = null;
  for (const e of (state.enemies || [])) if (!best || e.distance < best.distance) best = e;
  return best;
}

// ---------- 初始化 ----------
function onInit(ctx) {
  SEAT = ctx.seat;
  SPAWN = { x: ctx.mySpawn.x, y: ctx.mySpawn.y };
  HOME_NODES = MAP.resourceNodes.filter(function (n) { return n.kind === "home"; });
  CENTER_NODES = MAP.resourceNodes.filter(function (n) { return n.kind === "center"; });
  HOME_NODE = pickNearest(HOME_NODES.length ? HOME_NODES : CENTER_NODES, SPAWN); // 有些图没有近端资源点
  ALL_FUEL = MAP.fuelStations;
  ALL_DEPOT = MAP.ammoDepots;
  ALL_DEPOSIT = MAP.depositPoints;
  API.log("init seat=" + SEAT + " spawn=" + SPAWN.x + "," + SPAWN.y);
}

// 选采集目标：中央收益是近端的数倍；只有"血量被碾压"时才退守近端（注意：残血不等于必死）
function chooseNodeTarget(state) {
  const self = state.self;
  const enemy = nearestVisibleEnemy(state);
  const outgunned = !!enemy && enemy.distance <= 5 && enemy.hp - self.hp >= 40;
  const risky = !ALLOW_CENTER || self.hp <= 20 || outgunned;
  const first = risky ? HOME_NODES : CENTER_NODES;
  const second = risky ? CENTER_NODES : HOME_NODES;
  return pickStocked(first, state, self.pos) || pickStocked(second, state, self.pos) || HOME_NODE;
}

// 选定任务（只在没有任务时调用）
function pickMission(state) {
  const self = state.self;
  if (self.cargo >= self.cargoMax) {
    const d = nearestDeposit(self.pos);
    return { kind: "deposit", x: d.x, y: d.y };
  }
  if (fuelTight(self, self.pos) || self.fuel < RULES.moveFuelCost * 4) {
    const f = nearestFuel(self.pos);
    return { kind: "fuel", x: f.x, y: f.y };
  }
  // 弹药见底必须补：小地图上"顺路补弹"不成立，所以用绝对阈值
  if (self.ammo <= 2) {
    const a = nearestDepot(self.pos);
    if (a) return { kind: "ammo", x: a.x, y: a.y };
  }
  const node = chooseNodeTarget(state);
  if (!node) return null;
  if (self.ammo < 6 && cheb(self.pos, node) > 8) {
    const a = nearestDepot(self.pos);
    return { kind: "ammo", x: a.x, y: a.y };
  }
  if (self.fuel < fuelNeeded(self, self.pos, node)) {
    const f = nearestFuel(self.pos);
    return { kind: "fuel", x: f.x, y: f.y };
  }
  return { kind: "node", x: node.x, y: node.y, id: node.id };
}

// ---------- 每回合决策 ----------
function onTurn(state) {
  try {
    updateMemory(state);
    const self = state.self;
    const acts = [];
    let ap = RULES.apPerTurn;
    const pos = { x: self.pos.x, y: self.pos.y };

    // 1) 站在设施上：把能做的补给/提交尽量做满（2 点行动力别浪费在同一格的来回上）
    if (ap > 0 && self.cargo > 0 && API.isDeposit(pos.x, pos.y)) {
      acts.push({ type: "deposit" }); ap -= 1; mission = null; // 提交后货舱清空
    }
    while (ap > 0 && API.isFuel(pos.x, pos.y) && self.fuel <= self.fuelMax - 12) {
      const add = Math.min(RULES.refuelPerAction, self.fuelMax - self.fuel);
      if (add <= 0) break;
      acts.push({ type: "refuel" }); ap -= 1; self.fuel += add;
      if (mission && mission.kind === "fuel") mission = null;
    }
    while (ap > 0 && API.isAmmo(pos.x, pos.y) && self.ammo <= RULES.ammoMax - 6) {
      const add = Math.min(RULES.loadAmmoPerAction, RULES.ammoMax - self.ammo);
      if (add <= 0) break;
      acts.push({ type: "loadAmmo" }); ap -= 1; self.ammo += add;
      if (mission && mission.kind === "ammo") mission = null;
    }
    while (ap > 0 && API.isResource(pos.x, pos.y) && self.cargo < self.cargoMax) {
      const node = state.resourceNodes.filter(function (r) { return r.x === pos.x && r.y === pos.y; })[0];
      const known = node && node.remaining !== null ? node.remaining : 1; // 看不见的余量按 1 保守估计
      if (known <= 0) { mission = null; break; } // 采空的点不原地等回充，立刻换目标
      acts.push({ type: "collect" }); ap -= 1;
      const taken = Math.min(RULES.collectPerAction, known, self.cargoMax - self.cargo);
      self.cargo += taken;
      if (node && node.remaining !== null) node.remaining = Math.max(0, node.remaining - taken);
      if (self.cargo + RULES.collectPerAction >= self.cargoMax) mission = null; // 快装满就去提交
    }

    // 2) 火力：近距离 / 对方已残 / 对方载着货 都值得打；远距离对满血敌人只在弹药宽裕时打
    const enemy = nearestVisibleEnemy(state);
    if (ap > 0 && enemy && self.ammo >= 1 && self.hp > 20
      && enemy.distance <= RULES.fireRange && API.hasLOS(pos, enemy.pos)) {
      const worthIt = enemy.distance <= 4 || enemy.hp <= 60 || enemy.cargo > 0 || self.ammo >= 9;
      if (worthIt) {
        acts.push({ type: "fire", target: { x: enemy.pos.x, y: enemy.pos.y } });
        ap -= 1;
      }
    }

    // 3) 按任务前进（任务锁定，不每回合改主意）
    if (ap > 0) {
      if (!mission) mission = pickMission(state);
      if (mission) {
        if (cheb(pos, mission) === 0) {
          // 到了但活干不成（例如资源点被别人采空、货舱已空）→ 放弃任务，下回合重选
          const nodeView = mission.kind === "node"
            ? state.resourceNodes.filter(function (r) { return r.id === mission.id; })[0] : null;
          const pointless =
            (mission.kind === "node" && nodeView && nodeView.remaining === 0) ||
            (mission.kind === "deposit" && self.cargo === 0) ||
            (mission.kind === "fuel" && self.fuel > self.fuelMax - 12) ||
            (mission.kind === "ammo" && self.ammo > RULES.ammoMax - 6);
          mission = null;
          if (!pointless) return acts.length ? acts.slice(0, RULES.apPerTurn) : [{ type: "wait" }];
        } else {
          const r = moveToward(pos, mission, ap);
          for (const a of r.acts) acts.push(a);
          if (r.acts.length === 0) mission = null; // 走不通就换个目标
        }
      }
    }

    return acts.length ? acts.slice(0, RULES.apPerTurn) : [{ type: "wait" }];
  } catch (e) {
    try { API.log("onTurn error: " + (e && e.message ? e.message : e)); } catch (e2) {}
    return [];
  }
}