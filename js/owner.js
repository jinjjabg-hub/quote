// 사장님 화면 (owner.html) — 구글 로그인 필요
// 탭: 요청 목록 / 단가표 / 업체 정보,  상세: #req=요청ID
import {
  auth, db, storage, isConfigured, signInWithGoogle, onAuthStateChanged, signOut,
  doc, collection, getDoc, setDoc, updateDoc, onSnapshot, query, where, serverTimestamp, writeBatch,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
} from './firebase.js';
import { appConfig } from './config.js';
import { loadTemplate } from './templates.js';
import {
  calculateQuote, finalizeLines, mergePriceTable, priceWarnings, formatWon, addDays, toDateStr, dateFlags, ROUNDING_KEY,
  isFieldVisible,
} from './calc.js';
import {
  $, h, toast, copyText, pageUrl, compressImage, STATUS, statusBadge, fmtDateTime, optionLabel, telHref,
  registerSW, showFatal, MANDU_ID_RE, setChildren, icon, timeAgo, maskName, tsToDate, footerNote,
} from './util.js';
import { placeLabel, appliedText } from './areaLookup.js';
import { subscribeStaff, renderSchedule } from './staffAdmin.js';

registerSW();

const app = $('#app');
const S = {
  user: null, shop: null, tpl: null, priceTable: null,
  requests: new Map(), filter: 'all', tab: 'home', unsub: null, detail: null,
  staff: null, unsubStaff: null, sched: {},
};

if (!isConfigured) showFatal('Firebase 설정이 아직 없습니다. js/config.js 를 채운 뒤 다시 열어주세요. (배포.md 참고)');
else onAuthStateChanged(auth, (user) => onUser(user).catch((e) => showFatal(e.message)));

window.addEventListener('hashchange', route);

async function onUser(user) {
  S.unsub?.(); S.unsub = null;
  S.unsubStaff?.(); S.unsubStaff = null; S.staff = null;
  S.user = user;
  if (!user) { renderLogin(); return; }
  setChildren(app, h('p.muted.center', {}, '불러오는 중…'));
  await loadShop();
  subscribeRequests();
  subscribeStaffList();
  route();
}

function renderLogin() {
  app.classList.remove('has-nav');
  setChildren(app, h('section.card.center', { style: 'margin-top:40px;padding:32px 22px' },
    h('div.logo-ph', { style: 'margin:0 auto 14px;width:64px;height:64px;border-radius:18px' }, icon('request_quote', true)),
    h('div.brand', { style: 'color:var(--primary);font-weight:700' }, '비즈마이 견적'),
    h('h1', {}, '견적은 자동으로,\n사장님은 확인만'),
    h('p.muted', {}, '고객이 링크로 정보를 입력하면 내 단가표로 견적이 자동 계산됩니다.\n사장님은 확인 후 한 번 눌러 보내기만 하세요.'),
    h('button.btn.primary.big.block', {
      onclick: () => signInWithGoogle().catch((e) => toast(`로그인 실패: ${e.message}`)),
    }, 'Google 계정으로 시작하기')),
    footerNote());
}

// ---------- 데이터 로드 ----------

async function loadShop() {
  const uid = S.user.uid;
  const shopRef = doc(db, 'shops', uid);
  const pricingRef = doc(db, 'shops', uid, 'private', 'pricing');
  let snap = await getDoc(shopRef);
  if (!snap.exists()) {
    await setDoc(shopRef, {
      ownerUid: uid, templateId: appConfig.defaultTemplateId,
      name: '', ownerName: S.user.displayName || '', phone: '', bizNo: '', logoUrl: '', manduId: '',
      createdAt: serverTimestamp(),
    });
    snap = await getDoc(shopRef);
  }
  S.shop = snap.data();
  S.tpl = await loadTemplate(S.shop.templateId);
  const p = await getDoc(pricingRef);
  S.priceTable = mergePriceTable(S.tpl, p.exists() ? p.data().priceTable : {});
  if (!S.shop.name) S.tab = 'shop'; // 처음이면 업체 정보부터
}

function subscribeStaffList() {
  S.unsubStaff?.();
  S.unsubStaff = subscribeStaff(S.user.uid, (list) => {
    S.staff = list;
    if (!S.detail && S.tab === 'schedule' && !document.querySelector('dialog[open]')) renderMain();
  });
}

function subscribeRequests() {
  const q = query(collection(db, 'requests'), where('shopId', '==', S.user.uid));
  S.unsub = onSnapshot(q, (snap) => {
    S.requests = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    if (!S.detail && ['home', 'list', 'link'].includes(S.tab)) renderMain();
    if (S.detail) renderDetailStatus();
  }, (e) => toast(`목록을 불러오지 못했습니다: ${e.message}`, 4000));
}

function route() {
  const m = /req=([\w-]+)/.exec(location.hash);
  if (m) openDetail(m[1]); else { S.detail = null; renderMain(); }
}

// ---------- 메인 (아래 탭 메뉴) ----------

function shopLink() { return pageUrl('q.html', { shop: S.user.uid }); }

const TABS = [
  ['home', '홈', 'grid_view'],
  ['list', '견적요청', 'assignment_late'],
  ['schedule', '일정', 'calendar_month'],
  ['price', '단가표', 'payments'],
  ['link', '내 링크', 'link'],
];
// 업체 정보는 오른쪽 위 사람 아이콘에서 (아래 메뉴 5칸 유지)
const TAB_TITLE = { home: '홈 대시보드', list: '견적 요청', schedule: '일정 · 직원', price: '단가표 관리', link: '내 견적 링크', shop: '업체 정보' };

function goTab(k) { S.tab = k; renderMain(); window.scrollTo(0, 0); }

function renderMain() {
  if (!S.shop) return;
  app.classList.add('has-nav');
  const body = {
    home: renderHome, list: renderList, price: renderPriceForm, link: renderLinkTab, shop: renderShopForm,
    schedule: () => renderSchedule({ shopId: S.user.uid, shopName: S.shop.name, staff: S.staff, st: S.sched, rerender: renderMain }),
  }[S.tab] || renderHome;
  setChildren(app,
    appBar(),
    body(),
    h('nav.bottom-nav', { 'aria-label': '메뉴' }, TABS.map(([k, label, ic]) => h(`button.nav-item${S.tab === k ? '.on' : ''}`, {
      type: 'button', onclick: () => goTab(k), 'aria-current': S.tab === k ? 'page' : null,
    }, icon(ic), label, k === 'list' ? waitingDot() : null))),
  );
}

