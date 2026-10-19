// packages/script-check/src/static-scan.ts —— L1 静态扫描
// 只在"去掉了注释与字符串字面量"的源码上扫描，避免把注释里提到的 Date 误判为违规。

export interface StaticIssue {
  rule: string;
  token: string;
  line: number;
  snippet: string;
}

export interface StaticScanResult {
  ok: boolean;
  issues: StaticIssue[];
  lines: number;
  hasOnTurn: boolean;
  hasOnInit: boolean;
}

interface Rule {
  rule: string;
  pattern: RegExp;
  /** 命中即拒（true）还是仅提示（false） */
  reject?: boolean;
}

const RULES: Rule[] = [
  { rule: "NO_REQUIRE", pattern: /\brequire\s*\(/ },
  { rule: "NO_IMPORT", pattern: /\bimport\s+[\s\S]*?\bfrom\b|\bimport\s*\(|\bimport\s*\{/ },
  { rule: "NO_EXPORT", pattern: /\bexport\s+(default|const|function|class|\{)/ },
  { rule: "NO_PROCESS", pattern: /\bprocess\s*\./ },
  { rule: "NO_GLOBAL_THIS", pattern: /\bglobalThis\b/ },
  { rule: "NO_EVAL", pattern: /(^|[^.\w])eval\s*\(/ },
  { rule: "NO_FUNCTION_CTOR", pattern: /\bnew\s+Function\s*\(/ },
  { rule: "NO_DATE", pattern: /\bDate\b/ },
  { rule: "NO_MATH_RANDOM", pattern: /\bMath\s*\.\s*random\b/ },
  { rule: "NO_FETCH", pattern: /\bfetch\s*\(/ },
  { rule: "NO_XHR", pattern: /\bXMLHttpRequest\b/ },
  { rule: "NO_WEBSOCKET", pattern: /\bWebSocket\b/ },
  { rule: "NO_WEBASSEMBLY", pattern: /\bWebAssembly\b/ },
  { rule: "NO_ATOMICS", pattern: /\bAtomics\b/ },
  { rule: "NO_SHARED_MEMORY", pattern: /\bSharedArrayBuffer\b/ },
  { rule: "NO_DYNAMIC_IMPORT", pattern: /\bimport\s*\(/ },
];

const INFINITE_LOOP_RULES: Rule[] = [
  { rule: "NO_WHILE_TRUE", pattern: /\bwhile\s*\(\s*(true|1)\s*\)/ },
  { rule: "NO_FOR_EMPTY", pattern: /\bfor\s*\(\s*;\s*;\s*\)/ },
  { rule: "NO_DO_WHILE_TRUE", pattern: /\bdo\s*\{[\s\S]*?\}\s*while\s*\(\s*(true|1)\s*\)/ },
];

/** 去掉块注释、行注释与字符串/模板字面量（保留换行以维持行号） */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let state: "code" | "line" | "block" | "squote" | "dquote" | "tick" = "code";
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { state = "squote"; out += " "; i += 1; continue; }
      if (c === '"') { state = "dquote"; out += " "; i += 1; continue; }
      if (c === "`") { state = "tick"; out += " "; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; } else out += " ";
      i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " ";
      i += 1; continue;
    }
    // 字符串内部
    const quote = state === "squote" ? "'" : state === "dquote" ? '"' : "`";
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === quote) { state = "code"; out += " "; i += 1; continue; }
    out += c === "\n" ? "\n" : " ";
    i += 1;
  }
  return out;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line += 1;
  return line;
}

export function staticScan(script: string, opts: { maxLines?: number } = {}): StaticScanResult {
  const maxLines = opts.maxLines ?? 600;
  const lines = script.split(/\r?\n/).length;
  const sanitized = stripCommentsAndStrings(script);
  const issues: StaticIssue[] = [];

  for (const r of [...RULES, ...INFINITE_LOOP_RULES]) {
    const m = r.pattern.exec(sanitized);
    if (m) {
      issues.push({
        rule: r.rule,
        token: m[0].trim(),
        line: lineOf(sanitized, m.index),
        snippet: (script.split(/\r?\n/)[lineOf(sanitized, m.index) - 1] ?? "").trim().slice(0, 160),
      });
    }
  }
  if (lines > maxLines) {
    issues.push({ rule: "TOO_MANY_LINES", token: `${lines} 行`, line: lines, snippet: `超过上限 ${maxLines} 行` });
  }

  const hasOnTurn = /function\s+onTurn\s*\(/.test(sanitized);
  const hasOnInit = /function\s+onInit\s*\(/.test(sanitized);
  if (!hasOnTurn) {
    issues.push({ rule: "MISSING_ON_TURN", token: "onTurn", line: 0, snippet: "必须定义 function onTurn(state)（函数声明形式）" });
  }
  return { ok: issues.length === 0, issues, lines, hasOnTurn, hasOnInit };
}