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

nav-index에 등록된 페이지에서 안정적으로 데이터를 추출하고, 미등록 페이지를 발견하면 nav-index를 확장하여 재사용 가능하게 만든다.

## 핵심 동작

| 명령 | 용도 |
|------|------|
| `navigate` | 페이지 이동 + nav-index 자동 조회 → 컨텍스트 제공 |
| `extract` | nav-index 셀렉터로 구조화된 데이터 추출 (스크린샷 불필요) |
| `eval` | JS 실행 — API fetch, iframe 접근, DOM 탐색 |
| `click` | 텍스트 기반 UI 클릭 |
| `snapshot` / `screenshot` | 페이지 상태 확인 |

## Gotchas (반드시 확인)

1. **`--user-data-dir` 누락 = 세션 소실**: Chrome을 CDP 모드로 재시작할 때 `--user-data-dir="$HOME/.chrome-dev-profile"` 없으면 로그인 세션이 전부 날아감
2. **iframe 사이트는 extract 불가**: iframe 안에 콘텐츠가 있는 사이트는 CSS 셀렉터가 작동 안 함. `eval`로 iframe contentDocument 접근 필수
3. **가상스크롤 = DOM 불완전**: 가상스크롤 페이지는 DOM에 화면 내 항목만 존재. 전수 데이터는 API로 수집해야 정확
4. **SPA 페이지 전환**: SPA에서 다른 페이지로 전환할 때 내부 라우팅이 안 되면 `window.location.href` 직접 변경 필요
5. **extract/eval 미등록 차단**: nav-index에 없는 페이지에서 extract/snapshot/eval 실행하면 exit code 2로 차단. navigate는 경고만 출력하고 진행
6. **bot detection 주의**: 일부 사이트는 fetch/XHR 직접 호출 시 봇으로 차단. nav-index 주석에 API 사용 가능 여부 확인

## 사이트별 패턴 (`patterns/`)

사이트별 경험적 지식(gotcha, 인증 방법, API 호출 패턴, 워크플로우)을 `patterns/{site}.md`에 관리한다.
nav-index가 "어떻게 접근하는가"(URL→셀렉터 매핑)라면, patterns는 "무엇을 주의해야 하는가"(경험적 지식)이다.

| 파일 | 용도 |
|------|------|
| `patterns/generic.md` | 일반 사이트 — 셀렉터 추출, API 발견, 가상스크롤 대응 |
| `patterns/experdy.md` | Experdy — Firebase 토큰, API 호스트, 모달 조작 |

**자동 기록**: 사용 중 예상과 다르게 동작하는 부분(gotcha)을 발견하면, 유저 요청 없이도 해당 사이트의 패턴 파일에 즉시 추가한다. 파일이 없으면 새로 생성.

## CDP 사전 조건

CDP 포트 9222에 연결. 꺼져 있으면 `❌ HTTP 404 from CDP port 9222`.

```bash
pkill -9 "Google Chrome" && sleep 3
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-dev-profile" &
```

확인: `curl -s http://localhost:9222/json/version`

## 프로젝트별 nav-index

`$NAV_INDEX_PATH` 환경변수 또는 `--nav-index` 옵션으로 프로젝트별 nav-index 지정.
