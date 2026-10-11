// 결제 금액·상태 규칙 (순수 함수: Firebase·네트워크 의존 없음 → node --test 로 바로 검증)
//
// 원칙
// - 결제 금액은 "항상 서버가 quotes 문서로 다시 계산"한다. 브라우저가 보낸 금액은 비교용일 뿐 믿지 않는다.
// - 환불 금액은 "고객이 결제 때 본" 규칙 스냅샷(payments.refundRules)으로만 계산한다. 없으면 사장님이 직접 입력 (검수 M13).

export const KINDS = ['deposit', 'balance'];

// 결제 종류별로 "결제를 시작해도 되는 견적 상태"
export const PAYABLE_STATUS = {
  deposit: ['sent', 'booking_requested'],
  balance: ['paid_deposit', 'confirmed', 'done'],
};

// 결제 성공 후 서버가 기록하는 견적 상태
export const STATUS_AFTER_PAID = {
  deposit: 'paid_deposit',
  balance: 'paid_full',
};

const QUOTE_ID_RE = /^[A-Za-z0-9]{10,40}$/;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/; // 토스페이먼츠 orderId 규격: 영문·숫자·-·_ 6~64자
const PAYMENT_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/;

export function isQuoteId(v) { return typeof v === 'string' && QUOTE_ID_RE.test(v); }
export function isOrderId(v) { return typeof v === 'string' && ORDER_ID_RE.test(v); }

/** KST(UTC+9) 기준 YYYY-MM-DD */
export function kstDateStr(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 이 견적으로 지금 결제를 시작할 수 있는지 + 서버가 계산한 결제 금액.
 * @param quote   quotes/{id} 문서 데이터
 * @param kind    'deposit' | 'balance'
 * @param ctx     { approvedExtras: [{amount}], paidDeposit: number, now: Date }
 * @returns { ok: true, amount, orderName } | { ok: false, code, message }
 */
export function checkPayable(quote, kind, ctx = {}) {
  const { approvedExtras = [], paidDeposit = 0, now = new Date() } = ctx;
  if (!quote) return fail('NOT_FOUND', '견적서를 찾을 수 없습니다.');
  if (!KINDS.includes(kind)) return fail('BAD_KIND', '결제 종류가 올바르지 않습니다.');
  if (!PAYABLE_STATUS[kind].includes(quote.status)) {
    return fail('BAD_STATUS', kind === 'deposit'
      ? '이미 결제했거나 결제할 수 없는 견적입니다. 업체에 문의해주세요.'
      : '아직 잔금을 결제할 단계가 아닙니다.');
  }
  if (kind === 'deposit' && quote.validUntil && kstDateStr(now) > quote.validUntil) {
    return fail('EXPIRED', '견적 유효기간이 지났습니다. 업체에 다시 견적을 요청해주세요.');
  }
  const total = toWon(quote.total);
  const deposit = toWon(quote.deposit);
  if (total == null || deposit == null || deposit > total) return fail('BAD_AMOUNT', '견적 금액이 올바르지 않습니다.');

  let amount;
  if (kind === 'deposit') {
    amount = deposit;
  } else {
    // 잔금 = 합계 - 실제 결제된 계약금 + "고객이 승인한" 현장 추가금
    const extras = approvedExtras.reduce((s, e) => s + (toWon(e.amount) ?? 0), 0);
    amount = total - toWon(paidDeposit ?? 0) + extras;
  }
  if (!(amount > 0)) return fail('ZERO_AMOUNT', '결제할 금액이 없습니다.');
  if (amount > 50_000_000) return fail('TOO_LARGE', '온라인 결제 한도를 넘습니다. 업체에 문의해주세요.');

  const shopName = String(quote.shop?.name || '').slice(0, 30);
  const what = kind === 'deposit' ? '계약금' : '잔금';
  const orderName = `${shopName} ${quote.templateName || '서비스'} ${what}`.trim().slice(0, 100);
  return { ok: true, amount, orderName };
}

/** 토스페이먼츠 orderId: 종류-견적ID-랜덤 (견적 하나에 결제 시도가 여러 번 있을 수 있음) */
export function makeOrderId(quoteId, kind, rand = Math.random().toString(36).slice(2, 10)) {
  const k = kind === 'deposit' ? 'D' : 'B';
  return `${k}-${quoteId}-${rand}`.slice(0, 64);
}

/** 결제 성공 리다이렉트 값 검증 (successUrl 의 paymentKey, orderId, amount) */
export function parseConfirmInput(body) {
  const paymentKey = body?.paymentKey;
  const orderId = body?.orderId;
  const amount = Number(body?.amount);
  if (typeof paymentKey !== 'string' || !PAYMENT_KEY_RE.test(paymentKey)) return { ok: false, message: 'paymentKey 형식 오류' };
  if (!isOrderId(orderId)) return { ok: false, message: 'orderId 형식 오류' };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, message: 'amount 형식 오류' };
  return { ok: true, paymentKey, orderId, amount };
}

