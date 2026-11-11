// 요금 (설계도 12장): 처음 견적 10건 무료 → 월 요금제(카드 자동결제, 토스페이먼츠)
// 쓴 건수·요금제 상태는 서버 함수 billingStatus 가 알려준다 (화면에서는 세지 않는다).
// 서버에 닿지 않으면 null → 화면은 막지 않는다. 실제로 막는 곳은 보안 규칙이다.
import { auth } from './firebase.js';
import { billingConfig } from './config.js';
import { h, toast, icon, telHref, pageUrl } from './util.js';
import { formatWon } from './calc.js';

const TOSS_SDK = 'https://js.tosspayments.com/v2/standard';

export const PLANS = [
  { id: 'solo', name: '혼자', target: '1인 사장님', amount: 19900, points: ['견적 무제한', '새 문의 휴대폰 알림', '여러 업종 템플릿'] },
  { id: 'team', name: '팀', target: '직원이 있는 업체', amount: 49000, points: ['‘혼자’의 모든 기능', '일정·인력 관리', '직원 일정 알림'] },
  { id: 'company', name: '회사', target: '직원이 많은 업체', amount: 99000, points: ['‘팀’의 모든 기능', '직원 수·견적 수 확대'] },
];
const planName = (id) => PLANS.find((p) => p.id === id)?.name || '';
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : '');

export const payReady = () => !!billingConfig.tossClientKey;

async function call(url, body) {
  const token = await auth.currentUser?.getIdToken();
  if (!token || !url) return null;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return res.json().catch(() => null);
}

/** 요금 상태. 실패하면 null (화면은 막지 않음) */
export async function fetchBilling() {
  try { const r = await call(billingConfig.statusUrl, { action: 'status' }); return r?.ok ? r.state : null; } catch { return null; }
}

/** 한 줄 요약: "무료 견적 7건 남음" / "혼자 요금제 · 다음 결제 12/11" */
export function billingLine(b) {
  if (!b) return '';
  if (b.plan !== 'trial') {
    return `${planName(b.plan)} 요금제 · ${b.status === 'canceled' ? `${md(b.paidUntil)}까지 이용 (해지됨)` : b.status === 'past_due' ? '결제 실패 · 카드를 확인해주세요' : `다음 결제 ${md(b.nextChargeDate)}`}`;
  }
  if (b.freeLeft > 0) return `무료 견적 ${b.freeLeft}건 남음`;
  return b.canSend ? '무료 견적을 모두 썼어요 · 결제가 열릴 때까지 무료' : '무료 견적을 모두 썼어요';
}

/** 홈의 요금 카드. 무료 체험 중에는 쓴 만큼 막대로, 요금제 이용 중에는 한 줄 */
export function renderBillingCard(b, onOpen) {
  if (!b) return null;
  const trial = b.plan === 'trial';
  const pct = Math.min(100, Math.round((b.used / Math.max(1, b.freeLimit)) * 100));
  const warn = trial && b.freeLeft <= 2;
  return h(`button.card.bill-card${warn ? '.warn' : ''}`, { type: 'button', onclick: onOpen },
    h('div.bill-row', {},
      h('b', {}, billingLine(b)),
      h('span.bill-more', {}, trial ? '요금제 보기' : '관리', icon('chevron_right'))),
    trial ? h('div.bill-bar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': b.freeLimit, 'aria-valuenow': Math.min(b.used, b.freeLimit), 'aria-label': '무료 견적 사용' },
      h('span', { style: `width:${pct}%` })) : null,
    trial ? h('div.muted.small', {}, `무료 ${b.freeLimit}건 중 ${Math.min(b.used, b.freeLimit)}건 사용 · 테스트 견적은 세지 않아요`) : null);
}

