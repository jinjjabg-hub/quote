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
  registerSW, showFatal, MANDU_ID_RE, setChildren, icon, timeAgo, maskName, tsToDate, footerNote, legalFooter,
} from './util.js';
import { placeLabel, appliedText } from './areaLookup.js';
import { subscribeStaff, renderSchedule } from './staffAdmin.js';
import { subscribeJobs, ensureQuoteJob } from './jobsAdmin.js';
import { openBookingSheet } from './bookingAdmin.js';
import { jobFromRequest, shiftDate } from './schedule.js';
import { pushReady, pushState, enableOwnerPush, thisDeviceToken } from './push.js';
import { fetchBilling, finishCardAuth, renderBillingCard, openPlanSheet, billingLine } from './billing.js';

registerSW();

const app = $('#app');
const S = {
  user: null, shop: null, tpl: null, priceTable: null,
  requests: new Map(), filter: 'all', tab: 'home', unsub: null, detail: null,
  staff: null, unsubStaff: null, sched: {},
  jobs: null, unsubJobs: null, jobWin: null, // 일정: 보고 있는 날짜 앞뒤 구간만 구독
  pushTokens: [], // 새 견적 요청 알림을 받는 내 기기들
  billing: null, // 요금 상태 (서버 함수 billingStatus). null 이면 아직 모름 → 막지 않는다
  settings: {}, // shops/{id}/private/settings (사장님만): scheduleOn 등
};

const NUDGE_DAYS = 2; // 견적을 보내고 이만큼 답이 없으면 "다시 연락" 할 일로 올린다

if (!isConfigured) showFatal('Firebase 설정이 아직 없습니다. js/config.js 를 채운 뒤 다시 열어주세요. (배포.md 참고)');
else onAuthStateChanged(auth, (user) => onUser(user).catch((e) => showFatal(e.message)));

window.addEventListener('hashchange', route);

async function onUser(user) {
  S.unsub?.(); S.unsub = null;
  S.unsubStaff?.(); S.unsubStaff = null; S.staff = null;
  S.unsubJobs?.(); S.unsubJobs = null; S.jobs = null; S.jobWin = null;
  S.user = user;
  if (!user) { renderLogin(); return; }
  setChildren(app, h('p.muted.center', {}, '불러오는 중…'));
  await loadShop();
  subscribeRequests();
  subscribeStaffList();
  route();
  refreshBilling(await finishCardAuth()); // 카드 등록 창에서 돌아온 경우 결제 확인, 아니면 상태만 조회
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
    footerNote(), legalFooter());
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
  S.pushTokens = await getDoc(doc(db, 'shops', uid, 'private', 'push')).then((d) => (d.exists() ? d.data().tokens || [] : [])).catch(() => []);
  S.settings = await getDoc(doc(db, 'shops', uid, 'private', 'settings')).then((d) => (d.exists() ? d.data() : {})).catch(() => ({}));
  if (!S.shop.name) S.tab = 'shop'; // 처음이면 업체 정보부터
}

// 요금 상태를 다시 받아 홈·업체 정보에 반영 (입력 중인 화면은 건드리지 않는다)
async function refreshBilling(known) {
  const b = known || await fetchBilling();
  if (!b) return;
  S.billing = b;
  if (!S.detail && ['home', 'shop'].includes(S.tab) && !document.querySelector('dialog[open]') && S.shop?.name) renderMain();
}
function openPlans(reason) { return openPlanSheet(S.billing, { shop: S.shop, reason, onChange: (b) => { S.billing = b; if (!S.detail) renderMain(); } }); }

function subscribeStaffList() {
  S.unsubStaff?.();
  S.unsubStaff = subscribeStaff(S.user.uid, (list) => {
    const was = scheduleOn();
    S.staff = list;
    if (!S.detail && !document.querySelector('dialog[open]') && (S.tab === 'schedule' || (was !== scheduleOn() && ['home', 'list', 'link'].includes(S.tab)))) renderMain();
  });
}

