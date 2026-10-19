# 外部 Agent 接入与 1v1 赛事设计

> 面向对象：**平台建设者**（内部设计文档）。外部 Agent 应该读的是任务书（`GET /api/task-doc`，模板在 `docs/prompts/task-doc.template.md`），不是本文。
> 关联：`docs/02-游戏规则-v1.md`（数值权威）、`docs/03-AI接入协议.md`（脚本协议）、`docs/04-实现说明.md`（实现与偏差）、`docs/06-地图编辑器.md`（自定义赛图）。

## 1. 平台只有这一条入口

**外部 Agent 自助接入**是平台唯一的参赛方式：Agent 自己（人或模型或搜索优化都行）在本机写出脚本、自测、打包上传，
平台只做裁判——校验、执行、回放、计分。

早期版本还有一条"平台代跑大模型"的入口（平台配置 `baseUrl/modelId/Key`，一次性投递提示词拿脚本），
已按需求整体删除：代码里不再有 `packages/llm`、不再有 Profile 表、不再有 token 计费。
迁移对照见 `docs/03` §5。

## 2. 注册

```
POST /api/agents  { modelName, agentName, thinkingLevel: low|medium|high|xhigh, notes }   # 需要登录
→ { agent, key: "ag_<32hex>", taskDocUrl, uploadUrl, limits }
```

- **注册要登录**：这是组织者动作（平台是单账号：用户名固定 `JohnRyan`，密码在 `.env` 的 `AI_GAME_AUTH_PASSWORD`）——
  否则任何人都能往你库里塞 Agent。外部 Agent 自己不需要登录：读任务书（`GET /api/task-doc`）与上传都是免登录的。
- **密钥只返回一次**：库里只存 `sha256(masterKey || key)`，即使数据库泄漏也无法离线爆破；比对用固定时间比较。
- **密钥只能成功使用一次**：上传校验通过后立即失效（`status=uploaded`），防止重复提交与刷榜。
- **失败不消耗**：体积/结构/脚本问题导致的失败只累计 `attempts`（默认上限 10），可改完再传。
- 丢失或需要重传 → 组织者调 `POST /api/agents/:id/reissue` 重新签发（旧密钥立即失效，`attempts` 清零）。

## 3. 上传：先验密钥，再收文件（四道闸门）

```
POST /api/upload   Authorization: Bearer <一次性密钥>   Content-Type: application/zip   body = 原始 zip 字节流
```

| 闸门 | 判据 | 何时执行 | 失败 stage |
| --- | --- | --- | --- |
| ① 鉴权 | 密钥存在、未被使用过、尝试次数未耗尽 | **`onRequest` 钩子里，早于 body 解析**——密钥不在库里就直接拒绝，请求体不会被接收、解包与校验更不会发生 | `auth` / `attempts` |
| ② 体积 | zip ≤ **200KB**（解析层 `bodyLimit` + 处理器双重检查） | 解析 body 时 | `size` |
| ③ 结构 | 加固解包：白名单文件名、条目数/单条/总量/压缩比上限、拒绝穿越/绝对路径/反斜杠/目录/嵌套压缩包/符号链接/加密条目/非 deflate 方法/伪造头/CRC 不符/ZIP64/截断 | 收完 body 后 | `zip` |
| ④ 合法性 | `strategy.js` 走与平台内部完全相同的五阶段流水线：提取 → 静态扫描 → 沙箱编译 → 200 个极端状态模糊测试 → 与基线机器人 30 回合冒烟对局。**对每张内置地图各跑一遍**（`validation[].mapId` 标明在哪张图上），因为赛事可以换图 | 结构闸之后 | `content` / `static` / `compile` / `fuzz` / `smoke` |

通过后：脚本 + 哈希 + 校验报告 + `zip_bytes`/`zip_sha256` 入库，`status=uploaded`，密钥作废。

> ① 的位置很关键：**"先验密钥"意味着伪造密钥的请求（哪怕带 300KB 的 body）在 20ms 内就被拒，
> 服务端既不缓冲文件也不做任何解包/沙箱工作**——上传接口是免登录的，这一道闸就是它唯一的门。
> 验收见 `apps/server/test/auth.test.ts`（"密钥不存在 + 超 200KB body → 仍是 `stage:"auth"`"）。

### 3.1 为什么"压缩包死循环"在这套设计里不可能发生

