#!/bin/bash
# PostToolUse hook: navigate 성공 시 도메인 매칭 패턴 파일 내용을 직접 주입
# 예: finance.yahoo.com → yahoo.md, news.google.com → google.md

INPUT=$(cat)

# NAV_INDEX_MISS가 있으면 스킵 (nav-index-miss.sh가 처리)
echo "$INPUT" | /usr/bin/grep -q 'NAV_INDEX_MISS' && exit 0

# navigate 명령인지 확인
echo "$INPUT" | /usr/bin/grep -q 'navigate' || exit 0

# URL 추출
URL=$(echo "$INPUT" | /usr/bin/grep -oE 'https?://[^"\\[:space:]]+' | head -1)
[ -z "$URL" ] && exit 0

# 도메인에서 키워드 추출 (www. 제거 → TLD 앞 단어)
DOMAIN=$(echo "$URL" | sed -E 's|https?://([^/]+).*|\1|' | sed 's/^www\.//')
MAIN_DOMAIN=$(echo "$DOMAIN" | awk -F. '{if (NF >= 2) print $(NF-1); else print $1}')
[ -z "$MAIN_DOMAIN" ] && exit 0

# 패턴 파일 검색 (프로젝트 → 플러그인 순)
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_PATTERNS="$HOOK_DIR/../skills/web-auto/patterns"

PROJECT_PATTERNS=""
if [ -n "$NAV_INDEX_PATH" ]; then
  PROJECT_ROOT="$(dirname "$(dirname "$NAV_INDEX_PATH")")"
  PROJECT_PATTERNS="$PROJECT_ROOT/.claude/web-auto-patterns"
fi

PATTERN_FILE=""
for DIR in "$PROJECT_PATTERNS" "$PLUGIN_PATTERNS"; do
  if [ -n "$DIR" ] && [ -f "$DIR/$MAIN_DOMAIN.md" ]; then
    PATTERN_FILE="$DIR/$MAIN_DOMAIN.md"
    break
  fi
done

if [ -n "$PATTERN_FILE" ]; then
  # 패턴 파일 내용을 직접 읽어서 주입 (Read 지시 대신 인라인)
  # JSON 안전하게 이스케이프: 백슬래시, 따옴표, 줄바꿈
  CONTENT=$(cat "$PATTERN_FILE" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | awk '{printf "%s\\n", $0}' | sed 's/\\n$//')

  cat <<HOOKJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "📋 사이트 패턴 (${MAIN_DOMAIN}):\\n${CONTENT}"
  }
}
HOOKJSON
  exit 0
fi

exit 0
