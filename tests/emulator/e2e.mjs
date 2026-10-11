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
  await shopField('상호').fill('반짝입주청소');
  await shopField('연락처').fill('010-1111-2222');
  await owner.getByRole('button', { name: '저장', exact: true }).click();
  await owner.getByText('숫자만 고치고').waitFor();
  const priceInput = (label) => owner.locator('label.price-row', { hasText: label }).locator('input');
  await priceInput('평당 단가').fill('8000');
  const priceWarn = owner.locator('section.card .warn-box');
  assert.match(await priceWarn.innerText(), /분쟁/, '9,000원 미만 경고');
  await priceInput('평당 단가').fill('13000');
  assert.equal(await priceWarn.isHidden(), true);
  await priceInput('신축').fill('20');
  await priceInput('곰팡이 제거').fill('30000');
  await shot(owner, '1-owner-price');
  await owner.getByRole('button', { name: /단가표 저장/ }).click();
  await owner.getByText('단가표를 저장했어요').waitFor();
  const uid = await owner.evaluate(async () => (await import('./js/firebase.js')).auth.currentUser.uid);

  // 2) 고객 입력
  step('2) 고객: 34평, 신축, 곰팡이 예, 붙박이장 모름, 사진 2장');
  const cust = await newPage();
  await cust.goto(`${BASE}q.html?shop=${uid}&emulator=1`);
  const next = () => cust.locator('.nav-row .btn.primary').click();
  // 개인정보 동의 (체크 전엔 시작 불가)
  assert.equal(await cust.getByRole('button', { name: '시작하기' }).isDisabled(), true);
  await cust.locator('#consent').check();
  await shot(cust, '2-customer-consent');
  await cust.getByRole('button', { name: '시작하기' }).click();
  await cust.getByPlaceholder('홍길동').fill('김고객');
  await cust.getByPlaceholder('010-0000-0000').fill('010-3333-4444');
  await shot(cust, '2-customer-step1');
  await next();
  await cust.getByPlaceholder('예) 서울 송파구').fill('서울 송파구');
  await cust.getByRole('button', { name: '아파트' }).click();
  await next();
  await cust.locator('input[type=date]').fill('2026-10-21'); // 수요일, 공휴일·손 없는 날 아님
  await cust.getByRole('button', { name: '오전', exact: true }).click();
  await next();
  await cust.locator('input[type=number]').fill('34');
  await cust.getByRole('button', { name: '예, 신축' }).click();
  await next();
  await next(); // 방·욕실·베란다 기본값 (베란다 2 = 기본 포함)
  const items = cust.locator('.check-item');
  const n = await items.count();
  for (let i = 0; i < n; i += 1) {
    const item = items.nth(i);
    const q = await item.locator('.check-q').innerText();
    const ans = /곰팡이/.test(q) ? '예' : /붙박이장/.test(q) ? '모름' : /(주차|엘리베이터)/.test(q) ? '예' : '아니오';
    await item.getByRole('button', { name: ans, exact: true }).click();
  }
  await shot(cust, '3-customer-checklist');
  await next();
  await next(); // 추가 서비스 없음
  // 칸을 누르면 촬영 안내 바텀시트 → [앨범에서 고르기]
  for (const i of [0, 1]) {
    await cust.locator('.photo-slot').nth(i).click();
    const sheet = cust.locator('dialog.sheet[open]');
    await sheet.waitFor();
    if (i === 0) await shot(cust, '4a-customer-photo-sheet');
    await sheet.locator('input[type=file]:not([capture])').setInputFiles({ name: `${i}.png`, mimeType: 'image/png', buffer: PNG });
    await cust.locator('.photo-slot img').nth(i).waitFor();
  }
  await shot(cust, '4-customer-photos');
  await next();
  // 필수 사진이 비면 화면 안 안내 → 사진 없이 다음
  await cust.getByRole('button', { name: '사진 없이 다음' }).click();
  await next(); // 요청사항 → 제출
  await cust.getByText('요청이 접수되었습니다').waitFor({ timeout: 15000 });
  await shot(cust, '5-customer-done');

  // 3) 사장님 화면 자동 계산
  step('3) 사장님: 34 × 13,000 × 1.2 + 30,000 = 560,400 → 560,000원');
  await owner.getByRole('button', { name: /견적 요청/ }).click();
  const item = owner.locator('.req-item', { hasText: '김고객' });
  await item.waitFor();
  assert.match(await item.innerText(), /560,000원/);
  assert.match(await item.innerText(), /신규/);
  await shot(owner, '6-owner-list');
  await item.click();
  await owner.locator('.total-box').waitFor();
  assert.match(await owner.locator('.total-box').innerText(), /560,000원/);
  const condValues = await owner.locator('.conds input.line-label').evaluateAll((els) => els.map((e) => e.value));
  assert.ok(condValues.some((v) => /붙박이장 내부/.test(v)), condValues.join(','));
  await owner.locator('.photo-grid.view img[src]').nth(1).waitFor();
  await shot(owner, '7-owner-detail');
  await owner.getByRole('button', { name: /견적 발송/ }).click();
  await owner.locator('dialog.sheet').waitFor();
  const viewUrl = await owner.getByRole('link', { name: '견적서 미리보기' }).getAttribute('href');
  await shot(owner, '8-owner-sent');
  await owner.getByRole('button', { name: '목록으로' }).click();

  // 4) 견적서
  step('4) 견적서: 붙박이장 내부가 ⚠️ 추가요금 조건에 표시');
  const view = await newPage();
  await view.goto(`${viewUrl}&emulator=1`);
  await view.locator('.cond').waitFor();
  assert.match(await view.locator('.cond').innerText(), /붙박이장 내부/);
  assert.match(await view.locator('.total-box').innerText(), /560,000원/);
  assert.match(await view.locator('.total-box').innerText(), /56,000원/); // 계약금 10%
  assert.equal(await view.locator('.badge.verified').count(), 1, '사진 확인 완료 배지');
  await shot(view, '9-quote-view');

  // 5) 예약 요청 → 사장님 목록 상태 변경
  step('5) 고객 예약 요청 → 사장님 목록이 "계약요청"으로 실시간 변경');
  await view.getByRole('button', { name: '이 견적으로 예약 요청' }).click();
  await view.getByRole('button', { name: /예약 요청 완료/ }).waitFor();
  await owner.locator('.req-item', { hasText: '김고객' }).getByText('계약요청').waitFor({ timeout: 10000 });
  await shot(owner, '10-owner-booking-requested');

  // 6) 다업종 (S1·S2): 이사 추가 → 고객 링크에 서비스 선택, 기존 입주청소 요청 금액은 그대로
  step('6) 업종 추가(이사) → 서비스 선택 단계, 기존 요청 560,000원 유지');
  await owner.getByRole('button', { name: '업체 정보' }).click();
  await owner.getByRole('button', { name: '이사', exact: true }).click();
  await owner.getByRole('button', { name: '저장', exact: true }).click();
  await owner.getByText('숫자만 고치고').waitFor();
  await owner.getByRole('button', { name: '이사', exact: true }).click(); // 단가표 업종 탭
  await owner.getByText('이사 기본값이 채워져').waitFor();
  await shot(owner, '11-owner-price-moving');
  await owner.getByRole('button', { name: /견적 요청/ }).click();
  assert.match(await owner.locator('.req-item', { hasText: '김고객' }).innerText(), /560,000원/);
  const cust2 = await newPage();
  await cust2.goto(`${BASE}q.html?shop=${uid}&emulator=1`);
  await cust2.locator('#consent').check();
  await cust2.getByRole('button', { name: '시작하기' }).click();
  await cust2.getByText('어떤 서비스가 필요하세요?').waitFor();
  await shot(cust2, '12-customer-service-select');
  await cust2.getByRole('button', { name: '이사' }).click();
  await cust2.getByText('이사 견적 요청').waitFor();
  const cust3 = await newPage();
  await cust3.goto(`${BASE}q.html?shop=${uid}&t=moving&emulator=1`);
  await cust3.locator('#consent').check();
  await cust3.getByRole('button', { name: '시작하기' }).click();
  await cust3.getByPlaceholder('홍길동').waitFor(); // &t= 이면 선택 단계 없이 바로

  console.log('\n✅ 완료 확인 시나리오 1~6 모두 통과');
} catch (e) {
  for (const [i, p] of pages.entries()) await shot(p, `fail-${i}`).catch(() => {});
  throw e;
} finally {
  await browser.close();
  server.close();
}
