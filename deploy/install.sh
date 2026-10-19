#!/usr/bin/env bash
# deploy/install.sh —— 在目标服务器上执行（幂等，重复执行安全）
#
#   bash ~/ai-game/deploy/install.sh
#
# 做六件事：pnpm 依赖 → 构建前端 → 安装 systemd 单元 → 安装 logrotate 规则
# → 写日志维护 crontab → 启动并自检。
# 需要 sudo（安装单元/规则、systemctl）；本机 admin 已配置免密 sudo。
set -euo pipefail

APP_DIR="${AI_GAME_HOME:-$HOME/ai-game}"
PORT="${PORT:-8787}"
SERVICE="ai-game"
NODE_BIN="$(command -v node || true)"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m!!\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$NODE_BIN" ] || die "找不到 node（建议用绝对路径的 nvm node：export PATH=\$HOME/.nvm/versions/node/vXX/bin:\$PATH）"
[ -d "$APP_DIR" ] || die "目录不存在：$APP_DIR（先跑 deploy/publish.sh 同步代码）"
cd "$APP_DIR"

# Windows 上编辑过的脚本可能是 CRLF，先统一成 LF，否则 bash 会报 $'\r': command not found
sed -i 's/\r$//' deploy/*.sh deploy/ai-game.service deploy/logrotate.ai-game package.json 2>/dev/null || true
chmod +x deploy/*.sh
mkdir -p logs data
# systemd 是以 root 打开 StandardOutput=append: 的文件再降权到 User=admin 的：
# 文件预先由 admin 建好，属主就一直是 admin，logrotate 与 log-maintenance.sh 才切得动它
touch logs/app.log logs/maintenance.log

# 1) pnpm（corepack 会按 package.json 的 packageManager 字段选版本）
if ! command -v pnpm >/dev/null 2>&1; then
  log "安装 pnpm（corepack）"
  corepack enable pnpm >/dev/null 2>&1 || npm i -g pnpm@9.15.9
fi
log "node $("$NODE_BIN" -v) / pnpm $(pnpm -v) / 目录 $APP_DIR"

# 2) 依赖
log "pnpm install（首次约 1~3 分钟）"
pnpm install --reporter=append-only

# 3) 前端构建产物（后端把它挂在 / 下，见 apps/server/src/app.ts 末尾）
log "pnpm build:web"
pnpm build:web
[ -f apps/web/dist/index.html ] || die "前端构建失败：apps/web/dist/index.html 不存在"

# 4) 可选覆盖配置（首次安装生成，之后不动）
#    登录密码**不在仓库里**：安装时随机生成一个写进 .env，之后想改就编辑该文件再重启
if [ ! -f "$APP_DIR/.env" ]; then
  log "生成 $APP_DIR/.env（默认值都写在 systemd 单元里，这里只放可覆盖项）"
  cat > "$APP_DIR/.env" <<'ENVEOF'
# 覆盖 systemd 单元里的默认值：KEY=VALUE，不带 export，改完 systemctl restart ai-game
# HOST=0.0.0.0
# PORT=8787
# AI_GAME_TURN_INTERVAL_MS=1200
# AI_GAME_MAX_CONCURRENT=2
# 固定主密钥（64 位 hex）可避免重装后旧密钥失效；留空则用 data/master.key
# AI_GAME_MASTER_KEY=
# 登录密码（用户名固定 JohnRyan）——install.sh 已随机生成，编辑这里即可改成自己的
AI_GAME_AUTH_PASSWORD=__GENERATED_PASSWORD__
# 会话有效期与登录失败限流（毫秒/次数，默认 7 天、10 次/10 分钟）
# AI_GAME_SESSION_TTL_MS=604800000
# AI_GAME_AUTH_MAX_FAILURES=10
# 走 HTTPS 时打开（Cookie 加 Secure）
# AI_GAME_COOKIE_SECURE=1
ENVEOF
  AUTH_PASS="$("$NODE_BIN" -e 'console.log(require("node:crypto").randomBytes(18).toString("base64url"))')"
  # 生成的是 base64url（A-Za-z0-9-_），放进 sed 替换里没有转义问题
  sed -i "s|__GENERATED_PASSWORD__|$AUTH_PASS|" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  log "登录密码（用户名 JohnRyan）：$AUTH_PASS"
  echo "     已写入 $APP_DIR/.env，可随时编辑该文件更换（改完 systemctl restart ai-game）"
fi

# 5) systemd 单元 + logrotate 规则
log "安装 /etc/systemd/system/$SERVICE.service"
sed -e "s#__HOME__#$HOME#g" -e "s#__USER__#$(id -un)#g" -e "s#__NODE__#$NODE_BIN#g" \
  deploy/ai-game.service | sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null
sudo systemctl daemon-reload

log "安装 /etc/logrotate.d/$SERVICE（第一层日志老化）"
sed -e "s#__HOME__#$HOME#g" -e "s#__USER__#$(id -un)#g" \
  deploy/logrotate.ai-game | sudo tee "/etc/logrotate.d/$SERVICE" >/dev/null
sudo logrotate -d "/etc/logrotate.d/$SERVICE" >/dev/null 2>&1 || log "（logrotate 预检有告警，可忽略；详见 sudo logrotate -d）"

# 6) 用户 crontab：每 15 分钟日志老化兜底（第二层）
CRON_LINE="*/15 * * * * /bin/bash $APP_DIR/deploy/log-maintenance.sh >> $APP_DIR/logs/maintenance.log 2>&1"
if crontab -l 2>/dev/null | grep -Fq "log-maintenance.sh"; then
  log "crontab 已有日志维护条目，跳过"
else
  log "写入 crontab 日志维护条目"
  { crontab -l 2>/dev/null || true; echo "$CRON_LINE"; } | crontab -
fi

# 7) 启动
log "启用并启动 $SERVICE"
sudo systemctl enable "$SERVICE" >/dev/null 2>&1 || true
sudo systemctl restart "$SERVICE"

# 8) 自检：/login 是免登录页面，能返回 200 就说明进程、路由与静态托管都就绪
#    （/api/health 现在需要登录，不能拿它探活；外部探活一律用 /login）
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login")" = "200" ]; then break; fi
  sleep 1
done
log "就绪探测"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login")"
[ "$CODE" = "200" ] || die "服务没能启动（GET /login → HTTP $CODE），看日志：tail -n 50 $APP_DIR/logs/app.log"
echo "GET /login → 200 ✅"
curl -s -o /dev/null -w 'GET /api/agents（未登录）→ HTTP %{http_code}（应为 401）\n' "http://127.0.0.1:$PORT/api/agents"
curl -s -o /dev/null -w 'GET /api/task-doc（免登录）→ HTTP %{http_code}（应为 200）\n' "http://127.0.0.1:$PORT/api/task-doc"
log "运行状态"
sudo systemctl --no-pager --lines=0 status "$SERVICE" | head -12
echo
log "完成。日志目录：$APP_DIR/logs（logrotate 每日 + crontab 每 15 分钟双重老化）"