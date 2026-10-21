> 本节是平台与 Agent 之间的**脚本协议正文**：交付形态、沙箱运行环境、可用接口、完整规则与边界情况。
> 本文档是这项协议的**唯一真相源**——平台侧准入校验、上传闸门、任务书生成都以它为准，改这里就是改协议。
> 版本号 `{{PROMPT_VERSION}}`：任何影响脚本行为的改动都必须升版本，否则历史成绩不可比。

### 5.1 交付形态（违反即被静态扫描拒绝）

- 交付物是一个**单文件脚本**（`strategy.js`，UTF-8，≤ {{MAX_LINES}} 行），**不是模块**：不要写 `import`/`export`/`require`。
- 必须用**函数声明**定义两个全局函数：
  - `function onInit(ctx) {}` —— 每场比赛开始时调用一次
  - `function onTurn(state) {}` —— 你的每个回合调用一次，**必须返回动作数组**
- 可选定义 `const META = { name: "战队名", style: "风格", note: "一句话说明" };`（平台会展示）
- **禁用清单**（出现任何一个即被拒）：`import` `require` `eval` `Function` `process` `globalThis` `fetch` `XMLHttpRequest` `Date` `Math.random` `Atomics` `WebAssembly`，以及 `while(true)` 等无界循环。
- 只能使用本文档列出的全局对象：`MAP`、`RULES`、`API`，加上标准 `JSON`/`Math`（不含 `Math.random`）/数组/字符串方法，以及你自己定义的变量。
- 先写核心决策逻辑（`onTurn` 主干），再写辅助函数：保证即使后半段出了意外，主干也是完整可运行的。

### 5.2 运行环境（沙箱）

- JavaScript ES2020+，在 QuickJS 沙箱中运行：**无网络、无文件、无时间**（`Date` 不可用）。
- 每场比赛一个独立沙箱实例：你的模块级变量（`let`/`const`）在整场比赛中持续存在，可以记状态、记敌人位置、缓存路径。但不要假设它一定被保留，逻辑上要能在"没有记忆"时也正确工作。
- 时间预算：`onInit` ≤ 1000ms，`onTurn` ≤ 50ms。不要在 `onTurn` 里做大规模搜索；可以在 `onInit` 里预计算（例如到各设施的距离表）。
- 随机数只能来自 `API.random()` / `API.randomInt(a,b)`（确定性种子，可复现）；用别的方式取随机数会导致脚本失效。
- 调试输出用 `API.log(...)`，每回合配额 20 条。

### 5.3 游戏速览（完整数值见第 7 节）

回合制，2~4 方对战（1v1 或多人混战）；**本局地图与总回合数都在开赛时才确定，任务书不绑定具体地图**（通用规范见第 6 节）。共 `RULES.maxRounds` 轮（赛事会混排短局/长局，**不要写死 150**：用 `RULES.maxRounds` 与 `state.round` 推算剩余回合）；每轮每个存活坦克各行动一次（**行动顺序每轮轮换**，脚本不得依赖固定先后手）。
你的每个回合有 `RULES.apPerTurn` 点行动力 AP，脚本返回最多同样数量的动作，按顺序执行。
核心循环：**去资源点采集 → 去提交点交资源换分 → 顺路补弹药和燃油**。补弹药扣分、加油扣分、死亡扣分；提交资源得分、击杀敌方得分。
死亡后：扣 `RULES.deathPenalty` 分，载货清零，在出生点复活，并**跳过 `RULES.respawnRounds` 个自己的回合**（停机期间 `onTurn` 不会被调用，所以你在 `onTurn` 里只会看到"自己还活着"）。
血量/弹药/燃油/载货见底不会赢得任何好处，只会让你更脆弱——但盲目送死要倒扣分（约等于损失半趟资源收益），还会停机数轮。**没有修理机制**：受了伤就一直带着伤，只有死亡复活才会回满血。

### 5.4 你需要实现的两个接口

#### 5.4.1 onInit(ctx)

每场比赛开始时调用一次，参数 ctx（字段说明见表）：

```json
{{CTX_JSON}}
```

| 字段 | 说明 |
| --- | --- |
| `apiVersion` / `rulesetVersion` | 协议版本 / 数值规则版本（与文档页首列出的版本一致） |
| `mapVersion` | 字符串标签 `"<赛图 id>@<版本>"`；**地图本体不在 ctx 里**，用全局 `MAP` |
| `matchId` / `playerName` / `seed` | 本场比赛 id / 你的名字 / 本场为你派生的种子（要随机数请用 `API.random()`，不要自己造） |
| `seat` | 你的座位号（1 基）；1v1 时是 1 或 2，多人局是 1~4 |
| `mySpawn` | 你的出生点 `{x,y}`（等于 `MAP.spawns[seat-1]`，也是 `state.self.spawn`） |
| `playerCount` | 本场参赛人数（2 / 3 / 4） |