function appBar() {
  return h('header.appbar', {},
    h('div.grow', {},
      h('div.brand', {}, '비즈마이 견적', S.shop.name ? h('span.shop-chip', {}, icon('verified'), S.shop.name) : null),
      h('div.title', {}, TAB_TITLE[S.tab])),
    h('button.avatar', { type: 'button', title: '업체 정보', 'aria-label': '업체 정보', onclick: () => goTab('shop') }, icon('person', true)));
}

function waitingCount() {
  return [...S.requests.values()].filter((r) => r.status === 'new' || r.status === 'booking_requested').length;
}

function waitingDot() {
  const n = waitingCount();
  return n ? h('span.dot', {}, n) : null;
}

function sortedRequests() {
  return [...S.requests.values()].sort((a, b) => (b.createdAt?.seconds ?? 9e9) - (a.createdAt?.seconds ?? 9e9));
}

// "내 숫자" (설계도 0장). 테스트 요청은 항상 제외한다.
function myNumbers() {
  const real = [...S.requests.values()].filter((r) => !r.test);
  const dayOf = (r) => { const d = tsToDate(r.createdAt); return d ? toDateStr(d) : toDateStr(new Date()); };
  const today = toDateStr(new Date());
  const yesterday = addDays(today, -1);
  const month = today.slice(0, 7);
  const monthReqs = real.filter((r) => dayOf(r).startsWith(month));
  const sent = monthReqs.filter((r) => ['sent', 'booking_requested', 'confirmed'].includes(r.status)).length;
  const confirmed = monthReqs.filter((r) => r.status === 'confirmed').length;
  const waiting = real.filter((r) => r.status === 'new').sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
  return {
    today: real.filter((r) => dayOf(r) === today).length,
    yesterday: real.filter((r) => dayOf(r) === yesterday).length,
    waiting: waiting.length,
    oldestWaiting: waiting[0]?.createdAt,
    month: monthReqs.length,
    sent,
    confirmed,
    rate: sent ? Math.round((confirmed / sent) * 1000) / 10 : null,
  };
}

function renderHome() {
  const n = myNumbers();
  const diff = n.today - n.yesterday;
  const stat = (label, ic, value, cls, sub, subCls) => h('div.stat', {},
    h('div.stat-head', {}, label, icon(ic)),
    h(`div.stat-num${cls ? `.${cls}` : ''}`, {}, value, h('small', {}, '건')),
    sub ? h(`div.stat-sub${subCls ? `.${subCls}` : ''}`, {}, sub) : null);
  const recent = sortedRequests().slice(0, 4);
  return h('section', {},
    h('div.hero', {},
      h('span.tag', {}, icon('storefront'), S.tpl.name),
      h('h1', {}, `${S.shop.name || '사장님'} 대표님,`),
      h('p', {}, n.waiting
        ? `답을 기다리는 요청이 ${n.waiting}건 있어요.\n먼저 답하는 업체가 계약합니다.`
        : '밀린 요청이 없어요.\n내 링크를 더 많은 곳에 붙여보세요.')),
    h('div.section-head', {}, h('h2', {}, '실시간 운영 현황'), h('span.muted.small', {}, '테스트 제외')),
    h('div.stats', {},
      stat('오늘 신규 견적', 'mark_email_unread', n.today, 'blue', diff ? [icon(diff > 0 ? 'trending_up' : 'trending_down'), `어제 대비 ${diff > 0 ? '+' : ''}${diff}건`] : '어제와 같아요', diff > 0 ? 'up' : null),
      stat('답장 대기', 'phone_in_talk', n.waiting, null, n.waiting ? [icon('schedule'), `가장 오래된 요청 ${timeAgo(n.oldestWaiting)}`] : '모두 답했어요', n.waiting ? 'alert' : null),
      stat('이번 달 누적', 'calendar_month', n.month, null, `견적 발송 ${n.sent}건`),
      stat('계약 성공', 'task_alt', n.confirmed, 'green', n.rate == null ? '발송한 견적이 아직 없어요' : `전환율 ${n.rate}%`, 'up')),
    h('div.tools', {},
      h('div.section-head', { style: 'margin:0' }, h('b', {}, '빠른 업무 도구')),
      h('div.tools-grid', {},
        h('button.tool', { type: 'button', onclick: () => goTab('price') }, icon('tune'), '단가표 수정'),
        h('button.tool', { type: 'button', onclick: () => copyText(shopLink()) }, icon('content_copy'), '내 링크 복사'),
        h('a.tool', { href: pageUrl('q.html', { shop: S.user.uid, test: 1 }), target: '_blank', rel: 'noopener' }, icon('visibility'), '고객용 미리보기'))),
    h('div.section-head', {},
      h('h2', {}, '최근 견적 요청', S.requests.size ? h('span.pill-count', {}, S.requests.size) : null),
      S.requests.size > recent.length ? h('button.link', { type: 'button', onclick: () => goTab('list') }, '전체보기 ›') : null),
    recent.length ? h('ul.req-list', {}, recent.map(renderListItem)) : emptyList(),
  );
}

function emptyList() {
  return h('div.card.empty', {},
    h('p', {}, h('b', {}, '아직 견적 요청이 없습니다.')),
    h('p.muted', {}, '내 링크를 카톡·문자·숨고 채팅에 붙여 고객에게 보내보세요.'),
    h('button.btn.primary.block', { type: 'button', onclick: () => goTab('link') }, icon('link'), '내 링크 보러 가기'));
}

function renderList() {
  const all = sortedRequests();
  const filters = [['all', '전체'], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])];
  const shown = S.filter === 'all' ? all : all.filter((r) => r.status === S.filter);
  return h('section', {},
    h('div.choices.filter', {}, filters.map(([k, label]) => {
      const n = k === 'all' ? all.length : all.filter((r) => r.status === k).length;
      return h(`button.chip.small${S.filter === k ? '.on' : ''}`, { onclick: () => { S.filter = k; renderMain(); } }, `${label} ${n}`);
    })),
    shown.length ? h('ul.req-list', {}, shown.map(renderListItem)) : emptyList(),
    renderTestPanel(all));
}

