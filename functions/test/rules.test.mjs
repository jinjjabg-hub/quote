// 결제 금액·환불 규칙 단위 테스트 (설치 불필요: cd functions && npm test)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPayable, makeOrderId, isOrderId, parseConfirmInput, checkAgreements, refundByRules, describeRefundRules, refundable,
} from '../lib/rules.js';

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
  assert.deepEqual(refundByRules(112000, rules, '2026-10-15', NOW), { amount: 112000, pct: 100, daysBefore: 4 });
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
