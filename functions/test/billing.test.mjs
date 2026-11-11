// 요금 테스트 (무료 10건 세기 · 요금제 시작 · 해지 · 매월 결제). Firebase·토스 없이 가짜 저장소·가짜 결제로 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeState, nextMonth, handleStatus, handleSubscribe, handleCancel, runRenewals, BillingError, FREE_LIMIT, MAX_RETRY } from '../lib/billing.js';

const TODAY = '2026-11-11';

function fake({ docs = {}, quotes = 0, uid = 'shop1', today = TODAY, failCharge = false } = {}) {
  const charges = [];
  let n = 0;
  const deps = {
    uid, today,
    getDoc: async (p) => docs[p] ?? null,
    setDoc: async (p, data, merge) => { docs[p] = merge ? { ...docs[p], ...data } : { ...data }; },
    countQuotes: async () => quotes,
    orderId: () => `o${++n}`,
    listDue: async (t) => Object.entries(docs).filter(([p, d]) => p.startsWith('subscriptions/') && d.nextChargeDate && d.nextChargeDate <= t).map(([, d]) => d),
    pg: {
      issueKey: async ({ authKey }) => { if (authKey === 'bad') throw new BillingError(402, 'pg', '카드 오류'); return { billingKey: 'bk1', card: { company: '현대', number: '4330****' } }; },
      charge: async (c) => { if (failCharge) throw new BillingError(402, 'pg', '한도 초과'); charges.push(c); return { paymentKey: 'pay1', approvedAt: 't' }; },
    },
  };
  return { deps, docs, charges };
}

test('다음 결제일: 한 달 뒤 같은 날, 없으면 말일, 12월 → 1월', () => {
  assert.equal(nextMonth('2026-11-11'), '2026-12-11');
  assert.equal(nextMonth('2026-12-11'), '2027-01-11');
  assert.equal(nextMonth('2027-01-31'), '2027-02-28');
  assert.equal(nextMonth('2027-02-28', 31), '2027-03-31', '말일로 당겨졌다가도 원래 결제일(31일)로 돌아온다');
});

test('무료 10건: 남은 건수, 다 쓰면 — 막기 꺼짐이면 계속 가능, 켜짐이면 불가', () => {
  assert.deepEqual(pick(computeState(null, 3, { today: TODAY, enforce: true })), { plan: 'trial', used: 3, freeLeft: 7, canSend: true });
  assert.deepEqual(pick(computeState(null, FREE_LIMIT, { today: TODAY, enforce: false })), { plan: 'trial', used: 10, freeLeft: 0, canSend: true });
  assert.deepEqual(pick(computeState(null, FREE_LIMIT, { today: TODAY, enforce: true })), { plan: 'trial', used: 10, freeLeft: 0, canSend: false });
});

test('견적서를 지워도 쓴 건수는 줄지 않는다, 운영자가 늘려준 무료 한도를 따른다', () => {
  assert.equal(computeState({ used: 9 }, 2, { today: TODAY, enforce: true }).used, 9);
  assert.equal(computeState({ used: 12, freeLimit: 30 }, 12, { today: TODAY, enforce: true }).canSend, true);
});

test('요금제 이용 중이면 무료 한도와 상관없이 가능, 기간이 끝나면 다시 무료 한도 규칙', () => {
  const paid = { used: 50, plan: 'solo', status: 'active', paidUntil: '2026-12-11', nextChargeDate: '2026-12-11' };
  assert.deepEqual(pick(computeState(paid, 50, { today: TODAY, enforce: true })), { plan: 'solo', used: 50, freeLeft: 0, canSend: true });
  const s = computeState(paid, 50, { today: '2026-12-12', enforce: true });
  assert.equal(s.plan, 'trial'); assert.equal(s.canSend, false);
});

test('상태 조회: 실제 견적서 수를 세어 저장, 로그인 없으면 거절', async () => {
  const f = fake({ quotes: 10, docs: { 'config/billing': { enforce: true } } });
  const s = await handleStatus(f.deps);
  assert.equal(s.canSend, false);
  assert.deepEqual(pickSaved(f.docs['shops/shop1/billing/state']), { used: 10, canSend: false });
  await assert.rejects(handleStatus({ ...f.deps, uid: null }), (e) => e.reason === 'auth');
});

