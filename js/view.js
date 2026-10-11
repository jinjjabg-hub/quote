// 견적서 화면 (view.html?id=견적ID) — 고객용, 로그인 없음
// 견적 ID 자체가 추측 불가능한 열쇠 역할을 한다. (Firestore 규칙: 단건 get 만 허용)
import { db, doc, getDoc, writeBatch, serverTimestamp, isConfigured } from './firebase.js';
import { formatWon, toDateStr, maxTotal } from './calc.js';
import { legalUrl } from './config.js';
import { $, h, toast, registerSW, showFatal, telHref } from './util.js';
import { paymentEnabled, payButton, paymentPendingNote, describeRefundRules } from './payment.js';

registerSW();

const quoteId = new URLSearchParams(location.search).get('id');
const app = $('#app');
// 화면 교체 (null·false 자식은 건너뜀 — 기본 replaceChildren 은 null 을 글자로 그린다)
const show = (...nodes) => app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
let quote;

init().catch((e) => showFatal(e.message));

async function init() {
  if (!isConfigured) throw new Error('Firebase 설정이 아직 없습니다.');
  if (!quoteId || !/^[A-Za-z0-9]{10,40}$/.test(quoteId)) throw new Error('견적서 링크가 올바르지 않습니다.');
  const snap = await getDoc(doc(db, 'quotes', quoteId));
  if (!snap.exists()) throw new Error('견적서를 찾을 수 없습니다. 업체에 문의해주세요.');
  quote = snap.data();
  document.title = `${quote.shop?.name || ''} 견적서 ${quote.number || ''}`;
  render();
}

function render() {
  const q = quote;
  const expired = q.validUntil && toDateStr(new Date()) > q.validUntil;
  const lines = q.lines || [];
  const conds = q.conditions || [];
  const max = maxTotal(q.total, conds);
  const refundText = describeRefundRules(q.refundRules);
  show(
    h('header.quote-head', {},
      q.shop?.logoUrl ? h('img.logo', { src: q.shop.logoUrl, alt: '' }) : null,
      h('div', {},
        h('div.shop-name', {}, q.shop?.name || '', q.shop?.bizVerified ? h('span.badge.st-ok', { title: '사업자등록 상태를 확인한 업체입니다' }, '사업자 인증') : null),
        h('div.muted.small', {}, [q.shop?.ownerName && `대표 ${q.shop.ownerName}`, q.shop?.bizNo && `사업자 ${q.shop.bizNo}`].filter(Boolean).join(' · ')))),

    h('section.card', {},
      h('div.quote-title', {},
        h('h1', {}, `${q.templateName || ''} 견적서`),
        q.verified ? h('span.badge.verified', { title: '사진과 추가요금 체크리스트를 확인하고 낸 견적입니다' }, '📷 사진 확인 완료 견적') : null),
      h('dl.kv', {},
        h('dt', {}, '견적 번호'), h('dd', {}, q.number || ''),
        h('dt', {}, '고객'), h('dd', {}, `${q.customer?.name || ''}님 · ${q.customer?.region || ''}`),
        q.service?.date ? [h('dt', {}, '작업 희망일'), h('dd', {}, `${q.service.date} ${q.service.timeSlot || ''}`)] : null,
        q.service?.summary ? [h('dt', {}, '내용'), h('dd', {}, q.service.summary)] : null,
        h('dt', {}, '유효기간'), h(`dd${expired ? '.risk' : ''}`, {}, `${q.validUntil || ''}까지${expired ? ' (만료)' : ''}`))),

    h('section.card', {},
      h('h2', {}, '금액 내역'),
      h('table.lines-table', {}, h('tbody', {}, lines.map((l) => h('tr', {},
        h('td', {}, l.label, l.note ? h('div.muted.small', {}, l.note) : null),
        h('td.num', {}, formatWon(l.amount)))))),
      h('div.total-box', {},
        h('div', {}, '합계', h('b', {}, formatWon(q.total))),
        h('div.muted', {}, `계약금 ${q.depositPct || 0}%`, h('span', {}, formatWon(q.deposit)))),
      priceNote(q, conds, max)),
    section('✅ 포함 항목', q.included, 'ok'),
    section('❌ 불포함 항목', q.excluded, 'no'),
    conds.length ? h('section.card.cond', {},
      h('h2', {}, '⚠️ 추가요금 조건'),
      h('p.muted.small', {}, '아래 항목만 추가돼요. 해당되면 작업 전에 사진과 금액을 보여드려요.\n고르실 수 있는 작업은 동의하지 않으시면 빼고 진행해요.'),
      h('p.muted.small', {}, '아래 조건과 맞춤 제작의 실측 확정 외에는 현장에서 추가요금을 받지 않아요.\n'
        + '고르실 수 있는 작업은 작업 전에 금액을 알려드리고 동의하실 때만 해요.\n'
        + '입력하신 정보(면적·대수 등)가 실제와 다르면 같은 단가표로 다시 계산해 작업 전에 알려드려요.'),
      h('ul', {}, conds.map((c) => h('li', {}, h('b', {}, c.label),
        Number(c.amount) > 0 ? h('span.cond-amount', {}, ` +${formatWon(c.amount)}`) : null,
        c.text ? ` — ${c.text}` : '')))) : null,
    q.cancelPolicy || refundText ? h('section.card', {}, h('h2', {}, '취소 규정'),
      h('p.muted.small', {}, '법령이 이 규정보다 고객에게 유리하면 법령을 따라요.'),
      q.cancelPolicy ? h('p', {}, q.cancelPolicy) : null,
      refundText ? h('div.refund-rules', {}, h('b', {}, '환불 계산'), h('p', {}, refundText)) : null) : null,

    paymentPendingNote(quote), // null 이면 생략
    h('div.sticky-actions', {},
      q.shop?.phone ? h('a.btn.ghost', { href: telHref(q.shop.phone) }, '📞 전화') : null,
      bookingButton(expired)),
    h('footer.legal-foot.muted.small', {},
      h('div', {}, `이 견적은 ${q.shop?.name || '업체'}의 가격표로 계산되고 사장님이 확인하여 발송했어요.`),
      h('div', {}, [q.shop?.name, q.shop?.ownerName && `대표 ${q.shop.ownerName}`, q.shop?.bizNo && `사업자 ${q.shop.bizNo}`, q.shop?.phone].filter(Boolean).join(' · ')),
      h('div', {}, '이 견적서는 T.M LINK 견적 프로그램으로 작성되었어요.'),
      h('div', {},
        legalUrl('termsUrl') ? h('a', { href: legalUrl('termsUrl'), target: '_blank', rel: 'noopener' }, '이용 안내') : null, ' ',
        legalUrl('privacyUrl') ? h('a', { href: legalUrl('privacyUrl'), target: '_blank', rel: 'noopener' }, '개인정보처리방침') : null)),
  );
}

