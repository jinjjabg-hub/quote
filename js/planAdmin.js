// 사장님 화면: 요금제 (설계도 12장 ①단계)
// 요금제는 운영자만 바꾼다(보안 규칙). 여기서는 지금 요금제·이번 달 사용량·비교표·신청 방법을 보여준다.
import { db, doc, onSnapshot } from './firebase.js';
import { h, icon, copyText, telHref, setChildren } from './util.js';
import { billingConfig } from './config.js';
import { PLANS, PLAN_ORDER, FEATURE_ROWS, FREE_MONTHLY, effectivePlan, monthKey, won, untilText } from './plan.js';

/** billing/plan + 이번 달 usage 구독 → onChange({ doc, plan, used }) */
export function subscribePlan(shopId, onChange) {
  const st = { doc: null, used: 0 };
  const got = { a: false, b: false };
  const emit = () => onChange({ doc: st.doc, plan: effectivePlan(st.doc), used: st.used, ready: got.a && got.b });
  // 문서가 없거나 못 읽으면 무료로 본다
  const a = onSnapshot(doc(db, 'shops', shopId, 'billing', 'plan'), (s) => { st.doc = s.exists() ? s.data() : null; got.a = true; emit(); }, () => { got.a = true; emit(); });
  const b = onSnapshot(doc(db, 'shops', shopId, 'usage', monthKey()), (s) => { st.used = s.exists() ? Number(s.data().sent) || 0 : 0; got.b = true; emit(); }, () => { got.b = true; emit(); });
  return () => { a(); b(); };
}

/** 홈·업체 정보에 붙는 작은 요금제 표시 */
export function planChip(P, onclick) {
  const p = PLANS[P.plan];
  const sub = p.monthly != null ? `이번 달 ${P.used}/${p.monthly}건` : untilText(P.doc) || '사용 중';
  return h('button.plan-chip', { type: 'button', onclick }, icon('workspace_premium'), h('b', {}, `${p.name} 요금제`), h('span', {}, sub), icon('chevron_right'));
}

/** 요금제 화면 */
export function renderPlanPage({ P, shop, uid }) {
  const p = PLANS[P.plan];
  const until = untilText(P.doc);
  const pct = p.monthly ? Math.min(100, Math.round((P.used / p.monthly) * 100)) : 0;
  return h('section', {},
    h('div.card.plan-now', {},
      h('div.small.muted', {}, '지금 요금제'),
      h('div.plan-name', {}, `${p.name}`, h('span', {}, p.price ? won(p.price) : '무료')),
      until ? h('div.small', {}, `이용 기간: ${until}`) : null,
      p.monthly != null
        ? h('div', {},
          h('div.plan-usage', {}, `이번 달 견적 발송 ${P.used}건 / ${p.monthly}건`),
          h('div.bar', {}, h(`div.bar-fill${pct >= 100 ? '.full' : ''}`, { style: `width:${pct}%` })),
          h('p.small.muted', {}, '테스트 견적과 같은 견적 다시 보내기는 세지 않아요. 매달 1일(한국 시간)에 다시 시작해요.'))
        : h('p.small.muted', {}, `이번 달 견적 발송 ${P.used}건 · 무제한`)),
    h('div.section-head', {}, h('h2', {}, '요금제 비교')),
    h('div.card.plan-table-card', {}, h('div.plan-scroll', {}, h('table.plan-table', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), PLAN_ORDER.map((k) => h(`th${k === P.plan ? '.on' : ''}`, {}, PLANS[k].name, h('div', {}, PLANS[k].price ? `${(PLANS[k].price / 10000).toFixed(PLANS[k].price % 10000 ? 2 : 0)}만원` : '0원'))))),
      h('tbody', {}, FEATURE_ROWS.map(([label, ...cells]) => h('tr', {}, h('th', {}, label), cells.map((c, i) => h(`td${PLAN_ORDER[i] === P.plan ? '.on' : ''}`, {}, c)))))))),
    h('p.small.muted', {}, '가격은 부가세 포함 월 요금이에요. 연간 결제는 10개월 값(2개월 무료).'),
    h('div.section-head', {}, h('h2', {}, '요금제 바꾸기')),
    h('div.card', {},
      h('p', {}, '지금은 입금 확인 후 운영자가 바로 켜드려요. (카드 자동결제는 준비 중)'),
      h('div.choices', {}, PLAN_ORDER.filter((k) => k !== 'free').map((k) => h('button.btn.soft.small', {
        type: 'button', onclick: () => openUpgrade({ want: k, shop, uid }),
      }, `${PLANS[k].name} 신청`)))));
}

