# 견적 자동화 앱 (MVP 1차: 입주청소)

> 📐 **앞으로의 전체 설계·로드맵은 [`docs/설계도.md`](docs/설계도.md) 가 기준입니다.** 새 기능은 그 문서의 14장 체크리스트를 먼저 확인하세요.

## 왜 만드는가
서비스업 사장님은 현장 작업 중이라 문의에 늦게 답하고, 견적 계산에 시간을 쓰다 고객을 놓친다.
(고객 78%가 가장 먼저 응답한 업체를 선택) 또 비대면 견적 뒤 **현장 추가요금 분쟁**이 가장 큰 문제다.

→ **고객이 링크로 정보를 입력 → 사장님 단가표로 자동 계산 → 사장님이 확인 후 1번 눌러 발송.**
플랫폼(중개)이 아니라 **사장님용 도구**다.

### 핵심 원칙 (코드에 반영된 위치)
| 원칙 | 구현 위치 |
|---|---|
| 가격은 업체가 정한다. 앱은 계산·제안만 | 단가표는 `shops/{uid}/private/pricing`, 계산은 `js/calc.js` |
| 금액 발송은 반드시 사장님 승인 | 고객 제출 시 금액 없음 → 사장님이 `견적 발송`을 눌러야 `quotes` 생성 |
| 포함/불포함/현장 추가요금 조건 명시 | `calculateQuote()`의 `included / excluded / conditions` |
| 업종 템플릿 교체 구조 | 업종 규칙은 전부 `templates/*.json`. JS에 업종 지식 없음 |

---

## 파일 구조
```
index.html            → owner.html 로 이동
owner.html  js/owner.js   사장님 화면 (구글 로그인): 요청 목록 / 단가표 / 업체 정보 / 요청 상세·견적 편집
q.html      js/q.js       고객 입력 화면 (?shop=업체ID): 템플릿 steps 를 단계형으로 렌더링
view.html   js/view.js    견적서 (?id=견적ID): 금액·포함·불포함·⚠️조건, 예약 요청, 전화
js/config.js              ★ Firebase 설정값 (이 파일 한 곳만 수정)
js/firebase.js            Firebase 초기화(CDN 모듈, 빌드 없음) + 에뮬레이터 모드
js/calc.js                ★ 견적 계산 순수 함수 (DOM·Firebase 의존 없음)
js/templates.js           템플릿 로더 (Firestore templates/{id} → 없으면 templates/{id}.json)
js/util.js                DOM 도우미 h(), 토스트, 복사, 이미지 압축, 상태 라벨
templates/move-in-cleaning.json   ★ 입주청소 템플릿 (질문·체크리스트·할증·옵션·기본단가·포함/불포함)
css/style.css             모바일 우선 스타일
manifest.webmanifest, sw.js, icons/   PWA
firestore.rules, storage.rules, firebase.json   보안 규칙 (+ 에뮬레이터 설정)
tests/calc.test.mjs       계산 단위 테스트 (전 업종 템플릿 점검 포함, 설치 불필요)
dev.html    js/dev.js     개발자 모드 · 업종 시뮬레이터
js/devtools.js            개발자 모드 · 오류 패널 (?dev=1)
templates/index.json      업종 목록 (live / draft)
tests/emulator/           보안 규칙 테스트 + 완료 시나리오 E2E (Firebase 에뮬레이터)
```

## 데이터 흐름
```
[사장님] 로그인 → shops/{uid} 자동 생성 → 업체정보·단가표 저장 → "링크 복사"
                                                   │  q.html?shop={uid}
[고객]   단계형 입력 + 사진(자동 압축) ──────────────┘
         → Storage requests/{shopId}/{requestId}/{slot}.jpg
         → Firestore requests/{id}  (status: new, 금액 없음)
[사장님] 목록(실시간) → 상세: calculateQuote(템플릿, 단가표, 요청, 수동조정)
         → 할증/옵션 토글, 금액·항목·조건 문구 직접 수정 → [견적 발송]
         → quotes/{id} 생성 + requests.status = sent  (배치 1회)
         → "문구 + 링크 복사" → 카톡·문자로 전송
[고객]   view.html?id={quoteId} → [이 견적으로 예약 요청]
         → quotes·requests.status = booking_requested  → 사장님 목록에 '계약요청' 실시간 표시
[사장님] 계약확정 / 보류 (requests·quotes 상태 동시 변경)
```

### 상태값
| 코드 | 화면 | 누가 바꾸나 |
|---|---|---|
| `new` | 신규 | 고객 제출 |
| `sent` | 발송완료 | 사장님 견적 발송 |
| `booking_requested` | 계약요청 | 고객 예약 요청 (sent 일 때만) |
| `confirmed` | 계약확정 | 사장님 |
| `hold` | 보류 | 사장님 |

