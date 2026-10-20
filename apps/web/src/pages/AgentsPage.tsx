// apps/web/src/pages/AgentsPage.tsx —— ⑦ 外部 Agent 自助接入：注册（一次性密钥）→ 拉任务文档 → 自写脚本上传
//
// 设计要点：后端只在注册/重发响应里返回一次明文 key，前端因此把它放在独立 state 里，
// 与"刷新列表"彻底解耦——刷新 Agent 列表不会让用户还没复制的密钥消失。
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Agent,
  type AgentRegisterResult,
  type ThinkingLevel,
  type TaskDocJson,
  type UploadLimits,
} from "../api";
import {
  Badge,
  Banner,
  EmptyState,
  Section,
  agentStatusInfo,
  fmtBytes,
  fmtTime,
} from "../ui";

const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "low", label: "low（低）" },
  { value: "medium", label: "medium（默认）" },
  { value: "high", label: "high（高）" },
  { value: "xhigh", label: "xhigh（极高）" },
];

type FormState = { modelName: string; agentName: string; thinkingLevel: ThinkingLevel; notes: string };

const EMPTY_FORM: FormState = { modelName: "", agentName: "", thinkingLevel: "medium", notes: "" };

/** 一次性的凭证信息：key 来自注册/重发响应，其余字段来自注册响应或任务文档 JSON（重发响应不带） */
type Credential = {
  key: string;
  agent: Agent;
  uploadUrl: string | null;
  taskDocUrl: string;
  limits: UploadLimits | null;
  /** 可直接粘给目标 Agent 的启动提示（服务端渲染；老版本服务端不返回时为 null） */
  prompt: string | null;
  origin: "register" | "reissue";
};

/**
 * 复制到剪贴板。优先用异步 Clipboard API；在内网 http 非安全上下文里它不可用，
 * 退回 textarea + execCommand 的老办法，保证"一键复制密钥"在部署环境里也真的能用。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走兜底方案
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 后端可能返回相对路径或绝对 URL，统一成可以直接放进 href / 拼接 curl 的形式 */
function asHref(url: string): string {
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) return url;
  return `/${url}`;
}

/** 上传限制表：注册响应与任务文档 JSON 都带 limits，两处展示共用这一份渲染 */
function LimitsTable({ limits }: { limits: UploadLimits }) {
  return (
    <table className="table table-dense table-auto">
      <thead>
        <tr>
          <th>限制项</th>
          <th>值</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>zip 体积上限</td>
          <td className="mono">{fmtBytes(limits.zipMaxBytes)}</td>
          <td className="muted small">{limits.zipMaxBytes} 字节</td>
        </tr>
        <tr>
          <td>zip 条目数上限</td>
          <td className="mono">{limits.maxEntries}</td>
          <td className="muted small">压缩包内文件个数</td>
        </tr>
        <tr>
          <td>解压后总大小上限</td>
          <td className="mono">{fmtBytes(limits.maxUncompressedBytes)}</td>
          <td className="muted small">防 zip 炸弹</td>
        </tr>
        <tr>
          <td>最大压缩比</td>
          <td className="mono">{limits.maxRatio}×</td>
          <td className="muted small">解压后 / 压缩后</td>
        </tr>
        <tr>
          <td>脚本最大行数</td>
          <td className="mono">{limits.maxScriptLines}</td>
          <td className="muted small">策略脚本上限</td>
        </tr>
        <tr>
          <td>最大上传尝试次数</td>
          <td className="mono">{limits.maxUploadAttempts}</td>
          <td className="muted small">超出后该密钥作废</td>
        </tr>
      </tbody>
    </table>
  );
}

