// apps/web/src/pages/CommentaryPage.tsx —— ⑦ 解说设置：给"上帝视角解说员"配一个外部模型
//
// 平台只在这一个地方调用外部模型（生成解说稿），所以配置必须一眼看懂：
// 地址/模型/密钥三项 + 自动开关 + 高级参数 + 一个"测试连接"按钮（真发一次请求，避免配错了到生成时才发现）。
// 密钥保存后只回掩码；表单里"留空"表示不修改已存的密钥（前端拿不到明文，也不该拿到）。
import { useEffect, useState } from "react";
import { api, ApiError, type CommentaryConfig, type CommentaryConfigPatch } from "../api";
import { Banner, Section } from "../ui";

type ProbeState = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; ms: number; model: string; reply: string } | { kind: "fail"; error: string };

export function CommentaryPage({ onOpenReplay }: { onOpenReplay?: () => void }) {
  const [config, setConfig] = useState<CommentaryConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [auto, setAuto] = useState(true);
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokens, setMaxTokens] = useState("1400");
  const [timeoutMs, setTimeoutMs] = useState("60000");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });

  const applyConfig = (c: CommentaryConfig) => {
    setConfig(c);
    setBaseUrl(c.baseUrl);
    setModelId(c.modelId);
    setAuto(c.auto);
    setTemperature(String(c.temperature));
    setMaxTokens(String(c.maxTokens));
    setTimeoutMs(String(c.timeoutMs));
    setApiKey("");
  };

  const load = () => {
    setError(null);
    api
      .commentarySettings()
      .then(applyConfig)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(load, []);

  const save = async () => {
    setSaving(true);
    setSaved(null);
    setProbe({ kind: "idle" });
    try {
      const patch: CommentaryConfigPatch = {
        baseUrl,
        modelId,
        auto,
        temperature: Number(temperature),
        maxTokens: Number(maxTokens),
        timeoutMs: Number(timeoutMs),
      };
      // 密钥：只有用户真的输入了才提交（留空 = 保持原样），输一个"清除"由下面的按钮负责
      if (apiKey.trim().length > 0) patch.apiKey = apiKey.trim();
      const next = await api.saveCommentarySettings(patch);
      applyConfig(next);
      setSaved(next.configured ? "已保存：三项齐全，可以生成解说了" : "已保存，但三项还没配全（baseUrl / modelId / apiKey 都填上才会生效）");
    } catch (err) {
      setSaved(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    setSaved(null);
    setProbe({ kind: "idle" });
    try {
      applyConfig(await api.saveCommentarySettings({ apiKey: "" }));
      setSaved("已清除保存的 apiKey");
    } catch (err) {
      setSaved(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setProbe({ kind: "busy" });
    try {
      const res = await api.testCommentary();
      if (res.ok) setProbe({ kind: "ok", ms: res.ms, model: res.model, reply: res.reply });
      else setProbe({ kind: "fail", error: res.error });
    } catch (err) {
      setProbe({ kind: "fail", error: err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="stack">
      <Section
        title="解说设置（上帝视角解说员）"
        extra={
          <button className="btn" onClick={load}>
            刷新
          </button>
        }
      >
        <p className="hint">
          这是平台<strong>唯一</strong>会调用外部模型的地方：配好之后，每场比赛可以生成一份解说稿，
          在观战/回放的右侧看板「<strong>🎙 解说</strong>」页签里按回放光标逐段播出
          （点某一句会跳到那一刻）。解说只讲<strong>双方的关键行为</strong>：交火与命中、阵亡与死因、
          踩雷与布雷、举盾与被弹开、提交得分、比分变化。
        </p>

        {error ? <Banner tone="error">读取配置失败：{error}</Banner> : null}

        <div className="field-grid">
          <label className="field">
            <span>baseUrl（OpenAI 兼容的 /chat/completions 基址）</span>
            <input
              type="text"
              value={baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>modelId（模型名）</span>
            <input
              type="text"
              value={modelId}
              placeholder="deepseek-chat / qwen-plus / gpt-4o-mini …"
              onChange={(e) => setModelId(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>apiKey{config?.hasApiKey ? `（已保存 ${config.apiKeyMasked}）` : ""}</span>
            <input
              type="password"
              value={apiKey}
              placeholder={config?.hasApiKey ? "留空 = 不修改已保存的密钥" : "sk-…（只写在服务端，接口只回掩码）"}
              onChange={(e) => setApiKey(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>

        <div className="field-grid">
          <label className="field">
            <span>温度（0~2，越大越活泼）</span>
            <input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </label>
          <label className="field">
            <span>单次最大输出 tokens</span>
            <input type="number" min={128} max={8192} step={64} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </label>
          <label className="field">
            <span>超时（毫秒）</span>
            <input type="number" min={5000} max={300000} step={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
          </label>
        </div>

        <label className="chip-toggle">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          每场比赛跑完后自动生成解说（关掉后只在打开回放时手动点「生成解说」）
        </label>

        <div className="row-actions">
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存配置"}
          </button>
          <button className="btn" onClick={() => void test()} disabled={probe.kind === "busy" || !config?.configured}>
            {probe.kind === "busy" ? "测试中…" : "测试连接"}
          </button>
          <button className="btn" onClick={() => void clearKey()} disabled={saving || !config?.hasApiKey}>
            清除已存密钥
          </button>
          {onOpenReplay ? (
            <button className="btn" onClick={onOpenReplay}>
              去回放看解说效果
            </button>
          ) : null}
        </div>

        {saved ? <div className="hint">{saved}</div> : null}
        {probe.kind === "ok" ? (
          <Banner tone="info">
            连接成功：{probe.ms}ms，模型 {probe.model}，返回「{probe.reply}」
          </Banner>
        ) : null}
        {probe.kind === "fail" ? <Banner tone="error">连接失败：{probe.error}</Banner> : null}
      </Section>

      <Section title="状态与口径">
        <ul className="hint-list">
          <li>
            配置状态：{config ? (config.configured ? "✅ 三项齐全，可以生成解说" : "⚠ 还没配全（baseUrl / modelId / apiKey）") : "读取中…"}
          </li>
          <li>
            已生成稿子：{config ? `${config.stats.ready} 场就绪 / ${config.stats.failed} 场失败（共 ${config.stats.total} 场）` : "-"}
            {config?.updatedAt ? `　最近保存：${new Date(config.updatedAt).toLocaleString()}` : ""}
          </li>
          <li>
            调用方式：`POST {baseUrl}/chat/completions`，一局约 3~6 次调用（事件流按"关键行为"压缩后分段送入）。
            失败会把原因写在稿子状态里（401 = 密钥、404 = 地址或模型名、超时 = 网络/限流）。
          </li>
          <li>
            密钥安全：apiKey 用 data/master.key 加密后存在 data/ai-game.db，接口只回掩码；
            「清成绩数据」不会动解说配置与已生成的稿子——稿子属于成绩，会被一起清掉（<code>clean-results</code>）。
          </li>
          <li>
            还没配之前，平台不会向任何外部地址发请求：解说页签只会显示"未配置解说模型"。
          </li>
        </ul>
      </Section>
    </div>
  );
}