#!/usr/bin/env bash
# deploy/log-maintenance.sh —— 日志老化第二层：由用户 crontab 每 15 分钟跑一次（不需要 root）
#
# 与 /etc/logrotate.d/ai-game 的分工：
#   logrotate（第一层）：每天切一次，单文件超过 20M 也切，保留 14 份并压缩——够用，但一天只醒一次
#   本脚本（第二层）    ：每 15 分钟兜底——单文件超 LIVE_MAX_MB 立即切割、清理过期归档、
#                        限制整个 logs 目录体积，并在分区水位过高时强制清理（85% 清旧档、92% 连当前日志一起清空），
#                        所以"日志把磁盘写满"在两层的共同约束下不会发生
#
# 边界：只碰 $APP_DIR/logs 下的日志文件；不删除任何业务数据（SQLite 里的对局/脚本只做体积上报，
#       需要瘦库时按 docs/07 §5 手工处理）。切档用"先复制再清空"，进程不需要重启、也不丢行。
#
# 可调参数（环境变量，想改就直接写进 crontab 那一行）：
#   LIVE_MAX_MB=40   单个 *.log 的上限，超过立即切档
#   KEEP_DAYS=14     归档保留天数
#   DIR_MAX_MB=200   整个 logs 目录的硬上限（从最旧的归档开始删）
#   WARN_PCT=85      分区使用率警戒线（只保留最近 3 份归档并再压缩目录上限）
#   CRIT_PCT=92      分区使用率红线（清空全部日志，只留一行告警）
#   DB_WARN_MB=2048  数据库体积上报阈值（只记录，不删除）
set -uo pipefail

APP_DIR="${AI_GAME_HOME:-$HOME/ai-game}"
LOG_DIR="$APP_DIR/logs"
MAINT_LOG="$LOG_DIR/maintenance.log"

LIVE_MAX_MB="${LIVE_MAX_MB:-40}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DIR_MAX_MB="${DIR_MAX_MB:-200}"
WARN_PCT="${WARN_PCT:-85}"
CRIT_PCT="${CRIT_PCT:-92}"
DB_WARN_MB="${DB_WARN_MB:-2048}"

mkdir -p "$LOG_DIR" 2>/dev/null || exit 0
ts() { date '+%Y-%m-%d %H:%M:%S'; }
file_mb() { local b; b="$(stat -c %s "$1" 2>/dev/null || echo 0)"; echo $(( b / 1048576 )); }
file_bytes() { stat -c %s "$1" 2>/dev/null || echo 0; }
dir_mb() { local m; m="$(du -sm "$LOG_DIR" 2>/dev/null | awk '{print $1}' | head -1)"; echo "${m:-0}"; }

# 单文件切档：先复制成归档再清空原文件（O_APPEND 下清空是安全的，进程无需重启）
rotate_live() {
  local f="$1" size_mb="$2" stamp out
  stamp="$(date '+%Y%m%d-%H%M%S')"
  out="${f}.${stamp}.gz"
  if gzip -c "$f" > "$out" 2>/dev/null; then
    : > "$f"
    echo "$(ts) rotate ${f##*/} (${size_mb}MB) -> ${out##*/}" >> "$MAINT_LOG"
  else
    rm -f "$out"
  fi
}

# 从最旧的归档开始删，直到目录体积低于目标值
shrink_dir() {
  local target="$1" oldest
  while [ "$(dir_mb)" -gt "$target" ] 2>/dev/null; do
    oldest="$(ls -1t "$LOG_DIR"/*.gz 2>/dev/null | tail -1)"
    [ -z "$oldest" ] && break
    rm -f "$oldest" || break
  done
}

USED_PCT="$(df -P "$APP_DIR" 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
[ -z "${USED_PCT:-}" ] && USED_PCT=0

# 1) 单个日志超过上限 → 立即切档
for f in "$LOG_DIR"/*.log; do
  [ -f "$f" ] || continue
  [ "$f" = "$MAINT_LOG" ] && continue
  size_mb="$(file_mb "$f")"
  [ "$size_mb" -ge "$LIVE_MAX_MB" ] && rotate_live "$f" "$size_mb"
done

# 2) 过期归档清理（含 logrotate 因 delaycompress 暂存的未压缩份）
find "$LOG_DIR" -maxdepth 1 -name '*.log.*.gz' -mtime +"$KEEP_DAYS" -delete 2>/dev/null
find "$LOG_DIR" -maxdepth 1 -name '*.log.[0-9]*' -mtime +2 -delete 2>/dev/null

# 3) 目录硬上限
shrink_dir "$DIR_MAX_MB"

# 4) maintenance.log 自身瘦身：超过 2000 行就只留最后 500 行（原地截断，保留 inode，cron 的重定向不会丢）
if [ "$(file_bytes "$MAINT_LOG")" -gt 5242880 ]; then
  tail -n 500 "$MAINT_LOG" > "$MAINT_LOG.tmp" 2>/dev/null && cat "$MAINT_LOG.tmp" > "$MAINT_LOG" && rm -f "$MAINT_LOG.tmp"
fi

# 5) 分区水位保护
if [ "$USED_PCT" -ge "$CRIT_PCT" ]; then
  echo "$(ts) WARN 分区已用 ${USED_PCT}% ≥ ${CRIT_PCT}%：清空全部日志文件" >> "$MAINT_LOG"
  rm -f "$LOG_DIR"/*.log.*.gz "$LOG_DIR"/*.log.[0-9]* 2>/dev/null
  for f in "$LOG_DIR"/*.log; do
    [ -f "$f" ] || continue
    [ "$f" = "$MAINT_LOG" ] && continue
    : > "$f"
  done
elif [ "$USED_PCT" -ge "$WARN_PCT" ]; then
  echo "$(ts) WARN 分区已用 ${USED_PCT}% ≥ ${WARN_PCT}%：只保留最近 3 份归档" >> "$MAINT_LOG"
  ls -1t "$LOG_DIR"/*.gz 2>/dev/null | tail -n +4 | xargs -r rm -f --
  shrink_dir $(( DIR_MAX_MB / 4 ))
fi

# 6) 每次一行上报，便于看趋势（disk/logs/db/当前日志大小）
DB_MB=$(( $(file_bytes "$APP_DIR/data/ai-game.db") / 1048576 ))
echo "$(ts) ok disk=${USED_PCT}% logs=$(dir_mb)MB db=${DB_MB}MB live=$(file_bytes "$LOG_DIR/app.log")B" >> "$MAINT_LOG"
if [ "$DB_MB" -ge "$DB_WARN_MB" ]; then
  echo "$(ts) WARN 数据库 ${DB_MB}MB ≥ ${DB_WARN_MB}MB：对局与回放会持续增长，处理方式见 docs/07 §5" >> "$MAINT_LOG"
fi