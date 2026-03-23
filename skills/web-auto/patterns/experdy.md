# Experdy (dev.experdy.com) 패턴

React SPA (Vite + TanStack Query). Firebase Auth.

## 주의사항

- **API 호스트가 프론트엔드와 다름**: 프론트 `dev.experdy.com` / API `api.dev.experdy.com`
- **`--match` 키워드**: `"reservation"` 사용 (URL 기반). `"Mevops"`는 GitHub 탭과 충돌
- **동일 URL 탭 다수**: `--match`로 반드시 명시 지정
- **eval 비동기**: `window.__result`에 저장 → 다음 eval에서 읽는 2-step 패턴 필수
- **좌표 클릭 주의**: 캘린더 날짜 셀과 예약 블록이 가까움. DOM에서 좌표 먼저 확인

## Firebase 토큰 획득

```js
// eval로 실행 — IndexedDB에서 Firebase accessToken 추출
new Promise((resolve) => {
  var req = indexedDB.open('firebaseLocalStorageDb');
  req.onsuccess = function(e) {
    var db = e.target.result;
    var tx = db.transaction('firebaseLocalStorage', 'readonly');
    var store = tx.objectStore('firebaseLocalStorage');
    var getAll = store.getAll();
    getAll.onsuccess = function() {
      var item = getAll.result.find(i => i.value && i.value.stsTokenManager);
      resolve(item ? item.value.stsTokenManager.accessToken : null);
    };
  };
}).then(r => window.__fbToken = r);
// 다음 eval에서: window.__fbToken
```

## API 호출 패턴

토큰 획득 후 sync XHR로 호출:

```js
// stay calendar 조회
var x = new XMLHttpRequest();
x.open('GET', 'https://api.dev.experdy.com/v2/stay/calendar/2026-03-22', false);
x.setRequestHeader('Authorization', 'Bearer ' + window.__fbToken);
x.send();
var data = JSON.parse(x.responseText);
// data.stay_plans, data.stays
```

### 주요 API 엔드포인트

| API | Method | URL |
|-----|--------|-----|
| 캘린더 조회 | GET | `https://api.dev.experdy.com/v2/stay/calendar/{date}` |
| 예약 수정 | PATCH | `https://api.dev.experdy.com/v2/reservations/{reservationId}` |
| 기본 정보 | GET | `https://api.dev.experdy.com/v2/stay/calendar/base-info` |
| 환자 목록 | GET | `https://api.dev.experdy.com/v2/patients/dropdown` |
| SSE 캘린더 | GET | `https://api.dev.experdy.com/v2/sse/calendar` |

## 예약 캘린더 페이지 (/reservation)

### 예약 블록 찾기

```js
// 캘린더의 예약 블록 위치 + 텍스트
var all = document.querySelectorAll('[class*=block], [class*=card], [class*=event], [class*=plan]');
var results = [];
all.forEach(function(el) {
  var text = el.innerText?.trim();
  if (text && text.length > 0 && text.length < 100) {
    var rect = el.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 20 && rect.top > 50) {
      results.push({text: text.substring(0,40), x: Math.round(rect.x+rect.width/2), y: Math.round(rect.y+rect.height/2)});
    }
  }
});
JSON.stringify(results);
```

### 예약 수정 모달

예약 블록 클릭 → 사이드 패널 → "예약 변경" 버튼 클릭 → 모달 열림.

#### 모달 내 토글 스위치 찾기

```js
// 상담/시술/수면 토글 (Tailwind: w-9 h-5 rounded-[0.625rem])
var switches = document.querySelectorAll('button');
var results = [];
switches.forEach(function(el) {
  var rect = el.getBoundingClientRect();
  var cls = (el.className||'').toString();
  if (cls.includes('rounded-[0.625rem]') && rect.y > 60 && rect.y < 120) {
    results.push({x: Math.round(rect.x+rect.width/2), y: Math.round(rect.y+rect.height/2), w: Math.round(rect.width)});
  }
});
JSON.stringify(results);
// 순서: [0]=상담, [1]=시술, [2]=수면
```

#### 저장 버튼

```bash
bun src/browser.ts --match "reservation" click "예약변경"
```

## 테스트 워크플로우 예시

```bash
# 1. 페이지 이동
bun src/browser.ts --match "reservation" navigate "https://dev.experdy.com/reservation?date=2026-03-22"

# 2. 토큰 획득 (eval 2-step)
bun src/browser.ts --match "reservation" eval "<firebase token snippet>"
sleep 1
bun src/browser.ts --match "reservation" eval "window.__fbToken?.substring(0,20)"

# 3. API로 예약 데이터 확인 (eval 2-step)
bun src/browser.ts --match "reservation" eval "<api call snippet>"
sleep 2
bun src/browser.ts --match "reservation" eval "window.__calData"

# 4. 예약 블록 클릭
bun src/browser.ts --match "reservation" click-at {x} {y}

# 5. 사이드 패널 → 예약 변경 클릭
bun src/browser.ts --match "reservation" click "예약 변경"

# 6. 토글 조작 (좌표)
bun src/browser.ts --match "reservation" click-at 903 86   # 상담 토글
bun src/browser.ts --match "reservation" click-at 985 86   # 시술 토글

# 7. 저장
bun src/browser.ts --match "reservation" click "예약변경"

# 8. 스크린샷으로 결과 확인
bun src/browser.ts --match "reservation" screenshot --output /tmp/result.png
```
