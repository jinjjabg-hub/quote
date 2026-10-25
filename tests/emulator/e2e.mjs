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
        : { ok: true, items: [{ roadAddr: '부산광역시 부산진구 가야대로 000', jibunAddr: '', bdNm: '예시타운', apt: true, ref: REF }] },
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
  assert.deepEqual(lookupCalls, ['search', 'search', 'dongs', 'hos', 'area']);
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
