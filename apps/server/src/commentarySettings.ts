// apps/server/src/commentarySettings.ts —— 观战解说的配置读写（组织者填 baseUrl / modelId / apiKey）
//
// 存法：settings 表按 key 存；apiKey 用 master.key 加密（secrets.ts），读取时才解出来，
// **任何接口都不回显明文**（只回掩码）。这里是"配置"而不是"成绩"，所以 clean-results 不动它。
import type { Store } from "./store.ts";
import { maskSecret, openSecret, sealSecret } from "./secrets.ts";
import { normalizeBaseUrl } from "./llmClient.ts";

export interface LlmSettings {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

/** 设置页看到的东西：密钥只给掩码；auto = 每场比赛跑完后后台自动生成解说 */
export interface CommentaryConfigView {
  configured: boolean;
  baseUrl: string;
  modelId: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  auto: boolean;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  updatedAt: string | null;
  stats: { total: number; ready: number; failed: number };
}

export const COMMENTARY_KEYS = {
  baseUrl: "commentary.baseUrl",
  modelId: "commentary.modelId",
  apiKey: "commentary.apiKey",
  auto: "commentary.auto",
  temperature: "commentary.temperature",
  maxTokens: "commentary.maxTokens",
  timeoutMs: "commentary.timeoutMs",
  updatedAt: "commentary.updatedAt",
} as const;

export const COMMENTARY_DEFAULTS = {
  auto: true,
  temperature: 0.7,
  // 4000 而不是 1400：推理模型（MiniMax-M3、DeepSeek-R1 这类）的"思考 token"也算在
  // max_tokens 里，额度太小会把输出截断成半截 JSON（2026-10-22 实测踩过）。
  // max_tokens 只是上限，不会多花钱——模型写多少算多少。
  maxTokens: 6000,
  // 单次调用 180s：推理模型（MiniMax-M3）实测 12 条事实要 ~60s，思考 token 吃得多，
  // 60s/120s 都会误杀（表现为"请求超时"）。
  timeoutMs: 180_000,
};

function clampNumber(raw: string | null, fallback: number, lo: number, hi: number, integer = true): number {
  // 注意 Number(null) === 0：没存过（null/空串）必须回落到默认值，否则面板会显示 0/128/5000
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.max(lo, Math.min(hi, n));
  return integer ? Math.round(v) : Math.round(v * 100) / 100; // 温度是小数，不能被四舍五入成整数
}

/** 读出可直接用于调用模型的配置；缺 baseUrl/modelId/apiKey 任一项 → null（视为"还没配"） */
export function loadLlmSettings(store: Store, masterKey: Buffer): LlmSettings | null {
  const baseUrl = (store.getSetting(COMMENTARY_KEYS.baseUrl) ?? "").trim();
  const modelId = (store.getSetting(COMMENTARY_KEYS.modelId) ?? "").trim();
  const sealed = store.getSetting(COMMENTARY_KEYS.apiKey);
  const apiKey = sealed ? openSecret(masterKey, sealed) : null;
  if (!baseUrl || !modelId || !apiKey) return null;
  return {
    baseUrl,
    modelId,
    apiKey,
    temperature: clampNumber(store.getSetting(COMMENTARY_KEYS.temperature), COMMENTARY_DEFAULTS.temperature, 0, 2, false),
    maxTokens: clampNumber(store.getSetting(COMMENTARY_KEYS.maxTokens), COMMENTARY_DEFAULTS.maxTokens, 128, 16384),
    timeoutMs: clampNumber(store.getSetting(COMMENTARY_KEYS.timeoutMs), COMMENTARY_DEFAULTS.timeoutMs, 5_000, 300_000),
  };
}

export function isAutoEnabled(store: Store): boolean {
  const raw = store.getSetting(COMMENTARY_KEYS.auto);
  if (raw === null) return COMMENTARY_DEFAULTS.auto;
  return raw === "1";
}

export function readCommentaryConfig(store: Store, masterKey: Buffer): CommentaryConfigView {
  const sealed = store.getSetting(COMMENTARY_KEYS.apiKey);
  const apiKey = sealed ? openSecret(masterKey, sealed) : null;
  const baseUrl = (store.getSetting(COMMENTARY_KEYS.baseUrl) ?? "").trim();
  const modelId = (store.getSetting(COMMENTARY_KEYS.modelId) ?? "").trim();
  return {
    configured: Boolean(baseUrl && modelId && apiKey),
    baseUrl,
    modelId,
    apiKeyMasked: apiKey ? maskSecret(apiKey) : "",
    hasApiKey: Boolean(apiKey),
    auto: isAutoEnabled(store),
    temperature: clampNumber(store.getSetting(COMMENTARY_KEYS.temperature), COMMENTARY_DEFAULTS.temperature, 0, 2, false),
    maxTokens: clampNumber(store.getSetting(COMMENTARY_KEYS.maxTokens), COMMENTARY_DEFAULTS.maxTokens, 128, 16384),
    timeoutMs: clampNumber(store.getSetting(COMMENTARY_KEYS.timeoutMs), COMMENTARY_DEFAULTS.timeoutMs, 5_000, 300_000),
    updatedAt: store.getSetting(COMMENTARY_KEYS.updatedAt),
    stats: store.commentaryStats(),
  };
}

export interface CommentaryConfigPatch {
  baseUrl?: string;
  modelId?: string;
  /** 传了才改：空串 = 清除密钥；不传 = 保持原样（前端表单不会回显明文，所以"留空"必须是"不改"） */
  apiKey?: string;
  auto?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export function saveCommentaryConfig(store: Store, masterKey: Buffer, patch: CommentaryConfigPatch): CommentaryConfigView {
  if (patch.baseUrl !== undefined) {
    const normalized = normalizeBaseUrl(patch.baseUrl); // 不合法直接抛，路由把它翻成 400
    store.setSetting(COMMENTARY_KEYS.baseUrl, normalized);
  }
  if (patch.modelId !== undefined) {
    const model = patch.modelId.trim();
    if (model.length === 0) store.setSetting(COMMENTARY_KEYS.modelId, null);
    else store.setSetting(COMMENTARY_KEYS.modelId, model.slice(0, 200));
  }
  if (patch.apiKey !== undefined) {
    const key = patch.apiKey.trim();
    if (key.length === 0) store.setSetting(COMMENTARY_KEYS.apiKey, null);
    else store.setSetting(COMMENTARY_KEYS.apiKey, sealSecret(masterKey, key.slice(0, 500)));
  }
  if (patch.auto !== undefined) store.setSetting(COMMENTARY_KEYS.auto, patch.auto ? "1" : "0");
  if (patch.temperature !== undefined) store.setSetting(COMMENTARY_KEYS.temperature, String(clampNumber(String(patch.temperature), COMMENTARY_DEFAULTS.temperature, 0, 2, false)));
  if (patch.maxTokens !== undefined) store.setSetting(COMMENTARY_KEYS.maxTokens, String(clampNumber(String(patch.maxTokens), COMMENTARY_DEFAULTS.maxTokens, 128, 8192)));
  if (patch.timeoutMs !== undefined) store.setSetting(COMMENTARY_KEYS.timeoutMs, String(clampNumber(String(patch.timeoutMs), COMMENTARY_DEFAULTS.timeoutMs, 5_000, 300_000)));
  store.setSetting(COMMENTARY_KEYS.updatedAt, new Date().toISOString());
  return readCommentaryConfig(store, masterKey);
}