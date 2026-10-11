// 계약금 온라인 결제 (고객용) — 토스페이먼츠 결제창 SDK v2, 테스트 모드 골격
//
// 흐름: [계약금 결제] → 취소·환불 규정 + (맞춤제작 별도 고지) + 약관 동의 → 서버 preparePayment(금액은 서버가 quotes 로 계산)
//       → 토스 결제창 → pay-success.html → 서버 confirmPayment(금액 대조 후 승인) → 견적서 상태 '계약금완료'
//
// 이 파일은 금액을 정하지 않는다. 화면에 보이는 금액은 안내용이고, 실제 결제 금액은 서버 응답값만 쓴다.
// 카드번호 등 결제수단 정보는 이 앱을 거치지 않는다(토스 결제창이 직접 받음).
//
// ★ 아래 CUSTOM_MADE_NOTICE·canonicalJson·quoteSnapshot·describeRefundRules·legalLinksReady 는
//   functions/lib (consent.js, snapshot.js, rules.js) 와 같아야 한다. functions/test 가 두 구현을 비교한다.
import { paymentConfig as PC, appConfig as AC } from './config.js';
import { formatWon } from './calc.js';
import { $, h, toast, pageUrl } from './util.js';

// 맞춤제작(커튼·중문) 청약철회 제한 — 별도 박스 + 별도 체크(기본 해제). 원문: docs/legal/cancel-policies.md §3 (custommade-v1)
export const CUSTOM_MADE_NOTICE = {
  version: 'custommade-v1',
  title: '맞춤 제작 상품 취소 안내 (꼭 읽어 주세요)',
  body: '이 상품은 고객님 현장 치수에 맞춰 개별 제작하므로 다른 곳에 다시 쓸 수 없습니다.\n'
    + '· 제작은 방문 실측 후 확정 견적서를 보내드리고, 고객님이 동의하신 뒤에만 시작합니다.\n'
    + '· 제작 시작 전: 언제 취소하셔도 계약금 전액을 돌려드립니다.\n'
    + '· 제작 시작 후: 단순 변심에 의한 청약철회는 제한됩니다. 그래도 취소하시면 이미 들어간 자재·제작 비용을 발주서·영수증으로 보여드리고, 그 금액을 계약금에서 뺀 나머지를 돌려드립니다.\n'
    + '· 제품 하자, 확정 견적서와 다르게 만들어진 경우, 업체가 잰 치수가 틀린 경우에는 이 제한과 관계없이 다시 만들어 드리거나 환불합니다.',
  checkbox: '(필수) 맞춤 제작 상품은 제작 시작 후 단순 변심에 의한 청약철회가 제한된다는 위 안내를 따로 확인했고, 이에 동의합니다.',
};

/** 약관·처리방침 링크 (paymentConfig 우선, 없으면 appConfig) */
function legalUrls() {
  return {
    termsUrl: String(PC?.termsUrl || AC?.termsUrl || '').trim(),
    privacyUrl: String(PC?.privacyUrl || AC?.privacyUrl || '').trim(),
  };
}

/** 둘 다 있어야 결제를 연다 (검수 S4①). https 주소 또는 같은 사이트 상대경로 */
export function legalLinksReady({ termsUrl, privacyUrl } = {}) {
  const ok = (u) => typeof u === 'string' && /^(https?:\/\/|\.{0,2}\/|[A-Za-z0-9_-]+\.html)\S*$/.test(u.trim());
  return ok(termsUrl) && ok(privacyUrl);
}

const DONE_LABEL = {
  paid_deposit: '계약금 결제 완료 ✓',
  confirmed: '예약 확정 ✓',
  done: '작업 완료 ✓',
  paid_full: '결제 완료 ✓',
  canceled: '취소된 예약입니다',
};

/**
 * 결제 버튼을 보여줄 조건: 설정 켜짐 + 서버 주소 + 약관·처리방침 링크 둘 다 있음(S4) + 계약금 > 0
 * + 업체 취소 규정 있음(결제 전 고지 의무). false 면 view.js 가 기존 "예약 요청" 버튼을 보여준다.
 */
export function paymentEnabled(quote) {
  return !!(PC?.enabled && PC.provider === 'toss' && apiBase() && legalLinksReady(legalUrls())
    && Number(quote?.deposit) > 0 && String(quote?.cancelPolicy || '').trim());
}

/**
 * 결제가 켜져 있는데 약관 준비가 안 돼 예약 요청으로 돌린 경우의 안내 한 줄 (view.js 가 예약 버튼 위에 붙임).
 * 해당 없으면 null.
 */