// ---------- 테스트 모드 ----------
// 실제 고객 없이 견적 흐름 전체를 해보는 기능. 테스트 데이터는 test: true 로 표시되고 한 번에 지울 수 있다.

function renderTestPanel(all) {
  const tests = all.filter((r) => r.test);
  return h('details.test-panel', { open: S.testOpen },
    h('summary', { onclick: (e) => { e.preventDefault(); S.testOpen = !S.testOpen; renderMain(); } },
      '🧪 테스트 모드', tests.length ? h('span.muted.small', {}, ` · 테스트 요청 ${tests.length}건`) : null),
    h('p.muted.small', {}, '실제 고객 없이 견적 흐름을 직접 해볼 수 있어요. 테스트 데이터에는 "테스트" 표시가 붙습니다.'),
    h('div.btn-col', {},
      h('button.btn.primary', { onclick: (e) => createSampleRequest(e.target) }, '샘플 요청 1건 만들기'),
      h('a.btn.ghost', { href: pageUrl('q.html', { shop: S.user.uid, test: 1 }), target: '_blank', rel: 'noopener' }, '고객 화면으로 직접 입력해보기'),
      h('a.btn.ghost', { href: 'dev.html', target: '_blank', rel: 'noopener' }, '🛠 업종 시뮬레이터 (6개 업종 계산 확인)'),
      tests.length ? h('button.btn.ghost.danger', { onclick: (e) => clearTestData(tests, e.target) }, `테스트 데이터 모두 지우기 (${tests.length}건)`) : null));
}

async function createSampleRequest(btn) {
  const sample = S.tpl.sample;
  if (!sample) { toast('이 업종에는 샘플 데이터가 아직 없어요. "고객 화면으로 직접 입력해보기"를 이용해주세요.'); return; }
  btn.disabled = true;
  try {
    const ref = doc(collection(db, 'requests'));
    await setDoc(ref, {
      shopId: S.user.uid,
      templateId: S.shop.templateId,
      status: 'new',
      test: true,
      customer: { ...sample.customer },
      answers: { date: addDays(toDateStr(new Date()), 7), ...sample.answers },
      checklist: { ...(sample.checklist || {}) },
      photos: [],
      quoteId: null,
      createdAt: serverTimestamp(),
    });
    toast('샘플 요청을 만들었어요. 목록에서 눌러 견적을 보내보세요.');
  } catch (e) { toast(`만들기 실패: ${e.message}`); }
  btn.disabled = false;
}

async function clearTestData(tests, btn) {
  if (!confirm(`테스트 요청 ${tests.length}건과 그 견적서·사진을 지울까요? 되돌릴 수 없습니다.`)) return;
  btn.disabled = true;
  try {
    for (const r of tests) {
      for (const p of r.photos || []) await deleteObject(storageRef(storage, p.path)).catch(() => {});
    }
    for (let i = 0; i < tests.length; i += 200) { // 배치 1회 최대 500건 → 요청+견적 2건씩
      const batch = writeBatch(db);
      for (const r of tests.slice(i, i + 200)) {
        if (r.quoteId) batch.delete(doc(db, 'quotes', r.quoteId));
        batch.delete(doc(db, 'requests', r.id));
      }
      await batch.commit();
    }
    toast('테스트 데이터를 지웠어요.');
  } catch (e) { toast(`지우기 실패: ${e.message}`); btn.disabled = false; }
}

function requestSummary(r) {
  const a = r.answers || {};
  const b = S.tpl.pricing.base || {};
  const size = b.quantityField && a[b.quantityField] ? `${a[b.quantityField]}${b.unit || ''}` : '';
  const extras = (a.extras || []).map((k) => S.tpl.pricing.options.find((o) => o.key === k)?.label).filter(Boolean);
  return { size, what: [S.tpl.name, ...extras].join(' + ') };
}

function renderListItem(r) {
  let est = '';
  try { est = formatWon(calculateQuote(S.tpl, S.priceTable, r).total); } catch { /* 템플릿 불일치 */ }
  const { size, what } = requestSummary(r);
  const fresh = r.status === 'new';
  const ageMin = (Date.now() - (tsToDate(r.createdAt)?.getTime() ?? Date.now())) / 60000;
  const open = () => { location.hash = `req=${r.id}`; };
  const stop = (fn) => (e) => { e.stopPropagation(); fn?.(); };
  return h(`li.req-card${fresh ? '.is-new' : ''}`, { onclick: open },
    h('div.req-top', {},
      h('span.name', {}, `${maskName(r.customer?.name) || '이름 없음'} 고객님`),
      statusBadge(r.status),
      r.test ? h('span.badge.st-test', {}, '테스트') : null,
      h(`span.when${fresh && ageMin < 60 ? '.fresh' : ''}`, {}, icon(fresh && ageMin < 60 ? 'bolt' : 'schedule'), `${timeAgo(r.createdAt)} 접수`)),
    h('div.req-box', {},
      h('div.loc', {}, icon('location_on'), [r.customer?.region, size].filter(Boolean).join(' ') || '지역 미입력'),
      h('div.what', {}, icon('cleaning_services'), `신청 항목: ${what}`),
      r.answers?.date ? h('div.what', {}, icon('event'), `희망일 ${r.answers.date}`) : null),
    h('div.req-bottom', {},
      h('div.price', {}, h('div.muted', {}, r.status === 'confirmed' ? '계약 금액 (예상)' : '예상 견적 금액'), h(`b${r.status === 'confirmed' ? '.green' : ''}`, {}, est || '-')),
      h('button.btn.soft.small', { type: 'button', onclick: stop(open) }, '상세보기'),
      r.customer?.phone ? h(`a.btn.small.${fresh ? 'primary' : 'dark'}`, { href: telHref(r.customer.phone), onclick: stop() }, icon('call'), fresh ? '바로 전화' : '전화') : null));
}

// ---------- 단가표 ----------

function sectionTitle(no, title, aside) {
  return h('div.card-title', {}, no != null ? h('span.step-no', {}, no) : null, h('span.grow', {}, title), aside ? h('span.aside', {}, aside) : null);
}

