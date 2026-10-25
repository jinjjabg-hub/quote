// 견적서 화면 (view.html?id=견적ID) — 고객용, 로그인 없음
// 견적 ID 자체가 추측 불가능한 열쇠 역할을 한다. (Firestore 규칙: 단건 get 만 허용)
import { db, doc, getDoc, writeBatch, serverTimestamp, isConfigured } from './firebase.js';
import { formatWon, toDateStr } from './calc.js';
import { $, h, toast, registerSW, showFatal, telHref, manduHref, setChildren, icon, footerNote } from './util.js';
import { appConfig } from './config.js';

registerSW();

const quoteId = new URLSearchParams(location.search).get('id');
const app = $('#app');
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
  setChildren(app,
    h('header.quote-head', {},
      q.shop?.logoUrl ? h('img.logo', { src: q.shop.logoUrl, alt: '' }) : null,
      h('div.grow', {},
        h('div.shop-name', {}, q.shop?.name || ''),
        h('div.shop-sub', {}, [q.shop?.ownerName && `대표 ${q.shop.ownerName}`, q.shop?.bizNo && `사업자 ${q.shop.bizNo}`].filter(Boolean).join(' · ')))),
    q.test ? h('div.test-banner', {}, '🧪 테스트 견적서입니다. 실제 견적이 아닙니다.') : null,

    h('section.card', {},
      h('div.quote-title', {},
        h('h2', {}, `${q.templateName || ''} 견적서`),
        q.verified ? h('span.badge.verified', { title: '사진과 추가요금 체크리스트를 확인하고 낸 견적입니다' }, icon('photo_camera'), '사진 확인 완료 견적') : null),
      h('dl.kv', {},
        h('dt', {}, '견적 번호'), h('dd.strong', {}, q.number || ''),
        h('dt', {}, '고객'), h('dd', {}, `${q.customer?.name || ''}님 · ${q.customer?.region || ''}`),
        q.service?.date ? [h('dt', {}, '작업 희망일'), h('dd.strong', {}, `${q.service.date} ${q.service.timeSlot || ''}`)] : null,
        q.service?.summary ? [h('dt', {}, '내용'), h('dd', {}, q.service.summary)] : null,
        h('dt', {}, '유효기간'), h(`dd${expired ? '.risk' : ''}`, {}, `${q.validUntil || ''}까지${expired ? ' (만료)' : ''}`))),

    h('section.card', {},
      h('div.card-title', {}, icon('receipt_long'), '금액 내역'),
      h('table.lines-table', {}, h('tbody', {}, lines.map((l) => h('tr', {},
        h('td', {}, l.label, l.note ? h('div.muted.small', {}, l.note) : null),
        h('td.num', {}, formatWon(l.amount)))))),
      h('div.total-box', {},
        h('div', {}, '합계', h('b', {}, formatWon(q.total))),
        h('div.muted', {}, `계약금 ${q.depositPct || 0}% ${formatWon(q.deposit)}`))),

    section('✅ 포함 항목', q.included, 'ok'),
    section('❌ 불포함 항목', q.excluded, 'no'),
    q.conditions?.length ? h('section.card.cond', {},
      h('h2', {}, '⚠️ 현장 추가요금이 생기는 조건'),
      h('p.cond-note', {}, '아래 경우에만 현장에서 추가요금이 발생합니다. 그 외 추가요금은 없습니다.'),
      h('ul', {}, q.conditions.map((c) => h('li', {}, h('b', {}, c.label), c.text ? ` — ${c.text}` : '')))) : null,
    q.cancelPolicy ? h('section.card.policy', {}, h('h2', {}, icon('info'), '취소 규정'), h('p', {}, q.cancelPolicy)) : null,
    footerNote('궁금한 점은 아래 "전화" 버튼으로 사장님께 바로 물어보세요.'),

    h('div.sticky-actions', {},
      q.shop?.phone ? h('a.btn.side', { href: telHref(q.shop.phone) }, icon('call'), '전화') : null,
      manduHref(appConfig.manduBaseUrl, q.shop?.manduId)
        ? h('a.btn.side', { href: manduHref(appConfig.manduBaseUrl, q.shop.manduId), target: '_blank', rel: 'noopener' }, icon('chat'), '채팅') : null,
      bookingButton(expired)),
  );
}

function section(title, items, cls) {
  if (!items?.length) return null;
  const mark = cls === 'ok' ? 'check_circle' : 'cancel';
  return h(`section.card.list-${cls}`, {}, h('h2', {}, title), h('ul.mark-list', {}, items.map((t) => h('li', {}, icon(mark), h('span', {}, t)))));
}

function bookingButton(expired) {
  if (quote.status === 'booking_requested' || quote.status === 'confirmed') {
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
  }, '이 견적으로 예약 요청', icon('arrow_forward'));
}