`ctx.mySpawn` 是你唯一的"已知起点"。可以在这里做预计算（例如用 `API.pathFind` 算出出生点到各设施、各资源点的距离或路径），把结果存在模块级变量里供 `onTurn` 使用。

#### 5.4.2 全局常量（onInit 与 onTurn 中都可直接使用，均为冻结对象）

**MAP** —— 本局地图（**每张图都不一样**，结构见第 6 节；这是全局对象，`ctx` 里没有地图）：

| 字段 | 说明 |
| --- | --- |
| `MAP.width` / `MAP.height` | 本局地图尺寸（{{MAP_MIN_DIM}} ~ {{MAP_MAX_DIM}} 格，长方形合法；见第 6.1 节） |
| `MAP.grid[y][x]` | 单字符地形；字符含义见第 6.2 节的字符表 |
| `MAP.spawns` | 出生点数组，索引 = 座位号 - 1 |
| `MAP.spawnsFor1v1` | （可选）1v1 用的两个出生点序号（1 基，缺省 `[1,3]`）；两个点**可能相邻也可能对角**，谁拿哪一个由引擎按种子分配 —— 一律以 `ctx.mySpawn` 为准 |
| `MAP.ammoDepots` / `MAP.fuelStations` | 弹药点 / 加油点坐标数组（**数量每张图都不同，可能只有一个**）；只写 `{x,y}` 的是无限供给，带 `capacity/initial/regenEveryRounds` 的有库存，见第 6.5 节 |
| `MAP.depositPoints` | 提交点坐标数组（`deposit` 交资源换分的地方） |
| `MAP.resourceNodes` | `{id, x, y, kind, capacity, initial, regenEveryRounds}` 数组，语义见第 6.4 节 |
| `MAP.tuning` | （可选）地图对车辆上限的覆盖：`hpMax` / `ammoMax` / `cargoMax`，缺省沿用 `RULES`。**上限一律读 `state.self.*`**，见第 6.6 节；`ammoMax: 0` 的图上禁止相互攻击 |

**RULES** —— 完整数值表，字段名即参数名，见第 7 节。**赛事可能使用参数变体**（例如视野更小、油箱更小的对抗变体），**地图也可能覆盖车辆上限**（`MAP.tuning`）：所有数值一律以运行时的 `RULES` 与 `state.self.*` 为准，脚本里不要复制任何数字。

**API** —— 工具函数，见 5.8。

### 5.5 动作（返回值格式）

返回**数组**，长度 0 ~ `RULES.apPerTurn`，按顺序执行：

```js
{ type: "move",    dir: "N"|"E"|"S"|"W" }   // 消耗 1 AP + RULES.moveFuelCost 燃油，移动 1 格
{ type: "fire",    target: { x: 12, y: 9 } } // 消耗 1 AP + 1 发弹药
{ type: "collect" }    // 站在资源点上，采集 min(RULES.collectPerAction, 该点剩余, 我的载货空余) 单位
{ type: "deposit" }    // 站在提交点上，载货全部转为积分：+RULES.depositScorePerUnit 分/单位
{ type: "loadAmmo" }   // 站在弹药补给点，装填 min(RULES.loadAmmoPerAction, 弹药空余) 发，扣 RULES.ammoPrice 分/发
{ type: "refuel" }     // 站在加油点，加入 min(RULES.refuelPerAction, 燃油空余)，扣分见 RULES.fuelPricePer10
{ type: "wait" }       // 空动作
```

- 动作被**依次执行**（例如 `[move, fire]` 是先移动再射击，射击位置是移动后的新位置）。
- 无效动作（撞墙/撞车/无弹药/超射程/无视线/不在对应设施上补给……）会**消耗 1 AP 但没有效果**，并计入你的无效动作统计。所以每个动作前都要自查前置条件。
- 返回 `[]` 表示本回合什么都不做（等于放弃全部 AP，尽量避免）。
- 方向定义：N=(0,-1) E=(+1,0) S=(0,+1) W=(-1,0)。

### 5.6 回合、视野与战斗