// 고른 날짜가 구독 구간(앞 7일 ~ 뒤 35일) 밖으로 나가면 다시 구독
function ensureJobs(date) {
  if (S.jobWin && date >= S.jobWin.from && date <= S.jobWin.to) return;
  S.unsubJobs?.();
  S.jobs = null;
  S.jobWin = { from: shiftDate(date, -7), to: shiftDate(date, 35) };
  S.unsubJobs = subscribeJobs(S.user.uid, S.jobWin.from, S.jobWin.to, (list) => {
    S.jobs = list;
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
const TAB_TITLE = { home: '홈', list: '견적 요청', schedule: '일정 · 직원', price: '단가표 관리', link: '내 견적 링크', shop: '업체 정보' };

// 일정·직원 관리는 직원이 있는 업체용 (설계도 12장: 1인 사장님에게는 화면만 복잡).
// 사장님이 업체 정보에서 켜고 끈다. 고른 적이 없으면 직원을 등록한 업체만 켜진 것으로 본다.
function scheduleOn() { return S.settings.scheduleOn ?? !!S.staff?.length; }
function visibleTabs() { return TABS.filter(([k]) => k !== 'schedule' || scheduleOn()); }

function goTab(k) { S.tab = k; renderMain(); window.scrollTo(0, 0); }

function renderMain() {
  if (!S.shop) return;
  app.classList.add('has-nav');
  const body = {
    home: renderHome, list: renderList, price: renderPriceForm, link: renderLinkTab, shop: renderShopForm,
    schedule: () => {
      S.sched.date = S.sched.date || toDateStr(new Date());
      ensureJobs(S.sched.date);
      return renderSchedule({ shopId: S.user.uid, shopName: S.shop.name, staff: S.staff, jobs: S.jobs, st: S.sched, rerender: renderMain });
    },
  }[S.tab === 'schedule' && !scheduleOn() ? 'home' : S.tab] || renderHome;
  setChildren(app,
    appBar(),
    body(),
    h('nav.bottom-nav', { 'aria-label': '메뉴' }, visibleTabs().map(([k, label, ic]) => h(`button.nav-item${S.tab === k ? '.on' : ''}`, {
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

// 고객에게 실제로 보낸 금액. 보낸 견적이 없으면 지금 단가표로 계산한 예상 금액
function requestAmount(r) {
  if (typeof r.quoteTotal === 'number') return r.quoteTotal;
  try { return calculateQuote(S.tpl, S.priceTable, r).total; } catch { return null; /* 템플릿 불일치 */ }
}

// "내 숫자" (설계도 0장). 테스트 요청은 항상 제외한다.
function myNumbers() {
  const real = [...S.requests.values()].filter((r) => !r.test);
  const dayOf = (r) => { const d = tsToDate(r.createdAt); return d ? toDateStr(d) : toDateStr(new Date()); };
  const month = toDateStr(new Date()).slice(0, 7);
  const monthReqs = real.filter((r) => dayOf(r).startsWith(month));
  const sent = monthReqs.filter((r) => ['sent', 'booking_requested', 'confirmed'].includes(r.status)).length;
  const won = monthReqs.filter((r) => r.status === 'confirmed');
  return {
    month: monthReqs.length,
    sent,
    confirmed: won.length,
    wonAmount: won.reduce((sum, r) => sum + (requestAmount(r) || 0), 0),
    rate: sent ? Math.round((won.length / sent) * 100) : null,
  };
}

// 홈 = "지금 할 일". 돈이 되는 순서: ① 계약하겠다는 고객 ② 견적을 기다리는 고객(오래 기다린 순) ③ 견적 받고 답 없는 고객
function todoList() {
  const all = [...S.requests.values()];
  const at = (ts) => tsToDate(ts)?.getTime() ?? Date.now();
  const byOldest = (key) => (a, b) => at(a[key]) - at(b[key]);
  const quiet = (r) => r.status === 'sent' && !r.nudgedAt && Date.now() - at(r.sentAt || r.updatedAt) > NUDGE_DAYS * 86400000;
  return [
    ...all.filter((r) => r.status === 'booking_requested').sort(byOldest('bookingRequestedAt')).map((r) => ({ kind: 'book', r })),
    ...all.filter((r) => r.status === 'new').sort(byOldest('createdAt')).map((r) => ({ kind: 'quote', r })),
    ...all.filter(quiet).sort(byOldest('updatedAt')).map((r) => ({ kind: 'nudge', r })),
  ];
}

function nudgeMessage(r) {
  return `[${S.shop.name}] ${r.customer?.name || '고객'}님, 보내드린 ${S.tpl.name} 견적서 확인해 보셨나요? 궁금한 점은 편하게 연락 주세요.\n견적서 보기: ${pageUrl('view.html', { id: r.quoteId })}`;
}

function smsHref(phone, body) {
  return `sms:${String(phone || '').replace(/[^0-9+]/g, '')}?&body=${encodeURIComponent(body)}`;
}

function renderTodo({ kind, r }) {
  const open = () => { location.hash = `req=${r.id}`; };
  const stop = (fn) => (e) => { e.stopPropagation(); fn?.(); };
  const phone = r.customer?.phone;
  const amount = requestAmount(r);
  const head = {
    book: ['계약 요청', `${timeAgo(r.bookingRequestedAt || r.updatedAt)} 요청`],
    quote: ['견적 기다리는 중', `${timeAgo(r.createdAt)} 접수`],
    nudge: ['답 없음', `견적 보낸 지 ${timeAgo(r.sentAt || r.updatedAt).replace(' 전', '')}`],
  }[kind];
  const action = {
    book: phone ? h('a.btn.ok', { href: telHref(phone), onclick: stop() }, icon('call'), '전화해서 확정') : null,
    quote: h('button.btn.primary', { type: 'button', onclick: stop(open) }, '견적 보내기', icon('arrow_forward')),
    nudge: phone ? h('a.btn.dark', {
      href: smsHref(phone, nudgeMessage(r)),
      onclick: stop(() => updateDoc(doc(db, 'requests', r.id), { nudgedAt: serverTimestamp() }).catch(() => {})),
    }, icon('sms'), '문자로 다시 연락') : null,
  }[kind];
  return h(`li.todo.todo-${kind}`, { onclick: open },
    h('div.todo-head', {}, h('b', {}, head[0]), r.test ? h('span.badge.st-test', {}, '테스트') : null, h('span.todo-wait', {}, head[1])),
    h('div.todo-body', {},
      h('div.grow', {},
        h('div.todo-who', {}, `${maskName(r.customer?.name) || '이름 없음'} 고객님`),
        h('div.muted.small', {}, [r.customer?.region, requestSummary(r).size, r.answers?.date && `희망일 ${r.answers.date.slice(5).replace('-', '/')}`].filter(Boolean).join(' · '))),
      amount != null ? h('div.todo-amount', {}, formatWon(amount)) : null),
    action);
}

// 새 견적 요청이 오면 휴대폰이 울리게 (1순위: 문의를 놓치지 않기). 이미 켠 기기에서는 아무것도 안 보인다.
function renderPushCard() {
  if (!pushReady()) return null;
  const st = pushState();
  if (st === 'unsupported' || (st === 'granted' && S.pushTokens.includes(thisDeviceToken()))) return null;
  const guide = {
    'ios-install': '아이폰은 먼저 아래 공유 버튼 → "홈 화면에 추가"를 한 뒤, 홈 화면의 앱에서 켤 수 있어요.',
    denied: '알림이 차단돼 있어요. 휴대폰 설정 → 알림에서 이 앱을 허용해 주세요.',
  }[st];
  return h('section.card.push-card.off', {},
    h('div.push-head', {}, icon('notifications_active'), h('b', {}, '새 문의가 오면 휴대폰이 울리게 하세요')),
    h('p.small', {}, guide || '지금은 앱을 열어 봐야만 새 요청을 알 수 있어요. 먼저 답하는 업체가 계약합니다.'),
    guide ? null : h('button.btn.primary.block', {
      type: 'button',
      onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try { S.pushTokens = await enableOwnerPush(S.user.uid, S.pushTokens); toast('알림을 켰어요. 새 견적 요청이 오면 이 휴대폰으로 알려드려요.', 3500); renderMain(); }
        catch (err) { toast(err.message, 4000); btn.disabled = false; }
      },
    }, icon('notifications'), '이 휴대폰으로 알림 받기'));
}

function renderHome() {
  const n = myNumbers();
  const todos = todoList();
  const recent = sortedRequests().filter((r) => !todos.some((t) => t.r.id === r.id)).slice(0, 3);
  const step = (label, value) => h('div.funnel-step', {}, h('b', {}, value), h('span', {}, label));
  return h('section', {},
    renderPushCard(),
    renderBillingCard(S.billing, () => openPlans()),
    h('div.section-head', {}, h('h2', {}, '지금 할 일', todos.length ? h('span.pill-count', {}, todos.length) : null)),
    todos.length
      ? h('ul.todo-list', {}, todos.map(renderTodo))
      : h('div.card.empty', {},
        h('p', {}, h('b', {}, S.requests.size ? '밀린 일이 없어요.' : '아직 견적 요청이 없어요.')),
        h('p.muted', {}, '내 링크를 카톡·문자·숨고 채팅에 붙여 고객에게 보내보세요.'),
        h('button.btn.primary.block', { type: 'button', onclick: () => copyText(shopLink()) }, icon('content_copy'), '내 견적 링크 복사')),
    h('div.section-head', {}, h('h2', {}, '이번 달'), h('span.muted.small', {}, '테스트 제외')),
    h('div.card.month', {},
      h('div.funnel', {}, step('요청', n.month), icon('chevron_right'), step('견적 발송', n.sent), icon('chevron_right'), step('계약', n.confirmed)),
      h('div.month-won', {},
        h('span', {}, '계약 금액', n.confirmed ? h('span.muted', {}, ` · 보낸 견적의 ${n.rate}%가 계약`) : null),
        h('b', {}, formatWon(n.wonAmount)))),
    recent.length ? [
      h('div.section-head', {}, h('h2', {}, '그 밖의 최근 요청'),
        h('button.link', { type: 'button', onclick: () => goTab('list') }, '전체보기 ›')),
      h('ul.req-list', {}, recent.map(renderListItem)),
    ] : null,
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
  const amount = requestAmount(r);
  const est = amount == null ? '' : formatWon(amount);
  const quoted = typeof r.quoteTotal === 'number';
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
      h('div.price', {}, h('div.muted', {}, r.status === 'confirmed' ? '계약 금액' : quoted ? '보낸 견적 금액' : '예상 견적 금액'), h(`b${r.status === 'confirmed' ? '.green' : ''}`, {}, est || '-')),
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
    S.billing ? h('div.card', {},
      sectionTitle(null, '요금제'),
      h('p', {}, h('b', {}, billingLine(S.billing))),
      h('button.btn.soft.block', { type: 'button', onclick: () => openPlans() }, icon('payments'), '요금제 보기')) : null,
    h('div.card', {},
      sectionTitle(4, '직원·일정 관리', scheduleOn() ? '사용 중' : '꺼짐'),
      h('p.muted.small', {}, '직원이 있는 업체용입니다. 켜면 아래 메뉴에 "일정"이 생겨 직원 등록·일정표·배정 알림을 쓸 수 있어요. 혼자 일하시면 꺼 두세요.'),
      h('button.btn.soft.block', {
        type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          const next = !scheduleOn();
          try {
            await setDoc(doc(db, 'shops', S.user.uid, 'private', 'settings'), { scheduleOn: next, updatedAt: serverTimestamp() }, { merge: true });
            S.settings = { ...S.settings, scheduleOn: next };
            toast(next ? '일정 메뉴를 켰어요.' : '일정 메뉴를 껐어요. 등록한 직원·일정은 그대로 남아 있어요.', 3000);
            renderMain();
          } catch (err) { toast(`저장 실패: ${err.message}`); btn.disabled = false; }
        },
      }, icon(scheduleOn() ? 'event_busy' : 'calendar_month'), scheduleOn() ? '일정 메뉴 끄기' : '직원이 있어요 · 일정 메뉴 켜기')),
    h('button.btn.ghost.block', { type: 'button', onclick: () => { if (confirm('로그아웃할까요?')) signOut(auth); } }, icon('logout'), '로그아웃'),
    h('a.btn.ghost.block', { href: './account-deletion.html' }, icon('close'), '계정 삭제 요청'),
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
    return batch.commit()
      .then(() => (status === 'confirmed' ? addQuoteJob(req).then(() => openBooking(req)) : toast(`'${STATUS[status].label}'(으)로 바꿨어요.`)))
      .catch((e) => toast(e.message));
  };
  return h('span.status-actions', {},
    req.status !== 'confirmed' && req.status !== 'new' ? h('button.btn.small.ok', { onclick: () => set('confirmed') }, '계약확정') : null,
    req.status === 'confirmed' ? h('button.btn.small.ok', { onclick: () => openBooking(req) }, '확정 안내') : null,
    req.status !== 'hold' ? h('button.btn.small.ghost', { onclick: () => set('hold') }, '보류') : null,
    req.status === 'hold' ? h('button.btn.small.ghost', { onclick: () => set(req.quoteId ? 'sent' : 'new') }, '보류 해제') : null);
}

// 계약확정 → 일정 자동 등록 (설계도 10-1장 ②단계). 인원·시간은 견적의 인력 예상값
async function addQuoteJob(req) {
  let labor = null;
  try { labor = calculateQuote(S.tpl, S.priceTable, req).labor; } catch { /* 템플릿 불일치 → 기본값 */ }
  const job = jobFromRequest(req, { templateName: S.tpl.name, labor, sizeText: requestSummary(req).size });
  try {
    const r = await ensureQuoteJob(S.user.uid, job);
    toast({
      created: scheduleOn() ? `계약확정! ${job.date} ${job.start} 일정에 등록했어요. 일정 탭에서 직원을 배정하세요.` : `계약확정! ${job.date} ${job.start} 일정에 등록했어요.`,
      exists: '계약확정했어요. (일정은 이미 등록되어 있어요)',
      nodate: '계약확정했어요. 희망일이 없어 일정은 일정 탭에서 직접 등록해주세요.',
    }[r], 3500);
  } catch (e) { toast(`계약확정은 됐지만 일정 등록 실패: ${e.message}`, 4000); }
}

// 고객에게 예약 확정 안내 (설계도 10-2장)
function openBooking(req) {
  let labor = null;
  try { labor = calculateQuote(S.tpl, S.priceTable, req).labor; } catch { /* 기본값 */ }
  return openBookingSheet({ shopId: S.user.uid, shop: S.shop, tpl: S.tpl, req: currentReqFor(req), labor, sizeText: requestSummary(req).size })
    .catch((e) => toast(`확정 안내 창을 열지 못했어요: ${e.message}`, 4000));
}
const currentReqFor = (req) => S.requests.get(req.id) || req;

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
    renderQuoteSummary(req),
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
    req.status === 'confirmed'
      // 계약확정 뒤에는 견적서를 다시 만들면 확정 내용이 지워지므로, 아래 버튼은 확정 안내로 바꾼다
      ? h('div.dock', {},
        h('button.btn.primary', { onclick: () => openBooking(req) }, icon('event_available'), '고객에게 확정 안내'),
        h('div.dock-note', {}, h('span', {}, '방문 날짜·시간·준비사항'), h('span', {}, '견적서 링크에 표시')))
      : h('div.dock', {},
        h('button.btn.primary', { onclick: (e) => sendQuote(req, e.currentTarget) }, icon('send'),
          `${formatWon(finalizeLines(S.detail.lines, S.priceTable.policy.depositPct).total)} ${req.quoteId ? '견적서 다시 보내기' : '견적서 보내기'}`),
        h('div.dock-note', {}, h('span', {}, '보내기 전에 한 번 더 확인해요'))),
  );
  renderDetailStatus();
}

// 상세 맨 위 요약: 사장님이 제일 먼저 알고 싶은 것 = "얼마로 나가나, 뭘 확인해야 하나".
// 금액이 맞으면 스크롤 없이 아래 [견적서 보내기]만 누르면 된다.
function renderQuoteSummary(req) {
  const d = S.detail;
  const t = finalizeLines(d.lines, S.priceTable.policy.depositPct);
  const ansLabel = { yes: '예', unknown: '모름', no: '아니오' };
  const risks = S.tpl.checklist
    .filter((i) => req.checklist?.[i.key] === i.risk || req.checklist?.[i.key] === 'unknown')
    .map((i) => h(`span.check-chip${req.checklist[i.key] === 'unknown' ? '.unknown' : ''}`, {}, `${i.short || i.label.replace(/[?？]$/, '')} · ${ansLabel[req.checklist[i.key]]}`));
  const parts = t.lines.filter((l) => l.key !== ROUNDING_KEY).map((l) => l.label);
  return h('section.card.quote-summary', {},
    h('div.sum-label', {}, d.edited ? '직접 고친 금액' : '내 단가표로 계산한 금액'),
    h('div.sum-total', {}, formatWon(t.total)),
    h('div.muted.small', {}, parts.join(' + ')),
    h('div.sum-checks', {},
      h(`span.check-chip${req.photos?.length ? '.ok' : '.unknown'}`, {}, icon('photo_camera'), req.photos?.length ? `사진 ${req.photos.length}장` : '사진 없음'),
      risks),
    h('button.link', { type: 'button', onclick: () => $('.quote-editor')?.scrollIntoView({ behavior: 'smooth' }) }, '금액·항목 고치기 ↓'));
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
    h('details.guide-edit', { open: !!d.guideOpen, ontoggle: (e) => { d.guideOpen = e.currentTarget.open; } },
      h('summary', {}, h('b', {}, '견적서 안내 문구 고치기'), h('span.muted.small', {}, `추가요금 조건 ${d.conditions.length} · 포함 ${d.included.length} · 불포함 ${d.excluded.length}`)),
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
      listEditor('❌ 불포함 항목', d.excluded, 'excluded')));
}

async function sendQuote(req, btn) {
  const d = S.detail;
  const pt = S.priceTable;
  const t = finalizeLines(d.lines, pt.policy.depositPct);
  if (currentReq().status === 'confirmed' && !confirm('계약확정된 요청이에요. 견적서를 다시 만들면 고객 확정 안내가 지워지고 상태가 "견적발송"으로 돌아가요. 계속할까요?')) return;
  if (!S.shop.name || !S.shop.phone) { toast('업체 정보(상호·연락처)를 먼저 저장해주세요.'); return; }
  // 무료 견적을 다 썼고 요금제도 없으면 새 견적서는 못 만든다 (보낸 견적 수정·테스트는 가능). 서버 규칙도 같은 기준으로 막는다
  if (!req.quoteId && !req.test && S.billing && !S.billing.canSend) { openPlans('limit'); return; }
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
        summary: [requestSummary(req).size, a.isNew ? '신축' : ''].filter(Boolean).join(' · '),
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
    // sentAt·quoteTotal: 홈의 "답 없는 견적"·이번 달 계약 금액·견적 발송 시간 지표에 쓴다
    batch.update(doc(db, 'requests', req.id), { status: 'sent', quoteId: quoteRef.id, quoteTotal: t.total, sentAt: serverTimestamp(), nudgedAt: null, updatedAt: serverTimestamp() });
    await batch.commit();
    showSent(quoteRef.id, quote, req.customer?.phone);
    if (!req.test) refreshBilling();
  } catch (e) {
    // 규칙이 막은 경우(다른 기기에서 무료 건수를 다 씀) → 상태를 다시 받아 요금제 안내
    if (e.code === 'permission-denied' && !req.test) { await refreshBilling(); if (S.billing && !S.billing.canSend) { btn.disabled = false; openPlans('limit'); return; } }
    toast(`발송 실패: ${e.message}`, 4000);
    btn.disabled = false;
  }
}

// 견적서를 만든 뒤: 고객 번호로 문자 앱이 바로 열리게 (복사 → 앱 전환 → 고객 찾기 → 붙여넣기를 1번 탭으로)
function showSent(quoteId, quote, phone) {
  const url = pageUrl('view.html', { id: quoteId });
  const msg = `[${quote.shop.name}] ${quote.customer.name}님 ${quote.templateName} 견적서입니다.\n`
    + `합계 ${formatWon(quote.total)} (계약금 ${formatWon(quote.deposit)})\n견적서 보기: ${url}`;
  const dlg = h('dialog.sheet', {},
    h('h2', {}, '견적서가 만들어졌어요'),
    h('p.muted', {}, phone ? '이제 고객에게 보내기만 하면 됩니다.' : '아래 문구를 복사해 카톡·문자로 보내세요.'),
    h('pre.msg', {}, msg),
    h('div.btn-col', {},
      phone ? h('a.btn.primary.big', { href: smsHref(phone, msg) }, icon('sms'), `${quote.customer.name}님께 문자로 보내기`) : null,
      h(`button.btn.${phone ? 'ghost' : 'primary.big'}`, { onclick: () => copyText(msg) }, icon('content_copy'), '문구 + 링크 복사 (카톡용)'),
      navigator.share ? h('button.btn.ghost', { onclick: () => navigator.share({ text: msg }).catch(() => {}) }, '다른 앱으로 공유') : null,
      h('a.btn.ghost', { href: url, target: '_blank', rel: 'noopener' }, '견적서 미리보기'),
      h('button.btn.ghost', { onclick: () => { dlg.close(); dlg.remove(); location.hash = ''; } }, '목록으로')));
  document.body.append(dlg);
  dlg.showModal();
}
