# 견적 자동화 앱 (2차: 7개 업종 · 사업자 인증 · 동의 · 사진 안내)

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
owner.html  js/owner.js   사장님 화면 (구글 로그인): 요청 목록 / 업종별 단가표 / 업체 정보(업종·사업자 인증) / 요청 상세·견적 편집·결제·환불
q.html      js/q.js       고객 입력 화면 (?shop=업체ID[&t=업종ID]): 동의 → (업종 2개 이상이면) 서비스 선택 → 템플릿 steps
view.html   js/view.js    견적서 (?id=견적ID): 금액·최대 금액·포함·불포함·⚠️조건·취소 규정, 예약 요청/결제, 전화
js/config.js              ★ Firebase 설정값 (이 파일 한 곳만 수정)
js/firebase.js            Firebase 초기화(CDN 모듈, 빌드 없음) + 에뮬레이터 모드
js/calc.js                ★ 견적 계산 순수 함수 (DOM·Firebase 의존 없음)
js/templates.js           ★ 업종 목록 TEMPLATE_LIST(7개, 한 곳에서 관리) + 템플릿 로더 (Firestore templates/{id} → 없으면 templates/{id}.json)
js/util.js                DOM 도우미 h(), 토스트, 복사, 이미지 압축, 상태 라벨(결제 상태 포함), 사업자번호 체크섬 isValidBizNo()
js/payment.js             계약금 결제 (payment 담당 파일)
templates/*.json          ★ 업종 템플릿 7종: move-in-cleaning, home-cleaning, moving, aircon-cleaning, aircon-install, curtain, jungmun
img/guide/*.svg           사진 촬영 안내 그림 (designer 담당)
css/style.css             모바일 우선 스타일
manifest.webmanifest, sw.js, icons/   PWA
firestore.rules, storage.rules, firebase.json   보안 규칙 (+ 에뮬레이터 설정)
tests/calc.test.mjs       계산 단위 테스트 (Node 내장 테스트, 설치 불필요)
tests/emulator/           보안 규칙 테스트 + 완료 시나리오 E2E (Firebase 에뮬레이터)
```

## 데이터 흐름
```
[사장님] 로그인 → shops/{uid} 자동 생성 → 업종 선택(여러 개)·업체정보·(사업자 인증) → 업종별 단가표 → "링크 복사"
                                                   │  q.html?shop={uid}  (업종 1개만: &t={업종ID})
[고객]   개인정보 동의 → 서비스 선택 → 단계형 입력 + 사진(칸·컷별, 자동 압축) ──┘
         → Storage requests/{shopId}/{requestId}/{slot}-{index}-{shot}.jpg
         → Firestore requests/{id}  (status: new, templateId = 고객이 고른 업종, consent, 금액 없음)
[사장님] 목록(실시간) → 상세: calculateQuote(요청 업종 템플릿, 그 업종 단가표, 요청, 수동조정)
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
| `hold` | 보류 | 사장님 (결제된 건은 보류 해제 시 `paid_deposit` 으로 되돌림) |
| `paid_deposit` | 계약금완료 | 서버(결제) 또는 사장님(계좌 입금 확인) — 목록 맨 위, 미처리 배지에 포함 |
| `canceled` · `done` · `paid_full` | 취소 · 작업완료 · 잔금완료 | 서버 — 해당 건이 있을 때만 목록 필터 칩이 나옴 |

## Firestore 구조
| 경로 | 내용 | 권한 |
|---|---|---|
| `shops/{shopId}` | `ownerUid, templateIds[], templateId(=templateIds[0], 하위호환), name, ownerName, phone, bizNo, logoUrl, brandColor?` + 서버 전용 `bizVerified, bizVerifiedAt, bizVerifiedMode, identityChangedAt, identityHistory[]` | 누구나 get, 본인만 쓰기. 신원 필드는 서버만. 인증 후 name·bizNo 는 서버(updateIdentity)만 |
| `shops/{shopId}/private/pricing` | `{ byTemplate: { [templateId]: priceTable } }` (1차 평면 `{priceTable}` 은 읽을 때 `byTemplate[shop.templateId]` 로 간주 → 다음 저장 때 새 모양으로 바뀜) | 본인만 |
| `bizNos/{bizNo}` | `{ uid, verifiedAt }` 1사업자번호 = 1계정 | 아무도 못 읽고 못 씀 (서버 Admin SDK 만) |
| `templates/{templateId}` | 템플릿 JSON (선택. 없으면 저장소 JSON 사용) | 누구나 읽기, 콘솔에서만 쓰기 |
| `requests/{requestId}` | `shopId, templateId, status, customer{name,phone,region}, answers{…}, checklist{key:'yes'\|'no'\|'unknown'}, photos[{slot,index,shot,path}], consent{version,at}, quoteId, createdAt` | 누구나 생성(검증), 사장님만 읽기/수정 |
| `quotes/{quoteId}` | `shopId, requestId, templateId, number, shop{…,bizVerified}, customer{name,region}, service{templateId, customMade, date, timeSlot, summary}, lines[], total, depositPct, deposit, included[], excluded[], conditions[{label,text,amount\|null}], cancelPolicy, refundRules, validUntil, verified, overrides, status, payment?(서버)` | 누구나 **get**(링크), list 는 본인만, 고객은 상태만 `sent→booking_requested`. `payment` 가 있으면 사장님도 `number, lines, total, deposit, conditions, included, excluded, cancelPolicy, depositPct, refundRules` 수정 불가 (M9) |
| `payments/{orderId}` | 결제 기록·영수증 (서버만 씀) | 사장님 자기 것 읽기 |

### 규칙의 입력 상한 (L7, 스팸 방지)
- 요청 생성: `consent.version` 이 `consent-v…` 이고 `consent.at == 서버 시각` 필수 (S3).
- `templateId` 는 그 업체 `templateIds` 중 하나(없으면 `templateId`).
- answers 키 40개 이하, 자유 입력 칸 길이: `memo`·`windowSizes` 500자, `model`·`toRegion` 60자, `date` 20자. `extras` 12개·각 60자. checklist 20개·값은 yes/no/unknown. 사진 20장.
- **왜 모든 값을 검사하지 않나**: Firestore 규칙은 요청 1건에 1000식까지만 계산한다. 값마다 검사하면 15칸만 넘어도 한도 초과로 **정상 요청까지 거부**된다(에뮬레이터 실측). 그래서 자유 입력 칸을 이름으로 검사한다. **템플릿에 text·textarea 칸을 새로 만들면 `firestore.rules okAnswers` 에도 추가**한다. 근본 대책은 App Check.
- Storage 사진 파일 이름: `{칸}-{1~6}-{컷}.jpg` 또는 1차 형식 `{칸}.jpg`, 3MB 미만, 이미지만.

**설계 결정 (지시문과 다른 점과 이유)**
- `shopId = 사장님 uid` — 1계정 1업체. 규칙이 `request.auth.uid == shopId` 한 줄로 끝나 안전하고 단순하다. 다업체가 필요하면 `shops` 문서 ID를 랜덤으로 바꾸고 규칙을 `ownerUid` 비교로 바꾸면 된다.
- 단가표는 `shops/{id}` 가 아닌 `shops/{id}/private/pricing` — 업체 공개정보는 고객 화면이 읽어야 하므로 공개인데, 거기에 단가를 넣으면 경쟁업체가 링크만으로 단가표를 볼 수 있다.
- 사진 URL 대신 `path` 저장 — 고객은 Storage 읽기 권한이 없고(개인 집 사진), 사장님 화면이 권한 확인 후 다운로드 URL을 받는다.
- 견적서는 추측 불가능한 20자 ID 가 열쇠. 로그인 없이 링크로 열리되 목록 조회는 막는다. 고객 전화번호는 견적서에 넣지 않는다.

### priceTable (업종 1개분, `byTemplate[업종ID]`)
```json
{ "unitPrice": 13000, "minPrice": 250000,
  "surcharges": { "newBuild": 20, "weekend": 10, "sonEomneun": 10, "firstSlot": 5 },
  "options":    { "mold": 30000, "balcony": 20000, "closet": 30000, "sickHouse": 150000, "window": 50000, "sticker": 30000 },
  "policy":     { "validDays": 7, "depositPct": 10, "cancelPolicy": "…",
                  "refundRules": [ { "daysBefore": 3, "pct": 100 }, { "type": "withinDaysOfPayment", "days": 7, "pct": 100 } ] } }
```
- `refundRules`(선택): 온라인 결제 환불 자동 계산 규칙. 견적 발송 때 `quotes.refundRules` 로 복사되고, 고객은 견적서에서 같은 문장을 본다(payment.js `describeRefundRules`). 서버는 고객이 본 규칙으로만 계산한다.
키는 템플릿의 `surcharges[].key`, `options[].key` 와 같다. 저장값이 없으면 템플릿 `defaults` 로 채운다 (`mergePriceTable`).

## 계산 로직 (`js/calc.js`)
```
합계 = max(최소금액, 수량 × 단가) × (1 + 해당 할증% 합) + 선택된 옵션 금액 합  → 1,000원 단위 반올림
```
- `calculateQuote(template, priceTable, request, overrides)` → `{ lines, subtotal, total, deposit, conditions, included, excluded, verified, surchargeState, optionState, baseQty, hasQuantityLine, errors }`
- **각 줄은 원 단위 정수**(`toWon`: 부동소수 오차를 걷어낸 뒤 반올림) → 33.3평 × 15,000 = 499,500 → 합계 500,000 (M4).
- 반올림 차액은 `1,000원 단위 조정` 줄로 보여줘 **항목 합 = 합계**가 항상 맞는다 (`finalizeLines`).
- 할증·옵션 조건(`when`, `offWhen`, `requires`): `{field, equals}`, `{field, in}`, `{field, gt}`, `{any:[]}`, `{all:[]}`. `field` 는 답변 키, `$weekend`·`$holiday`·`$sonEomneun`(날짜 자동 판정), **`checklist.<키>`(체크리스트 답 'yes'|'no'|'unknown')**.
- 체크리스트: `risk` 와 같은 답 → `optionKey` 옵션 자동 추가(사유 = 실제 답, 예: `엘리베이터: 아니오`), 없으면 `conditionText` 를 ⚠️조건에. `모름` → ⚠️조건 "현장에서 확인되면 N원 추가…" + `amount: N`.
- **0원 옵션은 줄·조건·포함 목록을 만들지 않는다** (L2). 기본 수량 0이고 최소금액도 0이면 기본 줄도 없다.
- 조건은 `{label, text, amount|null}` — 발송 시 그대로 저장, 견적서 "최대 금액" = `maxTotal(total, conditions)` (금액 없는 조건이 있으면 최대 금액을 보이지 않음).
- 발송 차단 `sendBlockReasons(calc, total, template)`: 검증 오류(maxField·validation) / 합계 0원 이하 / 기본 수량 0(단, 수량형 옵션 줄이 있으면 허용 — 예: 에어컨 스탠드만). 사장님 화면에서 버튼이 꺼지고 이유가 보인다. 결제된 견적·단가표 없는 이전 업종 요청도 발송 불가.
- 요약 `summarize(template, answers)`: 템플릿 `summaryFields` 사용. 없으면 기본 수량 1개(예: "34평").
- "사진 확인 완료 견적" 배지 `isVerified`: 체크리스트 전부 답 + (템플릿에 `shots` 가 있으면) **모든 필수 컷**, (없으면 기존처럼) 사진 1장 이상.
- 경고: `pricing.warnings` (예: 평당 9,000원 미만) — 강제 아님.

### 템플릿 새 필드 (2차, 모두 선택 — 없으면 기존 동작)
| 필드 | 위치 | 의미 · 예 |
|---|---|---|
| `customMade: true` | 최상위 | 맞춤제작(커튼·중문). 견적서 `service.customMade`, "가견적" 안내, 결제 시 별도 고지·동의 |
| `summaryFields: [{key, label?, unit?}]` | 최상위 | 견적서·목록 요약. 값 true → label 만, 선택형 → 선택지 라벨, 그 외 값+unit. `[{"key":"area","unit":"평"},{"key":"isNew","label":"신축"}]` → "34평 · 신축" |
| `validation: {requireAny:[키…], minTotal?:1, message?}` (배열 가능) | 최상위 | 키들 값 합계 ≥ minTotal. 위반이면 고객 제출 불가(그 키들이 모두 나온 단계에서 막음) + 사장님 발송 불가 |
| `offWhen: <조건>` | `pricing.options[]` | 참이면 옵션을 끔(자동 켜짐보다 우선, 사장님 수동 체크는 가능). 예: 계단 운반 `{"field":"checklist.ladderFrom","equals":"yes"}` |
| `requires: <조건>` | `pricing.options[]` | 거짓이면 수량이 있어도 0·자동으로 안 켜짐. 예: 보관료 `{"field":"storage","equals":true}` |
| `listInExcluded: false` | `pricing.options[]` | 꺼져 있어도 불포함 목록에 "(요청 시 +N원)" 으로 넣지 않음 |
| `maxField: "<키>"` | steps 필드(number·stepper) | 다른 답 값보다 클 수 없음. 고객 화면 상한 + 검증 오류 + calc 에서 잘라냄(clamp) |
| `photoSlots[].repeatField` | 사진 칸 | 그 답 값만큼 칸 반복("욕실 1", "욕실 2"), 0이면 없음, 최대 6. **3번째 칸부터 필수 컷은 선택**(PM 결정) |
| `photoSlots[].shots: [{key,label,required,tip,illustration}]` | 사진 칸 | 칸 안의 컷. 없으면 필수 1장. `illustration` = `img/guide/{이름}.svg`(영소문자·-만), 없으면 tip 만 |
| `photoLimit` | 최상위 | 요청 1건 사진 상한 (기본·최대 20) |

## 업종 템플릿 추가 방법 (예: 에어컨청소)
1. `templates/move-in-cleaning.json` 을 복사해 `templates/aircon-cleaning.json` 생성, `id` 를 파일명과 같게.
2. 고칠 곳
   - `steps` : 고객 질문. `type` = `text | tel | date | number | textarea | choice | stepper | checklist | extras | photos`.
     **`name`, `phone`, `region` 키는 모든 업종 공통으로 유지** (목록·견적서가 사용).
   - `pricing.base.quantityField` : 수량 기준 (입주청소=`area` 평, 에어컨=`units` 대수 등), `unit`, 라벨.
   - `pricing.surcharges` / `pricing.options` : 키·라벨·조건. 금액은 넣지 않는다 (`defaults` 에).
   - `checklist`, `photoSlots`, `included`, `excluded`, `defaults`.
3. `js/templates.js` 의 `TEMPLATE_LIST` 에 `{id, name}` 추가 + `firestore.rules` 의 `templateIds.hasOnly([...])` 목록에 추가 (+ text·textarea 칸이 새로 생기면 `okAnswers` 에도).
4. `npm test` — 업종 목록 = templates 폴더 확인 + 새 업종 스모크 테스트가 자동으로 돈다.

계산 규칙이 `max(최소, 수량×단가)×(1+할증)+옵션` 으로 표현 안 되는 업종(예: 이사 — 거리·층수·짐량)은
`pricing.base` 에 `type` 필드를 추가하고 `calculateQuote` 의 "1) 기본" 부분만 분기하면 된다. 나머지(할증·옵션·조건·반올림)는 공통.

## 여러 업종 (S1·S2)
- 업체 정보 탭: 업종 칩 여러 개 선택. 새로 고른 업종은 템플릿 기본 단가로 단가표가 바로 채워진다(3분 설정). 업종을 빼도 그 업종 단가표와 기존 요청은 남는다.
- 단가표 탭: 위쪽 업종 칩으로 업종을 바꿔 가며 저장. 업종별 바로가기 링크(`&t=`) 복사 버튼.
- 고객 링크: 업종 2개 이상이면 동의 다음에 "어떤 서비스가 필요하세요?". `&t={업종ID}` 면 바로 그 업종.
- 요청은 **항상 요청의 `templateId` 템플릿과 그 업종 단가표로** 계산·표시. 지금 업종 목록에 없으면 "이전 업종 요청" 배지, 단가표도 없으면 발송 불가.

## 사업자 인증 (업체 신원)
1. 업체 정보 탭에서 상호·사업자번호 입력 → [사업자 인증하기]. 앱이 먼저 체크섬(`isValidBizNo`)으로 형식을 본다.
2. 서버 주소(`appConfig.functionsBaseUrl`, 없으면 `paymentConfig.functionsBaseUrl`)가 있으면 `POST /verifyBusiness {bizNo}` (Firebase 로그인 토큰). 서버가 국세청 상태조회 → `bizNos/{번호}` 선점 → `bizVerified=true`. 서버가 비어 있으면 "서버 미연결" 배지만 보이고 형식 확인까지만 된다.
3. 인증 후 상호·사업자번호 칸은 잠기고 [변경 요청] → `POST /updateIdentity {name?, bizNo?}` (30일 1회, 이력 기록). 오류 문구: `biz_taken`·`too_soon` 은 legal 문구, 나머지는 서버 문구.
4. 인증 전에도 견적 발송은 되지만 상단에 경고. 인증되면 견적서 상호 옆에 "사업자 인증" 배지.
- 규칙: 클라이언트는 `bizVerified, bizVerifiedAt, bizVerifiedMode, identityChangedAt, identityHistory` 를 절대 못 쓰고, 인증 후 `name`·`bizNo` 도 못 바꾼다.

## 고객 동의·사진
- q.html 첫 화면 = 개인정보 수집·이용 동의(legal copy-snippets §1, 버전 `appConfig.consentVersion` = `consent-v1`). 체크 전엔 [시작하기] 꺼짐. `requests.consent = {version, at}`. 처리방침 링크(`privacyUrl`)가 비면 동의 내용 전문을 화면에 보여준다.
- 메모(textarea) 칸 아래 공통 경고 "현관 비밀번호·주민등록번호·계좌번호는 적지 마세요…".
- 사진: 칸을 누르면 바텀시트(안내 그림 인라인 SVG + tip) → [촬영] [앨범에서 고르기]. 필수 컷이 비면 화면 안 안내 → [사진 마저 올리기] / [사진 없이 다음] (제출은 허용).
- 사장님 상세: 사진을 칸·컷 이름별로 묶어 보여주고, 빠진 필수 컷은 "없음" 칸으로 표시.

## 개발·테스트
```bash
npm test                 # 계산 단위 테스트 31개 (설치 불필요, Node 20+) — 7개 업종 스모크 포함
npm run serve            # http://localhost:8080/owner.html

# 보안 규칙 + 완료 시나리오 E2E (Java 11+ 필요)
cd tests/emulator && npm install
npm test                 # firestore.rules / storage.rules 16개 케이스 (신원·bizNos·M9·동의·상한 포함)
npm run e2e              # 시나리오 1~6 (동의·사진 시트·다업종 포함)을 Chromium 폰 화면으로 실행 (스크린샷: tests/emulator/screenshots)
```
- **에뮬레이터 모드**: localhost 에서 `owner.html?emulator=1` 로 한 번 열면 켜진다(`?emulator=0` 끔). 로그인 버튼이 가짜 구글 계정으로 바로 로그인된다. 에뮬레이터 실행: `npx firebase emulators:start --project demo-quote` (tests/emulator 에서 `npx firebase --config ../../firebase.json …`).
- Firebase SDK 는 gstatic CDN 10.14.1. 버전을 올리면 `js/firebase.js` 4줄과 `tests/emulator/package.json` 을 같이 바꾼다.
- 정적 파일을 고친 뒤 배포하면 `sw.js` 의 `CACHE` 이름(`quote-v1`)을 올린다. (네트워크 우선이라 필수는 아님)

## 2차 확장 지점 (이번엔 미구현)
| 기능 | 붙일 위치 |
|---|---|
| AI 사진 분석 → 추가요금 후보 표시 | 요청 생성 시 Cloud Function(onCreate `requests`) → `requests.aiHints[]` 저장 → `owner.js renderDetail` 에 표시, `calculateQuote` 의 `overrides.options` 제안값으로 사용 |
| 통화 메모 요약 | `requests.notes[]` 필드 + 상세 화면 메모 입력 → Function 에서 요약 |
| 부재중 전화 자동문자 / 카카오 채널 자동응답 | 외부 webhook → Function 이 `q.html?shop=` 링크 발송. 앱 쪽 변경 없음 |
| 미응답 고객 자동 재연락 | 예약 Function: `status=sent` 이고 `updatedAt` 이 N일 지난 견적 → 문자 |
| 최근 견적 3~5건으로 단가표 역산 | 순수 함수 `inferPriceTable(template, quotes[])` 를 `calc.js` 에 추가 → 단가표 화면 "내 최근 견적으로 채우기" 버튼 |
| 작업 전후 사진 기록 | Storage `jobs/{shopId}/{quoteId}/before|after` + `quotes.jobPhotos[]` |
| 스팸 방지 | Firebase App Check (reCAPTCHA Enterprise) 활성화 → 규칙에 영향 없음 |
| 다업체/직원 계정 | `shops` ID 를 랜덤으로, `members` 하위 컬렉션 + 규칙 변경 |
