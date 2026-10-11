// 계약금 온라인 결제 (고객용) — 토스페이먼츠 결제창 SDK v2, 테스트 모드 골격
//
// 흐름: [계약금 결제] → 취소·환불 규정 + 약관 동의 → 서버 preparePayment(금액은 서버가 quotes 로 계산)
//       → 토스 결제창 → pay-success.html → 서버 confirmPayment(금액 대조 후 승인) → 견적서 상태 '계약금완료'
//
// 이 파일은 금액을 정하지 않는다. 화면에 보이는 금액은 안내용이고, 실제 결제 금액은 서버 응답값만 쓴다.
// 카드번호 등 결제수단 정보는 이 앱을 거치지 않는다(토스 결제창이 직접 받음).
import { paymentConfig as PC } from './config.js';
import { formatWon } from './calc.js';
import { $, h, toast, pageUrl } from './util.js';

const DONE_LABEL = {
  paid_deposit: '계약금 결제 완료 ✓',
  confirmed: '예약 확정 ✓',
  done: '작업 완료 ✓',
  paid_full: '결제 완료 ✓',
  canceled: '취소된 예약입니다',
};

/** 결제 버튼을 보여줄 조건: 설정 켜짐 + 서버 주소 + 계약금 > 0 + 업체 취소 규정 있음(결제 전 고지 의무) */
export function paymentEnabled(quote) {
  return !!(PC?.enabled && PC.provider === 'toss' && apiBase()
    && Number(quote?.deposit) > 0 && String(quote?.cancelPolicy || '').trim());
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
  const checks = {
    cancelPolicy: h('input', { type: 'checkbox' }),
    terms: h('input', { type: 'checkbox' }),
    privacy: h('input', { type: 'checkbox' }),
  };
  const payBtn = h('button.btn.primary', { disabled: true }, `${formatWon(quote.deposit)} 결제하기`);
  const sync = () => { payBtn.disabled = !Object.values(checks).every((c) => c.checked); };
  Object.values(checks).forEach((c) => c.addEventListener('change', sync));

  const agreeRow = (input, text, url) => h('label.field', { style: 'display:flex;gap:8px;align-items:flex-start;margin:10px 0' },
    input,
    h('span', {}, text, ' ',
      url === undefined ? null // 링크가 필요 없는 항목(취소 규정은 바로 위에 원문 표시)
        : url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, '보기')
          : h('span.muted.small', {}, '(문구 준비 중)')));

  const dlg = h('dialog.sheet', {},
    PC.mode !== 'live' ? h('div.warn-box', {}, '테스트 결제입니다. 실제 돈이 나가지 않아요.') : null,
    h('h2', {}, '계약금 결제'),
    h('dl.kv', {},
      h('dt', {}, '견적 합계'), h('dd', {}, formatWon(quote.total)),
      h('dt', {}, `계약금 ${quote.depositPct || 0}%`), h('dd', {}, h('b', {}, formatWon(quote.deposit))),
      h('dt', {}, '잔금'), h('dd', {}, `${formatWon(Number(quote.total) - Number(quote.deposit))} (작업 완료 후)`)),
    h('h3', {}, '취소·환불 규정'),
    h('p.msg', {}, quote.cancelPolicy),
    h('p.muted.small', {},
      '현장 추가금은 견적서의 ⚠️조건에 해당할 때만 발생하며, 사장님이 사유와 금액을 보여드리고 고객님이 승인한 뒤에만 청구됩니다.'),
    agreeRow(checks.cancelPolicy, '[필수] 위 취소·환불 규정을 확인했습니다.'),
    agreeRow(checks.terms, '[필수] 이용약관에 동의합니다.', PC.termsUrl),
    agreeRow(checks.privacy, '[필수] 개인정보 수집·이용 및 결제대행사(토스페이먼츠) 제공에 동의합니다.', PC.privacyUrl),
    h('p.muted.small', {}, `결제는 토스페이먼츠 결제창에서 진행되며 카드 정보는 이 앱에 저장되지 않습니다. 결제 대금은 ${quote.shop?.name || '업체'}에 지급됩니다.`),
    h('div.btn-col', {},
      payBtn,
      h('button.btn.ghost', { onclick: () => dlg.close() }, '닫기')));

  payBtn.addEventListener('click', async () => {
    payBtn.disabled = true;
    try {
      await startPayment(quote, quoteId, {
        cancelPolicy: checks.cancelPolicy.checked, terms: checks.terms.checked, privacy: checks.privacy.checked,
      });
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
  const order = await api('preparePayment', { quoteId, kind: 'deposit', agreements, termsVersion: PC.termsVersion });
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
