// apps/server/src/config.ts —— 服务端配置（环境变量驱动）
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import {
  AUTH_USER,
  DEFAULT_FAILURE_WINDOW_MS,
  DEFAULT_MAX_FAILURES,
  DEFAULT_SESSION_TTL_MS,
  type AuthConfig,
} from "./auth.ts";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  masterKey: Buffer;
  /** 默认观战节奏 */
  defaultTurnIntervalMs: number;
  /** 单用户并发比赛数上限 */
  maxConcurrentMatches: number;
  /**
   * 对外可访问的基础地址（可选）：设置后，注册响应与任务书里的 URL 一律用它。
   * 用途：组织者自己可能是通过 SSH 隧道 / 内网地址访问平台的，但**外部 Agent 拿到的地址必须是它自己能访问到的那一个**。
   */
  publicUrl: string;
  /** 登录与会话：用户名固定，密码来自 AI_GAME_AUTH_PASSWORD（默认见 auth.ts） */
  auth: AuthConfig;
  /** 日志配置（测试时可关闭） */
  logger?: boolean | { level: string };
}

export function loadConfig(): ServerConfig {
  const port = Number(process.env.PORT ?? 8787);
  const dataDir = resolve(process.env.AI_GAME_DATA_DIR ?? join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });

  // 主密钥：优先环境变量；否则在数据目录生成一次并复用（开发便利；生产请用 KMS/环境变量）
  let masterKey: Buffer;
  const envKey = process.env.AI_GAME_MASTER_KEY;
  if (envKey) {
    masterKey = /^[0-9a-fA-F]{64}$/.test(envKey) ? Buffer.from(envKey, "hex") : Buffer.from(envKey, "base64");
    if (masterKey.length !== 32) throw new Error("AI_GAME_MASTER_KEY 必须是 32 字节（hex 64 位或 base64）");
  } else {
    const keyPath = join(dataDir, "master.key");
    if (existsSync(keyPath)) {
      masterKey = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    } else {
      masterKey = randomBytes(32);
      writeFileSync(keyPath, masterKey.toString("base64"), { mode: 0o600 });
      console.warn(`[config] 已生成开发用主密钥：${keyPath}（生产环境请改用 AI_GAME_MASTER_KEY 环境变量 / KMS）`);
    }
  }

  return {
    port,
    host: process.env.HOST ?? "127.0.0.1",
    dataDir,
    dbPath: join(dataDir, "ai-game.db"),
    masterKey,
    defaultTurnIntervalMs: Number(process.env.AI_GAME_TURN_INTERVAL_MS ?? 1200),
    maxConcurrentMatches: Number(process.env.AI_GAME_MAX_CONCURRENT ?? 4),
    publicUrl: (process.env.AI_GAME_PUBLIC_URL ?? "").trim().replace(/\/+$/, ""),
    auth: {
      // 用户名固定（需求如此）；密码**没有内置默认值**：
      // 优先 AI_GAME_AUTH_PASSWORD（.env），留空则由进程入口自动生成 data/auth.password（见 auth.ts）
      user: AUTH_USER,
      password: process.env.AI_GAME_AUTH_PASSWORD ?? "",
      sessionTtlMs: Number(process.env.AI_GAME_SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS),
      maxFailures: Number(process.env.AI_GAME_AUTH_MAX_FAILURES ?? DEFAULT_MAX_FAILURES),
      windowMs: Number(process.env.AI_GAME_AUTH_WINDOW_MS ?? DEFAULT_FAILURE_WINDOW_MS),
      cookieSecure: process.env.AI_GAME_COOKIE_SECURE === "1",
    },
  };
}