function renderPriceForm() {
  const pt = structuredClone(S.priceTable);
  const p = S.tpl.pricing;
  const warn = h('div.warn-box', { hidden: true });
  const updateWarn = () => {
    const w = priceWarnings(S.tpl, pt);
    warn.hidden = !w.length; warn.textContent = w.map((x) => `⚠️ ${x}`).join('\n');
  };
  const numInput = (get, set, suffix) => h('div.input-suffix', {},
    h('input.input', {
      type: 'number', inputMode: 'numeric', min: 0, value: get(),
      oninput: (e) => { set(e.target.value === '' ? 0 : Number(e.target.value)); updateWarn(); },
    }), h('span', {}, suffix));
  const row = (label, control, sub) => h('label.price-row', {}, h('span', {}, label, sub ? h('div.muted.small', {}, sub) : null), control);

  updateWarn();
  return h('section', {},
    h('div.notice', {}, h('div.box-row', {}, icon('calculate'), h('b', {}, '자동 계산 안내')),
      h('p.small', {}, `입력하신 단가로 고객 견적이 자동 계산됩니다. ${S.tpl.name} 기본값이 채워져 있으니 다른 숫자만 고치세요.`)),
    h('div.card', {},
      sectionTitle(1, `${p.base.label || '기본'} 단가`, '필수 설정'),
      h('label.price-main', {}, h('span.label', {}, p.base.unitPriceLabel), numInput(() => pt.unitPrice, (v) => { pt.unitPrice = v; }, `원/${p.base.unit}`)),
      warn,
      h('label.price-main', {}, h('span.label', {}, p.base.minPriceLabel, h('span.hint', {}, '작은 집도 이 금액 아래로는 내려가지 않습니다')),
        numInput(() => pt.minPrice, (v) => { pt.minPrice = v; }, '원'))),
    h('div.card', {},
      sectionTitle(2, '할증', '기본 금액에 % 추가'),
      p.surcharges.map((x) => row(x.label, numInput(() => pt.surcharges[x.key] ?? 0, (v) => { pt.surcharges[x.key] = v; }, '%'))),
      h('p.muted.small', {}, '주말·공휴일·손 없는 날은 고객 희망 날짜로 자동 판단합니다. (대체공휴일은 상세 화면에서 직접 체크)')),
    h('div.card', {},
      sectionTitle(3, '추가 옵션 단가', '현장 상황에 따른 추가'),
      p.options.map((o) => row(o.priceLabel || o.label, numInput(() => pt.options[o.key] ?? 0, (v) => { pt.options[o.key] = v; }, '원'), o.customerSelectable ? '고객이 직접 고르는 항목' : null))),
    h('div.card', {},
      sectionTitle(4, '견적 정책'),
      row('견적 유효기간', numInput(() => pt.policy.validDays, (v) => { pt.policy.validDays = v; }, '일')),
      row('계약금 비율', numInput(() => pt.policy.depositPct, (v) => { pt.policy.depositPct = v; }, '%')),
      h('label.field', {}, h('span.label', {}, '취소 규정'),
        h('textarea.input', { rows: 3, value: pt.policy.cancelPolicy || '', oninput: (e) => { pt.policy.cancelPolicy = e.target.value; } }))),
    h('p.footer-note', {}, '단가를 바꾸면 이후에 계산되는 모든 견적에 바로 적용됩니다.\n이미 보낸 견적서는 바뀌지 않습니다.'),
    h('div.dock', {}, h('button.btn.primary', {
      onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try {
          await setDoc(doc(db, 'shops', S.user.uid, 'private', 'pricing'), { priceTable: pt, updatedAt: serverTimestamp() });
          S.priceTable = mergePriceTable(S.tpl, pt);
          toast('단가표를 저장했어요.');
        } catch (err) { toast(`저장 실패: ${err.message}`); }
        btn.disabled = false;
      },
    }, icon('save'), '단가표 저장하기')));
}

// ---------- 내 링크 ----------
// 설계도 6-1장: 모든 채널은 같은 고객 화면 링크를 쓴다.

function renderLinkTab() {
  const url = shopLink();
  const n = myNumbers();
  const msg = `${S.shop.name || '저희 업체'} ${S.tpl.name} 견적 요청 링크입니다. 3분이면 입력이 끝나고, 확인 후 견적을 보내드립니다.\n${url}`;
  return h('section', {},
    h('div.card', { style: 'background:var(--surface)' },
      h('span.shop-chip', {}, icon('share'), '어디에 붙여도 같은 링크'),
      h('h2', { style: 'margin-top:10px' }, '우리 업체 전용 견적 링크'),
      h('p.muted', {}, '이 링크를 카톡 프로필, 문자, 숨고 채팅, 블로그, 인스타그램, 명함에 올려두세요. 고객이 직접 입력하면 내 단가표로 견적이 자동 계산됩니다.'),
      h('div.stats', {},
        h('div.stat', {}, h('div.stat-head', {}, '이번 달 요청', icon('inbox')), h('div.stat-num', {}, n.month, h('small', {}, '건'))),
        h('div.stat', {}, h('div.stat-head', {}, '계약 전환율', icon('trending_up')), h('div.stat-num.green', {}, n.rate == null ? '-' : `${n.rate}%`)))),
    h('div.card', {},
      sectionTitle(null, '전용 주소'),
      h('div.link-url', {}, h('code', {}, url), h('button.btn.primary.small', { type: 'button', onclick: () => copyText(url) }, icon('content_copy'), '링크 복사')),
      h('p.muted.small', {}, '버튼을 누르면 복사됩니다. 카톡·문자에 붙여넣으세요.')),
    h('div.card', {},
      sectionTitle(null, '간편 공유'),
      navigator.share ? h('button.share-btn.kakao', { type: 'button', onclick: () => navigator.share({ text: msg }).catch(() => {}) }, icon('chat'), h('span.grow', {}, '카카오톡 등으로 공유'), icon('chevron_right')) : null,
      h('a.share-btn', { href: `sms:?&body=${encodeURIComponent(msg)}` }, icon('sms'), h('span.grow', {}, '문자로 보내기'), icon('chevron_right')),
      h('button.share-btn', { type: 'button', onclick: () => copyText(msg, '안내 문구와 링크를 복사했어요.') }, icon('content_paste'), h('span.grow', {}, '안내 문구와 함께 복사'), icon('content_copy'))),
    h('div.card', {},
      sectionTitle(null, '고객에게 이렇게 보여요'),
      h('p.muted.small', {}, '테스트 모드로 열려서 실제 요청으로 집계되지 않습니다.'),
      h('a.btn.primary.big.block', { href: pageUrl('q.html', { shop: S.user.uid, test: 1 }), target: '_blank', rel: 'noopener' }, icon('play_circle'), '고객 견적 화면 바로 테스트하기')),
    footerNote('고객이 보낸 요청은 홈과 견적요청 탭에 바로 표시됩니다.'));
}

