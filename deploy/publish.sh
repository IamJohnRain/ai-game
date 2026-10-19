#!/usr/bin/env bash
# deploy/publish.sh —— 在开发机（本仓库）上执行：把代码同步到服务器的 ~/ai-game
#
#   AI_GAME_HOST=<user>@<your-server> bash deploy/publish.sh
#   AI_GAME_HOST=<user>@<your-server> AI_GAME_REMOTE_DIR=apps/ai-game bash deploy/publish.sh
#
# 也可以把地址写进 deploy/.env.local（已被 .gitignore 排除，不会入库）：
#   AI_GAME_HOST=<user>@<your-server>
#
# 只同步代码与构建产物：不含 node_modules（服务器自己装）、不含 data/（业务数据，服务器上独立存在，
# 不会被覆盖）、不含 logs/。同步完在服务器上跑 deploy/install.sh 完成安装/升级。
set -euo pipefail

cd "$(dirname "$0")/.."

# 命令行显式传入的优先于 deploy/.env.local 里的值
CALLER_HOST="${AI_GAME_HOST:-}"
CALLER_DIR="${AI_GAME_REMOTE_DIR:-}"
if [ -f deploy/.env.local ]; then
  # shellcheck disable=SC1091
  . ./deploy/.env.local
fi
HOST="${CALLER_HOST:-${AI_GAME_HOST:-}}"
REMOTE_DIR="${CALLER_DIR:-${AI_GAME_REMOTE_DIR:-ai-game}}"

if [ -z "$HOST" ]; then
  cat >&2 <<'USAGE'
用法：AI_GAME_HOST=<user>@<your-server> bash deploy/publish.sh
      （可选）AI_GAME_REMOTE_DIR=ai-game     指定远端目录，默认是远端家目录下的 ai-game
      （可选）在 deploy/.env.local 里写 AI_GAME_HOST=...（该文件不会入库）
USAGE
  exit 1
fi

echo "==> 同步 $(pwd) → $HOST:~/$REMOTE_DIR（不含 node_modules/data/logs）"
tar czf - \
  --exclude='./node_modules' \
  --exclude='./data' \
  --exclude='./logs' \
  --exclude='*/node_modules' \
  --exclude='./.git' \
  --exclude='*.log' \
  --exclude='./tsconfig.tsbuildinfo' \
  --exclude='./deploy/.env.local' \
  . | ssh -o BatchMode=yes "$HOST" "mkdir -p \"\$HOME/$REMOTE_DIR\" && tar xzf - -C \"\$HOME/$REMOTE_DIR\""

echo "==> 完成。到服务器上执行：ssh $HOST 'bash ~/$REMOTE_DIR/deploy/install.sh'"