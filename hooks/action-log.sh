#!/bin/bash
# PostToolUse hook: agent-browser 명령을 JSONL로 기록

INPUT=$(cat)

# Bash + agent-browser만 처리
echo "$INPUT" | /usr/bin/grep -q '"tool_name"' || exit 0
echo "$INPUT" | /usr/bin/grep -q 'agent-browser' || exit 0

# 성공/실패 판정
TYPE="success"
echo "$INPUT" | /usr/bin/grep -qE '❌|Error|ECONNREFUSED|TimeoutError|failed|error:' && TYPE="error"

# 명령어 추출 (2000자)
COMMAND=$(echo "$INPUT" | /usr/bin/grep -oE 'agent-browser[^"\\]*' | head -1 | sed 's/\\n/ /g')
COMMAND="${COMMAND:0:2000}"

# 서브커맨드 추출
SUBCMD=$(echo "$COMMAND" | sed -E 's/agent-browser\s+(--cdp\s+\S+\s+)?(--[a-z-]+\s+\S+\s+)*//' | awk '{print $1}')

# 결과 추출 (1000자)
OUTPUT=$(echo "$INPUT" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  r=d.get('tool_response','')
  if isinstance(r,dict): r=r.get('content','')
  print(str(r)[:1000])
except: pass
" 2>/dev/null)

# URL/사이트 추출
SITE_URL=$(echo "$INPUT" | /usr/bin/grep -oE 'https?://[^"\\[:space:]]+' | head -1)
if [ -n "$SITE_URL" ]; then
  SITE=$(echo "$SITE_URL" | sed -E 's|https?://([^/]+).*|\1|' | sed 's/^www\.//' | awk -F. '{if (NF >= 2) print $(NF-1); else print $1}')
  echo "$SITE_URL" | /usr/bin/grep -q 'localhost' && SITE="localhost"
else
  SITE=$(cat /tmp/web-auto-current-site.txt 2>/dev/null || echo "unknown")
fi

# 페이지 경로
PAGE=""
if [ -n "$SITE_URL" ]; then
  PAGE=$(echo "$SITE_URL" | sed -E 's|https?://[^/]+(\/[^?#]*)?.*|\1|')
  [ "$PAGE" = "$SITE_URL" ] && PAGE=""
fi
PAGE_FILE="/tmp/web-auto-current-page.txt"
if [ -n "$PAGE" ] && [ "$PAGE" != "/" ] && [ "$PAGE" != "" ]; then
  echo "$PAGE" > "$PAGE_FILE"
  echo "$SITE" > /tmp/web-auto-current-site.txt
elif [ -f "$PAGE_FILE" ]; then
  PAGE=$(cat "$PAGE_FILE")
fi
[ -z "$PAGE" ] && PAGE="/_unknown"

# 시퀀스 번호
SEQ_FILE="/tmp/web-auto-seq.txt"
SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo "0")
SEQ=$((SEQ + 1))
echo "$SEQ" > "$SEQ_FILE"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# JSON 이스케이프
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }

# JSONL append
ACTIONS_FILE="/tmp/web-auto-actions.jsonl"
printf '{"seq":%d,"site":"%s","page":"%s","subcmd":"%s","command":"%s","output":"%s","type":"%s","ts":"%s"}\n' \
  "$SEQ" "$(esc "$SITE")" "$(esc "$PAGE")" "$(esc "$SUBCMD")" "$(esc "$COMMAND")" "$(esc "$OUTPUT")" "$TYPE" "$TIMESTAMP" \
  >> "$ACTIONS_FILE"

COUNT=$(wc -l < "$ACTIONS_FILE" 2>/dev/null | tr -d ' ')

# 에러 시 gotcha 컨텍스트 주입
if [ "$TYPE" = "error" ]; then
  cat <<EOJSON
{"continue":true,"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"⚠️ [gotcha] #${SEQ} ${SUBCMD} ${PAGE} — ${OUTPUT:0:200}"}}
EOJSON
else
  cat <<EOJSON
{"continue":true,"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"📋 [${TYPE}] #${SEQ} ${SUBCMD} ${PAGE} (${COUNT}건)"}}
EOJSON
fi

exit 0
