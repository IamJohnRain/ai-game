// apps/server/src/agentKeys.ts —— Agent 注册密钥的生成与校验
// 设计：密钥明文只在注册响应里出现一次，库里只存 sha256(masterKey || key)。
// 用主密钥参与哈希，即使数据库泄漏也无法离线爆破注册密钥；比对用固定时间比较。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateAgentKey(): string {
  return `ag_${randomBytes(16).toString("hex")}`;
}

export function hashAgentKey(key: string, masterKey: Buffer): string {
  return createHash("sha256").update(masterKey).update(key, "utf8").digest("hex");
}

export function maskAgentKey(key: string): string {
  return key.length <= 8 ? "ag_****" : `${key.slice(0, 5)}****${key.slice(-4)}`;
}

export function keyEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** 从 Authorization 头里取 Bearer 密钥 */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}