// ---------- 업체 정보 ----------

function renderShopForm() {
  const f = { ...S.shop };
  const text = (key, label, opts = {}) => h('label.field', {}, h('span.label', {}, label, opts.required ? h('span.req', {}, ' *') : null, opts.optional ? h('span.muted', {}, ' (선택)') : null),
    h(opts.multiline ? 'textarea.input' : 'input.input', { type: opts.multiline ? undefined : (opts.type || 'text'), value: f[key] || '', placeholder: opts.placeholder || '', maxLength: 60, rows: opts.multiline ? 2 : undefined,
      oninput: (e) => { f[key] = e.target.value.trim(); } }),
    opts.hint ? h('span.hint', {}, opts.hint) : null);
  const logoImg = h('img.logo', { src: f.logoUrl || '', alt: '', hidden: !f.logoUrl });
  const logoPh = h('div.logo-ph', { hidden: !!f.logoUrl }, (f.name || '업')[0]);
  const logoInput = h('input', {
    type: 'file', accept: 'image/*', hidden: true,
    onchange: async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      try {
        const blob = await compressImage(file, 400, 0.85);
        const r = storageRef(storage, `shops/${S.user.uid}/logo.jpg`);
        await uploadBytes(r, blob, { contentType: 'image/jpeg' });
        f.logoUrl = await getDownloadURL(r);
        logoImg.src = f.logoUrl; logoImg.hidden = false; logoPh.hidden = true;
        toast('로고를 올렸어요. 저장을 눌러주세요.');
      } catch (err) { toast(`업로드 실패: ${err.message}`); }
    },
  });
  return h('section', {},
    !S.shop.name ? h('p.notice', {}, '처음 오셨네요! 견적서에 표시될 업체 정보를 먼저 입력해주세요.') : null,
    h('p.muted', {}, '고객 견적 화면과 견적서 상단에 표시되는 정보입니다.'),
    h('div.card', {},
      sectionTitle(1, '로고', '견적서 상단 표시'),
      h('div.logo-row', {}, logoImg, logoPh,
        h('div', {}, h('div.muted.small', {}, '정사각형 PNG·JPG 권장'),
          h('button.btn.soft.small', { type: 'button', onclick: () => logoInput.click(), style: 'margin-top:6px' }, icon('photo_camera'), '로고 사진 변경')), logoInput)),
    h('div.card', {},
      sectionTitle(2, '기본 업체 정보'),
      text('name', '업체명', { required: true, placeholder: '예) 반짝입주청소' }),
      text('phone', '대표 전화번호 (상담 직통)', { required: true, type: 'tel', placeholder: '010-0000-0000', hint: '고객 화면의 "전화 상담" 버튼으로 연결됩니다' }),
      text('ownerName', '대표자'),
      text('bizNo', '사업자번호', { optional: true, placeholder: '000-00-00000' }),
      text('intro', '한 줄 소개', { optional: true, multiline: true, placeholder: '예) 10년 경력 직영팀이 꼼꼼하게 시공합니다.' }),
      text('serviceArea', '서비스 가능 지역', { optional: true, placeholder: '예) 부산 전 지역, 김해·양산' })),
    h('div.card', {},
      sectionTitle(3, '만두 채팅 연결', '선택'),
      text('manduId', '만두 ID', { placeholder: '예) banjjak (@ 없이)', hint: '넣으면 고객 화면·견적서에 "만두로 채팅 문의" 버튼이 생깁니다. 외국인 고객과도 자동 번역으로 대화할 수 있어요.' })),
    h('div.card', {}, renderDevSettings()),
    h('button.btn.ghost.block', { type: 'button', onclick: () => { if (confirm('로그아웃할까요?')) signOut(auth); } }, icon('logout'), '로그아웃'),
    h('div.dock', {}, h('button.btn.primary', {
      onclick: async (e) => {
        if (!f.name || !f.phone) { toast('업체명과 전화번호는 꼭 입력해주세요.'); return; }
        f.manduId = (f.manduId || '').replace(/^@/, '').toLowerCase();
        if (f.manduId && !MANDU_ID_RE.test(f.manduId)) { toast('만두 ID는 영문 소문자·숫자·_ 3~20자입니다.'); return; }
        const btn = e.currentTarget; btn.disabled = true;
        try {
          const data = {
            name: f.name, ownerName: f.ownerName || '', phone: f.phone, bizNo: f.bizNo || '', logoUrl: f.logoUrl || '', manduId: f.manduId || '',
            intro: f.intro || '', serviceArea: f.serviceArea || '', updatedAt: serverTimestamp(),
          };
          await updateDoc(doc(db, 'shops', S.user.uid), data);
          const first = !S.shop.name;
          S.shop = { ...S.shop, ...data };
          toast('저장했어요.');
          if (first) goTab('price'); else renderMain();
        } catch (err) { toast(`저장 실패: ${err.message}`); btn.disabled = false; }
      },
    }, icon('save'), '업체 정보 저장하기')));
}

function renderDevSettings() {
  let on = false;
  try { on = localStorage.getItem('devMode') === '1'; } catch { /* 무시 */ }
  return h('div', {},
    sectionTitle(4, '개발자 모드'),
    h('p.muted.small', {}, '켜면 모든 화면 왼쪽 아래에 오류 패널이 생겨, 문제가 생겼을 때 원인을 바로 보고 복사해서 전달할 수 있어요. 이 기기에서만 적용됩니다.'),
    h('div.btn-col', {},
      h('button.btn.ghost', { onclick: () => { try { if (on) localStorage.removeItem('devMode'); else localStorage.setItem('devMode', '1'); } catch { /* 무시 */ } location.reload(); } },
        on ? '개발자 모드 끄기' : '개발자 모드 켜기 (오류 패널)'),
      h('a.btn.ghost', { href: 'dev.html', target: '_blank', rel: 'noopener' }, '업종 시뮬레이터 열기')));
}

// ---------- 요청 상세 + 견적 편집 ----------

