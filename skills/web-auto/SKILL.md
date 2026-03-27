---
name: web-auto
description: >
  웹 페이지 데이터 추출, 브라우저 자동화, UI 디버깅.
  triggers on "사이트에서 긁어와", "페이지 열어봐", "크롤링해줘", "웹에서 데이터 가져와",
  "스크린샷 찍어", "이 URL 확인해봐", "브라우저로 접속해서", "extract", "navigate",
  "DOM 확인", "웹 자동화", "셀렉터로 추출"
model: opus
---

# Web Autopilot v2

`agent-browser` CLI로 브라우저를 자동화합니다. CDP로 기존 Chrome에 연결.

## Playbook-First Workflow

1. **Playbook 있으면** — UserPromptSubmit 훅이 자동 안내. `bun {path}` 실행만 하면 끝.
2. **Playbook 없으면** — agent-browser로 탐색. 세션 종료 시 자동으로 Playwright 스크립트 생성.
3. **다음 번** — 같은 작업 요청 시 생성된 playbook 자동 매칭.

## 핵심 명령

| 명령 | 용도 |
|------|------|
| `agent-browser open <url>` | 페이지 이동 |
| `agent-browser click <text>` | 텍스트 기반 클릭 |
| `agent-browser fill <sel> <text>` | 입력 필드 채우기 |
| `agent-browser type <sel> <text>` | 키보드 입력 |
| `agent-browser select <sel> <val>` | 드롭다운 선택 |
| `agent-browser eval <js>` | JS 실행 |
| `agent-browser scroll <dir> [px]` | 스크롤 |
| `agent-browser wait <sel\|ms>` | 대기 |
| `agent-browser press <key>` | 키 입력 |
| `agent-browser snapshot` | AX tree (ref 기반) |
| `agent-browser screenshot` | 스크린샷 |

108+ 명령 전체: `agent-browser --help`

## CDP 연결

```bash
# 한번 연결하면 이후 --cdp 불필요
agent-browser connect 9222
```

Chrome이 꺼져 있으면:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-dev-profile" &
```
**Gotchas**

1. **"Session with given id not found"**: 데몬의 캐시된 session ID가 만료된 상태. `connect`만 재실행해도 해결 안 됨. 반드시 데몬을 kill하고 재연결:
   ```bash
   kill $(cat ~/.agent-browser/default.pid) 2>/dev/null
   rm -f ~/.agent-browser/default.pid ~/.agent-browser/default.sock
   agent-browser connect 9222
   ```

## 사이트별 패턴 (`patterns/`)

`~/claude-plugins/web-auto/skills/web-auto/patterns/{site}.md`에 사이트별 지식 관리.

**사전 읽기**: 작업 시작 전, 대상 사이트의 patterns 파일을 반드시 먼저 읽고 숙지.
localhost 사이트는 프로젝트명(예: `mevops.md`)으로 매칭.

## Playbooks (`playbooks/`)

`~/claude-plugins/web-auto/playbooks/{site}/{task}.ts`에 자동 생성된 Playwright 스크립트.
`bun {path}`로 실행. 수정이 필요하면 직접 편집 가능.

## Hook 시스템

| 훅 | 역할 |
|---|---|
| UserPromptSubmit → `playbook-match.sh` | playbook 매칭 또는 patterns 주입 |
| PostToolUse (Bash) → `action-log.sh` | agent-browser 액션 JSONL 기록 |
| Stop → `codegen-flush.sh` | JSONL → Playwright 스크립트 자동 생성 |