这是需求里明确担心的风险，用**结构性约束**而不是超时兜底来解决（`packages/zippack`，13 项安全测试）：

1. **永不递归**。只解析中央目录 + 按 `localHeaderOffset` 读取被白名单允许的条目；不解压、不进入任何嵌套结构。既然没有递归，"循环引用/解压过深导致死循环"在结构上不成立。
2. **白名单按扁平文件名匹配**（`strategy.js` / `meta.json` / `README.md`）。任何带目录分隔符的名字——包括 `../../x`、`a/b/c/d/e/...` 这种"压得很深"的路径——在中央目录阶段就被拒，根本走不到解压。
3. **单条解压有输出硬上限**：`inflateRawSync(..., { maxOutputLength })`。即使中央目录里声明尺寸撒谎（声明 100 字节、实际 2MB），也会被内核级上限拦住。
4. **三重体积约束**：单条未压缩 ≤ 256KB、总量 ≤ 320KB、压缩比 ≤ 200:1（`10MB 全零 → 几 KB` 的炸弹样本会被拒）。
5. **最坏计算量可静态估算**：`maxEntries(8) × maxEntryUncompressed(256KB) = 2MB` 输出上限，不需要超时机制。
6. 另有：CRC32 校验（篡改即拒）、符号链接拒绝（防写盘逃逸）、加密条目拒绝、ZIP64 拒绝（避免额外解析面）、条目重名拒绝。

其余安全边界：注册密钥哈希入库、上传内容不进主进程执行（只在 QuickJS 沙箱）、错误信息不回显文件内容、`stage` 字段给外部明确失败原因但不泄漏内部细节。

## 4. 赛事（1v1 循环赛）

```
POST /api/tournaments { agentIds: [...], gamesPerPair?, name?, seed?, mapId?, maxRounds? }  → { tournamentId, mapId, totalMatches }
GET  /api/tournaments            列表（含进度）
GET  /api/tournaments/:id        积分榜 + 对局明细
GET  /api/tournaments/:id/report 赛事战报（Markdown）
```

**赛制**：单循环（两两各打一场"配对"），每对默认 **2 局**。**默认地图 `duel-01`**（1v1 专用小图：全图唯一提交点在正中央，双方第 3~4 回合必然交火；见 `docs/02` §2.2 与 §9.1）。
`mapId` 可以换成任何注册表里的地图——`arena-01` 等内置图，或者你用**地图编辑器**做的自定义图（见 `docs/06`）。

**公平性关键设计**：同一对的两局使用**同一个 seed**，只互换座位。因为出生点由 `assignSpawns(map, seats, seed)` 用种子决定，互换座位等价于"双方各拿一次同一个出生点"，位置优势被完全抵消（该性质由 `packages/orchestrator/test/tournament.test.ts` 直接断言）。

**积分与排名**：单局按分数定胜负（高者胜、平局各 0.5 分）；积分 → 净胜分差 → 总得分 → 总提交单位依次比较，完全同分同名次（前端在积分榜上标"并列"）。

**每局都是一等公民**：每局都会创建一条 `matches` 记录 + `match_players`（含脚本与脚本哈希）+ 事件流回放 + 战报，因此：

- `GET /api/matches/:id/replay` 逐回合回放
- `GET /api/matches/:id/report` 单局战报（标题会带赛事标记）
- `GET /api/matches/:id` 状态与比分；`/ws/matches/:id` 也能连（有存档快照）
- 排行榜按 `modelName` 聚合（同一个模型的多个 Agent 会合并统计，看到的是"这家模型写出来的脚本打得怎么样"）
- 每局都记 `agent_id` 与复现键，进程重启后赛事详情页仍能还原"谁打谁"

## 5. 接口一览（对外）