## Firestore 구조
| 경로 | 내용 | 권한 |
|---|---|---|
| `shops/{shopId}` | `ownerUid, templateId, name, ownerName, phone, bizNo, logoUrl, manduId` | 누구나 get, 본인만 쓰기 |
| `shops/{shopId}/private/pricing` | `priceTable` (아래) | 본인만 |
| `templates/{templateId}` | 템플릿 JSON (선택. 없으면 저장소 JSON 사용) | 누구나 읽기, 콘솔에서만 쓰기 |
| `requests/{requestId}` | `shopId, templateId, status, customer{name,phone,region}, answers{…}, checklist{key:'yes'\|'no'\|'unknown'}, photos[{slot,path}], quoteId, createdAt` | 누구나 생성(검증), 사장님만 읽기/수정 |
| `quotes/{quoteId}` | `shopId, requestId, number, shop{…}, customer{name,region}, service{…}, lines[], total, depositPct, deposit, included[], excluded[], conditions[{label,text}], cancelPolicy, validUntil, verified, overrides, status` | 누구나 **get**(링크), list 는 본인만, 고객은 상태만 `sent→booking_requested` |

**설계 결정 (지시문과 다른 점과 이유)**
- `shopId = 사장님 uid` — 1계정 1업체. 규칙이 `request.auth.uid == shopId` 한 줄로 끝나 안전하고 단순하다. 다업체가 필요하면 `shops` 문서 ID를 랜덤으로 바꾸고 규칙을 `ownerUid` 비교로 바꾸면 된다.
- 단가표는 `shops/{id}` 가 아닌 `shops/{id}/private/pricing` — 업체 공개정보는 고객 화면이 읽어야 하므로 공개인데, 거기에 단가를 넣으면 경쟁업체가 링크만으로 단가표를 볼 수 있다.
- 사진 URL 대신 `path` 저장 — 고객은 Storage 읽기 권한이 없고(개인 집 사진), 사장님 화면이 권한 확인 후 다운로드 URL을 받는다.
- 견적서는 추측 불가능한 20자 ID 가 열쇠. 로그인 없이 링크로 열리되 목록 조회는 막는다. 고객 전화번호는 견적서에 넣지 않는다.

### priceTable
```json
{ "unitPrice": 13000, "minPrice": 250000,
  "surcharges": { "newBuild": 20, "weekend": 10, "sonEomneun": 10, "firstSlot": 5 },
  "options":    { "mold": 30000, "balcony": 20000, "closet": 30000, "sickHouse": 150000, "window": 50000, "sticker": 30000 },
  "policy":     { "validDays": 7, "depositPct": 10, "cancelPolicy": "…" } }
```
키는 템플릿의 `surcharges[].key`, `options[].key` 와 같다. 저장값이 없으면 템플릿 `defaults` 로 채운다 (`mergePriceTable`).

## 계산 로직 (`js/calc.js`)
```
합계 = max(최소금액, 수량 × 단가) × (1 + 해당 할증% 합) + 선택된 옵션 금액 합  → 1,000원 단위 반올림
```
- `calculateQuote(template, priceTable, request, overrides)` → `{ lines, subtotal, total, deposit, conditions, included, excluded, verified, surchargeState, optionState }`
- 반올림 차액은 `1,000원 단위 조정` 줄로 보여줘 **항목 합 = 합계**가 항상 맞는다 (`finalizeLines`). 사장님이 금액을 손으로 고친 뒤에도 같은 함수로 재계산.
- 할증 자동 판정: 템플릿 `when` 조건 (`{field, equals}`, `{field, in}`, `{field, gt}`, `{any:[]}`, `{all:[]}`). `$` 로 시작하는 필드는 날짜에서 자동 계산(`dateFlags`): `$weekend`, `$holiday`(양력 고정 공휴일 + 설·추석·부처님오신날, 브라우저 음력 달력 `Intl` 사용), `$sonEomneun`(음력 끝자리 9·0). 대체공휴일은 판정하지 않으므로 사장님이 상세에서 체크.
- 체크리스트: `risk` 와 같은 답 → `optionKey` 가 있으면 옵션 자동 추가, 없으면 `conditionText` 를 ⚠️조건에. `모름` → ⚠️조건 "현장 확인 시 필요하면 N원 추가".
- 수량형 옵션: `quantityField` + `includedQty` (예: 베란다 2개 초과분만 과금).
- 고객 선택 옵션: `customerSelectable: true` 인 옵션은 고객 화면 "추가 서비스" 단계에 나온다.
- 불포함: 선택 안 된 옵션은 "(요청 시 +N원)" 으로 자동 기재 → 분쟁 예방.
- "사진 확인 완료 견적" 배지: 사진 1장 이상 + 체크리스트 전 항목 답변(`isVerified`).
- 경고: `pricing.warnings` (예: 평당 9,000원 미만) — 강제 아님.

## 업종 템플릿 추가 방법 (예: 에어컨청소)
1. `templates/move-in-cleaning.json` 을 복사해 `templates/aircon-cleaning.json` 생성, `id` 를 파일명과 같게.
2. 고칠 곳
   - `steps` : 고객 질문. `type` = `text | tel | date | number | textarea | choice | stepper | checklist | extras | photos`.
     **`name`, `phone`, `region` 키는 모든 업종 공통으로 유지** (목록·견적서가 사용).
   - `pricing.base.quantityField` : 수량 기준 (입주청소=`area` 평, 에어컨=`units` 대수 등), `unit`, 라벨.
   - `pricing.surcharges` / `pricing.options` : 키·라벨·조건. 금액은 넣지 않는다 (`defaults` 에).
   - `checklist`, `photoSlots`, `included`, `excluded`, `defaults`.