async function openDetail(id) {
  const req = S.requests.get(id) || await getDoc(doc(db, 'requests', id)).then((s) => (s.exists() ? { id, ...s.data() } : null));
  if (!req) { toast('요청을 찾을 수 없습니다.'); location.hash = ''; return; }
  let quote = null;
  if (req.quoteId) {
    const qs = await getDoc(doc(db, 'quotes', req.quoteId));
    if (qs.exists()) quote = qs.data();
  }
  S.detail = { id, req, overrides: quote?.overrides || { surcharges: {}, options: {} } };
  if (quote) {
    Object.assign(S.detail, {
      lines: quote.lines, conditions: quote.conditions, included: quote.included, excluded: quote.excluded,
      calc: calculateQuote(S.tpl, S.priceTable, req, S.detail.overrides),
    });
  } else recalc(req);
  renderDetail();
}

function recalc(req) {
  const c = calculateQuote(S.tpl, S.priceTable, req, S.detail.overrides);
  Object.assign(S.detail, {
    calc: c, lines: c.lines.map((l) => ({ ...l })), conditions: c.conditions.map((x) => ({ ...x })),
    included: [...c.included], excluded: [...c.excluded],
  });
}

function currentReq() { return S.requests.get(S.detail.id) || S.detail.req; }

function renderDetailStatus() {
  const box = $('#status-box');
  const req = currentReq();
  if (box && req) box.replaceChildren(statusBadge(req.status), statusActions(req));
}

function statusActions(req) {
  const set = (status) => {
    // 견적서(고객 화면)의 상태도 함께 맞춘다
    const batch = writeBatch(db);
    batch.update(doc(db, 'requests', req.id), { status, updatedAt: serverTimestamp() });
    if (req.quoteId) batch.update(doc(db, 'quotes', req.quoteId), { status, updatedAt: serverTimestamp() });
    return batch.commit().then(() => toast(`'${STATUS[status].label}'(으)로 바꿨어요.`)).catch((e) => toast(e.message));
  };
  return h('span.status-actions', {},
    req.status !== 'confirmed' && req.status !== 'new' ? h('button.btn.small.ok', { onclick: () => set('confirmed') }, '계약확정') : null,
    req.status !== 'hold' ? h('button.btn.small.ghost', { onclick: () => set('hold') }, '보류') : null,
    req.status === 'hold' ? h('button.btn.small.ghost', { onclick: () => set(req.quoteId ? 'sent' : 'new') }, '보류 해제') : null);
}