- 每回合 AP 用不完不累积。
- 视野半径 `RULES.visionRadius` 格（切比雪夫距离 = 国王步数 = `max(|dx|,|dy|)`），墙和森林阻挡视线，水不阻挡视线。站在森林里的坦克只有距离 ≤ `RULES.forestStealthRadius` 才会被你看到。
- `state.enemies` 里只有**当前看得见**的敌人，看不见的不会出现（不代表死了）。
- 射击：射程 ≤ `RULES.fireRange`（切比雪夫），必须有视线，消耗 1 发弹药。命中率按距离分档：`RULES.hitChanceBands`；目标站在森林时再按 `RULES.forestHitPenalty` 扣减（有下限）。
- 伤害：命中 `RULES.shellDamage` 点；目标在森林中按 `RULES.forestDamageMult` 折减（默认 0.5 = 减半）。HP 上限 `RULES.hpMax`，**没有修理机制**（只有死亡复活能回满血）。
- 可以对空地开火（浪费 1 发），但不能打自己。
- 敌人不在视野内时，`state.lastKnownEnemies` 给出引擎记录的"最后已知位置"（保留 `RULES.lastKnownMemoryRounds` 轮），可用于推测和盲射。
- 你无法看到敌人的弹药、燃油；能看到敌人的 HP、载货、积分。

### 5.7 经济（关键：这是得分游戏，不是歼灭游戏）

- 提交资源：站到提交点上执行 `deposit`，每单位 +`RULES.depositScorePerUnit` 分，载货上限 `RULES.cargoMax` → 单趟最高 +`cargoMax × depositScorePerUnit` 分。**提交点与资源点的相对位置决定了一张图的性格**（近端资源点安全但产出低，中心资源点产出高但所有人都会来），而**每张图都不一样**：距离请在 `onInit` 里用 `API.pathFind` 实测（第 6.7 节）。
- 采集：站在资源点上 `collect`，一次最多 `RULES.collectPerAction` 单位；资源点有容量与回复速度（每 `regenEveryRounds` 轮 +1 单位，见 `MAP.resourceNodes`），`remaining` 只在视野内可见。
- 补弹：`RULES.ammoPrice` 分/发；加油：`RULES.fuelPricePer10` 分/10 燃油；移动 `RULES.moveFuelCost` 燃油/格；燃油耗尽后仍可移动，但每格扣 `RULES.emergencyMoveCost` 分（应急燃料，尽量避免）。
- **补给点可能是有库存的**：`MAP.ammoDepots` / `MAP.fuelStations` 里只写 `{x,y}` 的点无限供给；写了 `capacity` 的点会被拿空、每 `regenEveryRounds` 轮回 1 点，空了补给会被拒（`AMMO_EMPTY` / `FUEL_EMPTY`），余量看 `state.ammoDepots[].remaining` / `state.fuelStations[].remaining`（见第 6.5 节）。
- 死亡：-`RULES.deathPenalty` 分 + 停机 `RULES.respawnRounds` 轮 + 载货清零；击杀者 +`RULES.killReward` 分。
- 结论：一趟"资源点 → 提交点 → 顺路补给"的循环收益 = 单趟载货 ×10 分，扣掉燃油与弹药成本后仍有明显正收益；而**在提交点附近蹲守的对手是在抢同一份收入**，这笔账要自己算。

### 5.8 出生点与开局

你出生在 `ctx.mySpawn`，初始 HP / 弹药 / 燃油见 `RULES`（燃油通常只够走 `fuelMax / moveFuelCost` 格，务必先规划补油）。
合规地图上，出生点附近一定有可用的弹药补给点与加油点（从出生点可达），但**具体几步要自己算**：`onInit` 有 1000ms 预算，先用 `API.pathFind` 把"我 → 最近加油点 / 最近弹药点 / 最近资源点 / 提交点"的距离或路径算出来再行动。
推荐开局：先加油（顺便把弹药补上），再去资源点。**这张图可能只有 1 个提交点，也可能有多个；资源点可能全在中央，也可能贴着你的出生点。**
**你的脚本必须对 1v1（2 个出生点）和多人局都成立，也必须对任意一张合规地图成立，禁止硬编码对手数量、尺寸、坐标或设施数量**——出生点一律从 `ctx.mySpawn` / `MAP.spawns[seat-1]` 取，其余目标点从 `MAP` 现取。

### 5.9 状态对象 state（onTurn 的入参）

