# 일반 사이트 패턴

## CSS 셀렉터 기반 추출

대부분의 사이트는 nav-index에 셀렉터를 등록하면 extract로 바로 추출 가능.

```yaml
site-name:
  url: https://example.com/path/*    # 와일드카드 패턴
  selectors:
    title: h1
    body: article .prose
    author: .author-name
    items: .list-item                 # 복수 요소는 배열로 반환
  api:                                # 대량 수집용 (있으면)
    data: https://example.com/api/endpoint?param={param}
```

## API 엔드포인트 발견

대량 데이터가 필요하거나 DOM이 불완전할 때(가상스크롤, pagination) API 사용.

1. navigate로 페이지 이동
2. API 탐색:
   ```bash
   eval "performance.getEntriesByType('resource').filter(r => r.name.includes('api')).map(r => r.name).join('\n')"
   ```
3. 발견한 API를 nav-index `api` 필드에 추가
4. eval에서 fetch로 호출

## 가상스크롤 대응

가상스크롤 페이지는 DOM에 화면에 보이는 항목만 존재 (~30건).

- **소량**: 스크롤 → 추가 로드 → extract 반복
- **전량**: API 발견 후 fetch로 전수 조회 (권장)

## XpressEngine CMS (에펨코리아 등)

```yaml
xe-article:
  url: https://www.example.com/*
  selectors:
    title: .np_18px
    body: .xe_content
    date: .date.m_no
    author: .member_plate
```
