// 요금 (설계도 12장) — 계산과 처리 순서. Firebase·토스 연결은 billingStatus.js / billingPay.js 에서 넣어준다(테스트 가능하게).
//
// 흐름: 처음 견적 10건 무료 → 월 요금제(혼자·팀·회사, 카드 자동결제).
// - "쓴 건수"는 화면이 보내는 값이 아니라 서버가 실제 견적서(quotes) 수를 센다. 같은 견적을 고쳐 다시 보내면 문서가 하나라 늘지 않는다.
//   테스트 견적은 세지 않는다. 지워도 줄지 않게 지금까지의 최댓값을 남긴다.
// - 상태는 shops/{id}/billing/state (서버만 씀). 보안 규칙이 canSend == false 면 새 견적서 생성을 막는다.
// - 카드 자동결제 키(billingKey)는 shops/{id}/billing/secret (서버만 읽고 씀).
// - 막기(enforce)는 config/billing.enforce 가 true 일 때만. 결제가 열리기 전에는 세기만 하고 막지 않는다.

export const FREE_LIMIT = 10;
export const PLANS = {
  solo: { name: '혼자', amount: 19900 },
  team: { name: '팀', amount: 49000 },
  company: { name: '회사', amount: 99000 },
};
export const MAX_RETRY = 3; // 자동결제 실패 시 다시 시도하는 횟수 (하루 1번)

export class BillingError extends Error {
  constructor(status, reason, message) { super(message); this.status = status; this.reason = reason; }
}