/** 금액 아래 안내 (legal copy-snippets §4): 가견적 / 확정 / 예상(+최대 금액) */
function priceNote(q, conds, max) {
  if (q.service?.customMade) {
    return h('p.muted.small', {}, '치수·사진으로 계산한 가견적이에요. 방문 실측 후 확정 견적서를 다시 보내드리고, 동의하신 뒤에만 제작을 시작해요.');
  }
  if (q.verified) return h('p.muted.small', {}, '사진과 체크 항목을 확인한 확정 견적이에요. 아래 \'추가요금 조건\' 외에는 금액이 바뀌지 않아요.');
  const allPriced = conds.length > 0 && conds.every((c) => Number(c.amount) > 0);
  return h('div', {},
    allPriced && max > (Number(q.total) || 0)
      ? h('div.max-box', {}, h('div', {}, '최대 금액', h('b', {}, formatWon(max)))) : null,
    h('p.muted.small', {}, allPriced && max > (Number(q.total) || 0)
      ? `확인되지 않은 항목이 있는 예상 견적이에요.\n현장에서 아래 조건이 확인될 때만 금액이 늘어나며, 최대 ${formatWon(max)}을 넘지 않아요.`
      : `확인되지 않은 항목이 있는 예상 견적이에요.${conds.length ? '\n현장에서 아래 조건이 확인될 때만 금액이 늘어나요.' : ''}`));
}

function section(title, items, cls) {
  if (!items?.length) return null;
  return h(`section.card.list-${cls}`, {}, h('h2', {}, title), h('ul', {}, items.map((t) => h('li', {}, t))));
}

function bookingButton(expired) {
  // 온라인 결제가 켜져 있으면(js/config.js paymentConfig) 계약금 결제 버튼, 아니면 기존 예약 요청
  if (paymentEnabled(quote)) return payButton(quote, quoteId, expired);
  if (['booking_requested', 'confirmed', 'paid_deposit', 'done', 'paid_full'].includes(quote.status)) {
    return h('button.btn.primary', { disabled: true }, '예약 요청 완료 ✓');
  }
  if (expired) return h('button.btn.primary', { disabled: true }, '유효기간이 지났어요 · 전화 문의');
  return h('button.btn.primary', {
    onclick: async (e) => {
      if (!confirm('이 견적으로 예약을 요청할까요?\n사장님이 확인 후 연락드립니다.')) return;
      e.target.disabled = true;
      try {
        const batch = writeBatch(db);
        const patch = { status: 'booking_requested', bookingRequestedAt: serverTimestamp() };
        batch.update(doc(db, 'quotes', quoteId), patch);
        batch.update(doc(db, 'requests', quote.requestId), patch);
        await batch.commit();
        quote.status = 'booking_requested';
        render();
        toast('예약 요청을 보냈어요. 사장님이 곧 연락드립니다.', 3500);
      } catch (err) {
        console.error(err);
        toast('요청에 실패했어요. 전화로 문의해주세요.', 4000);
        e.target.disabled = false;
      }
    },
  }, '이 견적으로 예약 요청');
}