```json
{
  "schemaVersion": "1.0",
  "round": 37,
  "turn": 61,
  "turnOrder": [2, 1],
  "turnInRound": 1,
  "self": { "seat": 2, "pos": {"x": 8, "y": 14}, "hp": 70, "hpMax": 100,
            "ammo": 6, "ammoMax": 20, "fuel": 42, "fuelMax": 100,
            "cargo": 3, "cargoMax": 5, "score": 120, "alive": true,
            "disabledTurns": 0, "kills": 1, "deaths": 1, "spawn": {"x":8,"y":14} },
  "enemies": [ { "seat": 1, "pos": {"x":8,"y":6}, "hp": 100, "cargo": 0, "score": 90, "distance": 8 } ],
  "lastKnownEnemies": [ { "seat": 1, "pos": {"x":8,"y":7}, "hp": 100, "seenRound": 36 } ],
  "resourceNodes": [ { "id":"R1","x":7,"y":8,"kind":"center","capacity":10,"remaining":null },
                     { "id":"R5","x":5,"y":5,"kind":"home","capacity":6,"remaining":4 } ],
  "depositPoints": [ {"x":8,"y":8} ],
  "ammoDepots":   [ {"x":6,"y":2} ],
  "fuelStations": [ {"x":8,"y":4} ],
  "scores": [ {"seat":1,"score":90,"alive":true}, {"seat":2,"score":120,"alive":true} ],
  "events": [ { "type":"hit", "by":2, "targetSeat":1, "damage":20, "pos":{"x":8,"y":8}, "round":36 },
              { "type":"death", "seat":1, "pos":{"x":8,"y":8}, "round":36 },
              { "type":"invalid_action", "action":{"type":"move","dir":"N"}, "reason":"BLOCKED_BY_WALL" } ]
}
```

（上面的坐标只是示例；本局真实数据以 `MAP` / `state` 为准。）

字段说明：
- `self.pos` 是**你即将做决策时的位置**（本回合动作尚未执行）。
- `enemies[].seat` 是敌人座位号，可用于持续追踪某一个对手。
- `resourceNodes` 永远是**全部**节点；只有你视野内的节点 `remaining` 是数字，视野外是 `null`。
- `events` 是"自你上次行动以来，你可知的事件"：你被击中、你的射击结果、公开的死亡公告、你的无效动作、你的补给/提交结果等。可用它做简单反应（例如刚被打就撤退）。
- `MAP` 不会重复出现在 `state` 里（用全局 `MAP`）。

### 5.10 API 工具函数（强烈建议使用，能显著降低出错率）

| 调用 | 返回 | 说明 |
| --- | --- | --- |
| `API.chebyshev(a,b)` | number | 切比雪夫距离，`a`/`b` 形如 `{x,y}` |
| `API.euclid(a,b)` | number | 欧氏距离（1 位小数） |
| `API.dirTo(from,to)` | `"N"｜"E"｜"S"｜"W"｜null` | 主方向；`|dx|>=|dy|` 时给 E/W，否则 N/S；同格 null |
| `API.step(pos,dir)` | `{x,y}` | 沿方向走一格（不校验通行性） |
| `API.isPassable(x,y,opts)` | boolean | `opts={ignoreUnits:false}`；默认把其他坦克视为障碍 |
| `API.hasLOS(a,b)` | boolean | 墙/森林阻挡视线（目标格不算阻挡） |
| `API.pathFind(from,to,opts)` | `["E","N",...]` 或 `null` | A* 最短路径方向序列；`opts={avoidUnits:true,maxNodes:4000}`；不可达返回 null |
| `API.neighbors(x,y)` | `[{dir,x,y,passable}]` | 四向邻格 |
| `API.isWall(x,y)` `API.isWater(x,y)` `API.isForest(x,y)` `API.isAmmo(x,y)` `API.isFuel(x,y)` `API.isResource(x,y)` `API.isDeposit(x,y)` `API.isSpawn(x,y)` | boolean | 地形/设施判定 |
| `API.random()` `API.randomInt(min,max)` | number | 确定性随机（`randomInt` 含两端） |
| `API.log(...)` | void | 调试日志（每回合 ≤20 条） |

### 5.11 必须处理的边界情况（模糊测试会随机抽查这些）

1. `state.enemies` 为空数组；`lastKnownEnemies` 为空。
2. 弹药为 0（不能射击）、燃油 < 2×`moveFuelCost`（走不动了）、载货已满（不能再采集）、HP 很低。
3. 目标格被其他坦克占住，或路径不存在（`pathFind` 返回 `null`）——必须给安全兜底（例如改道、等待、换目标）。
4. 站在设施上时动作成功；站在非设施上时不要发出补给/提交动作（浪费 AP）。
5. 资源点 `remaining` 为 `null` 或 0（看不见或已采空）。
6. 任何字段缺失或类型异常时都不能抛异常（用默认值兜底）。
7. `onTurn` 里出现未捕获异常 → 该回合记一次异常，累计 3 次你将被强制待机直到终局。