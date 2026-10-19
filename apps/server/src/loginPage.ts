// apps/server/src/loginPage.ts —— 登录页（服务端渲染）
//
// 为什么不用前端构建产物：未登录时前端 bundle 根本不该下发（"所有界面都要认证"），
// 所以登录页自带样式与脚本，只依赖 /api/auth/login 一个接口。
import { AUTH_USER } from "./auth.ts";

const STYLE = `
:root { --bg:#0b0e14; --panel:#141a24; --border:#253044; --text:#e6ebf2; --muted:#7c8aa0;
        --accent:#4f9dff; --danger:#f87171; --ok:#34d399; --radius:10px; --shadow:0 8px 24px rgba(0,0,0,.35); }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin:0; background:radial-gradient(1200px 600px at 50% -10%, #16203a 0%, var(--bg) 60%);
       color:var(--text); font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
       "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif;
       display:flex; align-items:center; justify-content:center; padding:24px; }
.card { width:100%; max-width:380px; background:var(--panel); border:1px solid var(--border);
        border-radius:var(--radius); box-shadow:var(--shadow); padding:28px 26px 22px; }
.brand { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.mark { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px;
        border-radius:8px; background:linear-gradient(135deg, var(--accent), #7c5cff); color:#fff;
        font-weight:700; font-size:13px; letter-spacing:.5px; }
h1 { font-size:16px; margin:0; font-weight:600; }
p.sub { margin:2px 0 20px 40px; color:var(--muted); font-size:12px; }
label { display:block; font-size:12px; color:var(--muted); margin:14px 0 6px; }
input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border);
        background:#0f141d; color:var(--text); font-size:14px; outline:none; }
input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(79,157,255,.15); }
input[readonly] { color:var(--muted); }
button { width:100%; margin-top:20px; padding:11px 12px; border:0; border-radius:8px; cursor:pointer;
         background:linear-gradient(135deg, var(--accent), #7c5cff); color:#fff; font-size:14px; font-weight:600; }
button:disabled { opacity:.6; cursor:default; }
#msg { min-height:18px; margin-top:12px; font-size:12px; color:var(--danger); }
#msg.ok { color:var(--ok); }
.hint { margin-top:16px; padding-top:14px; border-top:1px solid var(--border); color:var(--muted); font-size:11px; line-height:1.7; }
code { font-family:ui-monospace, Menlo, Consolas, monospace; color:#c9d6ea; }
`;

export function renderLoginPage(opts: { next?: string } = {}): string {
  const next = JSON.stringify(opts.next ?? "/").replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<title>登录 · AI 坦克对战平台</title>
<style>${STYLE}</style>
</head>
<body>
<form class="card" id="f" autocomplete="on">
  <div class="brand"><span class="mark">AI</span><h1>坦克对战平台 · 登录</h1></div>
  <p class="sub">平台只在登录后提供界面与接口；外部 Agent 走 /api/task-doc 与 /api/upload，不需要登录。</p>
  <label for="u">用户名</label>
  <input id="u" name="user" value="${AUTH_USER}" readonly />
  <label for="p">密码</label>
  <input id="p" name="password" type="password" autocomplete="current-password" autofocus />
  <button id="go" type="submit">登录</button>
  <div id="msg" role="status" aria-live="polite"></div>
  <div class="hint">
    密码在服务端配置里改：<code>~/ai-game/.env</code> 的 <code>AI_GAME_AUTH_PASSWORD</code>（改完 <code>systemctl restart ai-game</code>）。
  </div>
</form>
<script>
  const NEXT = ${next};
  const form = document.getElementById("f");
  const msg = document.getElementById("msg");
  const go = document.getElementById("go");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    msg.className = "";
    msg.textContent = "";
    go.disabled = true;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: document.getElementById("u").value.trim(), password: document.getElementById("p").value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        msg.className = "ok";
        msg.textContent = "登录成功，正在进入…";
        location.replace(NEXT);
        return;
      }
      msg.textContent = data.error || ("登录失败（HTTP " + res.status + "）");
      document.getElementById("p").value = "";
      document.getElementById("p").focus();
    } catch (err) {
      msg.textContent = "无法连接后端：" + err;
    } finally {
      go.disabled = false;
    }
  });
</script>
</body>
</html>`;
}