// 결제 금액·환불 규칙 단위 테스트 (설치 불필요: cd functions && npm test)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPayable, makeOrderId, isOrderId, parseConfirmInput, checkAgreements, refundByRules, describeRefundRules, refundable,
  classifyTossUpdate, quotePaymentSummary, pickServiceDate, normalizeRefundRules, SETTLED_STATUS,
} from '../lib/rules.js';
import { readFileSync } from 'node:fs';

const quote = (over = {}) => ({
  status: 'sent', total: 560000, deposit: 112000, validUntil: '2026-10-20',
  shop: { name: '반짝청소' }, templateName: '입주청소', ...over,
});
const NOW = new Date('2026-10-11T03:00:00Z'); // KST 10-11 12:00

test('계약금: 서버가 quotes.deposit 으로 금액을 정한다', () => {
  const r = checkPayable(quote(), 'deposit', { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.amount, 112000);
  assert.match(r.orderName, /반짝청소 입주청소 계약금/);
});

test('계약금: 예약요청 상태도 결제 가능, 이미 결제/보류/만료는 불가', () => {
  assert.equal(checkPayable(quote({ status: 'booking_requested' }), 'deposit', { now: NOW }).ok, true);
  assert.equal(checkPayable(quote({ status: 'paid_deposit' }), 'deposit', { now: NOW }).code, 'BAD_STATUS');
  assert.equal(checkPayable(quote({ status: 'hold' }), 'deposit', { now: NOW }).code, 'BAD_STATUS');
  assert.equal(checkPayable(quote({ validUntil: '2026-10-10' }), 'deposit', { now: NOW }).code, 'EXPIRED');
  assert.equal(checkPayable(quote({ deposit: 0 }), 'deposit', { now: NOW }).code, 'ZERO_AMOUNT');
  assert.equal(checkPayable(quote({ deposit: 999999 }), 'deposit', { now: NOW }).code, 'BAD_AMOUNT');
  assert.equal(checkPayable(quote({ deposit: '112000.5' }), 'deposit', { now: NOW }).code, 'BAD_AMOUNT');
  assert.equal(checkPayable(null, 'deposit').code, 'NOT_FOUND');
});

test('잔금: 합계 - 결제된 계약금 + 고객이 승인한 추가금', () => {
  const r = checkPayable(quote({ status: 'done' }), 'balance', {
    paidDeposit: 112000, approvedExtras: [{ amount: 50000 }, { amount: 30000 }], now: NOW,
  });
  assert.equal(r.amount, 560000 - 112000 + 80000);
});

test('orderId 는 토스 규격(영문·숫자·-·_ 6~64자)', () => {
  const id = makeOrderId('AbCdEfGhIjKlMnOpQrSt', 'deposit');
  assert.ok(isOrderId(id), id);
  assert.ok(id.startsWith('D-AbCdEfGhIjKlMnOpQrSt-'));
});

test('승인 입력값 검증: 금액은 양의 정수만', () => {
  assert.equal(parseConfirmInput({ paymentKey: 'pk_1', orderId: 'D-abcdef', amount: '112000' }).amount, 112000);
  assert.equal(parseConfirmInput({ paymentKey: 'pk_1', orderId: 'D-abcdef', amount: '1e3' }).ok, true); // Number('1e3')=1000, 서버 기록과 비교되므로 무해
  assert.equal(parseConfirmInput({ paymentKey: 'pk_1', orderId: 'D-abcdef', amount: '-1' }).ok, false);
  assert.equal(parseConfirmInput({ paymentKey: 'pk_1', orderId: '../x', amount: 1 }).ok, false);
});

test('동의 3종이 모두 true 여야 결제 준비', () => {
  assert.equal(checkAgreements({ cancelPolicy: true, terms: true, privacy: true }).ok, true);
  assert.deepEqual(checkAgreements({ cancelPolicy: true, terms: 'yes' }).missing, ['terms', 'privacy']);
});

test('환불: 업체 규칙(3일 전 100%, 1~2일 전 50%, 당일 0%)', () => {
  const rules = [{ daysBefore: 0, pct: 0 }, { daysBefore: 3, pct: 100 }, { daysBefore: 1, pct: 50 }];
  assert.deepEqual(refundByRules(112000, rules, '2026-10-15', NOW), { amount: 112000, pct: 100, daysBefore: 4, rule: 'daysBefore' });
  assert.equal(refundByRules(112000, rules, '2026-10-14', NOW).pct, 100);
  assert.equal(refundByRules(112000, rules, '2026-10-13', NOW).amount, 56000);
  assert.equal(refundByRules(112000, rules, '2026-10-12', NOW).pct, 50);
  assert.equal(refundByRules(112000, rules, '2026-10-11', NOW).pct, 0);
  assert.equal(refundByRules(112000, rules, '2026-10-01', NOW).pct, 0); // 작업일 지남
  assert.equal(refundByRules(112000, null, '2026-10-15', NOW), null); // 규칙 없음 → 사장님 직접 입력
  assert.match(describeRefundRules(rules), /작업 3일 전까지 취소: 계약금 100% 환불/);
});

test('KST 기준 날짜: 한국 자정 직후도 다음 날로 계산', () => {
  const rules = [{ daysBefore: 1, pct: 100 }, { daysBefore: 0, pct: 0 }];
  // UTC 10-11 15:30 = KST 10-12 00:30 → 작업일 10-12 는 "당일"
  assert.equal(refundByRules(1000, rules, '2026-10-12', new Date('2026-10-11T15:30:00Z')).pct, 0);
});

test('부분 환불 후 남은 환불 가능 금액', () => {
  assert.equal(refundable({ amount: 112000, refundedAmount: 56000 }), 56000);
  assert.equal(refundable({ amount: 112000 }), 112000);
});

// ───────── M10: 위조 웹훅·주문 불일치 ─────────
const OID = 'D-AbCdEfGhIjKlMnOpQrSt-abc123';
const payDoc = (over = {}) => ({ amount: 112000, status: 'ready', ...over });
const tossPay = (over = {}) => ({ orderId: OID, paymentKey: 'pk_real', totalAmount: 112000, status: 'DONE', ...over });

test('M10: 토스 orderId == 요청 orderId == 문서 ID 일 때만 반영', () => {
  assert.deepEqual(classifyTossUpdate(OID, payDoc(), tossPay(), OID), { action: 'apply' });
  // 공격자: 자기 결제(다른 orderId)의 paymentKey + 피해 견적의 orderId
  assert.equal(classifyTossUpdate(OID, payDoc({ status: 'paid', paymentKey: 'pk_real' }), tossPay({ orderId: 'D-attacker-xyz999', paymentKey: 'pk_evil', totalAmount: 1000 }), OID).action, 'ignore');
  assert.equal(classifyTossUpdate(OID, payDoc(), tossPay(), 'D-other-order1').action, 'ignore');
  assert.equal(classifyTossUpdate('../bad', payDoc(), tossPay({ orderId: '../bad' }), '../bad').action, 'ignore');
  assert.equal(classifyTossUpdate(OID, payDoc({ paymentKey: 'pk_real' }), tossPay({ paymentKey: 'pk_other' })).action, 'ignore');
  assert.equal(classifyTossUpdate(OID, null, tossPay()).action, 'ignore');
  assert.equal(classifyTossUpdate(OID, payDoc(), null).action, 'ignore');
});

test('M10: 이미 결제된 건은 금액 불일치로 덮어쓰지 않고 경고만', () => {
  assert.equal(classifyTossUpdate(OID, payDoc(), tossPay({ totalAmount: 100 })).action, 'mismatch');
  assert.equal(classifyTossUpdate(OID, payDoc({ status: 'confirming' }), tossPay({ totalAmount: 100 })).action, 'mismatch');
  for (const st of SETTLED_STATUS) {
    assert.equal(classifyTossUpdate(OID, payDoc({ status: st }), tossPay({ totalAmount: 100 })).action, 'alert', st);
  }
  assert.ok(SETTLED_STATUS.includes('paid'));
});

test('L8: 공개 견적서 결제 요약에는 금액·상태·시각만', () => {
  const s = quotePaymentSummary({ amount: 112000, status: 'paid', paidAt: '2026-10-11T12:00:00+09:00' });
  assert.deepEqual(s, { amount: 112000, status: 'paid', paidAt: '2026-10-11T12:00:00+09:00', refundedAmount: 0 });
  const c = quotePaymentSummary({ amount: 112000, status: 'canceled', refundedAmount: 112000, canceledAt: '2026-10-12T00:00:00Z', orderId: 'x', receiptUrl: 'y' });
  assert.equal(c.orderId, undefined);
  assert.equal(c.receiptUrl, undefined);
  assert.deepEqual(Object.keys(c).sort(), ['amount', 'canceledAt', 'paidAt', 'refundedAmount', 'status']);
});

test('L8: index.js 가 quotes.payment 에 orderId·영수증을 쓰지 않는다', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const writes = [...src.matchAll(/\[`payment\.\$\{pay\.kind\}[^`]*`\]:\s*([^\n]+)/g)].map((m) => m[1]);
  assert.ok(writes.length >= 2, 'payment 필드 쓰기 위치를 찾지 못함');
  for (const w of writes) {
    assert.match(w, /quotePaymentSummary|^summary\b/, w);
    assert.doesNotMatch(w, /orderId|receipt/, w);
  }
});

// ───────── M13: 환불 규칙 = 고객이 본 규칙 ─────────
test('M13: 규칙 정리 — 형식이 틀린 줄은 버리고, 하나도 없으면 null (자동 계산 안 함)', () => {
  assert.equal(normalizeRefundRules(null), null);
  assert.equal(normalizeRefundRules([]), null);
  assert.equal(normalizeRefundRules([{ daysBefore: 'x', pct: 100 }]), null);
  assert.deepEqual(normalizeRefundRules([{ daysBefore: 3, pct: 150 }, { type: 'withinDaysOfPayment', days: 7, pct: 100 }, { foo: 1 }]),
    [{ daysBefore: 3, pct: 100 }, { type: 'withinDaysOfPayment', days: 7, pct: 100 }]);
  assert.equal(refundByRules(112000, [], '2026-10-15', NOW), null);
});

test('M13: 결제 후 7일 이내(작업일 전) 전액 — 더 유리한 규칙 적용', () => {
  const rules = [{ type: 'withinDaysOfPayment', days: 7, pct: 100 }, { daysBefore: 3, pct: 100 }, { daysBefore: 1, pct: 50 }, { daysBefore: 0, pct: 0 }];
  const paidAt = '2026-10-08T10:00:00+09:00';
  const r = refundByRules(112000, rules, '2026-10-12', NOW, { paidAt }); // 작업 1일 전이지만 결제 3일째
  assert.deepEqual(r, { amount: 112000, pct: 100, daysBefore: 1, rule: 'withinDaysOfPayment' });
  assert.equal(refundByRules(112000, rules, '2026-10-12', NOW, { paidAt: '2026-09-30T10:00:00+09:00' }).pct, 50); // 7일 지남
  assert.equal(refundByRules(112000, rules, '2026-10-11', NOW, { paidAt }).pct, 0); // 작업 당일은 7일 규칙 미적용
  assert.equal(refundByRules(112000, rules, '2026-10-12', NOW).pct, 50); // 결제 시각 모르면 7일 규칙 미적용
  assert.match(describeRefundRules(rules), /^결제 후 7일 이내\(작업일 전\) 취소: 계약금 100% 환불\n작업 3일 전까지/);
});

test('M13: 환불 기준일은 확정 작업일 우선', () => {
  assert.equal(pickServiceDate({ booking: { date: '2026-10-20' }, service: { date: '2026-10-15' } }), '2026-10-20');
  assert.equal(pickServiceDate({ service: { date: '2026-10-15' } }), '2026-10-15');
  assert.equal(pickServiceDate({ service: { date: '10월 15일' } }), null);
  assert.equal(pickServiceDate(null), null);
});

test('M13: 고객 화면(js/payment.js)의 환불 규칙 문장이 서버 기록과 같다', async (t) => {
  let client;
  try { client = await import('../../js/payment.js'); } catch (e) { t.skip(e.message); return; }
  for (const rules of [null, [], [{ daysBefore: 0, pct: 0 }, { daysBefore: 3, pct: 100 }],
    [{ type: 'withinDaysOfPayment', days: 7, pct: 100 }, { daysBefore: 1, pct: 50.4 }, { bad: true }]]) {
    assert.equal(client.describeRefundRules(rules), describeRefundRules(rules), JSON.stringify(rules));
  }
});

// ───────── L10 ─────────
test('L10: functions/.gitignore 가 .env 를 막고 .env.example 은 남긴다', () => {
  const gi = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(gi.includes('.env'));
  assert.ok(gi.includes('!.env.example'));
  const ex = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.doesNotMatch(ex, /(test|live)_(g)?sk_[A-Za-z0-9]{6,}/); // 시크릿키 금지
});
