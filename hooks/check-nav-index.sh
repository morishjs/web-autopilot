#!/bin/bash
# SessionStart hook: nav-index 파일 존재 여부 확인 및 초기 설정 안내
# web-auto 패키지의 일부로 세션 시작 시 실행됨

NAV_INDEX="${NAV_INDEX_PATH:-docs/ui-nav-index.yaml}"

if [ ! -f "$NAV_INDEX" ]; then
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "⚠️ nav-index 파일이 없습니다: ${NAV_INDEX}\nagent-browser의 extract/snapshot/eval은 nav-index 없이 동작하지 않습니다.\n\n설정 방법:\n1. bunx web-auto init  (템플릿 자동 생성)\n2. 또는 직접 ${NAV_INDEX} 파일을 생성\n\nnav-index yaml 형식:\n\`\`\`yaml\npage-name:\n  url: https://example.com/path/*\n  selectors:\n    title: h1\n    body: article .prose\n\`\`\`"
  }
}
EOF
  exit 0
fi

exit 0