export function paymentPendingNote(quote) {
  if (!PC?.enabled || paymentEnabled(quote) || !(Number(quote?.deposit) > 0)) return null;
  return h('p.muted.small', {}, '온라인 결제 준비 중이에요. 예약 요청을 남기시면 사장님이 계약금 안내를 드려요.');
}

// ───────── 견적 스냅샷 해시 (M9) — functions/lib/snapshot.js 와 같은 알고리즘 ─────────
export const SNAPSHOT_FIELDS = [
  'number', 'lines', 'total', 'deposit', 'depositPct',
  'conditions', 'included', 'excluded', 'cancelPolicy', 'refundRules',
];

export function canonicalJson(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x) ?? 'null').join(',')}]`;
  if (typeof v.toDate === 'function') return JSON.stringify(v.toDate().toISOString());
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

export function quoteSnapshot(quote = {}) {
  const q = quote || {};
  const snap = {};
  for (const k of SNAPSHOT_FIELDS) snap[k] = q[k] === undefined ? null : q[k];
  return snap;
}

/** 고객이 보고 있는 견적의 SHA-256 (브라우저 crypto.subtle 이 없으면 null → 서버 해시만 기록) */
export async function quoteSnapshotHash(quote) {
  try {
    const c = globalThis.crypto?.subtle;
    if (!c) return null;
    const buf = await c.digest('SHA-256', new TextEncoder().encode(canonicalJson(quoteSnapshot(quote))));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** 환불 계산 규칙 → 문장 (functions/lib/rules.js describeRefundRules 와 같은 문장) */
export function describeRefundRules(rules) {
  if (!Array.isArray(rules)) return '';
  const pct = (v) => Math.min(100, Math.max(0, Math.round(Number(v))));
  const within = [];
  const before = [];
  for (const r of rules) {
    if (r?.type === 'withinDaysOfPayment') {
      if (Number.isInteger(r.days) && r.days > 0 && Number.isFinite(Number(r.pct))) within.push({ days: r.days, pct: pct(r.pct) });
    } else if (Number.isInteger(r?.daysBefore) && r.daysBefore >= 0 && Number.isFinite(Number(r?.pct))) {
      before.push({ daysBefore: r.daysBefore, pct: pct(r.pct) });
    }
  }
  return [
    ...within.map((r) => `결제 후 ${r.days}일 이내(작업일 전) 취소: 계약금 ${r.pct}% 환불`),
    ...before.sort((a, b) => b.daysBefore - a.daysBefore)
      .map((r) => `${r.daysBefore === 0 ? '작업 당일' : `작업 ${r.daysBefore}일 전까지`} 취소: 계약금 ${r.pct}% 환불`),
  ].join('\n');
}

/** view.js bookingButton 대신 쓰는 계약금 결제 버튼 */
export function payButton(quote, quoteId, expired) {
  if (DONE_LABEL[quote.status]) return h('button.btn.primary', { disabled: true }, DONE_LABEL[quote.status]);
  if (expired) return h('button.btn.primary', { disabled: true }, '유효기간이 지났어요 · 전화 문의');
  if (!['sent', 'booking_requested'].includes(quote.status)) {
    return h('button.btn.primary', { disabled: true }, '업체 확인 중 · 전화 문의');
  }
  return h('button.btn.primary', { onclick: () => openPayDialog(quote, quoteId) },
    `계약금 ${formatWon(quote.deposit)} 결제하고 예약하기`);
}

function openPayDialog(quote, quoteId) {
  const customMade = quote?.service?.customMade === true;
  const { termsUrl, privacyUrl } = legalUrls();
  const checks = {
    cancelPolicy: h('input', { type: 'checkbox' }),
    ...(customMade ? { customMade: h('input', { type: 'checkbox' }) } : {}), // 기본 해제, 별도 체크 (S4②)
    terms: h('input', { type: 'checkbox' }),
    privacy: h('input', { type: 'checkbox' }),
  };
  const payBtn = h('button.btn.primary', { disabled: true }, `${formatWon(quote.deposit)} 결제하기`);
  const sync = () => { payBtn.disabled = !Object.values(checks).every((c) => c.checked); };
  Object.values(checks).forEach((c) => c.addEventListener('change', sync));

  const agreeRow = (input, text, url) => h('label.field', { style: 'display:flex;gap:8px;align-items:flex-start;margin:10px 0' },
    input,
    h('span', {}, text, ' ',
      url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, '보기') : null));

  const rulesText = describeRefundRules(quote.refundRules);
  const shopName = quote.shop?.name || '업체';
  const dlg = h('dialog.sheet', {},
    PC.mode !== 'live' ? h('div.warn-box', {}, '테스트 결제입니다. 실제 돈이 나가지 않아요.') : null,
    h('h2', {}, '계약금 결제'),
    h('dl.kv', {},
      h('dt', {}, '견적 합계'), h('dd', {}, formatWon(quote.total)),
      h('dt', {}, `계약금 ${quote.depositPct || 0}%`), h('dd', {}, h('b', {}, formatWon(quote.deposit))),
      h('dt', {}, '잔금'), h('dd', {}, `${formatWon(Number(quote.total) - Number(quote.deposit))} (작업 완료 후)`)),
    h('h3', {}, '취소·환불 규정'),
    h('p.msg', {}, quote.cancelPolicy),
    // 환불 계산 규칙이 있으면 고객에게도 같은 문장을 보여준다 (사장님 환불 계산 근거와 일치, M13)
    rulesText ? h('p.msg', { style: 'white-space:pre-line' }, rulesText) : null,
    h('p.muted.small', {},
      '현장 추가금은 견적서의 ⚠️조건에 해당할 때만 발생하며, 사장님이 사유와 금액을 보여드리고 고객님이 승인한 뒤에만 청구됩니다.'),
    agreeRow(checks.cancelPolicy, "[필수] 견적서의 '추가요금 조건'과 위 '취소·환불 규정'을 확인했어요."),
    customMade ? h('div.warn-box', { style: 'margin:12px 0' },
      h('b', {}, CUSTOM_MADE_NOTICE.title),
      h('p', { style: 'white-space:pre-line;margin:6px 0 0' }, CUSTOM_MADE_NOTICE.body),
      agreeRow(checks.customMade, CUSTOM_MADE_NOTICE.checkbox)) : null,
    agreeRow(checks.terms, '[필수] 이용약관에 동의합니다.', termsUrl),
    // 결제대행사는 업체가 직접 맡긴 처리위탁 수탁자 (제3자 제공 아님 — legal privacy-policy A-6, 검수 M12)
    agreeRow(checks.privacy, '[필수] 개인정보 수집·이용에 동의해요. (결제 처리는 업체가 맡긴 결제대행사에 위탁돼요)', privacyUrl),
    h('p.muted.small', { style: 'white-space:pre-line' },
      `· 계약 상대는 ${shopName}이에요. 계약금은 ${shopName}에게 결제돼요.\n`
      + `· 결제는 ${shopName}이 계약한 결제대행사가 처리하며, 카드번호는 ${shopName}·T.M LINK에 저장되지 않아요.\n`
      + '· 결제가 완료되면 예약(계약)이 확정돼요.'),
    h('div.btn-col', {},
      payBtn,
      h('button.btn.ghost', { onclick: () => dlg.close() }, '닫기')));

  payBtn.addEventListener('click', async () => {
    payBtn.disabled = true;
    try {
      const agreements = Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.checked]));
      await startPayment(quote, quoteId, agreements);
    } catch (e) {
      // 고객이 결제창을 닫은 경우(USER_CANCEL)는 조용히 안내
      toast(e?.code === 'USER_CANCEL' ? '결제를 취소했어요.' : (e?.message || '결제를 시작하지 못했어요. 전화로 문의해주세요.'), 4000);
      sync();
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

async function startPayment(quote, quoteId, agreements) {
  // 1) 서버가 금액을 계산하고 주문(orderId)을 만든다. 동의 내역도 여기서 서버에 기록된다.
  //    고객이 보고 있는 견적의 해시를 함께 보내 "본 화면 = 서버 스냅샷"을 증거로 남긴다 (M9)
  const order = await api('preparePayment', {
    quoteId, kind: 'deposit', agreements, termsVersion: PC.termsVersion,
    quoteSnapshotHash: await quoteSnapshotHash(quote),
    customMadeNoticeVersion: agreements.customMade ? CUSTOM_MADE_NOTICE.version : undefined,
  });
  // 2) 토스 결제창. 금액은 서버 응답값만 사용한다.
  const TossPayments = await loadSdk();
  const tp = TossPayments(order.clientKey || PC.clientKey);
  const payment = tp.payment({ customerKey: TossPayments.ANONYMOUS });
  await payment.requestPayment({
    method: 'CARD', // 계좌이체·가상계좌는 서버 웹훅(DEPOSIT_CALLBACK)까지 검증 후 추가
    amount: { currency: 'KRW', value: order.amount },
    orderId: order.orderId,
    orderName: order.orderName,
    customerName: order.customerName || undefined,
    successUrl: pageUrl('pay-success.html', { quoteId }),
    failUrl: pageUrl('pay-fail.html', { quoteId }),
  });
}

// ───────── pay-success.html ─────────
export async function handleSuccessPage() {
  const app = $('#app');
  const p = new URLSearchParams(location.search);
  const quoteId = p.get('quoteId');
  const back = () => (quoteId ? h('a.btn.primary', { href: pageUrl('view.html', { id: quoteId }) }, '견적서로 돌아가기') : null);
  app.replaceChildren(h('div.card.done', {}, h('p', {}, '결제를 확인하고 있어요… 이 화면을 닫지 마세요.')));
  try {
    const r = await api('confirmPayment', {
      paymentKey: p.get('paymentKey'), orderId: p.get('orderId'), amount: p.get('amount'),
    });
    if (r.status === 'waiting_deposit') {
      const va = r.virtualAccount || {};
      app.replaceChildren(h('div.card.done', {},
        h('h1', {}, '입금을 기다리고 있어요'),
        h('p', {}, `${va.accountNumber || ''} 계좌로 ${va.dueDate ? `${va.dueDate.slice(0, 16).replace('T', ' ')}까지` : ''} 입금하시면 예약이 확정됩니다.`),
        back()));
      return;
    }
    app.replaceChildren(h('div.card.done', {},
      h('div.done-icon', {}, '✓'),
      h('h1', {}, '계약금 결제 완료'),
      h('p', {}, '예약이 접수되었어요. 사장님이 일정 확인 후 연락드립니다.'),
      r.receiptUrl ? h('p', {}, h('a', { href: r.receiptUrl, target: '_blank', rel: 'noopener' }, '영수증 보기')) : null,
      back()));
  } catch (e) {
    app.replaceChildren(h('div.card.error', {},
      h('h2', {}, '결제를 완료하지 못했어요'),
      h('p', {}, e.message || '잠시 후 다시 시도해주세요.'),
      h('p.muted.small', {}, '카드 승인 문자가 왔는데 이 화면이 보이면, 결제는 자동으로 확인되거나 취소됩니다. 걱정되시면 업체에 전화해주세요.'),
      back()));
  }
}

// ───────── pay-fail.html ─────────
export function handleFailPage() {
  const p = new URLSearchParams(location.search);
  const quoteId = p.get('quoteId');
  const canceled = p.get('code') === 'PAY_PROCESS_CANCELED' || p.get('code') === 'USER_CANCEL';
  $('#app').replaceChildren(h('div.card.error', {},
    h('h2', {}, canceled ? '결제를 취소했어요' : '결제에 실패했어요'),
    canceled ? null : h('p', {}, p.get('message') || ''),
    canceled ? null : h('p.muted.small', {}, `오류 코드: ${p.get('code') || '-'}`),
    h('p.muted.small', {}, '결제되지 않았으니 안심하세요. 다시 시도하거나 업체에 전화해주세요.'),
    quoteId ? h('a.btn.primary', { href: pageUrl('view.html', { id: quoteId }) }, '견적서로 돌아가기') : null));
}

// ───────── 내부 ─────────
function apiBase() {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  let emu = false;
  try { emu = isLocal && localStorage.getItem('emulator') === '1'; } catch { /* 무시 */ }
  if (emu) return 'http://127.0.0.1:5001/demo-quote/asia-northeast3';
  return String(PC?.functionsBaseUrl || '').replace(/\/$/, '');
}

async function api(name, body) {
  let res;
  try {
    res = await fetch(`${apiBase()}/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('서버에 연결하지 못했어요. 인터넷 연결을 확인해주세요.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.message || `오류 (${res.status})`);
  return json;
}

let sdkPromise;
function loadSdk() {
  if (window.TossPayments) return Promise.resolve(window.TossPayments);
  sdkPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PC.sdkUrl;
    s.onload = () => (window.TossPayments ? resolve(window.TossPayments) : reject(new Error('결제 모듈을 불러오지 못했어요.')));
    s.onerror = () => { sdkPromise = null; reject(new Error('결제 모듈을 불러오지 못했어요.')); };
    document.head.append(s);
  });
  return sdkPromise;
}
