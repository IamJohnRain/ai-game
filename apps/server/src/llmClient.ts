// apps/server/src/llmClient.ts —— 极小的 OpenAI 兼容 chat 客户端（零依赖，只用 fetch）
//
// 用途只有一个：**观战解说**。组织者在自己那台服务器上填 baseUrl / modelId / apiKey，
// 平台在"生成解说"时调用 `${baseUrl}/chat/completions`，拿到一段 JSON 文本再解析成解说词。
//
// 设计取舍：
//   - 不引入任何 SDK：不同厂商（OpenAI / DeepSeek / 千问 / 本地 vLLM、Ollama 的兼容层）都实现了
//     同一套 /chat/completions，一个 fetch 就够了；SDK 反而会带来版本与打包负担。
//   - **不发 response_format**：不是所有兼容层都支持 json_object，靠提示词约束 + 宽容解析更稳。
//   - 超时可配（默认 60s），失败一律转成"人话"错误（401/404/超时/连不上），并原样带上服务端返回的片段，
//     让组织者能自己判断是地址不对、模型名不对还是额度/密钥问题。
import type { LlmSettings } from "./commentarySettings.ts";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmReply {
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  ms: number;
  /**
   * 模型的结束原因：`length` = 输出被 max_tokens 截断（推理模型很常见：思考 token 也算在里面）。
   * 调用方可以据此判断"这次的内容是不是完整的"。
   */
  finishReason: string | null;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 覆盖设置里的模型名（一般不用） */
  modelId?: string;
}

/** 把 baseUrl 归一到 /chat/completions：接受 `https://host/v1`、`https://host/v1/`、`https://host/v1/chat/completions` */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

/** 校验并归一 baseUrl；不合法就抛（错误文案直接给组织者看） */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("baseUrl 不能为空（例如 https://api.deepseek.com/v1）");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("baseUrl 不是合法 URL（形如 https://api.deepseek.com/v1）");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl 只支持 http/https");
  }
  // 末尾斜杠统一去掉；允许带 query（有些网关靠 query 区分租户），但不接受 fragment
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) return "请求超时（模型迟迟没有返回，可以把超时调大或换更快的模型）";
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|network/i.test(err.message)) {
      return `连不上这个地址（${err.message}）：域名/端口/代理是否可达？`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * 调一次 chat：返回助手文本。任何失败都抛 Error（消息已经是人话）。
 * 不做重试：解说是"尽力而为"的东西，失败了让用户点"重新生成"更清楚，也免得把额度烧在自动重试上。
 */
export async function chat(settings: LlmSettings, messages: LlmMessage[], opts: ChatOptions = {}): Promise<LlmReply> {
  const url = chatCompletionsUrl(settings.baseUrl);
  const controller = new AbortController();
  const timeoutMs = Math.max(3_000, Math.min(opts.timeoutMs ?? settings.timeoutMs, 300_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.modelId ?? settings.modelId,
          messages,
          temperature: opts.temperature ?? settings.temperature,
          max_tokens: opts.maxTokens ?? settings.maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(errText(err));
    }
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403
        ? "密钥被拒绝（检查 apiKey；注意不要多带空格或 Bearer 前缀）"
        : res.status === 404
          ? "接口不存在（baseUrl 一般写到 /v1，不要写到具体接口路径；也确认模型名）"
          : res.status === 429
            ? "被限流了（429）：稍后重试或换模型/额度"
            : res.status >= 500
              ? "模型服务端错误（5xx）：稍后重试"
              : "请求被拒绝";
      throw new Error(`${hint}：HTTP ${res.status} ${raw.slice(0, 300)}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`返回的不是 JSON（可能地址指向了网页而不是 API）：${raw.slice(0, 200)}`);
    }
    const parsed = body as {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      error?: { message?: unknown };
    };
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim().length === 0) {
      const msg = parsed.error?.message;
      throw new Error(`模型没有返回内容${msg ? `：${String(msg).slice(0, 200)}` : ""}（换一个 modelId 或检查账号额度）`);
    }
    const usage = parsed.usage
      ? {
          promptTokens: Math.max(0, Math.round(parsed.usage.prompt_tokens ?? 0)),
          completionTokens: Math.max(0, Math.round(parsed.usage.completion_tokens ?? 0)),
          totalTokens: Math.max(0, Math.round(parsed.usage.total_tokens ?? 0)),
        }
      : null;
    return { text, usage, ms: Date.now() - started, finishReason: parsed.choices?.[0]?.finish_reason ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/** 设置页的"测试连接"：发一句 ping，确认地址/密钥/模型名三者都对 */
export async function probe(settings: LlmSettings): Promise<{ ok: true; ms: number; model: string; reply: string } | { ok: false; error: string }> {
  try {
    const res = await chat(settings, [
      { role: "system", content: "你是连通性探针，只回一个词。" },
      { role: "user", content: "ping" },
    ], { maxTokens: 16, temperature: 0, timeoutMs: Math.min(settings.timeoutMs, 30_000) });
    return { ok: true, ms: res.ms, model: settings.modelId, reply: res.text.trim().slice(0, 80) };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}