#!/bin/bash
# UserPromptSubmit hook: playbook 매칭 → 있으면 실행 안내, 없으면 patterns 주입

INPUT=$(cat)

# prompt 추출
PROMPT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null)
[ -z "$PROMPT" ] && exit 0

# web-auto 관련 키워드가 없으면 무시
echo "$PROMPT" | /usr/bin/grep -qiE 'web-auto|agent-browser|크롤링|스크린샷|웹.*자동화|사이트.*긁|페이지.*열|DOM.*확인|셀렉터|localhost:[0-9]|https?://|데이터.*뽑|데이터.*추출|브라우저|네트워크.*탭|네트워크.*확인' || exit 0

BASE_DIR="$HOME/claude-plugins/web-auto"
PLAYBOOKS_DIR="$BASE_DIR/playbooks"
PATTERNS_DIR="$BASE_DIR/skills/web-auto/patterns"

# cwd에서 프로젝트명 추출
PROJECT_DIR=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null)

# URL에서 사이트명 추출 (프로토콜 있는 경우 + localhost:PORT 패턴)
SITE_URL=$(echo "$PROMPT" | /usr/bin/grep -oE 'https?://[^"\\[:space:]]+' | head -1)
[ -z "$SITE_URL" ] && SITE_URL=$(echo "$PROMPT" | /usr/bin/grep -oE 'localhost:[0-9]+[^"\\[:space:]]*' | head -1)

SITE=""
if [ -n "$SITE_URL" ]; then
  URL_HOST=$(echo "$SITE_URL" | sed -E 's|https?://||; s|/.*||')
  HOST=$(echo "$URL_HOST" | sed -E 's|:.*||')

  if echo "$HOST" | /usr/bin/grep -qE '^localhost'; then
    # localhost → git remote name으로 매칭
    REPO_NAME=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null | sed -E 's|.*/||; s|\.git$||')
    [ -n "$REPO_NAME" ] && SITE="$REPO_NAME" || SITE=$(basename "$PROJECT_DIR")
  else
    # 외부 도메인 → yaml aliases에서 매칭
    for yaml in "$PATTERNS_DIR"/*.yaml; do
      [ -f "$yaml" ] || continue
      SITE_NAME=$(head -1 "$yaml" | sed -n 's/^site: *//p')
      if /usr/bin/grep -q "aliases:" "$yaml" 2>/dev/null; then
        if /usr/bin/grep "aliases:" "$yaml" | /usr/bin/grep -qF "$URL_HOST"; then
          SITE="$SITE_NAME"
          break
        fi
      fi
    done
    # aliases 매칭 없으면 도메인에서 추출
    [ -z "$SITE" ] && SITE=$(echo "$HOST" | sed 's/^www\.//' | awk -F. '{if (NF >= 2) print $(NF-1); else print $1}')
  fi
fi
[ -z "$SITE" ] && SITE="generic"

# --- playbook 검색 ---
if [ -d "$PLAYBOOKS_DIR/$SITE" ]; then
  # 프롬프트 키워드로 매칭
  MATCHES=$(grep -rl --include="*.ts" -iE "$(echo "$PROMPT" | tr ' ' '|')" "$PLAYBOOKS_DIR/$SITE/" 2>/dev/null | head -3)

  if [ -n "$MATCHES" ]; then
    PLAYBOOK=$(echo "$MATCHES" | head -1)
    # 파일 헤더에서 goal 추출
    GOAL=$(grep -m1 'goal:' "$PLAYBOOK" 2>/dev/null | sed 's/.*goal:\s*//')
    [ -z "$GOAL" ] && GOAL=$(head -5 "$PLAYBOOK" | grep -m1 'Playbook:' | sed 's/.*Playbook:\s*//')

    cat <<EOJSON
{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[web-auto] Playbook 발견: $PLAYBOOK\nGoal: ${GOAL}\nbun $PLAYBOOK 로 실행하세요. 수정이 필요하면 파일을 먼저 확인하세요."}}
EOJSON
    exit 0
  fi
fi

# --- playbook 없으면 patterns 주입 ---
PATTERN_FILE="$PATTERNS_DIR/${SITE}.md"
[ ! -f "$PATTERN_FILE" ] && exit 0

FILE_SIZE=$(wc -c < "$PATTERN_FILE" | tr -d ' ')
if [ "$FILE_SIZE" -gt 10240 ]; then
  CONTENT=$(head -c 5000 "$PATTERN_FILE")
  CONTENT="${CONTENT}

... (truncated, full: ${PATTERN_FILE})"
else
  CONTENT=$(cat "$PATTERN_FILE")
fi

cat <<EOJSON
{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[web-auto] patterns/${SITE}.md 로드됨\n${CONTENT}"}}
EOJSON

exit 0
