#!/bin/bash
# Stop hook: 세션 로그에서 haiku로 실행 가능한 playbook을 추출하여 YAML에 기록

GOTCHA_FILE="/tmp/web-auto-gotchas.jsonl"
PATTERNS_DIR="$HOME/claude-plugins/web-auto/skills/web-auto/patterns"
PROMPT_FILE="/tmp/web-auto-refine-prompt.txt"
REFINED_FILE="/tmp/web-auto-refined-gotchas.txt"

# JSONL 파일이 없거나 비어있으면 스킵
[ -s "$GOTCHA_FILE" ] || exit 0

# 전체 로그 읽기
SESSION_LOG=$(cat "$GOTCHA_FILE")
TOTAL=$(echo "$SESSION_LOG" | wc -l | tr -d ' ')

# 사이트 추출 (첫 번째 항목에서)
SITE=$(echo "$SESSION_LOG" | head -1 | sed 's/.*"site":"\([^"]*\)".*/\1/')
YAML_FILE="$PATTERNS_DIR/${SITE}.yaml"
EXISTING_YAML=""
[ -f "$YAML_FILE" ] && EXISTING_YAML=$(cat "$YAML_FILE")

# haiku용 프롬프트 생성
cat > "$PROMPT_FILE" << 'PROMPT_HEADER'
아래는 브라우저 자동화 세션의 전체 명령 로그입니다 (seq 순서대로).
이 로그를 분석해서 **다음 세션에서 시행착오 없이 바로 실행 가능한 playbook**을 추출하세요.

규칙:
1. 실패한 시도는 무시하고, 최종적으로 성공한 경로만 추출
2. 각 스텝은 **실제 실행 가능한 browser.ts 명령 또는 eval JS 코드**를 포함해야 함
3. "클릭한다", "입력한다" 같은 설명이 아니라 구체적 코드/명령을 기록
4. eval JS 코드는 그대로 복사-실행 가능하도록 완전한 코드 포함
5. 시행착오에서 배운 주의사항(gotcha)도 해당 스텝의 note로 기록
6. 기존 YAML에 이미 있는 playbook과 중복되면 NONE 출력

출력 형식 (이것만 출력, 다른 설명 없이):
/page_path:
  goal: "달성한 목표 한 줄 설명"
  playbook:
    - cmd: "browser.ts 명령 또는 eval JS 코드"
      note: "주의사항 (없으면 생략)"
    - cmd: "다음 스텝"

여러 페이지에 걸친 워크플로우면 페이지별로 분리.
유용한 playbook이 없으면 (탐색만 한 경우) NONE만 출력.

PROMPT_HEADER

# 세션 로그 추가
echo "세션 로그 (${TOTAL}건):" >> "$PROMPT_FILE"
echo "$SESSION_LOG" >> "$PROMPT_FILE"

echo "" >> "$PROMPT_FILE"
echo "기존 YAML (중복 체크용, 일부):" >> "$PROMPT_FILE"
echo "${EXISTING_YAML:0:3000}" >> "$PROMPT_FILE"

# haiku 호출
if claude -p --model haiku < "$PROMPT_FILE" > "$REFINED_FILE" 2>/dev/null; then
  RESULT=$(cat "$REFINED_FILE")
  if [ -n "$RESULT" ] && [ "$RESULT" != "NONE" ] && [ ${#RESULT} -gt 10 ]; then
    # bun으로 YAML 삽입
    bun "$HOME/claude-plugins/web-auto/hooks/gotcha-insert-yaml.ts" "$YAML_FILE" "$REFINED_FILE" 2>&1
  else
    echo "📝 새로운 playbook 없음" >&2
  fi
else
  echo "⚠️ Haiku 호출 실패" >&2
fi

# 정리
rm -f "$GOTCHA_FILE" "$PROMPT_FILE" "$REFINED_FILE"
rm -f /tmp/web-auto-current-page.txt /tmp/web-auto-seq.txt
PID_FILE="/tmp/web-auto-gotcha-worker.pid"
PORT_FILE="/tmp/web-auto-gotcha-worker.port"
[ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null
rm -f "$PID_FILE" "$PORT_FILE" 2>/dev/null

exit 0