// 동의 규칙은 consent.js 로 옮겼다 (맞춤제작 별도 동의 S4). 기존 import 호환용 재수출.
export { checkAgreements, BASE_AGREEMENTS as REQUIRED_AGREEMENTS } from './consent.js';

// ───────── 토스 결제 객체 반영 여부 (검수 M10) ─────────
/** 결제가 한 번이라도 성립한 상태 — 이후에는 mismatch 로 덮어쓰지 않는다 */
export const SETTLED_STATUS = ['paid', 'waiting_deposit', 'partial_canceled', 'canceled'];

/**
 * 토스에서 조회·승인받은 결제 객체를 payments/{docId} 에 반영해도 되는가.
 * @param docId            payments 문서 ID (= 우리가 만든 orderId)
 * @param pay              payments 문서 데이터
 * @param p                토스 결제 객체 (조회/승인/취소 응답)
 * @param requestedOrderId 요청(웹훅 본문·승인 요청)이 말한 orderId
 * @returns { action: 'apply' | 'ignore' | 'mismatch' | 'alert', reason? }
 *   ignore   : 다른 주문의 결제 → 아무것도 쓰지 않는다 (위조 웹훅)
 *   mismatch : 아직 결제 전인데 금액이 다름 → amount_mismatch (사람 확인)
 *   alert    : 이미 결제된 건인데 금액이 다르게 보임 → 상태는 그대로, 경고만 남긴다
 */
export function classifyTossUpdate(docId, pay, p, requestedOrderId = docId) {
  if (!pay || !p || typeof p !== 'object') return { action: 'ignore', reason: 'NO_DATA' };
  if (!isOrderId(docId) || p.orderId !== docId || requestedOrderId !== docId) {
    return { action: 'ignore', reason: 'ORDER_ID_MISMATCH' };
  }
  if (pay.paymentKey && p.paymentKey && pay.paymentKey !== p.paymentKey) {
    return { action: 'ignore', reason: 'PAYMENT_KEY_MISMATCH' };
  }
  if (p.totalAmount !== pay.amount) {
    return SETTLED_STATUS.includes(pay.status)
      ? { action: 'alert', reason: 'AMOUNT_MISMATCH' }
      : { action: 'mismatch', reason: 'AMOUNT_MISMATCH' };
  }
  return { action: 'apply' };
}

/**
 * 고객 공개 견적서(quotes.payment.{kind})에 둘 요약 (검수 L8)
 * 금액·상태·시각만. orderId·paymentKey·영수증 URL·결제수단은 payments(사장님만 읽기)에만 둔다.
 */
export function quotePaymentSummary({ amount, status, paidAt = null, refundedAmount = 0, canceledAt = null }) {
  const out = { amount: toWon(amount) ?? 0, status, paidAt: paidAt || null, refundedAmount: toWon(refundedAmount) ?? 0 };
  if (canceledAt) out.canceledAt = canceledAt;
  return out;
}