test('요금제 시작: 카드 키 발급 → 첫 달 19,900원 결제 → 한 달 이용, 카드 키는 secret 문서에만', async () => {
  const f = fake({ quotes: 10 });
  const out = await handleSubscribe({ plan: 'solo', authKey: 'ak' }, f.deps);
  assert.deepEqual(out, { plan: 'solo', paidUntil: '2026-12-11', amount: 19900 });
  assert.equal(f.charges[0].amount, 19900);
  assert.equal(f.charges[0].customerKey, 'shop1');
  assert.equal(f.docs['shops/shop1/billing/secret'].billingKey, 'bk1');
  assert.equal(JSON.stringify(f.docs['shops/shop1/billing/state']).includes('bk1'), false, '화면 상태에는 카드 키 없음');
  assert.equal(f.docs['shops/shop1/billing/state'].canSend, true);
  assert.equal(f.docs['subscriptions/shop1'].nextChargeDate, '2026-12-11');
  assert.equal(f.docs['shops/shop1/payments/o1'].kind, 'first');
  await assert.rejects(handleSubscribe({ plan: 'solo', authKey: 'ak' }, f.deps), (e) => e.reason === 'already', '같은 요금제 두 번 결제 방지');
});

test('요금제 시작 실패: 없는 요금제·카드 오류·결제 거절 → 상태 그대로', async () => {
  const f = fake();
  await assert.rejects(handleSubscribe({ plan: 'vip', authKey: 'ak' }, f.deps), (e) => e.reason === 'bad_request');
  await assert.rejects(handleSubscribe({ plan: 'solo', authKey: 'bad' }, f.deps), (e) => e.reason === 'pg');
  const g = fake({ failCharge: true });
  await assert.rejects(handleSubscribe({ plan: 'solo', authKey: 'ak' }, g.deps), (e) => e.reason === 'pg');
  assert.equal(g.docs['shops/shop1/billing/state'], undefined);
});

test('해지: 다음 결제 없음, 낸 기간 말일까지는 이용', async () => {
  const f = fake();
  await handleSubscribe({ plan: 'team', authKey: 'ak' }, f.deps);
  assert.deepEqual(await handleCancel(f.deps), { paidUntil: '2026-12-11' });
  const s = await handleStatus(f.deps);
  assert.equal(s.status, 'canceled'); assert.equal(s.canSend, true); assert.equal(s.nextChargeDate, null);
  const r = await runRenewals({ ...f.deps, today: '2026-12-11' });
  assert.deepEqual(r, { charged: 0, failed: 0, stopped: 0 });
  assert.equal(f.charges.length, 1, '해지 뒤에는 결제하지 않는다');
});

test('매월 결제: 결제일에 1번만 결제하고 다음 달로, 결제일 전에는 안 함', async () => {
  const f = fake();
  await handleSubscribe({ plan: 'solo', authKey: 'ak' }, f.deps);
  assert.deepEqual(await runRenewals({ ...f.deps, today: '2026-12-10' }), { charged: 0, failed: 0, stopped: 0 });
  assert.deepEqual(await runRenewals({ ...f.deps, today: '2026-12-11' }), { charged: 1, failed: 0, stopped: 0 });
  assert.deepEqual(await runRenewals({ ...f.deps, today: '2026-12-11' }), { charged: 0, failed: 0, stopped: 0 }, '같은 날 두 번 돌아도 한 번만');
  assert.equal(f.docs['shops/shop1/billing/state'].paidUntil, '2027-01-11');
  assert.equal(f.charges.length, 2);
  assert.equal(f.charges[1].orderId, 'bm-r-shop1-2026-12-11-0', '주문번호가 결제일로 고정 → 중복 결제 방지');
});

test(`매월 결제 실패: 하루 1번 다시 시도, ${MAX_RETRY}번 실패하면 멈춤 → 기간이 끝나면 무료 한도 규칙`, async () => {
  const f = fake();
  await handleSubscribe({ plan: 'solo', authKey: 'ak' }, f.deps);
  const failing = { ...f.deps, pg: { ...f.deps.pg, charge: async () => { throw new BillingError(402, 'pg', '한도 초과'); } } };
  assert.deepEqual(await runRenewals({ ...failing, today: '2026-12-11' }), { charged: 0, failed: 1, stopped: 0 });
  assert.deepEqual(await runRenewals({ ...failing, today: '2026-12-12' }), { charged: 0, failed: 1, stopped: 0 });
  assert.deepEqual(await runRenewals({ ...failing, today: '2026-12-13' }), { charged: 0, failed: 0, stopped: 1 });
  assert.deepEqual(await runRenewals({ ...failing, today: '2026-12-14' }), { charged: 0, failed: 0, stopped: 0 });
  assert.equal(f.docs['shops/shop1/billing/state'].status, 'past_due');
  assert.equal(f.charges.length, 1, '실패한 결제는 돈이 나가지 않는다');
});

function pick(s) { return { plan: s.plan, used: s.used, freeLeft: s.freeLeft, canSend: s.canSend }; }
function pickSaved(d) { return { used: d.used, canSend: d.canSend }; }
