#!/bin/bash
# PostToolUse hook: NAV_INDEX_MISS / NAV_INDEX_STALE 감지 시
# 백그라운드 Claude subprocess를 spawn하여 nav-index를 자동 업데이트

INPUT=$(cat)

CLAUDE_BIN=$(which claude 2>/dev/null)
[ -z "$CLAUDE_BIN" ] && exit 0

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_TS="$MEVOPS_ROOT/scripts/browser.ts"

# 1) NAV_INDEX_MISS: URL 패턴 자체가 nav-index에 없음
if echo "$INPUT" | /usr/bin/grep -q 'NAV_INDEX_MISS:https\?://'; then
  MISS_URL=$(echo "$INPUT" | /usr/bin/grep -oE 'NAV_INDEX_MISS:https?://[^"\\]+' | head -1 | sed 's/NAV_INDEX_MISS://')

  PROMPT=$(cat <<EOF
nav-index에 등록되지 않은 페이지가 발견되었다: ${MISS_URL}

아래 절차로 nav-index를 업데이트하라:

1. bun ${BROWSER_TS} eval "document.body.innerText.substring(0,3000)" 실행하여 DOM 구조 파악
2. bun ${BROWSER_TS} eval "performance.getEntriesByType('resource').filter(r => r.initiatorType === 'xmlhttprequest' || r.initiatorType === 'fetch').map(r => r.name).join('\n')" 실행하여 API 엔드포인트 탐색
3. ${NAV_INDEX_PATH} yaml 파일에 새 블록 추가:
   - url: 와일드카드 패턴
   - selectors: 주요 콘텐츠 셀렉터 (title, body, items 등)
   - api: 발견된 API 엔드포인트 (있으면)
   - 주석으로 페이지 구조, 주의사항 기록
4. bun ${BROWSER_TS} extract "새블록이름" 실행하여 검증

nav-index yaml 형식 예시:
  block-name:
    url: https://example.com/path/*
    selectors:
      title: h1
      body: article .prose
    api:
      data: https://example.com/api/endpoint?param={param}

기존 nav-index 파일을 먼저 Read하여 형식을 맞출 것.
EOF
)

  nohup "$CLAUDE_BIN" -p \
    --model sonnet \
    --allowedTools "Bash(bun *) Bash(curl *) Read Edit" \
    --no-session-persistence \
    "$PROMPT" \
    > /tmp/nav-index-miss-$(date +%s).log 2>&1 &

  cat <<HOOKJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "🔧 NAV_INDEX_MISS: ${MISS_URL}\n백그라운드 Claude subprocess가 nav-index 업데이트를 처리 중입니다. 현재 작업을 계속하세요."
  }
}
HOOKJSON
  exit 0
fi

# 2) NAV_INDEX_STALE: URL 패턴은 있지만 미등록 API 발견
if echo "$INPUT" | /usr/bin/grep -q 'NAV_INDEX_STALE:https\?://'; then
  STALE_URL=$(echo "$INPUT" | /usr/bin/grep -oE 'NAV_INDEX_STALE:https?://[^"\\]+' | head -1 | sed 's/NAV_INDEX_STALE://')
  NEW_APIS=$(echo "$INPUT" | /usr/bin/grep -A 20 'nav-index에 미등록된 API' | /usr/bin/grep '^\s*-' | head -5 | sed 's/^\s*- //' | tr '\n' ', ' | sed 's/,$//')

  PROMPT=$(cat <<EOF
nav-index에 등록된 페이지이지만, 미등록 API 엔드포인트가 발견되었다.

페이지: ${STALE_URL}
미등록 API: ${NEW_APIS}

${NAV_INDEX_PATH} 파일을 Read한 후, 해당 블록의 api 섹션에 새 엔드포인트를 추가하라.
각 API의 용도를 주석으로 기록할 것.
EOF
)

  nohup "$CLAUDE_BIN" -p \
    --model sonnet \
    --allowedTools "Read Edit" \
    --no-session-persistence \
    "$PROMPT" \
    > /tmp/nav-index-stale-$(date +%s).log 2>&1 &

  cat <<HOOKJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "🔧 NAV_INDEX_STALE: ${STALE_URL}\n백그라운드 Claude subprocess가 nav-index API 업데이트를 처리 중입니다. 현재 작업을 계속하세요."
  }
}
HOOKJSON
  exit 0
fi

exit 0
