// apps/server/src/secrets.ts —— 用主密钥把"组织者填的第三方密钥"加密后落库
//
// 为什么不用明文：库里躺着的是别人家 API 的密钥（data/ai-game.db 会备份、会被拷走），
// 主密钥在 data/master.key（0600）或 AI_GAME_MASTER_KEY 环境变量里，两者分离才算"落库也不裸奔"。
// 算法用 AES-256-GCM：带认证标签，密文被改一个字节就会解不开（而不是解出一段垃圾）。
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

/** 明文 → `v1:<iv b64>:<tag b64>:<密文 b64>` */
export function sealSecret(masterKey: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** 密文 → 明文；格式不对/主密钥换了/密文被改过都返回 null（调用方按"没配"处理，不抛异常） */
export function openSecret(masterKey: Buffer, sealed: string): string | null {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const ct = Buffer.from(parts[3]!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** 面板上回显用的掩码：只留前 4 与后 2 位，中间固定 4 个星号（不泄露长度） */
export function maskSecret(key: string): string {
  const s = key.trim();
  if (s.length === 0) return "";
  if (s.length <= 6) return `${s.slice(0, 1)}****`;
  return `${s.slice(0, 4)}****${s.slice(-2)}`;
}

/** 固定时间比对（避免用字符串比较判断密钥是否一致） */
export function sameSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}