/** 한국 날짜 'YYYY-MM-DD' */
export function koreaToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 다음 결제일: 한 달 뒤 같은 날. 그 달에 같은 날짜가 없으면 말일 (이용약관 제7조). anchorDay = 최초 결제일의 '일' */
export function nextMonth(date, anchorDay) {
  const [y, m] = date.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const day = Math.min(anchorDay || Number(date.slice(8)), last);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 상태 계산. prev = 저장된 state(없으면 null), quoteCount = 지금 실제 견적서 수(테스트 제외) */
export function computeState(prev, quoteCount, { today, enforce }) {
  const p = prev || {};
  const used = Math.max(Number(p.used) || 0, quoteCount);
  const freeLimit = Number.isFinite(p.freeLimit) ? p.freeLimit : FREE_LIMIT; // 협력 업체는 운영자가 콘솔에서 늘려줄 수 있다
  const paid = !!p.paidUntil && p.paidUntil >= today;
  const plan = paid && PLANS[p.plan] ? p.plan : 'trial';
  const freeLeft = Math.max(0, freeLimit - used);
  return {
    plan,
    status: paid ? (p.status === 'canceled' ? 'canceled' : p.status === 'past_due' ? 'past_due' : 'active') : 'trial',
    used, freeLimit, freeLeft,
    paidUntil: paid ? p.paidUntil : null,
    nextChargeDate: paid && p.status !== 'canceled' ? p.nextChargeDate || p.paidUntil : null,
    card: paid ? p.card || null : null,
    enforce: !!enforce,
    canSend: paid || freeLeft > 0 || !enforce,
  };
}

/**
 * 상태 조회 (사장님 화면이 열릴 때·견적 발송 뒤에 부른다). 실제 견적서 수를 다시 세어 저장한다.
 * deps: { uid, today, getDoc(path), setDoc(path, data, merge), countQuotes(shopId) → number }
 */
export async function handleStatus(deps) {
  if (!deps.uid) throw new BillingError(401, 'auth', '로그인이 필요합니다.');
  const path = `shops/${deps.uid}/billing/state`;
  const [prev, cfg, count] = await Promise.all([deps.getDoc(path), deps.getDoc('config/billing'), deps.countQuotes(deps.uid)]);
  const state = computeState(prev, count, { today: deps.today, enforce: cfg?.enforce === true });
  if (!prev || prev.used !== state.used || prev.canSend !== state.canSend) {
    await deps.setDoc(path, { used: state.used, canSend: state.canSend, freeLimit: state.freeLimit }, true);
  }
  return state;
}

/**
 * 요금제 시작: 카드 등록 창에서 받은 authKey → 자동결제 키 발급 → 첫 달 결제 → 상태 저장.
 * deps: 위 + { pg: { issueKey({authKey, customerKey}) → {billingKey, card}, charge({billingKey, customerKey, amount, orderId, orderName}) → {paymentKey, approvedAt} },
 *              orderId() → string, email, shopName }
 */
export async function handleSubscribe(body, deps) {
  if (!deps.uid) throw new BillingError(401, 'auth', '로그인이 필요합니다.');
  const plan = PLANS[body?.plan];
  const authKey = String(body?.authKey || '');
  if (!plan || !authKey) throw new BillingError(400, 'bad_request', '요청 형식이 올바르지 않습니다.');
  const base = `shops/${deps.uid}`;
  const prev = await deps.getDoc(`${base}/billing/state`);
  if (prev?.paidUntil >= deps.today && prev.status !== 'canceled' && prev.plan === body.plan) {
    throw new BillingError(409, 'already', '이미 이용 중인 요금제입니다.');
  }
  const customerKey = deps.uid;
  const { billingKey, card } = await deps.pg.issueKey({ authKey, customerKey });
  const orderId = deps.orderId();
  const paid = await deps.pg.charge({ billingKey, customerKey, amount: plan.amount, orderId, orderName: `비즈마이 견적 ${plan.name} 요금제 (1개월)` });
  const next = nextMonth(deps.today);
  await deps.setDoc(`${base}/billing/secret`, { billingKey, customerKey }, false);
  await deps.setDoc(`${base}/billing/state`, {
    plan: body.plan, status: 'active', paidUntil: next, nextChargeDate: next, anchorDay: Number(deps.today.slice(8)),
    card: card || null, retry: 0, canSend: true,
  }, true);
  await deps.setDoc(`subscriptions/${deps.uid}`, { shopId: deps.uid, plan: body.plan, status: 'active', nextChargeDate: next }, false);
  await deps.setDoc(`${base}/payments/${orderId}`, { orderId, plan: body.plan, amount: plan.amount, kind: 'first', paymentKey: paid.paymentKey || '', approvedAt: paid.approvedAt || '', date: deps.today }, false);
  return { plan: body.plan, paidUntil: next, amount: plan.amount };
}

/** 해지: 다음 결제일부터 결제하지 않는다. 이미 낸 기간 말일까지는 그대로 쓴다 (이용약관 제9조) */
export async function handleCancel(deps) {
  if (!deps.uid) throw new BillingError(401, 'auth', '로그인이 필요합니다.');
  const base = `shops/${deps.uid}`;
  const prev = await deps.getDoc(`${base}/billing/state`);
  if (!prev?.paidUntil || prev.paidUntil < deps.today) throw new BillingError(409, 'no_plan', '이용 중인 요금제가 없습니다.');
  await deps.setDoc(`${base}/billing/state`, { status: 'canceled', nextChargeDate: null }, true);
  await deps.setDoc(`subscriptions/${deps.uid}`, { status: 'canceled', nextChargeDate: null }, true);
  return { paidUntil: prev.paidUntil };
}

/**
 * 매일 1번: 결제일이 된 구독을 결제한다. 실패하면 다음 날 다시 (MAX_RETRY 번), 그래도 안 되면 멈춘다(이용 기간이 끝나면 무료 한도 규칙으로 돌아감).
 * deps: { today, listDue(today) → [{ shopId, plan, nextChargeDate }], getDoc, setDoc, pg }
 * @returns { charged, failed, stopped }
 */
export async function runRenewals(deps) {
  const out = { charged: 0, failed: 0, stopped: 0 };
  for (const sub of await deps.listDue(deps.today)) {
    const base = `shops/${sub.shopId}`;
    const [state, secret] = await Promise.all([deps.getDoc(`${base}/billing/state`), deps.getDoc(`${base}/billing/secret`)]);
    const plan = PLANS[sub.plan];
    if (!state || state.status === 'canceled' || !secret?.billingKey || !plan) {
      await deps.setDoc(`subscriptions/${sub.shopId}`, { status: 'canceled', nextChargeDate: null }, true);
      out.stopped += 1;
      continue;
    }
    // 주문번호를 결제일·시도 횟수로 고정 → 결제는 됐는데 기록이 실패해 다시 돌아도 같은 번호라 두 번 결제되지 않는다
    const orderId = `bm-r-${sub.shopId}-${sub.nextChargeDate}-${Number(state.retry) || 0}`;
    try {
      const paid = await deps.pg.charge({ billingKey: secret.billingKey, customerKey: secret.customerKey, amount: plan.amount, orderId, orderName: `비즈마이 견적 ${plan.name} 요금제 (1개월)` });
      const next = nextMonth(state.paidUntil >= deps.today ? state.paidUntil : deps.today, state.anchorDay);
      await deps.setDoc(`${base}/billing/state`, { status: 'active', paidUntil: next, nextChargeDate: next, retry: 0, canSend: true }, true);
      await deps.setDoc(`subscriptions/${sub.shopId}`, { status: 'active', nextChargeDate: next }, true);
      await deps.setDoc(`${base}/payments/${orderId}`, { orderId, plan: sub.plan, amount: plan.amount, kind: 'renewal', paymentKey: paid.paymentKey || '', approvedAt: paid.approvedAt || '', date: deps.today }, false);
      out.charged += 1;
    } catch (e) {
      const retry = (Number(state.retry) || 0) + 1;
      const stop = retry >= MAX_RETRY;
      await deps.setDoc(`${base}/billing/state`, { status: 'past_due', retry, lastError: String(e?.message || '').slice(0, 200), ...(stop ? { nextChargeDate: null } : {}) }, true);
      await deps.setDoc(`subscriptions/${sub.shopId}`, stop ? { status: 'past_due', nextChargeDate: null } : { status: 'past_due' }, true);
      out[stop ? 'stopped' : 'failed'] += 1;
    }
  }
  return out;
}