function renderDetail() {
  app.classList.remove('has-nav');
  const req = currentReq();
  const a = req.answers || {};
  const fields = S.tpl.steps.flatMap((st) => st.fields);
  const flags = dateFlags(a.date);
  const timeField = fields.find((f) => f.key === 'timeSlot');

  const infoRows = fields
    .filter((f) => isFieldVisible(f, a))
    .filter((f) => !['checklist', 'extras', 'photos', 'textarea'].includes(f.type) && !['name', 'phone', 'region', 'date', 'timeSlot'].includes(f.key))
    .map((f) => [f.label, a[f.key] === undefined || a[f.key] === '' ? '-' : `${optionLabel(f, a[f.key])}${f.lookup ? lookupNote(a, f.key) : ''}`]);
  // 주소 → 평수 자동 조회 결과 (설계도 4-4장). 단지명·동·호는 사장님 화면에만 (견적서에는 넣지 않음)
  const site = fields.filter((f) => f.lookup).map((f) => a[`${f.key}Lookup`]).find(Boolean);
  const extras = (a.extras || []).map((k) => S.tpl.pricing.options.find((o) => o.key === k)?.label || k);
  const dateTags = [flags.$weekend && '주말', flags.$holiday && '공휴일', flags.$sonEomneun && '손 없는 날'].filter(Boolean);
  const ansLabel = { yes: '예', no: '아니오', unknown: '모름' };
  const phone = req.customer?.phone;

  setChildren(app,
    h('header.appbar', {},
      h('button.back', { type: 'button', 'aria-label': '뒤로 가기', onclick: () => { location.hash = ''; } }, icon('arrow_back')),
      h('div.grow', {}, h('div.title', {}, '견적 요청 상세')),
      phone ? h('a.btn.soft.small', { href: telHref(phone) }, icon('call'), '전화') : null),
    req.test ? h('div.test-banner', {}, '🧪 테스트 요청입니다. 견적을 보내도 실제 고객에게 가지 않고, 나중에 한 번에 지울 수 있어요.') : null,
    h('div.status-row', {}, h('span', {}, '진행 상태'), h('div.status-box', { id: 'status-box' })),
    h('section.card', {},
      h('div.cust-head', {},
        h('div', {},
          h('h2', {}, `${req.customer?.name || '고객'} 고객님`),
          phone ? h('a.cust-phone', { href: telHref(phone) }, phone) : null,
          h('div.muted.small', {}, `${timeAgo(req.createdAt)} 접수 · ${fmtDateTime(req.createdAt)}`)),
        phone ? h('div.cust-actions', {},
          h('a.btn.ok.icon', { href: telHref(phone), 'aria-label': '전화하기' }, icon('call', true)),
          h('a.btn.soft.icon', { href: `sms:${phone.replace(/[^0-9+]/g, '')}`, 'aria-label': '문자 보내기' }, icon('sms'))) : null)),
    h('section.card', {},
      h('div.card-title', {}, icon('location_on'), '시공 현장 정보'),
      h('div.box', {},
        h('b', {}, site ? placeLabel(site) || site.roadAddr : req.customer?.region || '지역 미입력'),
        site?.roadAddr ? h('div.muted', {}, site.roadAddr) : null,
        requestSummary(req).size ? h('div.muted', {}, `${requestSummary(req).size} · ${S.tpl.name}`) : null,
        site ? h('div.small', { style: 'margin-top:4px' }, h('span.badge.verified', {}, icon('verified'), ' 건축물대장'), ` ${appliedText(site)}`) : null),
      a.date ? h('div.date-row', {}, h('span', {}, icon('calendar_month'), ' 희망 시공일'),
        h('b', {}, `${a.date}${a.timeSlot ? ` ${optionLabel(timeField, a.timeSlot)}` : ''}${dateTags.length ? ` (${dateTags.join('·')})` : ''}`)) : null),
    h('section.card', {},
      h('div.card-title', {}, icon('checklist'), '고객 선택 요청 세부사항'),
      h('dl.kv', {}, infoRows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      extras.length ? h('div.box', {}, h('b', {}, '고객이 고른 추가 서비스'), h('div', {}, extras.join(', '))) : null,
      h('h3', {}, '추가요금 체크리스트'),
      h('dl.kv', {}, S.tpl.checklist.map((i) => {
        const ans = req.checklist?.[i.key];
        const risky = ans === i.risk || ans === 'unknown';
        return [h('dt', {}, i.label), h(`dd${risky ? '.risk' : ''}`, {}, ansLabel[ans] || '-')];
      })),
      a.memo ? h('div.memo', {}, h('div.quote-mark', {}, icon('chat'), h('b', {}, '고객 전달 요청')), h('p', {}, `"${a.memo}"`)) : null),
    h('section.card', {},
      h('div.card-title', {}, icon('photo_library'), h('span.grow', {}, '현장 첨부 사진'), h('span.aside', {}, `총 ${req.photos?.length || 0}장`)),
      req.photos?.length
        ? h('div.photo-grid.view', {}, req.photos.map(renderPhoto))
        : h('p.muted', {}, '사진 없음. 현장 추가요금 조건을 꼼꼼히 적어주세요.')),
    renderQuoteEditor(req),
    renderOwnerMemo(req),
    h('div.dock', {},
      h('button.btn.primary', { onclick: (e) => sendQuote(req, e.currentTarget) }, icon('send'), req.quoteId ? '견적서 다시 보내기' : '견적서 보내기'),
      h('div.dock-note', {}, h('span', {}, '견적서 링크 + 안내 문구 생성'), h('span', {}, '카톡·문자로 전달'))),
  );
  renderDetailStatus();
}

/** 평수 옆 표시: 대장으로 확인했는지, 고객이 대장 값과 다르게 고쳤는지 */
function lookupNote(a, key) {
  const info = a[`${key}Lookup`];
  if (a[`${key}Source`] === 'registry') return ' (건축물대장 확인)';
  if (info) return ` (고객 직접 입력 · 대장 ${Math.round(info.pyeong)}평)`;
  return a[`${key}Source`] === 'manual' ? ' (직접 입력)' : '';
}

// 사장님만 보는 메모. requests 문서에 저장하며, 견적서(quotes)로는 복사하지 않는다.
function renderOwnerMemo(req) {
  let value = req.ownerMemo || '';
  return h('section.card', {},
    h('div.card-title', {}, icon('edit_note'), '시공업체 내부 메모 (비공개)'),
    h('p.muted.small', {}, '고객에게는 보이지 않는 메모입니다.'),
    h('textarea.input', {
      rows: 3, value, maxLength: 1000, placeholder: '예) 방문 전 주차 확인 필요, 곰팡이 약품 추가 준비',
      oninput: (e) => { value = e.target.value; },
      onchange: () => updateDoc(doc(db, 'requests', req.id), { ownerMemo: value, updatedAt: serverTimestamp() })
        .then(() => toast('메모를 저장했어요.')).catch((err) => toast(`메모 저장 실패: ${err.message}`)),
    }));
}

const photoUrls = new Map();
function renderPhoto(p) {
  const img = h('img', { alt: p.slot, loading: 'lazy' });
  const link = h('a.photo-slot', { target: '_blank', rel: 'noopener' }, img,
    h('div.photo-label', {}, S.tpl.photoSlots.find((s) => s.key === p.slot)?.label || p.slot.replace(/^extra(\d+)$/, '기타 $1')));
  const set = (url) => { img.src = url; link.href = url; };
  if (photoUrls.has(p.path)) set(photoUrls.get(p.path));
  else {
    getDownloadURL(storageRef(storage, p.path))
      .then((url) => { photoUrls.set(p.path, url); set(url); })
      .catch(() => { link.append(h('div.muted.small', {}, '불러오기 실패')); });
  }
  return link;
}

function renderQuoteEditor(req) {
  const d = S.detail;
  const p = S.tpl.pricing;
  const toggle = (group, item, state) => h('label.toggle', {},
    h('input', {
      type: 'checkbox', checked: !!state.on,
      onchange: (e) => {
        if (d.edited && !confirm('항목을 다시 자동 계산합니다. 직접 고친 금액은 사라져요. 계속할까요?')) { e.target.checked = !e.target.checked; return; }
        d.overrides[group][item.key] = e.target.checked;
        d.edited = false;
        recalc(req); renderDetail();
      },
    }),
    state.on ? icon('check') : null, item.label, state.auto ? h('span.muted.small', {}, ' 자동') : null);

  const totals = finalizeLines(d.lines, S.priceTable.policy.depositPct);
  const refreshTotals = () => {
    d.lines = finalizeLines(d.lines, S.priceTable.policy.depositPct).lines;
    renderDetail();
  };

  const lineRow = (l, idx) => {
    if (l.key === ROUNDING_KEY) {
      return h('div.line.rounding', {}, h('span', {}, l.label), h('span', {}, formatWon(l.amount)));
    }
    const bump = (delta) => { l.amount = (Number(l.amount) || 0) + delta; d.edited = true; refreshTotals(); };
    return h('div.line', {},
      h('input.input.line-label', { value: l.label, 'aria-label': '항목 이름', oninput: (e) => { l.label = e.target.value; d.edited = true; } }),
      h('button.btn.round', { title: '삭제', 'aria-label': `${l.label} 삭제`, onclick: () => { d.lines.splice(idx, 1); d.edited = true; refreshTotals(); } }, icon('close')),
      h('div.amount-row', {},
        h('button.btn', { type: 'button', onclick: () => bump(-10000) }, '-1만'),
        h('input.input.line-amount', {
          type: 'number', inputMode: 'numeric', value: l.amount, step: 1000, 'aria-label': `${l.label} 금액`,
          onchange: (e) => { l.amount = Number(e.target.value) || 0; d.edited = true; refreshTotals(); },
        }),
        h('button.btn', { type: 'button', onclick: () => bump(10000) }, '+1만')),
      l.note ? h('div.line-note.muted.small', {}, l.note) : null);
  };

  const listEditor = (title, arr, key) => h('label.field', {}, h('span.label', {}, title),
    h('textarea.input', {
      rows: Math.max(3, arr.length + 1), value: arr.join('\n'),
      oninput: (e) => { d[key] = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); },
    }));

  const condText = d.conditions.map((c) => `${c.label}: ${c.text}`);

  return h('section.card.quote-editor', {},
    h('div.card-title', {}, icon('tune'), h('span.grow', {}, '견적 금액 산출 및 조정'), h('span.aside', {}, '실시간 반영')),
    h('p.muted.small', {}, '고객 답변으로 자동으로 켜진 항목에는 "자동" 표시가 있어요. 누르면 켜고 끄며 다시 계산합니다.'),
    h('div.toggles', {},
      h('div.toggle-group', {}, h('b', {}, '할증'), p.surcharges.map((x) => toggle('surcharges', x, d.calc.surchargeState[x.key]))),
      h('div.toggle-group', {}, h('b', {}, '옵션'), p.options.map((o) => toggle('options', o, d.calc.optionState[o.key])))),
    h('h3', {}, '항목별 금액 (직접 수정 가능)'),
    h('div.lines', {}, d.lines.map(lineRow)),
    h('div.btn-row', {},
      h('button.btn.ghost.small', {
        onclick: () => { d.lines.push({ key: `custom:${Date.now()}`, type: 'custom', label: '추가 항목', amount: 0 }); d.edited = true; refreshTotals(); },
      }, icon('add'), '항목 추가'),
      h('button.btn.ghost.small', { onclick: () => { d.overrides = { surcharges: {}, options: {} }; d.edited = false; recalc(req); renderDetail(); } }, icon('restart_alt'), '자동 계산으로 되돌리기')),
    h('div.total-box', {},
      h('div', {}, h('span', {}, h('div.small', { style: 'opacity:.85' }, '최종 고객 발송 견적'), h('b', { style: 'font-size:1.1rem' }, '합계 금액')), h('b', {}, formatWon(totals.total))),
      h('div.muted', {}, `계약금 ${S.priceTable.policy.depositPct}%`, h('span', {}, formatWon(totals.deposit)))),
    h('h3', {}, '견적서에 들어갈 안내'),
    h('label.field', {}, h('span.label', {}, '⚠️ 현장 추가요금 조건 (한 줄에 하나, "항목: 설명")'),
      h('textarea.input', {
        rows: Math.max(3, condText.length + 1), value: condText.join('\n'),
        oninput: (e) => {
          d.conditions = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).map((line) => {
            const i = line.indexOf(':');
            return i > 0 ? { label: line.slice(0, i).trim(), text: line.slice(i + 1).trim() } : { label: line, text: '' };
          });
        },
      })),
    listEditor('✅ 포함 항목', d.included, 'included'),
    listEditor('❌ 불포함 항목', d.excluded, 'excluded'));
}

