// apps/server/test/auth.test.ts —— 登录、会话与"上传先验密钥再收文件"的验收
//
// 需求要点（本文件逐条覆盖）：
//   ① 用户名固定 JohnRyan，密码来自配置或首次启动自动生成（仓库里没有默认密码）；
//   ② 除"查询任务书"与"上传"外，所有界面与接口都要认证；
//   ③ 上传接口先验一次性密钥是否存在，不存在直接拒绝——**不接收、不校验上传的文件**。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { MapRegistry } from "../src/maps.ts";
import { createApp } from "../src/app.ts";
import { TournamentRunner } from "../src/tournaments.ts";
import { AUTH_USER, SESSION_COOKIE, readOrCreatePasswordFile, generateAuthPassword } from "../src/auth.ts";
import { DEFAULT_UPLOAD_LIMITS } from "@ai-game/zippack";

/** 测试里显式给一个密码：仓库中没有默认密码，密码必须来自配置或自动生成 */
const TEST_PASSWORD = "unit-test-password-1";

async function boot(overrides: Partial<ServerConfig["auth"]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-game-auth-"));
  const base = loadConfig();
  const config: ServerConfig = {
    ...base,
    port: 0,
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    masterKey: randomBytes(32),
    defaultTurnIntervalMs: 20,
    logger: false,
    auth: { ...base.auth, password: TEST_PASSWORD, ...overrides },
  };
  const store = new Store(config.dbPath, config.masterKey);
  const registry = new MapRegistry(join(dir, "maps"));
  const { app } = await createApp({ config, store, registry, tournamentRunners: new Map<string, TournamentRunner>() });
  await app.ready();
  return {
    app, store, config,
    close: async () => {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Ctx = Awaited<ReturnType<typeof boot>>;

/** 登录并返回 Set-Cookie 里的会话 Cookie 值（形如 ai_game_session=xxxx） */
async function login(ctx: Ctx, user = AUTH_USER, password = ctx.config.auth.password) {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user, password } });
  const raw = res.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0]! : (raw ?? "")).split(";")[0]!;
  return { res, cookie };
}

/** 造一个已注册的 Agent，返回它的一次性密钥明文 */
function seedKey(ctx: Ctx, opts: { uploaded?: boolean; attempts?: number; maxAttempts?: number } = {}) {
  const key = `ag_${randomBytes(16).toString("hex")}`;
  const keyHash = createHash("sha256").update(ctx.config.masterKey).update(key, "utf8").digest("hex");
  const id = `ag_${randomBytes(4).toString("hex")}`;
  ctx.store.createAgent({
    id, modelName: "test-model", agentName: "测试 Agent", thinkingLevel: "high", notes: "",
    keyHash, keyMasked: "ag_****test", maxAttempts: opts.maxAttempts ?? 10,
  });
  if (opts.attempts) for (let i = 0; i < opts.attempts; i++) ctx.store.bumpAgentAttempts(id);
  if (opts.uploaded) {
    ctx.store.markAgentUploaded(id, {
      script: "function onInit() {}\nfunction onTurn() { return []; }\n",
      scriptSha256: "0".repeat(64), zipSha256: "0".repeat(64), zipBytes: 1, meta: null, validation: [],
    });
  }
  return { id, key };
}

test("未登录：界面与接口都被挡（页面 302 到 /login，接口 401）", async () => {
  const ctx = await boot();
  try {
    const page = await ctx.app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 302);
    assert.match(page.headers.location as string, /^\/login\?next=/);

    for (const url of ["/api/agents", "/api/health", "/api/maps", "/api/tournaments", "/api/matches", "/api/leaderboard", "/api/auth/me"]) {
      const res = await ctx.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 401, `${url} 应要求登录`);
      assert.equal(res.json().stage, "auth", `${url} 的 401 应带 stage=auth`);
    }
    // 静态资源同样要登录（未登录不下发前端 bundle）
    const asset = await ctx.app.inject({ method: "GET", url: "/assets/index-whatever.js" });
    assert.equal(asset.statusCode, 302);
    // 写接口也不能裸奔
    const create = await ctx.app.inject({ method: "POST", url: "/api/agents", payload: { modelName: "m", agentName: "a" } });
    assert.equal(create.statusCode, 401);
  } finally {
    await ctx.close();
  }
});

