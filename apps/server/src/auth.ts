// apps/server/src/auth.ts —— 登录与会话（单账号：用户名固定，密码来自配置）
//
// 几条设计取舍：
// - **仓库里不留任何默认密码**：密码要么来自 `AI_GAME_AUTH_PASSWORD`（`.env`），要么由服务首次启动时
//   随机生成并落到 `data/auth.password`（0600）——`data/` 已被 .gitignore 排除，所以永远只有部署机知道它。
// - **会话存内存**：重启服务 = 全部退出登录。单进程、单账号的平台没必要为此引入持久化会话表
//   （真要多实例部署时再换 Redis/DB，见 docs/04 §5）。
// - **凭据走 Cookie 而不是 Authorization 头**：观战 WebSocket 的握手没法带自定义头，但浏览器会自动带 Cookie；
//   对 fetch/XHR 也一样，前端不需要在每个调用点塞 token。
// - **密码比对用 sha256 + timingSafeEqual**（固定时间），不逐字节比较，避免泄漏长度与前缀信息。
// - **登录失败按来源计次**：窗口内超过阈值就锁一段时间，挡住在线爆破（内存计数，重启即清零）。
// - **白名单之外的一切都要登录**：页面、静态资源、/api、/ws。免登录的只有任务书（外部 Agent 要读）、
//   上传（改用一次性密钥把关，且先验密钥再收文件）和登录页自身。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const SESSION_COOKIE = "ai_game_session";
/** 用户名固定（需求如此），密码可改 */
export const AUTH_USER = "JohnRyan";
/** 零配置启动时，随机密码落在这个文件里（相对 data 目录）；仓库里不含任何密码 */
export const AUTH_PASSWORD_FILE = "auth.password";

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_FAILURES = 10;
export const DEFAULT_FAILURE_WINDOW_MS = 10 * 60 * 1000;

export interface AuthConfig {
  user: string;
  password: string;
  sessionTtlMs: number;
  maxFailures: number;
  windowMs: number;
  /** 走 HTTPS 时打开（Cookie 加 Secure） */
  cookieSecure: boolean;
}

export interface Session {
  user: string;
  createdAt: number;
  expiresAt: number;
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: 401 | 429; error: string };

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function sameSecret(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 生成一个 24 字符的 base64url 随机密码（18 字节熵 ≈ 144 bit） */
export function generateAuthPassword(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * 读取 data/auth.password；文件不存在（或为空）就生成一个随机密码写进去（0600）。
 * 用途：`AI_GAME_AUTH_PASSWORD` 没配置时（本地开发、临时起服务）也能安全地跑起来——
 * 密码只存在部署机的数据目录里，仓库与镜像里都不留任何默认值。
 */
export function readOrCreatePasswordFile(path: string): { password: string; created: boolean } {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return { password: existing, created: false };
  } catch {
    // 不存在或不可读 → 走生成分支
  }
  const password = generateAuthPassword();
  writeFileSync(path, `${password}\n`, { mode: 0o600 });
  return { password, created: true };
}

export class Auth {
  private readonly passwordHash: Buffer;
  private readonly sessions = new Map<string, Session>();
  private readonly failures = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();

  constructor(private readonly cfg: AuthConfig) {
    if (!cfg.password) {
      throw new Error(
        "登录密码为空：请设置 AI_GAME_AUTH_PASSWORD（或在部署机上让服务首次启动自动生成 data/auth.password）",
      );
    }
    this.passwordHash = sha256(cfg.password);
  }

  get user(): string {
    return this.cfg.user;
  }
  get sessionTtlMs(): number {
    return this.cfg.sessionTtlMs;
  }
  get cookieSecure(): boolean {
    return this.cfg.cookieSecure;
  }
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 用户名与密码都对才通过；两个比较都做完，避免短路带来的时间差 */
  verify(user: string, password: string): boolean {
    const userOk = sameSecret(sha256(user.trim()), sha256(this.cfg.user));
    const passOk = sameSecret(sha256(password), this.passwordHash);
    return userOk && passOk;
  }

  login(user: string, password: string, source: string): LoginResult {
    const now = Date.now();
    const failure = this.failures.get(source);
    if (failure && failure.blockedUntil > now) {
      const minutes = Math.ceil((failure.blockedUntil - now) / 60000);
      return { ok: false, status: 429, error: `登录失败次数过多，请 ${minutes} 分钟后再试` };
    }
    if (!this.verify(user, password)) {
      const withinWindow = failure && now - failure.firstAt <= this.cfg.windowMs;
      const next = withinWindow ? { ...failure, count: failure.count + 1 } : { count: 1, firstAt: now, blockedUntil: 0 };
      if (next.count >= this.cfg.maxFailures) next.blockedUntil = now + this.cfg.windowMs;
      this.failures.set(source, next);
      if (next.blockedUntil > now) {
        return {
          ok: false,
          status: 429,
          error: `登录失败次数过多（${next.count} 次），请 ${Math.ceil(this.cfg.windowMs / 60000)} 分钟后再试`,
        };
      }
      return { ok: false, status: 401, error: "用户名或密码错误" };
    }
    this.failures.delete(source);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.cfg.sessionTtlMs;
    this.sessions.set(token, { user: this.cfg.user, createdAt: now, expiresAt });
    this.sweep();
    return { ok: true, token, expiresAt };
  }

  /** 有效则返回会话；过期的顺手删掉 */
  authenticate(token: string | undefined | null): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  logout(token: string | undefined | null): void {
    if (token) this.sessions.delete(token);
  }

  /** 清理过期会话与失效的失败计数（每次登录时顺带跑一遍，平台规模下这点开销可忽略） */
  private sweep(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
    for (const [source, failure] of this.failures) {
      if (failure.blockedUntil <= now && now - failure.firstAt > this.cfg.windowMs) this.failures.delete(source);
    }
  }
}

/** 解析 Cookie 头（只处理我们关心的那一个字段，够用且不引依赖） */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function sessionCookieValue(token: string, ttlMs: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(1, Math.floor(ttlMs / 1000))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieValue(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 免登录路径（方法 + 精确路径，不含查询串）：白名单之外一律要求会话 */
const PUBLIC_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/login"],
  ["HEAD", "/login"],
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/logout"],
  ["GET", "/api/task-doc"],
  ["HEAD", "/api/task-doc"],
  ["POST", "/api/upload"],
  // 练习通道：与上传同属"外部 Agent 免登录"入口（自己用一次性密钥把关，见 practice.ts）
  ["POST", "/api/practice"],
  ["GET", "/favicon.ico"],
];

export function isPublicRoute(method: string, url: string): boolean {
  const path = (url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  const verb = method.toUpperCase();
  return PUBLIC_ROUTES.some(([m, p]) => m === verb && p === path);
}

/** 登录后跳哪儿：只允许站内绝对路径，挡掉 //evil.com 这类开放重定向 */
export function safeNextPath(next: unknown, fallback = "/"): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (next.startsWith("/login")) return fallback;
  return next;
}