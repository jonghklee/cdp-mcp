#!/bin/bash
# CDP-MCP 프로파일 자동 정리 (cron 백스톱)
#
# launch 시점의 인프로세스 정리(cleanupStaleProfiles)가 1차 방어선이고,
# 이 스크립트는 MCP가 한동안 실행되지 않아도 디스크가 쌓이지 않게 하는 2차 방어선.
#
# 삭제 조건: port-* 프로파일 중
#   - 그 디렉토리를 쓰는 Chrome 프로세스가 없고
#   - mtime이 MAX_AGE_DAYS 초과
# 실행 중인 Chrome은 절대 건드리지 않는다.

MAX_AGE_DAYS="${CDP_MCP_PROFILE_MAX_AGE_DAYS:-1}"
PROFILES_DIR="$HOME/.cdp-mcp/chrome-profiles"
LOG="$HOME/.cdp-mcp/cleanup.log"

[ -d "$PROFILES_DIR" ] || exit 0

for dir in "$PROFILES_DIR"/port-*; do
  [ -d "$dir" ] || continue
  pgrep -f -- "--user-data-dir=$dir" >/dev/null 2>&1 && continue
  find "$dir" -maxdepth 0 -mtime +"$MAX_AGE_DAYS" 2>/dev/null | grep -q . || continue
  size=$(du -sh "$dir" 2>/dev/null | cut -f1)
  rm -rf "$dir"
  echo "$(date '+%Y-%m-%d %H:%M:%S') deleted $dir ($size)" >> "$LOG"
done
