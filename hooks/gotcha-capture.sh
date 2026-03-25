#!/bin/bash
# PostToolUse hook: browser.ts 전체 세션 로그를 JSONL에 기록
# 성공/실패 모두 기록 — flush 시 haiku가 성공 플로우를 playbook으로 추출

INPUT=$(cat)

# Bash + browser.ts만 처리
echo "$INPUT" | /usr/bin/grep -q '"tool_name"' || exit 0
echo "$INPUT" | /usr/bin/grep -q 'browser\.ts' || exit 0

# 성공/실패 판정
TYPE="unknown"
echo "$INPUT" | /usr/bin/grep -qE '❌|Exit code [1-9]|eval error|알 수 없는 명령|ECONNREFUSED' && TYPE="error"
echo "$INPUT" | /usr/bin/grep -qE '✅|📸|── snapshot' && TYPE="success"

# 명령어 추출 (2000자)
COMMAND=$(echo "$INPUT" | /usr/bin/grep -oE 'browser\.ts[^"\\]*' | head -1 | sed 's/\\n/ /g')
COMMAND="${COMMAND:0:2000}"

# 서브커맨드 (navigate, eval, click, snapshot 등)
SUBCMD=$(echo "$COMMAND" | sed -E 's/browser\.ts\s+(--match\s+\S+\s+)?//' | awk '{print $1}')

# 결과 추출 (1000자)
OUTPUT=$(echo "$INPUT" | /usr/bin/grep -oE '(✅[^"\\]*|📸[^"\\]*|❌[^"\\]*|eval error[^"\\]*|── snapshot[^"\\]*)' | head -3 | tr '\n' ' ')
OUTPUT="${OUTPUT:0:1000}"

# 사이트 추출
SITE_URL=$(echo "$INPUT" | /usr/bin/grep -oE 'https?://[^"\\[:space:]]+' | head -1)
if [ -n "$SITE_URL" ]; then
  SITE=$(echo "$SITE_URL" | sed -E 's|https?://([^/]+).*|\1|' | sed 's/^www\.//' | awk -F. '{if (NF >= 2) print $(NF-1); else print $1}')
else
  echo "$INPUT" | /usr/bin/grep -q 'localhost' && SITE="localhost" || SITE="unknown"
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

# JSON 안전 이스케이프 (bash 내장)
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }

# JSONL append
GOTCHA_FILE="/tmp/web-auto-gotchas.jsonl"
printf '{"seq":%d,"site":"%s","page":"%s","subcmd":"%s","command":"%s","output":"%s","type":"%s","ts":"%s"}\n' \
  "$SEQ" "$(esc "$SITE")" "$(esc "$PAGE")" "$(esc "$SUBCMD")" "$(esc "$COMMAND")" "$(esc "$OUTPUT")" "$TYPE" "$TIMESTAMP" \
  >> "$GOTCHA_FILE"

# 세션 로깅
COUNT=$(wc -l < "$GOTCHA_FILE" 2>/dev/null | tr -d ' ')
cat <<EOJSON
{"continue":true,"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"📋 [${TYPE}] #${SEQ} ${SUBCMD:0:10} ${PAGE} (${COUNT}건)"}}
EOJSON

exit 0