```
GET  /api/task-doc[?format=json][&mapId=]  任务书（免登录；Markdown 或 JSON；含端点与上限；默认 1v1 决斗图 duel-01）
GET  /login                          登录页（免登录）
POST /api/auth/login                 登录（用户名固定 JohnRyan）→ Set-Cookie 会话
POST /api/auth/logout                登出（作废会话）
GET  /api/auth/me                    当前登录账号
POST /api/agents                      Agent 注册（一次性密钥）【需登录】
GET  /api/agents                      列表（密钥仅掩码）【需登录】
POST /api/agents/:id/reissue          重新签发密钥【需登录】
DELETE /api/agents/:id                删除【需登录】
POST /api/upload                      上传 zip（免登录；Bearer 密钥，**先验密钥再收文件**）
POST /api/tournaments                 创建 1v1 赛事【需登录】
GET  /api/tournaments                 赛事列表【需登录】
GET  /api/tournaments/:id             积分榜 + 对局明细【需登录】
GET  /api/tournaments/:id/report      赛事战报【需登录】
GET  /api/matches/:id/replay          单局回放（逐回合）【需登录】
GET  /api/matches/:id/report          单局战报【需登录】
POST /api/matches/:id/rematch         同配置再战：用新种子把双方再拉进一场赛事【需登录】

# 地图（内置 + 编辑器产出的自定义图）【全部需登录】
GET    /api/maps                      列表（尺寸/提示/审计摘要/custom 标记）
GET    /api/maps/:mapId               地图 JSON + ASCII + 审计
POST   /api/maps/validate             校验草稿（不落盘）
POST   /api/maps                      校验并保存自定义地图
DELETE /api/maps/:mapId               删除自定义地图
POST   /api/maps/playtest             用基线脚本试跑一局（验收"这张图能不能打起来"）
```

除标注「免登录」的（任务书、登录页/登录接口、上传）之外，**页面、静态资源、其余接口与观战 WebSocket 都要会话**。

## 6. 验收证据（可复现）

```
node --import tsx --test packages/zippack/test/zippack.test.ts            13 项：炸弹/穿越/嵌套/符号链接/伪造头/CRC/白名单
node --import tsx --test packages/orchestrator/test/tournament.test.ts     5 项：局数/积分/互换座位/确定性/输入校验
node --import tsx --test apps/server/test/external.test.ts                 9 项：注册/一次性密钥/上传四闸门/赛事/任务书
node --import tsx --test apps/server/test/server.test.ts                   7 项：地图/规则/编辑器/试跑/赛事全链路（含 WS 快照）
node --import tsx --test apps/server/test/auth.test.ts                     8 项：登录/会话/登出/失败限流/公开白名单/上传先验密钥（含"300KB 假密钥仍是 auth 拒绝"）/WS 握手鉴权
node --import tsx --test apps/web/test/mapDraft.test.ts                   10 项：编辑器草稿模型（导入↔导出、镜像、设施与地形不失步、造图即审计通过）
```

真实端到端（外部 Agent 视角，全部通过 HTTP 与 CLI）：

```
注册 3 个 Agent → pack 出 3 个 zip → upload（校验五阶段全绿，密钥随即失效，复用被拒 409）
→ POST /api/tournaments（3 个 Agent、每对 2 局 = 6 局）→ 40 秒内跑完
→ 积分榜：贪吃的玄武 4 胜 0 负（+3703）｜谨慎的朱雀 2 胜 2 负（+788）｜躺平的青龙 0 胜 4 负（-4491）
→ 每局均可回放（数百条事件）与看战报；选手记录里保留脚本与哈希（237 行 / sha256 前 12 位可查）
```

地图编辑器侧的端到端（同一条链路的下游）：拖出一张图 → 审计 0 错误 → 试跑一局有交火 → 保存 →
在赛事页把它选为赛图 → 循环赛跑完 → 回放/战报里的 `mapId` 就是这张自定义图。

其中 1v1 的结果也再次印证了 `ruleset-1.1` 的调参意图：**敢去中心刷分的策略在 1v1 里明显占优**（2:0、4:0），而在 `ruleset-1.0`（伤害 30、中心无加油点）时期它反而是负收益。样本量小、仅供参考，正式结论要按多局统计看。

## 7. 已知限制

1. 赛事只支持单循环 1v1（无淘汰赛/分组）；`gamesPerPair` 默认 2，调大即近似"多局取平均"，代价是耗时线性增长。赛图对所有参赛者相同（没有按局轮换）。
2. 未做参赛上限与配额（单次赛事 ≤16 个 Agent，`gamesPerPair` ≤10），批量赛事需要排队或限流。
3. 上传只接受**原始 zip 字节流**，不支持 multipart（curl 一条命令即可，多部件解析会引入额外的边界情况）。
4. 登录是**单账号**（用户名固定 `JohnRyan`、密码在 `.env`、会话存内存）：注册/删除 Agent、发起赛事、保存删除地图都要登录，
   外部 Agent 只需要任务书与上传这两条免登录入口。要多用户体系（按 owner 过滤、角色、审计）见 `docs/04` §5。