/** 환불 기준일: 사장님이 확정한 작업일(booking.date) 우선, 없으면 고객 희망일(service.date) */
export function pickServiceDate(quote) {
  const d = quote?.booking?.date || quote?.service?.date || null;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** 환불 규칙 정리: 형식이 맞는 줄만 남긴다. 하나도 없으면 null */
export function normalizeRefundRules(rules) {
  if (!Array.isArray(rules)) return null;
  const pct = (v) => Math.min(100, Math.max(0, Math.round(Number(v))));
  const out = [];
  for (const r of rules) {
    if (r?.type === 'withinDaysOfPayment') {
      if (Number.isInteger(r.days) && r.days > 0 && Number.isFinite(Number(r.pct))) {
        out.push({ type: 'withinDaysOfPayment', days: r.days, pct: pct(r.pct) });
      }
    } else if (Number.isInteger(r?.daysBefore) && r.daysBefore >= 0 && Number.isFinite(Number(r?.pct))) {
      out.push({ daysBefore: r.daysBefore, pct: pct(r.pct) });
    }
  }
  return out.length ? out : null;
}

/**
 * 업체 환불 규칙으로 환불 금액 계산.
 * rules 예: [{ daysBefore: 3, pct: 100 }, { daysBefore: 1, pct: 50 }, { daysBefore: 0, pct: 0 }]
 *   → 작업일 3일 전까지 100%, 1~2일 전 50%, 당일 0%
 *   + { type: 'withinDaysOfPayment', days: 7, pct: 100 } → 결제 후 7일 이내 & 작업일 전이면 100% (청약철회 안전안)
 *   여러 줄이 해당되면 고객에게 유리한(큰) 비율.
 * ★ 이 계산은 "고객이 결제 때 본 규칙 스냅샷"(payments.refundRules)으로만 한다 (검수 M13).
 * @param paid         실제 결제된 금액
 * @param rules        규칙 (없으면 null 반환 → 사장님 직접 입력)
 * @param serviceDate  'YYYY-MM-DD' 작업일
 * @param opts.paidAt  결제 시각 (withinDaysOfPayment 용)
 * @returns { amount, pct, daysBefore, rule } | null
 */
export function refundByRules(paid, rules, serviceDate, now = new Date(), opts = {}) {
  const list = normalizeRefundRules(rules);
  if (!list || !serviceDate) return null;
  const days = daysBetween(kstDateStr(now), serviceDate);
  if (days == null) return null;
  let best = { pct: 0, rule: 'none' };
  if (days >= 0) {
    const sorted = list.filter((r) => r.type == null).sort((a, b) => b.daysBefore - a.daysBefore);
    const r = sorted.find((x) => days >= x.daysBefore);
    if (r) best = { pct: r.pct, rule: 'daysBefore' };
    const paidAt = opts.paidAt ? new Date(opts.paidAt) : null;
    if (days > 0 && paidAt && !Number.isNaN(paidAt.getTime())) {
      const since = daysBetween(kstDateStr(paidAt), kstDateStr(now));
      for (const w of list.filter((x) => x.type === 'withinDaysOfPayment')) {
        if (since != null && since <= w.days && w.pct > best.pct) best = { pct: w.pct, rule: 'withinDaysOfPayment' };
      }
    }
  }
  return { amount: Math.floor((toWon(paid) * best.pct) / 100), pct: best.pct, daysBefore: days, rule: best.rule };
}

/** 규칙 → 고객에게 보여줄 문장 (결제 전 고지용). js/payment.js describeRefundRules 와 같은 문장 */
export function describeRefundRules(rules) {
  const list = normalizeRefundRules(rules);
  if (!list) return '';
  const within = list.filter((r) => r.type === 'withinDaysOfPayment')
    .map((r) => `결제 후 ${r.days}일 이내(작업일 전) 취소: 계약금 ${r.pct}% 환불`);
  const before = list.filter((r) => r.type == null).sort((a, b) => b.daysBefore - a.daysBefore)
    .map((r) => `${r.daysBefore === 0 ? '작업 당일' : `작업 ${r.daysBefore}일 전까지`} 취소: 계약금 ${r.pct}% 환불`);
  return [...within, ...before].join('\n');
}

/** 이미 환불된 금액을 빼고 이번에 환불 가능한 금액 */
export function refundable(payment) {
  return Math.max(0, toWon(payment?.amount ?? 0) - toWon(payment?.refundedAmount ?? 0));
}

function daysBetween(fromStr, toStr) {
  const a = Date.parse(`${fromStr}T00:00:00Z`);
  const b = Date.parse(`${toStr}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function toWon(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function fail(code, message) { return { ok: false, code, message }; }
