// 완료 확인 시나리오(지시문 7장)를 실제 브라우저로 끝까지 돌려보는 테스트.
// 실행: cd tests/emulator && npm install && npm run e2e
// - Firebase 에뮬레이터(auth/firestore/storage) + 로컬 정적 서버 + Chromium
// - gstatic CDN 대신 node_modules/firebase 의 같은 파일을 내려준다(오프라인 환경 대응)
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const FB = path.join(here, 'node_modules/firebase');
const SHOTS = process.env.SHOTS_DIR || path.join(here, 'screenshots');
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}/quote/`; // GitHub Pages 와 같은 하위 경로로 서빙
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname).replace(/^\/quote\//, '/');
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' };

const pages = [];
async function newPage() {
  const ctx = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
  await ctx.route(/https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/(.+\.js)$/, async (route) => {
    const name = /\/([^/]+\.js)$/.exec(route.request().url())[1];
    route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(FB, name)) });
  });
  const page = await ctx.newPage();
  pages.push(page);
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const step = (msg) => console.log(`▶ ${msg}`);
// 화면에 "null"·"undefined" 글자가 새어 나오지 않는지 (빈 값 렌더링 버그 방지)
async function noLeak(page, where) {
  const text = await page.locator('body').innerText();
  assert.ok(!/\b(null|undefined|NaN)\b/.test(text), `${where}: 화면에 null/undefined/NaN 표시됨`);
}

// 2x2 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwHwyBNAMDA5gGAJyFB/kXJ1ByAAAAAElFTkSuQmCC', 'base64');

try {
  // 1) 사장님 로그인 + 업체정보 + 단가표
  step('1) 사장님 로그인 → 단가표 설정 (평당 13,000 / 신축 20% / 곰팡이 30,000)');
  const owner = await newPage();
  await owner.goto(`${BASE}owner.html?emulator=1`);
  await owner.getByRole('button', { name: /Google/ }).click();
  await owner.getByText('처음 오셨네요').waitFor();
  const shopField = (label) => owner.locator('label.field', { hasText: label }).locator('input');
  await shopField('업체명').fill('반짝입주청소');
  await shopField('대표 전화번호').fill('010-1111-2222');
  await shopField('서비스 가능 지역').fill('서울 송파구·강동구');
  await shopField('만두 ID').fill('@Banjjak');
  await shot(owner, '0-owner-shop');
  await owner.getByRole('button', { name: '업체 정보 저장하기' }).click();
  await owner.getByText('다른 숫자만 고치세요').waitFor();
  const priceInput = (label) => owner.locator('label.price-row, label.price-main', { hasText: label }).locator('input');
  await priceInput('평당 단가').fill('8000');
  assert.match(await owner.locator('.warn-box').innerText(), /분쟁/, '9,000원 미만 경고');
  await priceInput('평당 단가').fill('13000');
  assert.equal(await owner.locator('.warn-box').isHidden(), true);
  await priceInput('신축').fill('20');
  await priceInput('곰팡이 제거').fill('30000');
  await shot(owner, '1-owner-price');
  await owner.getByRole('button', { name: '단가표 저장하기' }).click();
  await owner.getByText('단가표를 저장했어요').waitFor();
  const uid = await owner.evaluate(async () => (await import('./js/firebase.js')).auth.currentUser.uid);

  // 2) 고객 입력
  step('2) 고객: 34평, 신축, 붙박이장 없음(조건부 질문), 오염 보통, 곰팡이 예, 스티커 모름, 사진 2장');
  const cust = await newPage();
  // 주소 → 평수 자동 조회: 서버 함수는 가짜 응답으로 대신한다 (실제 공공 API 는 배포 후 dev.html 에서 검증)
  const lookupCalls = [];
  await cust.route(/cloudfunctions\.net\/areaLookup/, async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const body = JSON.parse(route.request().postData() || '{}');
    lookupCalls.push(body.action);
    const REF = { admCd: '2623010500', rnMgtSn: '262303000001', udrtYn: '0', buldMnnm: '123', buldSlno: '0', mtYn: '0', lnbrMnnm: '456', lnbrSlno: '1' };
    const replies = {
      search: String(body.keyword || '').includes('없는')
        ? { ok: false, reason: 'not_found', message: '검색 결과가 없습니다.' }
        : String(body.keyword || '').includes('주택')
          ? { ok: true, items: [{ roadAddr: '부산광역시 부산진구 가야로00번길 12', jibunAddr: '부산광역시 부산진구 가야동 345-6', bdNm: '', apt: false, ref: REF }] }
          : { ok: true, items: [{ roadAddr: '부산광역시 부산진구 가야대로 000', jibunAddr: '', bdNm: '예시타운', apt: true, ref: REF }] },
      house: {
        ok: true, kind: 'house', purpose: '단독주택 / 다가구주택', bldNm: '', totalM2: 330.6, totalPyeong: 100, households: 6, groundFloors: 3, buildings: 1,
        mixedUse: true, residentialM2: 220.4, residentialPyeong: 66.7,
        floors: [
          { key: '20-1', label: '1층', underground: false, residential: false, m2: 110.2, pyeong: 33.3, purpose: '제2종근린생활시설(일반음식점)' },
          { key: '20-2', label: '2층', underground: false, residential: true, m2: 220.4, pyeong: 66.7, purpose: '다가구주택' },
        ],
      },
      dongs: { ok: true, dongs: ['101동', '102동'] },
      hos: { ok: true, hos: [{ hoNm: '1203', floorNm: '12' }, { hoNm: '1204', floorNm: '12' }] },
      area: { ok: true, exclusiveM2: 84.97, supplyM2: 112.35, commonIncludedM2: 27.38, commonExcludedM2: 43.3, exclusivePyeong: 25.7, pyeong: 34, breakdown: [] },
    };
    await route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(replies[body.action]) });
  });
  await cust.goto(`${BASE}q.html?shop=${uid}&emulator=1&lookup=1`);
  const next = () => cust.locator('.nav-row .btn.primary').click();
  await cust.getByPlaceholder('홍길동').fill('김고객');
  await cust.getByPlaceholder('010-0000-0000').fill('010-3333-4444');
  assert.match(await cust.getByRole('link', { name: /채팅/ }).getAttribute('href'), /MANDU\/\?u=banjjak$/);
  assert.equal(await cust.locator('.shop-head img.logo').count(), 0, '로고가 없으면 로고 자리를 그리지 않음');
  await noLeak(cust, '고객 화면');
  await shot(cust, '2-customer-step1');
  await next();
  await cust.getByPlaceholder('예) 서울 송파구').fill('서울 송파구');
  await cust.getByRole('button', { name: '아파트' }).click();
  await next();
  await cust.locator('input[type=date]').fill('2026-10-21'); // 수요일, 공휴일·손 없는 날 아님
  await cust.getByRole('button', { name: '오전', exact: true }).click();
  await next();
  // 실패 → "직접 입력" 안내 → 다시 찾기 → 단지 → 동 → 호 → "공급 약 34평" → 맞아요 → 평수 칸 자동 입력
  await cust.getByRole('button', { name: '주소로 평수 찾기' }).click();
  await cust.locator('.lookup-input').fill('없는 주소');
  await cust.getByRole('button', { name: '검색', exact: true }).click();
  await cust.getByText('이 주소는 자동 조회가 안 돼요').waitFor();
  await shot(cust, '3a-lookup-fail');
  await cust.getByRole('button', { name: '다시 찾기' }).click();
  // 일반주택(다가구): 집 전체 / 층 선택 → 그 층 집 수 → 층 면적 ÷ 집 수
  await cust.locator('.lookup-input').fill('가야동 주택');
  await cust.locator('.lookup-input').press('Enter');
  await cust.getByRole('button', { name: /가야로00번길 12/ }).click();
  await cust.getByText('어디를 청소하나요?').waitFor();
  // 상가주택: "주택 부분 전체"(상가 제외), 1층 음식점은 (상가)로 따로 표시
  await cust.getByRole('button', { name: /주택 부분 전체/ }).waitFor();
  assert.match(await cust.getByRole('button', { name: /주택 부분 전체/ }).innerText(), /220\.4㎡.*상가 제외/s);
  assert.equal(await cust.getByRole('button', { name: /1층 \(상가\)/ }).count(), 1);
  await cust.getByRole('button', { name: /2층만/ }).click();
  await cust.getByText('2층에 몇 집이 사나요?').waitFor();
  await cust.getByRole('button', { name: '2집', exact: true }).click();
  await cust.getByText('약 33평').waitFor(); // 220.4 ÷ 2 = 110.2㎡ = 33.3평
  assert.match(await cust.locator('.lookup-result').innerText(), /2층 220\.4㎡ ÷ 2집 = 110\.2㎡/);
  await shot(cust, '3b0-lookup-house');
  await cust.getByRole('button', { name: '아니요, 직접 입력' }).click();
  // 아파트: 단지 → 동 → 호 → 공급 평수
  await cust.getByRole('button', { name: '주소로 평수 찾기' }).click();
  await cust.locator('.lookup-input').fill('가야대로 예시타운');
  await cust.locator('.lookup-input').press('Enter');
  await cust.getByRole('button', { name: /예시타운/ }).click();
  await cust.getByRole('button', { name: '101동' }).click();
  await cust.getByRole('button', { name: '1203호' }).click();
  await cust.getByText('공급 약 34평').waitFor();
  await shot(cust, '3b-lookup-result');
  await cust.getByRole('button', { name: /맞아요/ }).click();
  assert.equal(await cust.locator('input[type=number]').inputValue(), '34', '대장 평수가 평수 칸에 들어감');
  await cust.getByText('건축물대장으로 확인했어요').waitFor();
  assert.deepEqual(lookupCalls, ['search', 'search', 'house', 'search', 'dongs', 'hos', 'area']);
  await shot(cust, '3c-lookup-applied');
  await cust.getByRole('button', { name: '예, 신축' }).click();
  await next();
  // 방·욕실·베란다 기본값 (베란다 2 = 기본 포함). 붙박이장 개수는 "있어요"를 골라야만 보인다 (showIf)
  assert.equal(await cust.getByText('붙박이장 몇 개인가요?').count(), 0, '처음엔 개수 질문 숨김');
  await cust.getByRole('button', { name: '있어요' }).click();
  await cust.getByText('붙박이장 몇 개인가요?').waitFor();
  await shot(cust, '2b-customer-conditional');
  await cust.getByRole('button', { name: '없어요' }).click();
  assert.equal(await cust.getByText('붙박이장 몇 개인가요?').count(), 0, '"없어요"면 다시 숨김');
  await next();
  await cust.getByRole('button', { name: /보통/ }).click(); // 오염 정도
  await next();
  const items = cust.locator('.check-item');
  const n = await items.count();
  for (let i = 0; i < n; i += 1) {
    const item = items.nth(i);
    const q = await item.locator('.check-q').innerText();
    const ans = /곰팡이/.test(q) ? '예' : /스티커/.test(q) ? '모름' : /(주차|엘리베이터)/.test(q) ? '예' : '아니오';
    await item.getByRole('button', { name: ans, exact: true }).click();
  }
  await shot(cust, '3-customer-checklist');
  await next();
  await next(); // 추가 서비스 없음
  const fileInputs = cust.locator('.photo-slot input[type=file]');
  await fileInputs.nth(0).setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG });
  await cust.locator('.photo-slot img').first().waitFor();
  await cust.locator('.photo-slot input[type=file]').nth(1).setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG });
  await cust.locator('.photo-slot img').nth(1).waitFor();
  await shot(cust, '4-customer-photos');
  await next();
  await next(); // 요청사항 → 제출
  await cust.getByText('요청이 접수되었습니다').waitFor({ timeout: 15000 });
  await shot(cust, '5-customer-done');

  // 3) 사장님 화면 자동 계산
  step('3) 사장님: 34 × 13,000 × 1.2 + 30,000 = 560,400 → 560,000원');
  await owner.getByRole('button', { name: /견적요청/ }).click();
  const item = owner.locator('.req-card', { hasText: '김*객' }); // 목록에서는 이름 가림
  await item.waitFor();
  assert.match(await item.innerText(), /560,000원/);
  assert.match(await item.innerText(), /신규/);
  await noLeak(owner, '사장님 목록');
  await shot(owner, '6-owner-list');
  await item.click();
  await owner.locator('.total-box').waitFor();
  assert.match(await owner.locator('.total-box').innerText(), /560,000원/);
  const detailText = await owner.locator('body').innerText();
  assert.match(detailText, /예시타운 101동 1203/, '사장님 상세: 단지명·동·호');
  assert.match(detailText, /건축물대장 확인/, '사장님 상세: 평수 출처');
  const condValue = await owner.locator('label.field', { hasText: '현장 추가요금 조건' }).locator('textarea').inputValue();
  assert.match(condValue, /스티커/);
  const lineLabels = await owner.locator('.line-label').evaluateAll((els) => els.map((e) => e.value).join(','));
  assert.doesNotMatch(lineLabels, /붙박이장/, '붙박이장 없음 → 청구 안 됨');
  await owner.locator('textarea[placeholder^="예) 방문 전"]').fill('주차 확인 필요');
  await owner.locator('textarea[placeholder^="예) 방문 전"]').blur();
  await owner.getByText('메모를 저장했어요').waitFor();
  await owner.locator('.photo-grid.view img[src]').nth(1).waitFor();
  await noLeak(owner, '사장님 상세');
  await shot(owner, '7-owner-detail');
  await owner.getByRole('button', { name: '견적서 보내기' }).click();
  await owner.locator('dialog.sheet').waitFor();
  const viewUrl = await owner.getByRole('link', { name: '견적서 미리보기' }).getAttribute('href');
  await shot(owner, '8-owner-sent');
  await owner.getByRole('button', { name: '목록으로' }).click();

  // 4) 견적서
  step('4) 견적서: 스티커 제거가 ⚠️ 추가요금 조건에 표시, 내부 메모는 안 보임');
  const view = await newPage();
  await view.goto(`${viewUrl}&emulator=1`);
  await view.locator('.cond').waitFor();
  assert.match(await view.locator('.cond').innerText(), /스티커/);
  assert.equal(await view.locator('.shop-head, .quote-head').getByText('전화 상담').count(), 0, '견적서 상단에는 전화 버튼 없음 (하단에 있음)');
  assert.doesNotMatch(await view.locator('body').innerText(), /주차 확인 필요/, '내부 메모는 견적서에 없음');
  assert.doesNotMatch(await view.locator('body').innerText(), /예시타운|1203/, '단지명·동·호는 공개 견적서에 없음');
  assert.match(await view.locator('.total-box').innerText(), /560,000원/);
  assert.match(await view.locator('.total-box').innerText(), /56,000원/); // 계약금 10%
  assert.equal(await view.locator('.badge.verified').count(), 1, '사진 확인 완료 배지');
  assert.match(await view.getByRole('link', { name: /채팅/ }).getAttribute('href'), /MANDU\/\?u=banjjak$/);
  await noLeak(view, '견적서');
  await shot(view, '9-quote-view');

  // 5) 예약 요청 → 사장님 목록 상태 변경
  step('5) 고객 예약 요청 → 사장님 목록이 "계약요청"으로 실시간 변경');
  await view.getByRole('button', { name: '이 견적으로 예약 요청' }).click();
  await view.getByRole('button', { name: /예약 요청 완료/ }).waitFor();
  await owner.locator('.req-card', { hasText: '김*객' }).getByText('계약요청').waitFor({ timeout: 10000 });
  await shot(owner, '10-owner-booking-requested');

  // 6) 테스트 모드
  step('6) 테스트 모드: 샘플 요청 만들기 → "테스트" 표시 → 테스트 견적서 → 한 번에 지우기');
  await owner.getByText('🧪 테스트 모드').click();
  await owner.getByRole('button', { name: '샘플 요청 1건 만들기' }).click();
  const testItem = owner.locator('.req-card', { has: owner.locator('.badge.st-test') });
  await testItem.waitFor();
  assert.match(await testItem.innerText(), /테스트/);
  assert.match(await testItem.innerText(), /\d{3},000원/); // 샘플도 같은 단가표로 자동 계산 (날짜에 따라 주말 할증 가능)
  await testItem.click();
  await owner.locator('.test-banner').waitFor();
  await owner.getByRole('button', { name: '견적서 보내기' }).click();
  await owner.locator('dialog.sheet').waitFor();
  const testViewUrl = await owner.getByRole('link', { name: '견적서 미리보기' }).getAttribute('href');
  await owner.getByRole('button', { name: '목록으로' }).click();
  const tview = await newPage();
  await tview.goto(`${testViewUrl}&emulator=1`);
  await tview.locator('.test-banner').waitFor();
  await shot(tview, '11-test-quote');
  assert.equal(await owner.getByRole('link', { name: '고객 화면으로 직접 입력해보기' }).count(), 1);
  assert.match(await owner.getByRole('link', { name: '고객 화면으로 직접 입력해보기' }).getAttribute('href'), /test=1/);
  await shot(owner, '12-test-panel');
  await owner.getByRole('button', { name: /테스트 데이터 모두 지우기/ }).click();
  await testItem.waitFor({ state: 'detached', timeout: 10000 });
  await owner.getByText('테스트 데이터를 지웠어요').waitFor({ timeout: 10000 }); // 화면은 즉시 바뀌고 서버 삭제는 그 뒤에 끝남
  assert.equal(await owner.locator('.req-card', { hasText: '김*객' }).count(), 1, '실제 요청은 남아 있어야 함');
  await owner.getByRole('button', { name: '홈', exact: true }).click(); // 홈
  await owner.locator('.stats').first().waitFor();
  const stats = await owner.locator('.stats').first().innerText();
  assert.match(stats, /계약 성공/);
  await shot(owner, '12b-owner-home');
  await owner.getByRole('button', { name: '내 링크', exact: true }).click(); // 내 링크
  await owner.getByText('우리 업체 전용 견적 링크').waitFor();
  await shot(owner, '12c-owner-link');
  const gone = await tview.evaluate(async (id) => {
    const m = await import('./js/firebase.js');
    return !(await m.getDoc(m.doc(m.db, 'quotes', id))).exists();
  }, new URL(testViewUrl).searchParams.get('id'));
  assert.equal(gone, true, '테스트 견적서도 삭제');

  // 6b) 일정: 직원 등록 → 출근 명단 → 근무표에서 프리랜서 가능일 → 직원 초대 링크로 연결 → 본인 휴무일 → 사장님 화면 반영
  step('6b) 일정: 정규·프리랜서 등록, 출근 명단, 초대 링크로 직원 연결, 직원이 고른 휴무일이 사장님 화면에 반영');
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const target = plus(3); // 직원이 휴무로 고를 날 (지난 날은 못 고름)
  const offDays = [plus(4).getDay(), plus(5).getDay()]; // 정기 휴무는 다른 요일로 → 오늘·target 은 근무일
  await owner.getByRole('button', { name: '일정', exact: true }).click();
  await owner.getByText('이날 일정이 없어요').waitFor();
  await owner.getByRole('tab', { name: '직원·근무' }).click();
  await owner.getByText('등록된 직원이 없어요').waitFor();
  await owner.getByRole('button', { name: /직원 추가/ }).click();
  const form = owner.locator('dialog.staff-form');
  await form.locator('label.field', { hasText: '이름' }).locator('input').fill('김정규');
  for (const i of offDays) await form.locator('.choices.days').getByRole('button', { name: WD[i], exact: true }).click();
  await shot(owner, '12d-staff-form');
  assert.doesNotMatch(await form.innerText(), /\b(null|undefined)\b/, '직원 추가 창에 null 글자 없음');
  await form.getByRole('button', { name: '저장' }).click();
  await owner.locator('.staff-row', { hasText: '김정규' }).waitFor();
  await owner.getByRole('button', { name: /직원 추가/ }).click();
  await form.locator('label.field', { hasText: '이름' }).locator('input').fill('박프리');
  await form.getByRole('button', { name: '프리랜서' }).click();
  await form.getByRole('button', { name: '저장' }).click();
  await owner.locator('.staff-row', { hasText: '박프리' }).waitFor();
  const count = () => owner.locator('.sched-count b').innerText();
  assert.equal(await count(), '1명', '오늘: 정규 출근, 프리랜서는 가능일 아님');
  assert.match(await owner.locator('.off-list').innerText(), /박프리\s*가능일 아님/);
  await owner.locator('table.week tr', { hasText: '박프리' }).locator('button.wk-cell').first().click(); // 오늘 칸 → 가능일
  await owner.waitForFunction(() => document.querySelector('.sched-count b')?.textContent === '2명');
  await shot(owner, '12e-schedule');
  const invite = await owner.evaluate(async () => {
    const m = await import('./js/firebase.js');
    const s = await import('./js/staffAdmin.js');
    const uid = m.auth.currentUser.uid;
    const { getDocs, collection } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    const snap = await getDocs(collection(m.db, 'shops', uid, 'staff'));
    const kim = snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((x) => x.name === '김정규');
    return s.inviteUrl(uid, kim);
  });
  assert.match(invite, /staff\.html\?shop=.+&s=.+&k=[A-Za-z2-9]{24}$/);
  const staffPage = await newPage();
  await staffPage.goto(`${invite}&emulator=1&as=staff1`);
  await staffPage.getByRole('button', { name: /Google/ }).click();
  await staffPage.getByText('김정규님 근무 일정').waitFor();
  assert.doesNotMatch(staffPage.url(), /&k=/, '초대 값은 주소창에서 지움');
  if (target.getMonth() !== new Date().getMonth()) await staffPage.getByRole('button', { name: '다음 달' }).click();
  await staffPage.locator(`.cal-day[aria-label^="${ymd(target)}"]`).click();
  await staffPage.locator(`.cal-day[aria-label="${ymd(target)} 개인 휴무"]`).waitFor();
  await shot(staffPage, '12f-staff-calendar');
  for (let i = 0; i < 3; i += 1) await owner.getByRole('button', { name: '다음날' }).click();
  await owner.locator('.off-list', { hasText: '김정규' }).waitFor({ timeout: 10000 });
  assert.match(await owner.locator('.off-list').innerText(), /김정규\s*개인 휴무/);
  assert.match(await owner.locator('.staff-row', { hasText: '김정규' }).innerText(), /연결됨/);

  // 6c) 일정 ②단계: 빠른 등록 + 배정, 겹침 경고, 배정 필요 표시, 계약확정 → 자동 등록
  step('6c) 일정: 숨고 일정 빠른 등록·2명 배정, 같은 시간대 겹침 경고, 인원 부족 표시, 계약확정하면 일정 자동 등록');
  await owner.getByRole('button', { name: '오늘로' }).click();
  await owner.getByRole('tab', { name: '일정' }).click();
  await owner.getByText('이날 일정이 없어요').waitFor();
  const jobForm = owner.locator('dialog.job-form');
  const openNew = async () => { await owner.getByRole('button', { name: /일정 등록/ }).click(); await jobForm.waitFor(); };
  await openNew();
  await jobForm.getByRole('button', { name: '10:00' }).click();
  await jobForm.getByRole('button', { name: '3시간' }).click();
  await jobForm.locator('label.field', { hasText: '일 내용' }).locator('input').fill('에어컨 청소 3대');
  await jobForm.getByRole('button', { name: '숨고' }).click();
  await jobForm.locator('.cand', { hasText: '김정규' }).locator('input').check();
  await jobForm.locator('.cand', { hasText: '박프리' }).locator('input').check();
  assert.match(await jobForm.locator('.field', { hasText: '직원 배정' }).innerText(), /2명 배정 완료/);
  assert.doesNotMatch(await jobForm.innerText(), /\b(null|undefined)\b/, '일정 창에 null 글자 없음');
  await shot(owner, '12g-job-form');
  await jobForm.getByRole('button', { name: '저장' }).click();
  await owner.locator('.job-card', { hasText: '에어컨 청소 3대' }).waitFor();
  assert.match(await owner.locator('.job-card', { hasText: '에어컨 청소 3대' }).innerText(), /10:00~13:00[\s\S]*숨고[\s\S]*2명 배정 완료/);
  await openNew();
  await jobForm.getByRole('button', { name: '13:00' }).click(); // 10~13시 일 + 이동 60분 → 13시 시작은 겹침
  await jobForm.getByRole('button', { name: '1명' }).click();
  await jobForm.locator('label.field', { hasText: '일 내용' }).locator('input').fill('현관 청소');
  assert.match(await jobForm.locator('.cand', { hasText: '김정규' }).innerText(), /겹침: 10:00 에어컨 청소 3대/);
  await jobForm.locator('.cand', { hasText: '김정규' }).locator('input').check();
  await jobForm.locator('.warn-box', { hasText: '김정규: 겹침' }).waitFor();
  await jobForm.locator('.cand', { hasText: '김정규' }).locator('input').uncheck();
  await jobForm.getByRole('button', { name: '저장' }).click();
  await owner.locator('.job-card', { hasText: '현관 청소' }).waitFor();
  assert.match(await owner.locator('.job-card', { hasText: '현관 청소' }).innerText(), /1명 중 0명 배정/);
  await owner.getByText('인원이 모자란 일정 1건').waitFor();
  assert.equal(await owner.locator('.board-row.need .job-block').count(), 1, '일정표 "배정 필요" 줄');
  assert.equal(await owner.locator('.board-row', { hasText: '김정규' }).locator('.job-block').count(), 1);
  await shot(owner, '12h-schedule-board');
  await owner.locator('.bottom-nav').getByRole('button', { name: /^견적요청/ }).click();
  await owner.locator('.req-card', { hasText: '김*객' }).click();
  await owner.getByRole('button', { name: '계약확정' }).click();
  await owner.getByText(/일정에 등록했어요/).waitFor({ timeout: 10000 });
  const reqId = /req=([\w-]+)/.exec(owner.url())[1];
  const auto = await owner.evaluate(async (id) => {
    const m = await import('./js/firebase.js');
    const d = await m.getDoc(m.doc(m.db, 'shops', m.auth.currentUser.uid, 'jobs', `q_${id}`));
    return d.exists() ? d.data() : null;
  }, reqId);
  assert.ok(auto, '계약확정 → 일정 자동 생성');
  assert.equal(auto.date, '2026-10-21');
  assert.equal(auto.source, 'quote');
  assert.ok(auto.crew >= 1 && auto.hours > 0, '견적의 인력 예상값');
  assert.match(auto.title, /입주청소/);

  // 6d) 예약 확정 안내 (설계도 10-2장): 계약확정하면 바로 안내 창 → 고객 견적서 맨 위에 확정 카드
  step('6d) 확정 안내: 계약확정 → 안내 창(날짜·시간·인원·준비사항) → 고객 견적서에 확정 카드, 내부 정보 없음');
  const bk = owner.locator('dialog.booking-form');
  await bk.waitFor();
  assert.equal(await bk.locator('input[type=date]').inputValue(), '2026-10-21');
  assert.match(await bk.locator('textarea').inputValue(), /전기·수도/, '업종 기본 준비사항');
  await bk.locator('textarea').fill('전기·수도 확인\n- 주차는 지하 2층');
  await bk.getByRole('button', { name: /안내 만들기/ }).click();
  await bk.getByText('확정 안내가 준비됐어요').waitFor();
  const bkMsg = await bk.locator('pre.msg').innerText();
  assert.match(bkMsg, /예약이 확정되었습니다/);
  assert.match(bkMsg, /10월 21일 \(수\) \d{2}:\d{2} 도착/);
  assert.match(bkMsg, /- 주차는 지하 2층/);
  assert.match(bkMsg, /view\.html\?id=/);
  assert.doesNotMatch(bkMsg, /주차 확인 필요|김정규|박프리/, '내부 메모·직원 이름 없음');
  await shot(owner, '12i-booking-sheet');
  await bk.getByRole('button', { name: '닫기' }).click();
  await view.reload();
  await view.locator('.booking-card').waitFor();
  const card = await view.locator('.booking-card').innerText();
  assert.match(card, /예약이 확정되었어요/);
  assert.match(card, /10월 21일 \(수\)/);
  assert.match(card, /주차는 지하 2층/);
  assert.match(card, new RegExp(`${auto.crew}명이 방문해요`));
  await view.getByRole('button', { name: '예약 확정 ✓' }).waitFor();
  assert.doesNotMatch(await view.locator('body').innerText(), /주차 확인 필요|김정규|박프리|숨고/, '고객 화면에 내부 정보 없음');
  await noLeak(view, '확정 안내 견적서');
  await shot(view, '12j-customer-booking');
  await owner.getByRole('button', { name: '뒤로 가기' }).click();
  await owner.getByRole('button', { name: '일정', exact: true }).click();
  await owner.getByLabel('날짜 바로 가기').fill('2026-10-21');
  await owner.locator('.job-card', { hasText: '견적앱' }).waitFor({ timeout: 10000 });
  assert.match(await owner.locator('.job-card', { hasText: '견적앱' }).innerText(), new RegExp(`${auto.crew}명 중 0명 배정`));
  // 일정 탭에서 시간을 바꾸면 고객 확정 안내도 따라 바뀜
  await owner.locator('.job-card', { hasText: '견적앱' }).click();
  await jobForm.getByRole('button', { name: '14:00' }).click();
  await jobForm.getByRole('button', { name: '저장' }).click();
  await owner.getByText(/고객 확정 안내도 바뀐 시간으로/).waitFor({ timeout: 10000 });
  await view.reload();
  await view.locator('.booking-card', { hasText: '14:00 도착' }).waitFor();

  // 7) 개발자 모드: 업종 시뮬레이터
  step('7) 개발자 모드: 업종 시뮬레이터 6개 업종 모두 계산·점검 통과, 값 바꾸면 결과 변경');
  const dev = await newPage();
  await dev.goto(`${BASE}dev.html`);
  await dev.locator('.dev-tabs .chip').first().waitFor();
  const index = JSON.parse(await readFile(path.join(ROOT, 'templates/index.json'), 'utf8'));
  const tabNames = index.map((t) => t.name);
  assert.ok(tabNames.length >= 6, '업종 6개 이상');
  for (let i = 0; i < tabNames.length; i += 1) {
    await dev.locator('.dev-tabs .chip').nth(i).click();
    await dev.waitForFunction((n) => document.querySelector('.dev-tabs .chip.on')?.textContent.startsWith(n), tabNames[i]);
    await noLeak(dev, `시뮬레이터 ${tabNames[i]}`);
    assert.match(await dev.locator('.lint').innerText(), /점검 통과/, `${tabNames[i]} 템플릿 점검`);
    assert.match(await dev.locator('.total-box').innerText(), /\d,\d{3},?\d*원|\d{3},000원/, `${tabNames[i]} 금액`);
    assert.match(await dev.locator('.labor').innerText(), /명 ×/, `${tabNames[i]} 인력 예상`);
  }
  await shot(dev, '13-dev-moving');
  await dev.locator('.dev-tabs .chip', { hasText: '에어컨' }).click();
  const before = await dev.locator('.total-box b').innerText();
  await dev.locator('.dev-item input[type=number]').first().fill('5');
  await dev.locator('.dev-item input[type=number]').first().press('Enter');
  await dev.waitForFunction((b) => document.querySelector('.total-box b').textContent !== b, before);
  await shot(dev, '14-dev-aircon');
  assert.equal(await dev.locator('.dv-badge.has-error').count(), 0, '시뮬레이터에 오류 없음');

  // 8) 개발자 모드: 오류 패널
  step('8) 개발자 모드 오류 패널: ?dev=1 로 켜면 오류가 패널에 기록됨');
  const ownerDev = await newPage();
  await ownerDev.goto(`${BASE}owner.html?emulator=1&dev=1`);
  await ownerDev.locator('.dv-badge').waitFor();
  await ownerDev.evaluate(() => console.error('테스트 오류: 일부러 낸 오류'));
  await ownerDev.locator('.dv-badge.has-error').waitFor();
  await ownerDev.locator('.dv-badge').click();
  assert.match(await ownerDev.locator('.dv-list').innerText(), /일부러 낸 오류/);
  await shot(ownerDev, '15-dev-panel');

  console.log('\n✅ 완료 확인 시나리오 1~5 + 테스트 모드 + 개발자 모드 통과');
} catch (e) {
  for (const [i, p] of pages.entries()) await shot(p, `fail-${i}`).catch(() => {});
  throw e;
} finally {
  await browser.close();
  server.close();
}