/** 요금제 창. reason: 'limit' (무료를 다 써서 막혔을 때) | undefined */
export function openPlanSheet(b, { shop, onChange, reason } = {}) {
  const close = () => { dlg.close(); dlg.remove(); };
  const active = b && b.plan !== 'trial';
  const start = async (plan, btn) => {
    btn.disabled = true;
    try { await startCardAuth(plan, shop); } catch (e) { toast(e.message || '결제 창을 열지 못했어요.', 4000); btn.disabled = false; }
  };
  const cancel = async (btn) => {
    if (!confirm(`요금제를 해지할까요?\n${md(b.paidUntil)}까지는 그대로 쓸 수 있고, 다음 결제일부터 결제되지 않습니다.`)) return;
    btn.disabled = true;
    try {
      const r = await call(billingConfig.statusUrl, { action: 'cancel' });
      if (!r?.ok) throw new Error(r?.message || '해지하지 못했어요. 잠시 뒤 다시 시도해주세요.');
      toast('해지했어요. 남은 기간까지는 그대로 쓸 수 있어요.', 3500);
      onChange?.(r.state); close();
    } catch (e) { toast(e.message, 4000); btn.disabled = false; }
  };
  const dlg = h('dialog.sheet.plan-sheet', {},
    h('h2', {}, reason === 'limit' ? '무료 견적 10건을 모두 썼어요' : '요금제'),
    h('p.muted', {}, reason === 'limit'
      ? '계속 견적을 보내려면 요금제를 골라주세요. 이미 보낸 견적서와 고객 요청은 그대로 볼 수 있어요.'
      : b ? billingLine(b) : '처음 견적 10건은 무료입니다.'),
    b?.card?.number ? h('p.small.muted', {}, `등록 카드: ${b.card.company || ''} ${b.card.number}`) : null,
    h('div.plan-list', {}, PLANS.map((p) => {
      const mine = active && b.plan === p.id;
      return h(`div.plan-item${mine ? '.on' : ''}`, {},
        h('div.plan-head', {}, h('b', {}, p.name), h('span.muted.small', {}, p.target), mine ? h('span.badge.st-ok', {}, '이용 중') : null),
        h('div.plan-price', {}, formatWon(p.amount), h('small', {}, ' / 월 (부가세 포함)')),
        h('ul.plan-points', {}, p.points.map((t) => h('li', {}, icon('check'), t))),
        mine ? null : payReady()
          ? h('button.btn.primary.block', { type: 'button', onclick: (e) => start(p.id, e.currentTarget) }, `${p.name} 요금제 시작 · 카드 등록`)
          : null);
    })),
    payReady()
      ? h('p.small.muted', {}, '카드를 등록하면 오늘 첫 달 요금이 결제되고, 매월 같은 날 자동으로 결제됩니다. 언제든 해지할 수 있고, 해지하면 다음 결제일부터 결제되지 않습니다.')
      : h('div.notice', {}, h('b', {}, '카드 결제는 준비 중입니다'),
        h('p.small', {}, '결제가 열릴 때까지는 무료 건수를 넘어도 계속 쓸 수 있어요. 요금제 문의는 전화로 주세요.'),
        h('a.btn.soft.block', { href: telHref(billingConfig.contactPhone) }, icon('call'), `${billingConfig.contactPhone} 문의`)),
    h('p.small', {}, h('a', { href: 'pricing.html', target: '_blank', rel: 'noopener' }, '요금 안내'), ' · ',
      h('a', { href: 'terms.html', target: '_blank', rel: 'noopener' }, '이용약관'), ' · ',
      h('a', { href: 'refund.html', target: '_blank', rel: 'noopener' }, '환불규정')),
    h('div.btn-col', {},
      active && b.status !== 'canceled' ? h('button.btn.ghost.danger', { type: 'button', onclick: (e) => cancel(e.currentTarget) }, '요금제 해지') : null,
      h('button.btn.ghost', { type: 'button', onclick: close }, '닫기')));
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// 토스페이먼츠 카드 등록 창을 연다. 등록이 끝나면 토스가 owner.html?billing=success&plan=…&authKey=… 로 돌려보낸다.
async function startCardAuth(plan, shop) {
  const user = auth.currentUser;
  if (!user) throw new Error('로그인이 필요합니다.');
  if (!window.TossPayments) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TOSS_SDK; s.onload = resolve; s.onerror = () => reject(new Error('결제 창을 불러오지 못했어요. 인터넷 연결을 확인해주세요.'));
      document.head.append(s);
    });
  }
  const payment = window.TossPayments(billingConfig.tossClientKey).payment({ customerKey: user.uid });
  await payment.requestBillingAuth({
    method: 'CARD',
    successUrl: pageUrl('owner.html', { billing: 'success', plan }),
    failUrl: pageUrl('owner.html', { billing: 'fail' }),
    customerEmail: user.email || undefined,
    customerName: shop?.name || undefined,
  });
}

/**
 * 카드 등록 창에서 돌아왔을 때 (owner.html?billing=…). 주소의 값을 지우고 결과를 처리한다.
 * @returns 새 요금 상태 | null (돌아온 게 아니거나 실패)
 */
export async function finishCardAuth() {
  const q = new URLSearchParams(location.search);
  const result = q.get('billing');
  if (!result) return null;
  history.replaceState(null, '', location.pathname + location.hash); // 새로고침해도 다시 결제하지 않게
  if (result !== 'success') { toast(q.get('message') || '카드 등록을 취소했어요.', 4000); return null; }
  const authKey = q.get('authKey');
  const plan = q.get('plan');
  if (!authKey || !plan) return null;
  toast('결제를 확인하는 중…', 8000);
  try {
    const r = await call(billingConfig.payUrl, { plan, authKey });
    if (!r?.ok) { toast(r?.message || '결제하지 못했어요. 카드를 확인하고 다시 시도해주세요.', 5000); return null; }
    toast(`${planName(plan)} 요금제를 시작했어요. 다음 결제일은 ${md(r.paidUntil)}입니다.`, 5000);
    return r.state;
  } catch { toast('결제를 확인하지 못했어요. 잠시 뒤 요금제 화면에서 상태를 확인해주세요.', 5000); return null; }
}
