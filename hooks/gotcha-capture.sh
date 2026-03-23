#!/bin/bash
# PostToolUse hook: browser.ts 실패를 감지하여 gotcha worker에 기록
# claude-mem의 observation 패턴을 참고한 자동 수집 방식

INPUT=$(cat)

# Bash 도구만 처리
echo "$INPUT" | /usr/bin/grep -q '"tool_name"' || exit 0
TOOL_NAME=$(echo "$INPUT" | /usr/bin/grep -oE '"tool_name"\s*:\s*"[^"]*"' | head -1 | sed 's/.*: *"//;s/"//')
[ "$TOOL_NAME" = "Bash" ] || exit 0

# browser.ts 명령만 처리
echo "$INPUT" | /usr/bin/grep -q 'browser\.ts' || exit 0

# 실패 감지: ❌, exit code != 0, "알 수 없는 명령"
IS_FAILURE=false
echo "$INPUT" | /usr/bin/grep -qE '❌|Exit code [1-9]|알 수 없는 명령|Error:|ECONNREFUSED' && IS_FAILURE=true
[ "$IS_FAILURE" = "false" ] && exit 0

# Worker 포트 확인
PORT_FILE="/tmp/web-auto-gotcha-worker.port"
[ -f "$PORT_FILE" ] || exit 0
PORT=$(cat "$PORT_FILE")

# health check
curl -s --connect-timeout 1 "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1 || exit 0

# 명령어 추출
COMMAND=$(echo "$INPUT" | /usr/bin/grep -oE 'browser\.ts [^"\\]+' | head -1 | sed 's/\\n.*//;s/\\".*//')
COMMAND="${COMMAND:0:200}"

# 에러 메시지 추출
ERROR=$(echo "$INPUT" | /usr/bin/grep -oE '(❌[^"\\]*|알 수 없는 명령[^"\\]*|Error:[^"\\]*|ECONNREFUSED[^"\\]*)' | head -1)
ERROR="${ERROR:0:200}"

# 사이트 추출 (URL에서 도메인, 없으면 localhost)
SITE_URL=$(echo "$INPUT" | /usr/bin/grep -oE 'https?://[^"\\[:space:]]+' | head -1)
if [ -n "$SITE_URL" ]; then
  SITE=$(echo "$SITE_URL" | sed -E 's|https?://([^/]+).*|\1|' | sed 's/^www\.//' | awk -F. '{if (NF >= 2) print $(NF-1); else print $1}')
else
  SITE="localhost"
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

# Worker에 전송
curl -s --connect-timeout 1 -X POST "http://127.0.0.1:${PORT}/gotcha" \
  -H "Content-Type: application/json" \
  -d "{\"site\":\"${SITE}\",\"command\":\"${COMMAND}\",\"error\":\"${ERROR}\",\"timestamp\":\"${TIMESTAMP}\"}" \
  > /dev/null 2>&1

exit 0
