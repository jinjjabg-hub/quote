// 결제 금액·상태 규칙 (순수 함수: Firebase·네트워크 의존 없음 → node --test 로 바로 검증)
//
// 원칙
// - 결제 금액은 "항상 서버가 quotes 문서로 다시 계산"한다. 브라우저가 보낸 금액은 비교용일 뿐 믿지 않는다.
// - 환불 금액은 업체가 정한 규칙(refundRules)으로 계산한다. 규칙이 없으면 사장님이 직접 입력해야 한다.

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

/** 결제 전에 고객이 반드시 체크해야 하는 동의 항목 */
export const REQUIRED_AGREEMENTS = ['cancelPolicy', 'terms', 'privacy'];
export function checkAgreements(agreements) {
  const missing = REQUIRED_AGREEMENTS.filter((k) => agreements?.[k] !== true);
  return missing.length ? { ok: false, missing } : { ok: true };
}

/**
 * 업체 환불 규칙으로 환불 금액 계산.
 * rules 예: [{ daysBefore: 3, pct: 100 }, { daysBefore: 1, pct: 50 }, { daysBefore: 0, pct: 0 }]
 *   → 작업일 3일 전까지 100%, 1~2일 전 50%, 당일 0%
 * @param paid         실제 결제된 금액
 * @param rules        업체 규칙 (없으면 null 반환 → 사장님 직접 입력)
 * @param serviceDate  'YYYY-MM-DD' 작업일
 * @returns { amount, pct, daysBefore } | null
 */
export function refundByRules(paid, rules, serviceDate, now = new Date()) {
  if (!Array.isArray(rules) || !rules.length || !serviceDate) return null;
  const days = daysBetween(kstDateStr(now), serviceDate);
  if (days == null) return null;
  const sorted = [...rules]
    .filter((r) => Number.isFinite(r?.daysBefore) && Number.isFinite(r?.pct))
    .sort((a, b) => b.daysBefore - a.daysBefore);
  const rule = days < 0 ? null : sorted.find((r) => days >= r.daysBefore);
  const pct = rule ? Math.min(100, Math.max(0, rule.pct)) : 0;
  return { amount: Math.floor((toWon(paid) * pct) / 100), pct, daysBefore: days };
}

/** 규칙 → 고객에게 보여줄 문장 (결제 전 고지용) */
export function describeRefundRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return '';
  return [...rules].sort((a, b) => b.daysBefore - a.daysBefore)
    .map((r) => `${r.daysBefore === 0 ? '작업 당일' : `작업 ${r.daysBefore}일 전까지`} 취소: 계약금 ${r.pct}% 환불`)
    .join('\n');
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