test("免登录白名单：任务书、登录页、上传（上传另有一道密钥闸）", async () => {
  const ctx = await boot();
  try {
    const doc = await ctx.app.inject({ method: "GET", url: "/api/task-doc" });
    assert.equal(doc.statusCode, 200);
    assert.match(doc.body, /任务书/);

    const docJson = await ctx.app.inject({ method: "GET", url: "/api/task-doc?format=json&mapId=duel-01" });
    assert.equal(docJson.statusCode, 200);
    assert.equal(docJson.json().mapId, "duel-01");

    const page = await ctx.app.inject({ method: "GET", url: "/login" });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /JohnRyan/, "登录页应带出固定用户名");
    assert.match(page.headers["content-type"] as string, /text\/html/);

    const icon = await ctx.app.inject({ method: "GET", url: "/favicon.ico" });
    assert.ok(icon.statusCode === 204 || icon.statusCode === 200);
  } finally {
    await ctx.close();
  }
});

test("登录：用户名与密码都要对，成功后拿到 HttpOnly 会话 Cookie", async () => {
  const ctx = await boot();
  try {
    const wrongPassword = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user: AUTH_USER, password: "nope" } });
    assert.equal(wrongPassword.statusCode, 401);

    const wrongUser = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user: "RyanJohn", password: ctx.config.auth.password } });
    assert.equal(wrongUser.statusCode, 401);

    const { res, cookie } = await login(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user, AUTH_USER);
    assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
    const setCookie = (Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"][0]! : res.headers["set-cookie"]!) as string;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user, AUTH_USER);

    const agents = await ctx.app.inject({ method: "GET", url: "/api/agents", headers: { cookie } });
    assert.equal(agents.statusCode, 200);

    // 已登录再访问登录页：直接回站内，不重复登录
    const again = await ctx.app.inject({ method: "GET", url: "/login?next=/api/agents", headers: { cookie } });
    assert.equal(again.statusCode, 302);
    assert.equal(again.headers.location, "/api/agents");

    // 开放重定向防护：next 只允许站内绝对路径
    const evil = await ctx.app.inject({ method: "GET", url: "/login?next=//evil.example.com", headers: { cookie } });
    assert.equal(evil.statusCode, 302);
    assert.equal(evil.headers.location, "/", "站外地址必须被拒并回落 /");
  } finally {
    await ctx.close();
  }
});

test("密码来自配置：改了配置，旧密码立即失效（无需改代码）", async () => {
  const custom = "JohnRyan-custom-pw-2026";
  const ctx = await boot({ password: custom });
  try {
    const old = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user: AUTH_USER, password: TEST_PASSWORD } });
    assert.equal(old.statusCode, 401, "换配置前的密码在换过之后不应可用");
    const { res } = await login(ctx, AUTH_USER, custom);
    assert.equal(res.statusCode, 200);
  } finally {
    await ctx.close();
  }
});

test("仓库里没有默认密码：空密码直接拒绝启动，零配置则生成随机密码落到 data/auth.password", async () => {
  // ① 密码为空 → 构造 Auth 就报错（防止"忘记配置"变成"用某个内置密码能登进来"）
  await assert.rejects(
    () => boot({ password: "" }),
    /登录密码为空/,
    "空密码必须被拒绝，而不是回落到某个默认值",
  );

  // ② 零配置路径：随机生成 → 写进 data/auth.password（0600）→ 再次读取拿到同一个值
  const dir = mkdtempSync(join(tmpdir(), "ai-game-pwfile-"));
  try {
    const path = join(dir, "auth.password");
    const first = readOrCreatePasswordFile(path);
    assert.equal(first.created, true, "首次应生成");
    assert.ok(first.password.length >= 20, "生成的密码应有足够长度");
    assert.match(first.password, /^[A-Za-z0-9_-]+$/, "base64url 字符集");

    const second = readOrCreatePasswordFile(path);
    assert.equal(second.created, false);
    assert.equal(second.password, first.password, "重启后应沿用同一个密码");

    const another = generateAuthPassword();
    assert.notEqual(another, first.password, "每次都应是新随机值");
    assert.notEqual(another, generateAuthPassword());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("登出：服务端作废会话，旧 Cookie 立刻失效", async () => {
  const ctx = await boot();
  try {
    const { cookie } = await login(ctx);
    const before = await ctx.app.inject({ method: "GET", url: "/api/agents", headers: { cookie } });
    assert.equal(before.statusCode, 200);

    const out = await ctx.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    assert.equal(out.statusCode, 200);
    const cleared = (Array.isArray(out.headers["set-cookie"]) ? out.headers["set-cookie"][0]! : out.headers["set-cookie"]!) as string;
    assert.match(cleared, /Max-Age=0/);

    const after = await ctx.app.inject({ method: "GET", url: "/api/agents", headers: { cookie } });
    assert.equal(after.statusCode, 401, "会话已在服务端删除，旧 Cookie 不能再通过");
  } finally {
    await ctx.close();
  }
});

test("登录失败限流：同一来源连错 maxFailures 次后进入锁定，正确密码也先挡住", async () => {
  const ctx = await boot();
  try {
    for (let i = 1; i <= 9; i++) {
      const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user: AUTH_USER, password: `bad-${i}` } });
      assert.equal(res.statusCode, 401, `第 ${i} 次错误应为 401`);
    }
    const tenth = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user: AUTH_USER, password: "bad-10" } });
    assert.equal(tenth.statusCode, 429, "达到阈值应转入锁定");
    const evenCorrect = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { user: AUTH_USER, password: ctx.config.auth.password } });
    assert.equal(evenCorrect.statusCode, 429, "锁定期内不给登录，防爆破");
    assert.match(evenCorrect.json().error, /分钟/);
  } finally {
    await ctx.close();
  }
});

