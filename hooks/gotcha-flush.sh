#!/bin/bash
# Stop hook: 세션 종료 시 축적된 gotcha를 패턴 파일에 기록하고 worker 종료

PORT_FILE="/tmp/web-auto-gotcha-worker.port"
PID_FILE="/tmp/web-auto-gotcha-worker.pid"

# Worker가 없으면 스킵
[ -f "$PORT_FILE" ] || exit 0
[ -f "$PID_FILE" ] || exit 0

PORT=$(cat "$PORT_FILE")
PID=$(cat "$PID_FILE")

# flush 요청
RESULT=$(curl -s --connect-timeout 3 -X POST "http://127.0.0.1:${PORT}/flush" 2>/dev/null)

# worker 종료
kill "$PID" 2>/dev/null
rm -f "$PORT_FILE" "$PID_FILE" 2>/dev/null

# 결과가 있으면 알림
if [ -n "$RESULT" ] && echo "$RESULT" | /usr/bin/grep -q '"count":[1-9]'; then
  UPDATED=$(echo "$RESULT" | /usr/bin/grep -oE '"updated":\[[^]]*\]' | sed 's/"updated"://;s/\[//;s/\]//;s/"//g')
  COUNT=$(echo "$RESULT" | /usr/bin/grep -oE '"count":[0-9]+' | sed 's/"count"://')
  cat <<HOOKJSON
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "📝 Gotcha ${COUNT}건이 패턴 파일에 기록됨: ${UPDATED}"
  }
}
HOOKJSON
fi

exit 0
