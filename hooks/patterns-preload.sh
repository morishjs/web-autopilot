#!/bin/bash
# UserPromptSubmit hook: web-auto 사용 시 관련 patterns 파일을 additionalContext로 주입
# URL에서 사이트명을 추출하고, patterns/{site}.md가 있으면 내용을 주입

INPUT=$(cat)

# web-auto 관련 프롬프트인지 확인 (web-auto 스킬 트리거 키워드)
PROMPT=$(echo "$INPUT" | sed -n 's/.*"user_prompt"[[:space:]]*:[[:space:]]*"\(.*\)"/\1/p' | head -1)
[ -z "$PROMPT" ] && exit 0

# web-auto 관련 키워드가 없으면 무시
echo "$PROMPT" | /usr/bin/grep -qiE 'web-auto|browser\.ts|navigate|크롤링|스크린샷|웹.*자동화|사이트.*긁|페이지.*열|DOM.*확인|셀렉터|localhost:[0-9]|https?://' || exit 0

PATTERNS_DIR="${CLAUDE_PLUGIN_ROOT}/skills/web-auto/patterns"
[ ! -d "$PATTERNS_DIR" ] && exit 0

# hook input에서 cwd 추출 (신뢰할 수 있는 유일한 소스)
PROJECT_DIR=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null)
[ -z "$PROJECT_DIR" ] && exit 0

# URL에서 사이트명 추출
SITE_URL=$(echo "$PROMPT" | /usr/bin/grep -oE 'https?://[^"\\[:space:]]+' | head -1)

SITE=""
if [ -n "$SITE_URL" ]; then
  HOST=$(echo "$SITE_URL" | sed -E 's|https?://([^/:]+).*|\1|')
  if echo "$HOST" | /usr/bin/grep -qE '^localhost'; then
    # localhost → 프로젝트명으로 매칭
    # 1. git remote에서 프로젝트명 추출 (cwd 기준)
    REPO_NAME=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null | sed -E 's|.*/||; s|\.git$||')
    if [ -n "$REPO_NAME" ] && [ -f "$PATTERNS_DIR/${REPO_NAME}.md" ]; then
      SITE="$REPO_NAME"
    # 2. 프로젝트 디렉토리명으로 시도
    elif [ -f "$PATTERNS_DIR/$(basename "$PROJECT_DIR").md" ]; then
      SITE=$(basename "$PROJECT_DIR")
    # 3. localhost 전용 패턴
    else
      # localhost:PORT 패턴 파일 확인
      PORT=$(echo "$SITE_URL" | /usr/bin/grep -oE ':[0-9]+' | tr -d ':')
      if [ -n "$PORT" ] && [ -f "$PATTERNS_DIR/localhost:${PORT}.md" ]; then
        SITE="localhost:${PORT}"
      elif [ -f "$PATTERNS_DIR/localhost.md" ]; then
        SITE="localhost"
      fi
    fi
  else
    # 외부 사이트 → 도메인명 추출
    SITE=$(echo "$HOST" | sed 's/^www\.//' | awk -F. '{if (NF >= 2) print $(NF-1); else print $1}')
  fi
fi

# 사이트 특정 안 되면 generic
[ -z "$SITE" ] && SITE="generic"

PATTERN_FILE="$PATTERNS_DIR/${SITE}.md"
[ ! -f "$PATTERN_FILE" ] && exit 0

# 파일 크기 확인 (10KB 이하만)
FILE_SIZE=$(wc -c < "$PATTERN_FILE" | tr -d ' ')
if [ "$FILE_SIZE" -gt 10240 ]; then
  # 너무 크면 처음 5000자만
  CONTENT=$(head -c 5000 "$PATTERN_FILE")
  CONTENT="${CONTENT}

... (truncated, full file: ${PATTERN_FILE})"
else
  CONTENT=$(cat "$PATTERN_FILE")
fi

# JSON 안전 이스케이프
ESCAPED=$(printf '%s' "$CONTENT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null)
# python3 실패 시 기본 이스케이프
if [ -z "$ESCAPED" ]; then
  ESCAPED=$(printf '%s' "$CONTENT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')
  ESCAPED="\"${ESCAPED}\""
fi

cat <<EOJSON
{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[web-auto patterns/${SITE}.md auto-loaded]\n${CONTENT}"}}
EOJSON

exit 0