test("上传：先验一次性密钥，密钥不存在/已用过/次数用尽都在读 body 之前拒绝", async () => {
  const ctx = await boot();
  try {
    const zip = (size = 16) => Buffer.alloc(size, 0x41);
    const post = async (headers: Record<string, string>, payload: Buffer) =>
      ctx.app.inject({ method: "POST", url: "/api/upload", headers: { "content-type": "application/zip", ...headers }, payload });

    // ① 完全没有密钥
    const noKey = await post({}, zip());
    assert.equal(noKey.statusCode, 401);
    assert.equal(noKey.json().stage, "auth");

    // ② 密钥不存在 → 直接拒绝
    const unknown = await post({ authorization: `Bearer ag_${"0".repeat(32)}` }, zip());
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().stage, "auth");
    assert.match(unknown.json().error, /不存在/);

    // ③ 关键：密钥不存在 + 超过 200KB 的 body → 仍是 auth 拒绝，而不是 size（说明文件根本没被接收/解析）
    const bigUnknown = await post({ authorization: `Bearer ag_${"1".repeat(32)}` }, Buffer.alloc(DEFAULT_UPLOAD_LIMITS.maxZipBytes + 100 * 1024, 0x41));
    assert.equal(bigUnknown.statusCode, 401, "超大 body + 假密钥必须仍按鉴权拒绝");
    assert.equal(bigUnknown.json().stage, "auth");
    assert.notEqual(bigUnknown.json().stage, "size");

    // ④ 已成功使用过的密钥（一次性）
    const used = seedKey(ctx, { uploaded: true });
    const reused = await post({ authorization: `Bearer ${used.key}` }, zip());
    assert.equal(reused.statusCode, 409);
    assert.equal(reused.json().stage, "auth");
    assert.match(reused.json().error, /已成功使用过/);

    // ⑤ 尝试次数用尽的密钥
    const exhausted = seedKey(ctx, { attempts: 10, maxAttempts: 10 });
    const over = await post({ authorization: `Bearer ${exhausted.key}` }, zip());
    assert.equal(over.statusCode, 429);
    assert.equal(over.json().stage, "attempts");

    // ⑥ 反过来确认：密钥有效时体积闸门仍然生效（此时才会真正读 body）
    const fresh = seedKey(ctx);
    const tooBig = await post({ authorization: `Bearer ${fresh.key}` }, Buffer.alloc(DEFAULT_UPLOAD_LIMITS.maxZipBytes + 100 * 1024, 0x41));
    assert.equal(tooBig.statusCode, 413);
    assert.equal(tooBig.json().stage, "size");
  } finally {
    await ctx.close();
  }
});

test("观战 WebSocket：未登录握手被拒，带会话 Cookie 才能连上", async () => {
  const ctx = await boot();
  try {
    const { cookie } = await login(ctx);
    const addr = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const wsUrl = `${addr.replace(/^http/, "ws")}/ws/matches/m_does_not_exist`;

    const handshake = (headers?: Record<string, string>) =>
      new Promise<string>((resolve) => {
        // Node 的 WebSocket 支持第二参传 { headers }（DOM 类型里没有这个重载，这里显式转一下）
        const options = (headers ? { headers } : undefined) as unknown as string | string[] | undefined;
        const socket = new WebSocket(wsUrl, options);
        const timer = setTimeout(() => resolve("timeout"), 4000);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          socket.close();
          resolve("open");
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          resolve("rejected");
        });
      });

    assert.equal(await handshake(), "rejected", "没有会话不应完成 WS 握手");
    assert.equal(await handshake({ cookie }), "open", "带上会话 Cookie 应能握手（不存在的对局会收到 phase: failed，由前端提示）");
  } finally {
    await ctx.close();
  }
});