3. 업체의 `shops/{uid}.templateId` 를 새 ID로 바꾼다. (지금은 가입 시 `js/config.js` 의 `defaultTemplateId` 사용 → 업체 정보 화면에 업종 선택을 추가하는 것이 다음 작업)
4. `tests/calc.test.mjs` 에 새 업종 예시 1건 추가 → `npm test`.

계산 규칙이 `max(최소, 수량×단가)×(1+할증)+옵션` 으로 표현 안 되는 업종(예: 이사 — 거리·층수·짐량)은
`pricing.base` 에 `type` 필드를 추가하고 `calculateQuote` 의 "1) 기본" 부분만 분기하면 된다. 나머지(할증·옵션·조건·반올림)는 공통.

## 개발자 모드 (운영자용)
- **업종 시뮬레이터:** `dev.html` — 로그인 없이 6개 업종의 고객 입력 → 계산 → 견적서 → 인력 예상을 한 화면에서 확인. 실제 앱과 같은 계산 엔진
- **오류 패널:** 아무 화면 주소 뒤에 `?dev=1` → 왼쪽 아래 🛠 버튼에 오류가 모임. "전체 복사"로 전달. 끄기 `?dev=0`
- 자세한 내용: `docs/설계도.md` 4-2장

## 개발·테스트
```bash
npm test                 # 계산 단위 테스트 (설치 불필요, Node 18+)
npm run serve            # http://localhost:8080/owner.html

# 보안 규칙 + 완료 시나리오 E2E (Java 11+ 필요)
cd tests/emulator && npm install
npm test                 # firestore.rules / storage.rules 8개 케이스
npm run e2e              # 지시문 7장 시나리오 1~5 를 Chromium 으로 실행 (스크린샷: tests/emulator/screenshots)
```
- **에뮬레이터 모드**: localhost 에서 `owner.html?emulator=1` 로 한 번 열면 켜진다(`?emulator=0` 끔). 로그인 버튼이 가짜 구글 계정으로 바로 로그인된다. 에뮬레이터 실행: `npx firebase emulators:start --project demo-quote` (tests/emulator 에서 `npx firebase --config ../../firebase.json …`).
- Firebase SDK 는 gstatic CDN 10.14.1. 버전을 올리면 `js/firebase.js` 4줄과 `tests/emulator/package.json` 을 같이 바꾼다.
- 정적 파일을 고친 뒤 배포하면 `sw.js` 의 `CACHE` 이름(`quote-v1`)을 올린다. (네트워크 우선이라 필수는 아님)

## 2차 확장 지점 (이번엔 미구현)
| 기능 | 붙일 위치 |
|---|---|
| AI 사진 분석 → 추가요금 후보 표시 | 요청 생성 시 Cloud Function(onCreate `requests`) → `requests.aiHints[]` 저장 → `owner.js renderDetail` 에 표시, `calculateQuote` 의 `overrides.options` 제안값으로 사용 |
| 통화 메모 요약 | `requests.notes[]` 필드 + 상세 화면 메모 입력 → Function 에서 요약 |
| 만두(번역 메신저) 연동 | **1단계 완료**: 업체 정보의 `manduId` → 고객 화면·견적서에 `MANDU/?u=만두ID` 채팅 버튼 (`js/util.js manduHref`, `appConfig.manduBaseUrl`). 2단계: 만두 쪽에서 게스트 첫 메시지에 견적 링크 자동 안내(만두 저장소 수정 필요) |
| 부재중 전화 자동문자 / 카카오 채널 자동응답 | 외부 webhook → Function 이 `q.html?shop=` 링크 발송. 앱 쪽 변경 없음 |
| 계약금 온라인 결제 | `view.js bookingButton` 을 결제 위젯으로 교체 → 결제 완료 webhook(Function)이 `status=confirmed` 기록 (규칙상 고객은 confirmed 로 못 바꾸므로 서버에서 처리) |
| 미응답 고객 자동 재연락 | 예약 Function: `status=sent` 이고 `updatedAt` 이 N일 지난 견적 → 문자 |
| 최근 견적 3~5건으로 단가표 역산 | 순수 함수 `inferPriceTable(template, quotes[])` 를 `calc.js` 에 추가 → 단가표 화면 "내 최근 견적으로 채우기" 버튼 |
| 작업 전후 사진 기록 | Storage `jobs/{shopId}/{quoteId}/before|after` + `quotes.jobPhotos[]` |
| 스팸 방지 | Firebase App Check (reCAPTCHA Enterprise) 활성화 → 규칙에 영향 없음 |
| 다업체/직원 계정 | `shops` ID 를 랜덤으로, `members` 하위 컬렉션 + 규칙 변경 |