/** 신청 안내 창: 운영자에게 보낼 문구 복사 (계정 번호 포함 → 운영자가 바로 찾음) */
export function openUpgrade({ want = 'solo', shop, uid, reason = '' }) {
  const p = PLANS[want];
  const msg = `[비즈마이 견적] 요금제 신청\n업체: ${shop?.name || '-'}\n대표: ${shop?.ownerName || '-'} (${shop?.phone || '-'})\n원하는 요금제: ${p.name} (${won(p.price)})\n계정 번호: ${uid}`;
  const dlg = h('dialog.sheet', {});
  const close = () => { dlg.close(); dlg.remove(); };
  setChildren(dlg, // append 는 null 을 글자로 찍으므로 빈 값을 건너뛰는 setChildren
    h('h2', {}, reason ? '요금제가 필요해요' : `${p.name} 요금제 신청`),
    reason ? h('p.warn-box', {}, reason) : null,
    h('ol.steps', {},
      h('li', {}, '아래 신청 문구를 복사해서 운영자에게 보내주세요.'),
      billingConfig.bankAccount ? h('li', {}, `입금 계좌: ${billingConfig.bankAccount} — ${won(p.price)}`) : h('li', {}, '입금 계좌는 운영자가 안내해드려요.'),
      h('li', {}, '입금이 확인되면 운영자가 바로 켜드려요. 이 화면이 자동으로 바뀌어요.')),
    h('pre.msg', {}, msg),
    h('div.btn-col', {},
      h('button.btn.primary.big', { type: 'button', onclick: () => copyText(msg, '신청 문구를 복사했어요.') }, '신청 문구 복사'),
      billingConfig.contactPhone ? h('a.btn.ghost', { href: `sms:${billingConfig.contactPhone.replace(/[^0-9+]/g, '')}` }, icon('sms'), '문자로 보내기') : null,
      billingConfig.contactPhone ? h('a.btn.ghost', { href: telHref(billingConfig.contactPhone) }, icon('call'), '전화로 문의') : null,
      h('button.btn.ghost', { type: 'button', onclick: close }, '닫기')));
  document.body.append(dlg);
  dlg.showModal();
}

/** 팀 기능(일정·직원) 잠금 화면 */
export function renderTeamLock({ P, onPlan }) {
  return h('section', {},
    h('div.card.lock-card', {},
      h('div.lock-icon', {}, icon('lock', true)),
      h('h2', {}, '일정·직원 관리는 팀 요금제 기능이에요'),
      h('p.muted', {}, `지금: ${PLANS[P.plan].name} 요금제`),
      h('ul.mark-list', {},
        ['직원 × 시간 일정표, 전화·숨고 일정 빠른 등록', '휴무·겹침을 피한 추천 배정', '배정되면 직원 휴대폰으로 알림', '직원이 휴무일·가능일을 직접 설정'].map((t) => h('li', {}, icon('check_circle'), h('span', {}, t)))),
      h('p', {}, h('b', {}, `팀 ${won(PLANS.team.price)}`), ' · 직원 10명까지'),
      h('button.btn.primary.block', { type: 'button', onclick: onPlan }, '요금제 보기')));
}

export const FREE_LIMIT_TEXT = `무료 요금제는 한 달에 견적 ${FREE_MONTHLY}건까지 보낼 수 있어요. 이번 달 ${FREE_MONTHLY}건을 모두 썼어요.\n혼자 요금제(${won(PLANS.solo.price)})부터는 무제한이에요.`;