async function sendQuote(req, btn) {
  const d = S.detail;
  const pt = S.priceTable;
  const t = finalizeLines(d.lines, pt.policy.depositPct);
  if (!S.shop.name || !S.shop.phone) { toast('업체 정보(상호·연락처)를 먼저 저장해주세요.'); return; }
  if (!confirm(`합계 ${formatWon(t.total)} (계약금 ${formatWon(t.deposit)})\n이 금액으로 견적서를 만들까요?`)) return;
  btn.disabled = true;
  try {
    const quoteRef = req.quoteId ? doc(db, 'quotes', req.quoteId) : doc(collection(db, 'quotes'));
    const today = toDateStr(new Date());
    const a = req.answers || {};
    const timeField = S.tpl.steps.flatMap((s) => s.fields).find((f) => f.key === 'timeSlot');
    const quote = {
      shopId: S.user.uid,
      requestId: req.id,
      templateId: S.tpl.id,
      templateName: S.tpl.name,
      number: `Q${today.replace(/-/g, '').slice(2)}-${quoteRef.id.slice(0, 4).toUpperCase()}`,
      shop: { name: S.shop.name, ownerName: S.shop.ownerName || '', phone: S.shop.phone, bizNo: S.shop.bizNo || '', logoUrl: S.shop.logoUrl || '', manduId: S.shop.manduId || '' },
      customer: { name: req.customer?.name || '', region: req.customer?.region || '' },
      service: {
        date: a.date || '', timeSlot: optionLabel(timeField, a.timeSlot) || '',
        summary: [a.area ? `${a.area}평` : '', a.isNew ? '신축' : ''].filter(Boolean).join(' · '),
      },
      lines: t.lines.map(({ key, type, label, note, amount }) => ({ key, type: type || 'custom', label, note: note || '', amount: Number(amount) || 0 })),
      total: t.total,
      depositPct: pt.policy.depositPct,
      deposit: t.deposit,
      included: d.included,
      excluded: d.excluded,
      conditions: d.conditions.map(({ label, text }) => ({ label, text: text || '' })),
      cancelPolicy: pt.policy.cancelPolicy || '',
      validDays: pt.policy.validDays,
      issuedAt: today,
      validUntil: addDays(today, pt.policy.validDays),
      verified: d.calc.verified,
      test: !!req.test,
      overrides: d.overrides,
      status: 'sent',
      updatedAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    batch.set(quoteRef, quote);
    batch.update(doc(db, 'requests', req.id), { status: 'sent', quoteId: quoteRef.id, updatedAt: serverTimestamp() });
    await batch.commit();
    showSent(quoteRef.id, quote);
  } catch (e) {
    toast(`발송 실패: ${e.message}`, 4000);
    btn.disabled = false;
  }
}

function showSent(quoteId, quote) {
  const url = pageUrl('view.html', { id: quoteId });
  const msg = `[${quote.shop.name}] ${quote.customer.name}님 ${quote.templateName} 견적서입니다.\n`
    + `합계 ${formatWon(quote.total)} (계약금 ${formatWon(quote.deposit)})\n견적서 보기: ${url}`;
  const dlg = h('dialog.sheet', {},
    h('h2', {}, '견적서가 만들어졌어요'),
    h('p.muted', {}, '아래 문구를 복사해 카톡·문자로 보내세요.'),
    h('pre.msg', {}, msg),
    h('div.btn-col', {},
      h('button.btn.primary.big', { onclick: () => copyText(msg) }, '문구 + 링크 복사'),
      navigator.share ? h('button.btn.ghost', { onclick: () => navigator.share({ text: msg }).catch(() => {}) }, '공유하기') : null,
      h('a.btn.ghost', { href: url, target: '_blank', rel: 'noopener' }, '견적서 미리보기'),
      h('button.btn.ghost', { onclick: () => { dlg.close(); dlg.remove(); location.hash = ''; } }, '목록으로')));
  document.body.append(dlg);
  dlg.showModal();
}
