// packages/script-extract/src/index.ts —— 从模型回复中提取脚本（协议 §4）
// 现实情况：模型会加解释、加多个代码块、用不同语言标记，甚至整段都是代码。这里做宽容但确定的提取。

export type ExtractMethod = "fenced-js" | "fenced-plain" | "bare-code" | "none";

export interface ExtractResult {
  code: string | null;
  method: ExtractMethod;
  blockCount: number;
  /** 所有围栏块的信息（用于战报展示"模型到底输出了什么"） */
  blocks: { lang: string; length: number; hasOnTurn: boolean }[];
  error?: string;
}

const JS_LANGS = new Set(["js", "javascript", "jsx", "ts", "typescript", "node", "mjs", "cjs", ""]);
const FENCE_RE = /```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;

export function extractScript(response: string): ExtractResult {
  const text = typeof response === "string" ? response : "";
  const blocks: { lang: string; body: string; hasOnTurn: boolean }[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const lang = (m[1] ?? "").toLowerCase();
    const body = m[2] ?? "";
    blocks.push({ lang, body, hasOnTurn: /function\s+onTurn\s*\(/.test(body) || /onTurn\s*[:=]/.test(body) });
  }

  const info = blocks.map((b) => ({ lang: b.lang, length: b.body.length, hasOnTurn: b.hasOnTurn }));

  if (blocks.length > 0) {
    const candidates = blocks.filter((b) => JS_LANGS.has(b.lang));
    const pool = candidates.length > 0 ? candidates : blocks;
    const withOnTurn = pool.filter((b) => b.hasOnTurn);
    const chosenFrom = withOnTurn.length > 0 ? withOnTurn : pool;
    const chosen = chosenFrom.reduce((a, b) => (b.body.length > a.body.length ? b : a));
    const code = stripFenceResidue(chosen.body);
    if (!code.trim()) {
      return { code: null, method: "none", blockCount: blocks.length, blocks: info, error: "代码块为空" };
    }
    return {
      code,
      method: chosen.lang === "" ? "fenced-plain" : "fenced-js",
      blockCount: blocks.length,
      blocks: info,
    };
  }

  // 完全没有围栏：如果整段看起来就是代码，则宽容接受
  const trimmed = text.trim();
  if (/^(function\b|const\b|let\b|var\b|\/\*|\/\/|"use strict")/.test(trimmed) && trimmed.length > 0) {
    return { code: trimmed, method: "bare-code", blockCount: 0, blocks: [] };
  }
  return {
    code: null,
    method: "none",
    blockCount: 0,
    blocks: [],
    error: text.trim() ? "回复里没有找到 JavaScript 代码块（要求：恰好一个 ```js 代码块）" : "回复为空",
  };
}

function stripFenceResidue(body: string): string {
  return body
    .replace(/^\s*```[A-Za-z0-9_+-]*\s*$/gm, "") // 去掉嵌套/残留的围栏行
    .replace(/^\s*<\/?code[^>]*>\s*$/gm, "")     // 去掉 <code> 包装
    .trim();
}