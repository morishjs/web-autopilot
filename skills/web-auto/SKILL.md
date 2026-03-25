---
name: web-auto
description: >
  웹 페이지 데이터 추출, 브라우저 자동화, UI 디버깅.
  triggers on "사이트에서 긁어와", "페이지 열어봐", "크롤링해줘", "웹에서 데이터 가져와",
  "스크린샷 찍어", "이 URL 확인해봐", "브라우저로 접속해서", "extract", "navigate",
  "DOM 확인", "웹 자동화", "셀렉터로 추출"
---

# Web Autopilot

`bun ~/claude-plugins/web-auto/src/browser.ts` CLI로 브라우저를 자동화합니다.
MCP chrome-devtools tool 대신 CDP WebSocket 직접 통신. 모든 프로젝트에서 사용 가능.

## 목표

사이트별 patterns 파일의 경험적 지식(API, 셀렉터, gotcha, 워크플로우)을 축적하여, 반복 작업 시 탐색 없이 즉시 자동화할 수 있게 만든다.

## 핵심 동작

| 명령 | 용도 |
|------|------|
| `navigate` | 페이지 이동 |
| `eval` | JS 실행 — API fetch, iframe 접근, DOM 탐색 |
| `click` | 텍스트 기반 UI 클릭 |
| `snapshot` / `screenshot` | 페이지 상태 확인 |

## Gotchas (반드시 확인)

1. **`--user-data-dir` 누락 = 세션 소실**: Chrome을 CDP 모드로 재시작할 때 `--user-data-dir="$HOME/.chrome-dev-profile"` 없으면 로그인 세션이 전부 날아감
2. **iframe 사이트는 셀렉터 불가**: `eval`로 iframe contentDocument 접근 필수
3. **가상스크롤 = DOM 불완전**: 전수 데이터는 API로 수집해야 정확
4. **SPA 페이지 전환**: 내부 라우팅이 안 되면 `window.location.href` 직접 변경 필요
5. **bot detection 주의**: 일부 사이트는 fetch/XHR 직접 호출 시 봇으로 차단

## 사이트별 패턴 (`patterns/`)

사이트별 경험적 지식을 `~/claude-plugins/web-auto/skills/web-auto/patterns/{site}.md`에 관리한다.
하나의 파일에 해당 사이트의 모든 지식을 통합:

- **인증 방법** (로그인, 토큰 획득)
- **API 엔드포인트** (URL, Method, 요청 형식)
- **CSS 셀렉터** (페이지별 주요 요소)
- **UI 워크플로우** (결제 플로우, 모달 조작 순서 등)
- **Gotcha** (예상과 다른 동작, 필수 선행 조건)

| 파일 | 용도 |
|------|------|
| `patterns/generic.md` | 일반 사이트 — 기본 전략 |
| `patterns/{site}.md` | 사이트별 패턴 — 새 사이트 발견 시 자동 생성 |

**사전 읽기**: 작업 시작 전, 대상 URL의 도메인/호스트에 해당하는 patterns 파일이 있으면 **반드시 먼저 읽고** 숙지한 후 자동화를 시작한다. localhost 사이트는 프로젝트명(예: `experdy.md`)으로 매칭한다.

**자동 기록**: 사용 중 예상과 다르게 동작하는 부분(gotcha)을 발견하면, gotcha worker API에 즉시 POST한다. 세션 종료 시 Stop hook이 자동으로 patterns 파일에 flush한다.

```bash
# gotcha 발견 시 worker에 기록 (에러가 아닌 행동 패턴 gotcha도 포함)
PORT=$(cat /tmp/web-auto-gotcha-worker.port 2>/dev/null)
[ -n "$PORT" ] && curl -s -X POST "http://127.0.0.1:${PORT}/gotcha" \
  -H "Content-Type: application/json" \
  -d '{"site":"<site-name>","command":"click 수정","error":"인라인 편집 미지원 — 더보기 메뉴 경유 필요","timestamp":"2026-03-23 19:00"}'
```

기록 대상:
- browser.ts 에러 (hook이 자동 캡처)
- **예상과 다른 UI 동작** (클릭했는데 반응 없음, 모달이 예상과 다른 위치에 뜸 등)
- **필수 선행 조건** (드롭다운 선택 필수, 저장 버튼 클릭 필수 등)
- **페이지 자동 이동** (결제 후 스케줄 페이지로 이동 등)
- **새로 발견한 API 엔드포인트나 셀렉터**

## CDP 사전 조건

CDP 포트 9222에 연결. 꺼져 있으면 `❌ HTTP 404 from CDP port 9222`.

```bash
pkill -9 "Google Chrome" && sleep 3
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-dev-profile" &
```

확인: `curl -s http://localhost:9222/json/version`