export function AgentsPage({ onGotoTournament }: { onGotoTournament: (tournamentId?: string) => void }) {
  /** 空态里的"去注册"按钮用它把光标送回表单 */
  const modelNameRef = useRef<HTMLInputElement>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [registering, setRegistering] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [credential, setCredential] = useState<Credential | null>(null);
  const [copyState, setCopyState] = useState<{ text: string; ok: boolean } | null>(null);

  const [taskDoc, setTaskDoc] = useState<TaskDocJson | null>(null);
  const [taskDocError, setTaskDocError] = useState<string | null>(null);
  const [docPreview, setDocPreview] = useState<
    { state: "loading" } | { state: "ok"; markdown: string } | { state: "fail"; error: string } | null
  >(null);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setListError(null);
    api
      .listAgents()
      .then((res) => setAgents(res.agents))
      .catch((err: unknown) => {
        setAgents([]);
        setListError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(load, [load]);

  // 任务文档 JSON：注册前就给"上传接口 / 限制"区域提供内容，也作为重发密钥时上传地址与 limits 的兜底来源
  useEffect(() => {
    let alive = true;
    api
      .getTaskDocJson()
      .then((doc) => {
        if (!alive) return;
        setTaskDoc(doc);
        setTaskDocError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setTaskDocError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const copy = useCallback(async (label: string, text: string) => {
    const ok = await copyText(text);
    setCopyState({ text: ok ? `已复制${label}` : "复制失败：请手动选中文本后复制", ok });
    window.setTimeout(() => setCopyState(null), 2500);
  }, []);

  const submit = async () => {
    setFormError(null);
    if (!form.modelName.trim()) {
      setFormError("模型名称必填（例如 deepseek-v3 / gpt-4o）");
      return;
    }
    if (!form.agentName.trim()) {
      setFormError("Agent 名称必填（用于赛事积分榜展示）");
      return;
    }
    setRegistering(true);
    try {
      const res: AgentRegisterResult = await api.registerAgent({
        modelName: form.modelName.trim(),
        agentName: form.agentName.trim(),
        thinkingLevel: form.thinkingLevel,
        notes: form.notes.trim(),
      });
      setCredential({
        key: res.key,
        agent: res.agent,
        uploadUrl: res.uploadUrl ? asHref(res.uploadUrl) : null,
        taskDocUrl: res.taskDocUrl ? asHref(res.taskDocUrl) : "/api/task-doc",
        limits: res.limits ?? null,
        prompt: res.prompt ?? null,
        origin: "register",
      });
      setCopyState(null);
      // 表单清空：密钥已经落在上方面板里，避免手滑重复注册出第二个 Agent
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegistering(false);
    }
  };

  const reissue = async (a: Agent) => {
    setActionError(null);
    setBusy(a.id);
    try {
      const res = await api.reissueAgentKey(a.id);
      // 重发的 prompt 里带的是**新密钥**：旧的 prompt 从这一刻起就是废的，不能沿用
      setCredential((cur) => ({
        key: res.key,
        agent: res.agent,
        uploadUrl: res.uploadUrl ? asHref(res.uploadUrl) : (cur?.uploadUrl ?? (taskDoc ? asHref(taskDoc.endpoints.upload) : null)),
        taskDocUrl: res.taskDocUrl ? asHref(res.taskDocUrl) : (cur?.taskDocUrl ?? "/api/task-doc"),
        limits: cur?.limits ?? taskDoc?.limits ?? null,
        prompt: res.prompt ?? null,
        origin: "reissue",
      }));
      setCopyState(null);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (a: Agent) => {
    // 二次确认：删除会让密钥立刻失效并清掉已入库脚本，属于不可撤销操作
    if (!window.confirm(`删除 Agent「${a.agentName}」？其密钥立即失效，已上传的脚本也会从仓库移除。`)) return;
    setActionError(null);
    setBusy(a.id);
    try {
      await api.deleteAgent(a.id);
      if (credential?.agent.id === a.id) setCredential(null);
      if (expanded === a.id) setExpanded(null);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const loadDocPreview = async () => {
    setDocPreview({ state: "loading" });
    try {
      const markdown = await api.getTaskDoc();
      setDocPreview({ state: "ok", markdown });
    } catch (err) {
      setDocPreview({ state: "fail", error: err instanceof Error ? err.message : String(err) });
    }
  };

  // 展示用的上传地址 / 限制：优先用本次注册响应的真实值，其次任务文档 JSON，最后为空时只展示占位提示
  const uploadUrl = credential?.uploadUrl ?? (taskDoc ? asHref(taskDoc.endpoints.upload) : null);
  const limits = credential?.limits ?? taskDoc?.limits ?? null;
  const taskDocUrl = credential?.taskDocUrl ?? "/api/task-doc";
  const keyForCurl = credential?.key ?? "<key>";
  const curlExample = uploadUrl
    ? `curl -X POST ${uploadUrl} -H "Authorization: Bearer ${keyForCurl}" -H "Content-Type: application/zip" --data-binary @strategy.zip`
    : null;

  return (
    <div className="stack">
      <Section
        title="注册外部 Agent"
        extra={
          <>
            <button className="btn" onClick={load}>
              刷新列表
            </button>
            <button className="btn" onClick={() => onGotoTournament()}>
              下一步：发起赛事
            </button>
          </>
        }
      >
        <p className="hint">
          这里走的是<strong>外部自助流程</strong>：你在自己的环境里让 Agent 拉取任务文档、自己写策略脚本，打成 zip 后凭密钥上传；
          平台只负责校验入库与跑比赛。密钥<strong>只在注册（或重新签发）的那一刻返回一次</strong>，
          且一次只能用于一次上传——请立刻复制走。
        </p>

        <div className="form-grid">
          <label className="field">
            <span>模型名称（必填）</span>
            <input
              ref={modelNameRef}
              value={form.modelName}
              placeholder="例如：deepseek-v3"
              onChange={(e) => setForm({ ...form, modelName: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Agent 名称（必填）</span>
            <input
              value={form.agentName}
              placeholder="例如：deepseek-v3-思考版"
              onChange={(e) => setForm({ ...form, agentName: e.target.value })}
            />
          </label>
          <label className="field">
            <span>思考等级</span>
            <select
              value={form.thinkingLevel}
              onChange={(e) => setForm({ ...form, thinkingLevel: e.target.value as ThinkingLevel })}
            >
              {THINKING_LEVELS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-wide">
            <span>补充信息（可空，只做备注）</span>
            <textarea
              rows={3}
              value={form.notes}
              placeholder="例如：采样参数、提示词风格、负责调这个 Agent 的人…"
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>
        </div>

        {formError ? <Banner tone="error">{formError}</Banner> : null}

        <div className="form-actions">
          <button className="btn btn-primary" onClick={submit} disabled={registering}>
            {registering ? "注册中…" : "注册并签发密钥"}
          </button>
          {copyState ? (
            <span className={copyState.ok ? "copy-note copy-ok" : "copy-note copy-bad"}>{copyState.text}</span>
          ) : null}
        </div>
      </Section>

      {credential ? (
        <Section
          title={credential.origin === "register" ? "一次性密钥 + 启动 prompt（请立即复制）" : "重新签发的密钥 + 启动 prompt（请立即复制）"}
          extra={
            <button className="btn btn-sm" onClick={() => setCredential(null)}>
              我已复制，隐藏密钥
            </button>
          }
        >
          <div className="keybox">
            <div className="keybox-head">
              <Badge tone="warn">仅显示一次 · 仅可使用一次</Badge>
              <span className="muted small">
                {credential.agent.agentName}
                {credential.agent.modelName ? ` · ${credential.agent.modelName}` : ""} ·{" "}
                {credential.agent.thinkingLevel}
              </span>
            </div>
            <div className="key-value mono" title="选中即可手动复制">
              {credential.key}
            </div>
            <div className="key-warn">
              此密钥仅显示一次，且只能使用一次。刷新或离开本页后将无法再次查看明文；若丢失只能「重新签发密钥」。
              下面的<strong>启动 prompt</strong>里已经带上这把密钥与任务书地址，复制一次就能交给目标 Agent。
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => void copy("密钥", credential.key)}>
                复制密钥
              </button>
              {credential.prompt ? (
                <button className="btn" onClick={() => void copy("启动 prompt", credential.prompt!)}>
                  复制启动 prompt
                </button>
              ) : null}
              <a className="btn" href={taskDocUrl} target="_blank" rel="noreferrer">
                打开任务文档
              </a>
            </div>

            {/* 注册响应同时给出了上传地址与限制，直接落在密钥旁边，省得用户来回找 */}
            <div className="keybox-meta">
              <div className="kv">
                <span>
                  任务文档：<code>{taskDocUrl}</code>
                </span>
                <span>
                  上传接口：<code>{uploadUrl ?? "（服务端未返回上传地址）"}</code>
                </span>
              </div>
              {uploadUrl ? (
                <>
                  <div className="field-label">上传示例（已填入本次密钥，可直接复制执行）：</div>
                  <pre className="code">
                    {`curl -X POST ${uploadUrl} -H "Authorization: Bearer ${credential.key}" -H "Content-Type: application/zip" --data-binary @strategy.zip`}
                  </pre>
                  <div className="form-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        void copy(
                          "curl 命令",
                          `curl -X POST ${uploadUrl} -H "Authorization: Bearer ${credential.key}" -H "Content-Type: application/zip" --data-binary @strategy.zip`,
                        )
                      }
                    >
                      复制 curl
                    </button>
                  </div>
                </>
              ) : null}

              {/* 启动 prompt：任务描述 + 任务书地址 + 密钥 + 上传命令，复制一次就能贴给目标 Agent */}
              {credential.prompt ? (
                <>
                  <div className="field-label">
                    启动 prompt（<strong>推荐用法</strong>：复制这一段直接粘给目标 Agent，它自己会去读任务书、写脚本、打包上传）：
                  </div>
                  <pre className="code code-prompt">{credential.prompt}</pre>
                  <div className="form-actions">
                    <button className="btn btn-primary" onClick={() => void copy("启动 prompt", credential.prompt!)}>
                      复制 prompt
                    </button>
                    <a className="btn" href={taskDocUrl} target="_blank" rel="noreferrer">
                      先自己看一眼任务书
                    </a>
                  </div>
                </>
              ) : null}
              {credential.limits ? (
                <>
                  <div className="field-label">上传限制 limits（服务端返回）</div>
                  <LimitsTable limits={credential.limits} />
                </>
              ) : null}
            </div>
          </div>
        </Section>
      ) : null}

      <Section
        title="任务文档与上传接口"
        extra={
          <>
            <a className="btn" href={taskDocUrl} target="_blank" rel="noreferrer">
              新标签打开任务文档
            </a>
            <button className="btn" onClick={() => void loadDocPreview()} disabled={docPreview?.state === "loading"}>
              {docPreview?.state === "loading" ? "拉取中…" : "页面内预览"}
            </button>
          </>
        }
      >
        <div className="kv">
          <span>
            任务文档：<code>{taskDocUrl}</code>（<code>text/markdown</code>）
          </span>
          <span>
            上传接口：<code>{uploadUrl ?? "（等待注册响应或任务文档提供）"}</code>
          </span>
          {taskDoc ? <span>文档版本：{taskDoc.version}</span> : null}
          {taskDoc ? <span>注册接口：<code>{taskDoc.endpoints.register}</code></span> : null}
          {taskDoc ? <span>赛事接口：<code>{taskDoc.endpoints.tournaments}</code></span> : null}
        </div>

        {taskDocError ? (
          <Banner tone="warn">
            读取任务文档 JSON 失败：{taskDocError}
            <div className="banner-hint">
              这不影响注册与列表：上传地址与限制会在注册响应里一并返回。若后端尚未实现{" "}
              <code>GET /api/task-doc?format=json</code>，请使用新标签打开 Markdown 版本。
            </div>
          </Banner>
        ) : null}

        {credential ? (
          <div className="hint">
            上面的一次性密钥面板已经列出了本次注册返回的上传地址、curl 示例与 limits；这里保留任务文档入口，
            方便在隐藏密钥后再回来查文档。
          </div>
        ) : curlExample ? (
          <>
            <div className="field-label">把脚本打成 zip 后，用下面这条命令上传（<code>{"<key>"}</code> 处替换成注册时拿到的明文密钥）：</div>
            <pre className="code">{curlExample}</pre>
            <div className="form-actions">
              <button className="btn btn-sm" onClick={() => void copy("curl 命令", curlExample)}>
                复制 curl
              </button>
            </div>
          </>
        ) : (
          <div className="hint">
            注册成功后这里会显示带真实上传地址的 curl 示例；当前还没拿到上传地址（注册响应与任务文档 JSON 都没有），
            请先注册一个 Agent 或确认后端已实现 <code>GET /api/task-doc?format=json</code>。
          </div>
        )}

        {!credential && limits ? (
          <>
            <div className="field-label">上传限制（服务端返回的 limits）</div>
            <LimitsTable limits={limits} />
          </>
        ) : null}

        {docPreview ? (
          <div className="doc-preview">
            <div className="field-label">任务文档预览</div>
            {docPreview.state === "loading" ? <div className="hint">拉取中…</div> : null}
            {docPreview.state === "fail" ? <Banner tone="error">拉取任务文档失败：{docPreview.error}</Banner> : null}
            {docPreview.state === "ok" ? <pre className="code doc-md">{docPreview.markdown}</pre> : null}
          </div>
        ) : null}
      </Section>

      <Section
        title="已注册 Agent"
        extra={<span className="muted small">共 {agents?.length ?? 0} 个</span>}
      >
        {listError ? (
          <Banner tone="error">
            读取 Agent 列表失败：{listError}
            <div className="banner-hint">
              请确认后端已启动（默认 <code>http://127.0.0.1:8787</code>）并实现了{" "}
              <code>GET /api/agents</code>。注册表单仍可用，后端恢复后点「刷新列表」即可。
            </div>
          </Banner>
        ) : null}
        {actionError ? <Banner tone="error">操作失败：{actionError}</Banner> : null}
        {agents === null && !listError ? <div className="hint">加载中…</div> : null}

        {agents && agents.length === 0 && !listError ? (
          <EmptyState
            title="还没有 Agent"
            hint="先注册一个：填好模型名称与 Agent 名称，平台会签发一次性密钥并给出任务文档。Agent 按文档自己写策略脚本、打包上传，校验通过后就能参加赛事。"
            action={
              <button className="btn btn-primary" onClick={() => modelNameRef.current?.focus()}>
                去注册
              </button>
            }
          />
        ) : null}

        {agents && agents.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>模型名</th>
                  <th>Agent 名</th>
                  <th>思考等级</th>
                  <th>状态</th>
                  <th>密钥</th>
                  <th>尝试次数</th>
                  <th>创建时间</th>
                  <th>上传时间</th>
                  <th>脚本哈希</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const st = agentStatusInfo(a.status);
                  const canExpand = Boolean(a.rejectReason || (a.validation && a.validation.length > 0) || a.notes);
                  const open = expanded === a.id;
                  return (
                    <Fragment key={a.id}>
                      <tr className={open ? "row-open" : undefined}>
                        <td className="mono small">{a.modelName}</td>
                        <td>{a.agentName}</td>
                        <td>
                          <Badge tone={a.thinkingLevel === "xhigh" || a.thinkingLevel === "high" ? "info" : "muted"}>
                            {a.thinkingLevel}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone={st.tone} title={a.rejectReason}>
                            {st.text}
                          </Badge>
                        </td>
                        <td className="mono small">{a.keyMasked || "-"}</td>
                        <td className="mono small">
                          {a.attempts} / {a.maxAttempts}
                        </td>
                        <td className="small">{fmtTime(a.createdAt)}</td>
                        <td className="small">{fmtTime(a.uploadedAt)}</td>
                        <td className="mono small" title={a.scriptSha256 ?? ""}>
                          {a.scriptSha256 ? `${a.scriptSha256.slice(0, 12)}…` : "-"}
                        </td>
                        <td className="row-actions">
                          {canExpand ? (
                            <button className="btn btn-sm" onClick={() => setExpanded(open ? null : a.id)}>
                              {open ? "收起" : a.status === "rejected" ? "失败原因" : "详情"}
                            </button>
                          ) : null}
                          <button className="btn btn-sm" onClick={() => void reissue(a)} disabled={busy === a.id}>
                            {busy === a.id ? "处理中…" : "重新签发密钥"}
                          </button>
                          <button className="btn btn-sm btn-danger" onClick={() => void remove(a)} disabled={busy === a.id}>
                            删除
                          </button>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="row-detail">
                          <td colSpan={10}>
                            <div className="kv">
                              <span>
                                Agent ID：<span className="mono">{a.id}</span>
                              </span>
                              <span>思考等级：{a.thinkingLevel}</span>
                              {typeof a.zipBytes === "number" ? <span>zip 体积：{fmtBytes(a.zipBytes)}</span> : null}
                              {a.scriptSha256 ? (
                                <span>
                                  脚本 SHA256：<span className="mono">{a.scriptSha256}</span>
                                </span>
                              ) : null}
                            </div>
                            {a.rejectReason ? <Banner tone="error">校验失败：{a.rejectReason}</Banner> : null}
                            {a.notes ? <div className="kv">补充信息：{a.notes}</div> : null}
                            {a.validation && a.validation.length > 0 ? (
                              <ul className="checklist">
                                {a.validation.map((v, i) => (
                                  <li key={`${v.stage}-${i}`} className={v.ok ? "ck-ok" : "ck-bad"}>
                                    <span className="ck-mark">{v.ok ? "✓" : "✗"}</span>
                                    {v.stage}
                                    {v.detail ? `：${v.detail}` : ""}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="hint">还没有分阶段校验结论（尚未上传或后端未返回 validation）。</div>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {agents && agents.length > 0 ? (
          <div className="hint">
            只有 <Badge tone="ok">已入库</Badge>（uploaded）的 Agent 能参加赛事；<Badge tone="danger">校验失败</Badge>
            的可以展开看每个阶段的结论，改好脚本后重新签发密钥再传一次。
          </div>
        ) : null}
      </Section>
    </div>
  );
}