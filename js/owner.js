// 사장님 화면 (owner.html) — 구글 로그인 필요
// 탭: 요청 목록 / 단가표 / 업체 정보,  상세: #req=요청ID
//
// 여러 업종: shops/{uid}.templateIds[] (첫 값 = templateId, 하위호환)
//            shops/{uid}/private/pricing = { byTemplate: { [templateId]: priceTable } }
// 요청은 항상 "요청의 templateId" 템플릿과 그 업종 단가표로 계산한다 (업종을 바꿔도 기존 요청 금액 유지).
import {
  auth, db, storage, isConfigured, signInWithGoogle, onAuthStateChanged, signOut,
  doc, collection, getDoc, setDoc, updateDoc, onSnapshot, query, where, serverTimestamp, writeBatch,
  storageRef, uploadBytes, getDownloadURL,
} from './firebase.js';
import { appConfig, paymentConfig } from './config.js';
import { describeRefundRules } from './payment.js';
import { loadTemplate, cachedTemplate, TEMPLATE_LIST, templateName } from './templates.js';
import {
  calculateQuote, finalizeLines, mergePriceTable, priceWarnings, formatWon, addDays, toDateStr, dateFlags, ROUNDING_KEY,
  shopTemplateIds, normalizePricingDoc, summarize, sendBlockReasons, maxTotal, expandPhotoSlots, photoKey, photoKeyOf,
  cleanRefundRules,
} from './calc.js';
import {
  $, h, toast, copyText, pageUrl, compressImage, STATUS, PAYMENT_STATUS, ACTION_STATUSES, statusBadge, statusInfo,
  fmtDateTime, optionLabel, telHref, registerSW, showFatal, isValidBizNo, formatBizNo,
} from './util.js';

registerSW();

const app = $('#app');
// 화면 교체 (null·false 자식은 건너뜀 — 기본 replaceChildren 은 null 을 글자로 그린다)
const show = (...nodes) => app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
const S = {
  user: null, shop: null, templateIds: [], byTemplate: {}, priceTab: null,
  requests: new Map(), filter: 'all', tab: 'list', unsub: null, detail: null,
};

if (!isConfigured) showFatal('Firebase 설정이 아직 없습니다. js/config.js 를 채운 뒤 다시 열어주세요. (배포.md 참고)');
else onAuthStateChanged(auth, (user) => onUser(user).catch((e) => showFatal(e.message)));

window.addEventListener('hashchange', route);

async function onUser(user) {
  S.unsub?.(); S.unsub = null;
  S.user = user;
  if (!user) { renderLogin(); return; }
  show(h('p.muted.center', {}, '불러오는 중…'));
  await loadShop();
  subscribeRequests();
  route();
}

function renderLogin() {
  show(h('section.card.center', {},
    h('h1', {}, '견적 자동화'),
    h('p.muted', {}, '고객이 링크로 정보를 입력하면 내 단가표로 견적이 자동 계산됩니다.\n사장님은 확인 후 1번 눌러 보내기만 하세요.'),
    h('button.btn.primary.big', {
      onclick: () => signInWithGoogle().catch((e) => toast(`로그인 실패: ${e.message}`)),
    }, 'Google 계정으로 시작하기')));
}

// ---------- 데이터 로드 ----------

const shopRef = () => doc(db, 'shops', S.user.uid);
const pricingRef = () => doc(db, 'shops', S.user.uid, 'private', 'pricing');

async function loadShop() {
  const uid = S.user.uid;
  let snap = await getDoc(shopRef());
  if (!snap.exists()) {
    await setDoc(shopRef(), {
      ownerUid: uid, templateId: appConfig.defaultTemplateId, templateIds: [appConfig.defaultTemplateId],
      name: '', ownerName: S.user.displayName || '', phone: '', bizNo: '', logoUrl: '',
      createdAt: serverTimestamp(),
    });
    snap = await getDoc(shopRef());
  }
  S.shop = snap.data();
  S.templateIds = shopTemplateIds(S.shop, appConfig.defaultTemplateId);
  await Promise.all(S.templateIds.map(loadTemplate));
  const p = await getDoc(pricingRef());
  S.byTemplate = normalizePricingDoc(p.exists() ? p.data() : null, S.shop).byTemplate;
  S.priceTab = S.templateIds[0];
  if (!S.shop.name) S.tab = 'shop'; // 처음이면 업체 정보부터
}

async function reloadShopDoc() {
  const snap = await getDoc(shopRef());
  if (snap.exists()) S.shop = snap.data();
}

/** 업종 단가표 (저장값 + 템플릿 기본값). 템플릿을 아직 안 불러왔으면 null */
function priceTableFor(tid) {
  const tpl = cachedTemplate(tid);
  return tpl ? mergePriceTable(tpl, S.byTemplate[tid] || {}) : null;
}

async function savePricing() {
  await setDoc(pricingRef(), { byTemplate: S.byTemplate, updatedAt: serverTimestamp() });
}

function reqTemplateId(r) { return r.templateId || S.shop.templateId || appConfig.defaultTemplateId; }

const loadingTpl = new Set();
/** 목록용: 요청 업종 템플릿이 캐시에 없으면 불러온 뒤 다시 그린다 */
function ensureTemplate(tid) {
  if (cachedTemplate(tid) || loadingTpl.has(tid)) return;
  loadingTpl.add(tid);
  loadTemplate(tid).then(() => { if (!S.detail && S.tab === 'list') renderMain(); })
    .catch(() => {}).finally(() => loadingTpl.delete(tid));
}

function subscribeRequests() {
  const q = query(collection(db, 'requests'), where('shopId', '==', S.user.uid));
  S.unsub = onSnapshot(q, (snap) => {
    S.requests = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    if (!S.detail && S.tab === 'list') renderMain();
    if (S.detail) renderDetailStatus();
  }, (e) => toast(`목록을 불러오지 못했습니다: ${e.message}`, 4000));
}

function route() {
  const m = /req=([\w-]+)/.exec(location.hash);
  if (m) openDetail(m[1]).catch((e) => toast(e.message, 4000)); else { S.detail = null; renderMain(); }
}

// ---------- 메인 (탭) ----------

function shopLink(t) { return pageUrl('q.html', t ? { shop: S.user.uid, t } : { shop: S.user.uid }); }

function renderMain() {
  if (!S.shop) return;
  const tabs = [['list', '견적 요청'], ['price', '단가표'], ['shop', '업체 정보']];
  show(
    topBar(),
    S.shop.name && S.shop.bizVerified !== true ? h('div.warn-box', {},
      '아직 사업자 인증 전이에요. 견적은 보낼 수 있지만, 고객이 믿고 결제하려면 인증을 먼저 해 주세요. (업체 정보 탭)') : null,
    h('section.card.link-card', {},
      h('div', {}, h('b', {}, '내 견적 링크'), h('div.muted.small', {}, '카톡·문자·숨고 채팅에 붙여넣으세요')),
      h('button.btn.primary', { onclick: () => copyText(shopLink()) }, '링크 복사')),
    h('nav.tabs', {}, tabs.map(([k, label]) => h(`button.tab${S.tab === k ? '.on' : ''}`, {
      onclick: () => { S.tab = k; renderMain(); },
    }, label, k === 'list' ? countBadge() : null))),
    S.tab === 'list' ? renderList() : S.tab === 'price' ? renderPriceForm() : renderShopForm(),
  );
}

function topBar() {
  return h('header.topbar', {},
    h('div.shop-name', {}, S.shop.name || '내 업체', S.shop.bizVerified === true ? h('span.badge.st-ok', {}, '인증') : null),
    h('button.btn.ghost.small', { onclick: () => signOut(auth) }, '로그아웃'));
}

function countBadge() {
  const n = [...S.requests.values()].filter((r) => ACTION_STATUSES.includes(r.status)).length;
  return n ? h('span.count', {}, n) : null;
}

function renderList() {
  const prio = (r) => { const i = ACTION_STATUSES.indexOf(r.status); return i < 0 ? 99 : i; };
  const all = [...S.requests.values()].sort((a, b) => (prio(a) - prio(b))
    || ((b.createdAt?.seconds ?? 9e9) - (a.createdAt?.seconds ?? 9e9)));
  const countOf = (k) => all.filter((r) => r.status === k).length;
  const filters = [['all', '전체'],
    ...Object.entries(STATUS).map(([k, v]) => [k, v.label]),
    // 결제 관련 상태는 해당 건이 있을 때만 칩을 보여준다 (M8)
    ...Object.entries(PAYMENT_STATUS).filter(([k]) => countOf(k) > 0 || S.filter === k).map(([k, v]) => [k, v.label])];
  const shown = S.filter === 'all' ? all : all.filter((r) => r.status === S.filter);
  return h('section', {},
    h('div.choices.filter', {}, filters.map(([k, label]) => {
      const n = k === 'all' ? all.length : countOf(k);
      return h(`button.chip.small${S.filter === k ? '.on' : ''}`, { onclick: () => { S.filter = k; renderMain(); } }, `${label} ${n}`);
    })),
    shown.length ? h('ul.req-list', {}, shown.map(renderListItem))
      : h('div.card.empty', {}, h('p', {}, '아직 견적 요청이 없습니다.'),
        h('p.muted', {}, '위 "링크 복사"를 눌러 고객에게 보내보세요.')));
}

function renderListItem(r) {
  const tid = reqTemplateId(r);
  const tpl = cachedTemplate(tid);
  let est = '';
  let summary = '';
  if (!tpl) { ensureTemplate(tid); est = '…'; } else {
    try { est = formatWon(calculateQuote(tpl, priceTableFor(tid), r).total); } catch { /* 템플릿 불일치 */ }
    summary = summarize(tpl, r.answers || {});
  }
  const a = r.answers || {};
  const oldType = !S.templateIds.includes(tid);
  return h('li.req-item', { onclick: () => { location.hash = `req=${r.id}`; } },
    h('div.req-main', {},
      h('div', {}, h('b', {}, r.customer?.name || '이름 없음'), ' ', h('span.muted', {}, r.customer?.region || '')),
      (S.templateIds.length > 1 || oldType)
        ? h('div.small', {}, h('span.badge', {}, templateName(tid)), oldType ? h('span.badge.st-hold', {}, '이전 업종 요청') : null)
        : null,
      h('div.muted.small', {}, [summary, a.date || '', r.photos?.length ? `사진 ${r.photos.length}` : ''].filter(Boolean).join(' · '))),
    h('div.req-side', {}, statusBadge(r.status), h('div.amount', {}, est), h('div.muted.small', {}, fmtDateTime(r.createdAt))));
}

// ---------- 단가표 (업종별) ----------

function renderPriceForm() {
  if (!S.templateIds.includes(S.priceTab)) S.priceTab = S.templateIds[0];
  const tid = S.priceTab;
  const tpl = cachedTemplate(tid);
  if (!tpl) { loadTemplate(tid).then(() => renderMain()); return h('p.muted', {}, '불러오는 중…'); }
  const pt = structuredClone(priceTableFor(tid));
  const p = tpl.pricing;
  const warn = h('div.warn-box', { hidden: true });
  const updateWarn = () => {
    const w = priceWarnings(tpl, pt);
    warn.hidden = !w.length; warn.textContent = w.map((x) => `⚠️ ${x}`).join('\n');
  };
  const numInput = (get, set, suffix) => h('div.input-suffix', {},
    h('input.input', {
      type: 'number', inputMode: 'numeric', min: 0, value: get(),
      oninput: (e) => { set(e.target.value === '' ? 0 : Number(e.target.value)); updateWarn(); },
    }), h('span', {}, suffix));
  const row = (label, control, sub) => h('label.price-row', {}, h('span', {}, label, sub ? h('span.muted.small', {}, ` ${sub}`) : null), control);

  updateWarn();
  return h('section.card', {},
    S.templateIds.length > 1 ? h('div.choices.filter', {}, S.templateIds.map((id) => h(`button.chip.small${id === tid ? '.on' : ''}`, {
      onclick: () => { S.priceTab = id; renderMain(); },
    }, templateName(id)))) : null,
    h('p.notice', {}, '처음 보이는 금액은 예시예요. 사장님 가게 가격으로 꼭 바꿔 주세요. (가격은 사장님이 정해요)'),
    h('p.muted.small', {}, `${tpl.name} 기본값이 채워져 있어요. 숫자만 고치고 저장하세요.`),
    S.templateIds.length > 1 ? h('button.btn.ghost.small', { onclick: () => copyText(shopLink(tid)) }, `${tpl.name}만 바로 여는 링크 복사`) : null,
    h('h3', {}, '기본'),
    row(p.base.unitPriceLabel, numInput(() => pt.unitPrice, (v) => { pt.unitPrice = v; }, `원/${p.base.unit}`)),
    warn,
    row(p.base.minPriceLabel, numInput(() => pt.minPrice, (v) => { pt.minPrice = v; }, '원')),
    (p.surcharges || []).length ? h('h3', {}, '할증') : null,
    (p.surcharges || []).map((s) => row(s.label, numInput(() => pt.surcharges[s.key] ?? 0, (v) => { pt.surcharges[s.key] = v; }, '%'))),
    (p.surcharges || []).length ? h('p.muted.small', {}, '주말·공휴일·손 없는 날은 고객 희망 날짜로 자동 판단합니다. (대체공휴일은 상세 화면에서 직접 체크)') : null,
    h('h3', {}, '옵션'),
    h('p.muted.small', {}, '0원으로 두면 견적서에 그 항목이 나오지 않아요.'),
    p.options.map((o) => row(o.priceLabel || o.label, numInput(() => pt.options[o.key] ?? 0, (v) => { pt.options[o.key] = v; }, '원'))),
    h('h3', {}, '정책'),
    row('견적 유효기간', numInput(() => pt.policy.validDays, (v) => { pt.policy.validDays = v; }, '일')),
    row('계약금 비율', numInput(() => pt.policy.depositPct, (v) => { pt.policy.depositPct = v; }, '%')),
    h('label.field', {}, h('span.label', {}, '취소 규정'),
      h('textarea.input', { rows: 3, value: pt.policy.cancelPolicy || '', oninput: (e) => { pt.policy.cancelPolicy = e.target.value; } })),
    refundRulesEditor(pt),
    h('button.btn.primary.block', {
      onclick: async (e) => {
        e.target.disabled = true;
        const before = S.byTemplate[tid];
        try {
          pt.policy.refundRules = cleanRefundRules(pt.policy.refundRules) || [];
          S.byTemplate = { ...S.byTemplate, [tid]: pt };
          await savePricing();
          toast(`${tpl.name} 단가표를 저장했어요.`);
        } catch (err) {
          S.byTemplate = { ...S.byTemplate, [tid]: before };
          toast(`저장 실패: ${err.message}`);
        }
        e.target.disabled = false;
      },
    }, `${tpl.name} 단가표 저장`));
}

// 환불 계산 규칙 편집 (규칙 정리는 calc.js cleanRefundRules)
function refundRulesEditor(pt) {
  pt.policy.refundRules = Array.isArray(pt.policy.refundRules) ? pt.policy.refundRules : [];
  const rules = pt.policy.refundRules;
  const box = h('div.refund-editor');
  const preview = h('p.muted.small');
  const draw = () => {
    preview.textContent = describeRefundRules(cleanRefundRules(rules) || []) || '규칙이 없으면 환불 금액은 사장님이 직접 입력해요.';
    box.replaceChildren(...rules.map((r, i) => {
      const within = r.type === 'withinDaysOfPayment';
      const n = (key, val) => h('input.input.small-num', {
        type: 'number', inputMode: 'numeric', min: 0, value: val ?? '',
        oninput: (e) => { r[key] = e.target.value === '' ? '' : Number(e.target.value); preview.textContent = describeRefundRules(cleanRefundRules(rules) || []); },
      });
      return h('div.refund-row', {},
        within ? ['결제 후 ', n('days', r.days), '일 이내(작업일 전)'] : ['작업 ', n('daysBefore', r.daysBefore), '일 전까지'],
        ' 취소 → 계약금 ', n('pct', r.pct), '% 환불 ',
        h('button.btn.round.ghost', { type: 'button', title: '삭제', onclick: () => { rules.splice(i, 1); draw(); } }, '×'));
    }));
  };
  draw();
  return h('div.field', {}, h('span.label', {}, '환불 계산 규칙 (선택, 온라인 결제 환불 자동 계산)'),
    box, preview,
    h('div.btn-row', {},
      h('button.btn.ghost.small', { type: 'button', onclick: () => { rules.push({ daysBefore: 3, pct: 100 }); draw(); } }, '+ 작업 N일 전'),
      h('button.btn.ghost.small', { type: 'button', onclick: () => { rules.push({ type: 'withinDaysOfPayment', days: 7, pct: 100 }); draw(); } }, '+ 결제 후 N일 이내')));
}

// ---------- 업체 정보 + 업종 선택 + 사업자 인증 ----------

function functionsBase() {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  let emu = false;
  try { emu = isLocal && localStorage.getItem('emulator') === '1'; } catch { /* 무시 */ }
  if (emu) return 'http://127.0.0.1:5001/demo-quote/asia-northeast3';
  return String(appConfig.functionsBaseUrl || paymentConfig?.functionsBaseUrl || '').replace(/\/$/, '');
}

/** 서버 함수 호출 (Firebase 로그인 토큰 첨부). 실패 시 Error(message) + code/nextAt */
async function callFn(name, body) {
  const token = await auth.currentUser.getIdToken();
  let res;
  try {
    res = await fetch(`${functionsBase()}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('서버에 연결하지 못했어요. 인터넷 연결을 확인해주세요.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const code = json.code || json.error || '';
    // legal copy-snippets §5 문구. 나머지 코드(use_update, not_verified, no_change, invalid_biz_no, nts_02, nts_03,
    // nts_unregistered, nts_unavailable 등)는 서버가 보낸 문구를 그대로 보여준다.
    const msg = code === 'biz_taken' ? '이 사업자번호는 이미 다른 계정에 등록되어 있어요. 본인 사업자인데 등록한 적이 없다면 고객센터로 알려주세요.'
      : code === 'too_soon' ? `업체명·사업자번호는 30일에 한 번만 바꿀 수 있어요.${json.nextAt ? ` ${String(json.nextAt).slice(0, 10)}부터 다시 바꿀 수 있어요.` : ''}`
        : json.message || `오류 (${res.status})`;
    throw Object.assign(new Error(msg), { code, nextAt: json.nextAt, body: json });
  }
  return json;
}

function bizStatusBadge() {
  if (S.shop.bizVerified === true) {
    return h('span.badge.st-ok', {}, S.shop.bizVerifiedMode === 'checksum_only' ? '인증됨(테스트: 번호 형식만)' : '사업자 인증됨');
  }
  return h('span.badge.st-hold', {}, functionsBase() ? '인증 전' : '인증 전 · 서버 미연결');
}

function renderShopForm() {
  const f = { ...S.shop, templateIds: [...S.templateIds] };
  const verified = S.shop.bizVerified === true;
  const text = (key, label, opts = {}) => h('label.field', {}, h('span.label', {}, label, opts.optional ? h('span.muted', {}, ' (선택)') : null),
    h('input.input', { type: opts.type || 'text', value: f[key] || '', placeholder: opts.placeholder || '', maxLength: opts.maxLength || 60,
      disabled: !!opts.locked, inputMode: opts.inputMode,
      oninput: (e) => { f[key] = e.target.value.trim(); } }));
  const logoImg = h('img.logo', { src: f.logoUrl || '', alt: '', hidden: !f.logoUrl });
  const logoInput = h('input', {
    type: 'file', accept: 'image/*', hidden: true,
    onchange: async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      try {
        const blob = await compressImage(file, 400, 0.85);
        const r = storageRef(storage, `shops/${S.user.uid}/logo.jpg`);
        await uploadBytes(r, blob, { contentType: 'image/jpeg' });
        f.logoUrl = await getDownloadURL(r);
        logoImg.src = f.logoUrl; logoImg.hidden = false;
        toast('로고를 올렸어요. 저장을 눌러주세요.');
      } catch (err) { toast(`업로드 실패: ${err.message}`); }
    },
  });

  // 업종 다중 선택 (칩) — 새로 고른 업종은 템플릿 기본 단가로 바로 채워진다
  const typeBox = h('div.choices');
  const drawTypes = () => typeBox.replaceChildren(...TEMPLATE_LIST.map((t) => {
    const on = f.templateIds.includes(t.id);
    return h(`button.chip${on ? '.on' : ''}`, {
      type: 'button',
      onclick: () => {
        if (on && f.templateIds.length === 1) { toast('업종은 1개 이상 골라주세요.'); return; }
        f.templateIds = on ? f.templateIds.filter((x) => x !== t.id) : [...f.templateIds, t.id];
        drawTypes();
      },
    }, `${on ? '✓ ' : ''}${t.name}`);
  }));
  drawTypes();

  return h('section.card', {},
    !S.shop.name ? h('p.notice', {}, '처음 오셨네요! 업종을 고르고 견적서에 표시될 업체 정보를 입력해주세요. 단가는 업종 기본값이 채워져요.') : null,
    h('div.field', {}, h('span.label', {}, '업종 (여러 개 가능)'), typeBox,
      h('span.hint', {}, '업종을 빼도 그 업종으로 들어온 기존 요청과 단가표는 그대로 남아요.')),
    h('div.field', {}, h('span.label', {}, '사업자 인증 '), bizStatusBadge(),
      h('p.muted.small', {}, '사업자 인증: 사업자등록번호를 국세청에 조회해 영업 중인 사업자인지 확인해요.\n'
        + '· 사업자번호 1개는 계정 1개에서만 쓸 수 있어요.\n'
        + '· 인증 후 업체명·사업자번호는 30일에 한 번만 바꿀 수 있고, 변경 기록이 남아요.\n'
        + '· 계정은 다른 사업자와 함께 쓰거나 넘겨줄 수 없어요.')),
    text('name', '상호', { placeholder: '예) 반짝입주청소', locked: verified }),
    text('bizNo', '사업자번호', { placeholder: '000-00-00000', locked: verified, inputMode: 'numeric', maxLength: 12 }),
    verified
      ? h('button.btn.ghost.small', { type: 'button', onclick: openIdentityChange }, '상호·사업자번호 변경 요청')
      : h('button.btn.ghost', { type: 'button', onclick: (e) => verifyBiz(f, e.target) }, '사업자 인증하기'),
    text('ownerName', '대표자'),
    text('phone', '연락처', { type: 'tel', placeholder: '010-0000-0000' }),
    h('div.field', {}, h('span.label', {}, '로고', h('span.muted', {}, ' (선택)')),
      h('div.logo-row', {}, logoImg, h('button.btn.ghost', { onclick: () => logoInput.click() }, '로고 올리기'), logoInput)),
    h('p.muted.small', {}, '상호·대표자·연락처·사업자번호·로고는 고객 견적 화면과 견적서에 공개돼요.'),
    h('button.btn.primary.block', {
      onclick: async (e) => {
        if (!f.name || !f.phone) { toast('상호와 연락처는 꼭 입력해주세요.'); return; }
        if (!verified && f.bizNo && !isValidBizNo(f.bizNo)) { toast('사업자번호를 다시 확인해주세요. (10자리, 형식 오류)'); return; }
        e.target.disabled = true;
        try {
          await saveShop(f);
          toast('저장했어요.');
          S.tab = 'price'; renderMain();
        } catch (err) { toast(`저장 실패: ${err.message}`); e.target.disabled = false; }
      },
    }, '저장'));
}

async function saveShop(f) {
  const verified = S.shop.bizVerified === true;
  const ids = f.templateIds.length ? f.templateIds : S.templateIds;
  const data = {
    ownerName: f.ownerName || '', phone: f.phone, logoUrl: f.logoUrl || '',
    templateIds: ids, templateId: ids[0], updatedAt: serverTimestamp(),
  };
  // 인증 후 상호·사업자번호는 서버(updateIdentity)만 바꾼다 — 규칙도 막는다
  if (!verified) Object.assign(data, { name: f.name, bizNo: f.bizNo ? formatBizNo(f.bizNo) : '' });
  await updateDoc(shopRef(), data);
  S.shop = { ...S.shop, ...data };
  S.templateIds = ids;
  // 새로 고른 업종: 템플릿 기본 단가로 단가표를 채워 둔다 (3분 설정)
  await Promise.all(ids.map(loadTemplate));
  const added = ids.filter((id) => !S.byTemplate[id]);
  if (added.length) {
    for (const id of added) S.byTemplate[id] = mergePriceTable(cachedTemplate(id), {});
    await savePricing();
  }
  if (!ids.includes(S.priceTab)) S.priceTab = ids[0];
}

async function verifyBiz(f, btn) {
  const bizNo = formatBizNo(f.bizNo || '');
  if (!f.name) { toast('상호를 먼저 입력해주세요.'); return; }
  if (!isValidBizNo(bizNo)) { toast('사업자번호가 올바르지 않아요. 10자리 숫자를 확인해주세요.'); return; }
  btn.disabled = true;
  try {
    await saveShop({ ...f, bizNo });
    if (!functionsBase()) {
      toast('번호 형식은 맞아요. 서버가 연결되면 국세청 확인으로 인증이 완료돼요. (지금은 서버 미연결)', 4500);
      renderMain();
      return;
    }
    await callFn('verifyBusiness', { bizNo });
    await reloadShopDoc();
    toast(S.shop.bizVerified ? '사업자 인증이 완료됐어요.' : '인증 요청을 보냈어요.');
    renderMain();
  } catch (err) {
    toast(err.message, 4500);
    btn.disabled = false;
  }
}

function openIdentityChange() {
  if (!functionsBase()) { toast('서버 미연결 상태라 지금은 바꿀 수 없어요.'); return; }
  const v = { name: S.shop.name || '', bizNo: S.shop.bizNo || '' };
  const dlg = h('dialog.sheet', {},
    h('h2', {}, '상호·사업자번호 변경 요청'),
    h('p.muted.small', {}, '30일에 한 번만 바꿀 수 있어요. 사업자번호를 바꾸면 다시 인증해요. 변경 기록은 남아요.'),
    h('label.field', {}, h('span.label', {}, '상호'),
      h('input.input', { value: v.name, maxLength: 60, oninput: (e) => { v.name = e.target.value.trim(); } })),
    h('label.field', {}, h('span.label', {}, '사업자번호'),
      h('input.input', { value: v.bizNo, maxLength: 12, inputMode: 'numeric', oninput: (e) => { v.bizNo = e.target.value.trim(); } })),
    h('div.btn-col', {},
      h('button.btn.primary', {
        onclick: async (e) => {
          const body = {};
          if (v.name && v.name !== S.shop.name) body.name = v.name;
          if (v.bizNo && formatBizNo(v.bizNo) !== S.shop.bizNo) {
            if (!isValidBizNo(v.bizNo)) { toast('사업자번호가 올바르지 않아요.'); return; }
            body.bizNo = formatBizNo(v.bizNo);
          }
          if (!Object.keys(body).length) { toast('바뀐 내용이 없어요.'); return; }
          e.target.disabled = true;
          try {
            await callFn('updateIdentity', body);
            await reloadShopDoc();
            dlg.close(); dlg.remove();
            toast('변경했어요.');
            renderMain();
          } catch (err) { toast(err.message, 4500); e.target.disabled = false; }
        },
      }, '변경 요청'),
      h('button.btn.ghost', { onclick: () => { dlg.close(); dlg.remove(); } }, '닫기')));
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- 요청 상세 + 견적 편집 ----------

async function openDetail(id) {
  const req = S.requests.get(id) || await getDoc(doc(db, 'requests', id)).then((s) => (s.exists() ? { id, ...s.data() } : null));
  if (!req) { toast('요청을 찾을 수 없습니다.'); location.hash = ''; return; }
  const tid = reqTemplateId(req);
  const tpl = await loadTemplate(tid);
  let quote = null;
  if (req.quoteId) {
    const qs = await getDoc(doc(db, 'quotes', req.quoteId));
    if (qs.exists()) quote = qs.data();
  }
  const oldType = !S.templateIds.includes(tid);
  S.detail = {
    id, req, tid, tpl, quote, oldType,
    noPricing: oldType && !S.byTemplate[tid], // 업종을 뺐고 그 업종 단가표도 없음 → 발송 금지
    pt: priceTableFor(tid),
    overrides: quote?.overrides || { surcharges: {}, options: {} },
  };
  if (quote) {
    Object.assign(S.detail, {
      lines: quote.lines, conditions: (quote.conditions || []).map((c) => ({ amount: null, ...c })),
      included: quote.included, excluded: quote.excluded,
      calc: calculateQuote(tpl, S.detail.pt, req, S.detail.overrides),
    });
  } else recalc(req);
  renderDetail();
}

function recalc(req) {
  const d = S.detail;
  const c = calculateQuote(d.tpl, d.pt, req, d.overrides);
  Object.assign(d, {
    calc: c, lines: c.lines.map((l) => ({ ...l })),
    conditions: c.conditions.map(({ label, text, amount }) => ({ label, text, amount: amount ?? null })),
    included: [...c.included], excluded: [...c.excluded],
  });
}

function currentReq() { return S.requests.get(S.detail.id) || S.detail.req; }

function renderDetailStatus() {
  const box = $('#status-box');
  const req = currentReq();
  if (box && req) box.replaceChildren(statusBadge(req.status), ' ', statusActions(req));
}

function statusActions(req) {
  const paid = !!S.detail?.quote?.payment;
  const set = (status) => {
    // 견적서(고객 화면)의 상태도 함께 맞춘다
    const batch = writeBatch(db);
    batch.update(doc(db, 'requests', req.id), { status, updatedAt: serverTimestamp() });
    if (req.quoteId) batch.update(doc(db, 'quotes', req.quoteId), { status, updatedAt: serverTimestamp() });
    return batch.commit().then(() => toast(`'${statusInfo(status).label}'(으)로 바꿨어요.`)).catch((e) => toast(e.message));
  };
  // 결제 기록이 있으면 보류 해제 시 '계약금완료'로 되돌린다 (M8: 'sent'로 가면 결제 버튼이 다시 보임)
  const unhold = paid ? 'paid_deposit' : req.quoteId ? 'sent' : 'new';
  return h('span.status-actions', {},
    !['confirmed', 'new', 'canceled'].includes(req.status) ? h('button.btn.small.ok', { onclick: () => set('confirmed') }, '계약확정') : null,
    !['hold', 'canceled'].includes(req.status) ? h('button.btn.small.ghost', { onclick: () => set('hold') }, '보류') : null,
    req.status === 'hold' ? h('button.btn.small.ghost', { onclick: () => set(unhold) }, '보류 해제') : null);
}

function renderDetail() {
  const d = S.detail;
  const tpl = d.tpl;
  const req = currentReq();
  const a = req.answers || {};
  const fields = tpl.steps.flatMap((s) => s.fields);
  const flags = dateFlags(a.date);

  const infoRows = fields
    .filter((f) => !['checklist', 'extras', 'photos', 'name', 'phone', 'region'].includes(f.type) && !['name', 'phone', 'region'].includes(f.key))
    .map((f) => [f.label, a[f.key] === undefined || a[f.key] === '' ? '-' : String(optionLabel(f, a[f.key]))]);
  if (a.date) {
    const tags = [flags.$weekend && '주말', flags.$holiday && '공휴일', flags.$sonEomneun && '손 없는 날'].filter(Boolean);
    if (tags.length) infoRows.push(['날짜 판정', tags.join(', ')]);
  }
  const extras = (a.extras || []).map((k) => tpl.pricing.options.find((o) => o.key === k)?.label || k);
  if (extras.length) infoRows.push(['고객 요청 서비스', extras.join(', ')]);
  if (req.consent?.version) infoRows.push(['개인정보 동의', `${req.consent.version} · ${fmtDateTime(req.consent.at)}`]);

  const ansLabel = { yes: '예', no: '아니오', unknown: '모름' };

  show(
    h('header.topbar', {},
      h('button.btn.ghost.small', { onclick: () => { location.hash = ''; } }, '← 목록'),
      h('div.status-box', { id: 'status-box' })),
    h('section.card', {},
      h('div.cust-head', {},
        h('div', {}, h('h2', {}, req.customer?.name || '고객'), h('div.muted', {}, req.customer?.region || ''),
          h('div.small', {}, h('span.badge', {}, tpl.name), d.oldType ? h('span.badge.st-hold', {}, '이전 업종 요청') : null),
          h('div.muted.small', {}, `접수 ${fmtDateTime(req.createdAt)}`)),
        req.customer?.phone ? h('a.btn.primary.small', { href: telHref(req.customer.phone) }, `📞 ${req.customer.phone}`) : null),
      h('dl.kv', {}, infoRows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('h3', {}, '추가요금 체크리스트'),
      h('dl.kv', {}, (tpl.checklist || []).map((i) => {
        const ans = req.checklist?.[i.key];
        const risky = ans === i.risk || ans === 'unknown';
        return [h('dt', {}, i.label), h(`dd${risky ? '.risk' : ''}`, {}, ansLabel[ans] || '-')];
      })),
      a.memo ? [h('h3', {}, '요청사항'), h('p.memo', {}, a.memo)] : null,
      h('h3', {}, `사진 ${req.photos?.length || 0}장`),
      req.photos?.length ? renderPhotoGroups(tpl, req) : h('p.muted', {}, '사진 없음 — 현장 추가요금 조건을 꼼꼼히 적어주세요.')),
    d.quote?.payment ? renderPaymentPanel(req) : null,
    renderQuoteEditor(req),
  );
  renderDetailStatus();
}

// ---------- 결제 내역 · 환불 (M8) ----------
// 영수증·orderId 는 payments/{orderId} 에서만 읽는다 (quotes.payment 에는 금액·상태만 있음).

const PAY_LABEL = {
  paid: '결제 완료', partial_canceled: '일부 환불', canceled: '전액 환불', waiting_deposit: '입금 대기',
  confirming: '승인 중', unknown: '확인 필요', amount_mismatch: '금액 불일치(확인 필요)',
};

function getOnce(q) {
  return new Promise((resolve, reject) => {
    const un = onSnapshot(q, (snap) => { setTimeout(() => un(), 0); resolve(snap); }, reject);
  });
}

function renderPaymentPanel(req) {
  const box = h('div', {}, h('p.muted.small', {}, '결제 내역을 불러오는 중…'));
  const q = query(collection(db, 'payments'), where('shopId', '==', S.user.uid), where('quoteId', '==', req.quoteId));
  getOnce(q).then((snap) => {
    const pays = snap.docs.map((x) => ({ orderId: x.id, ...x.data() }))
      .filter((p) => !['ready', 'failed'].includes(p.status));
    if (!pays.length) { box.replaceChildren(h('p.muted.small', {}, '결제 기록이 없어요.')); return; }
    box.replaceChildren(...pays.map((p) => {
      const refunded = (p.refunds || []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
      return h('div.pay-row', {},
        h('dl.kv', {},
          h('dt', {}, '결제 금액'), h('dd', {}, formatWon(p.amount)),
          h('dt', {}, '상태'), h('dd', {}, PAY_LABEL[p.status] || p.status),
          refunded ? [h('dt', {}, '환불한 금액'), h('dd', {}, formatWon(refunded))] : null,
          p.approvedAt ? [h('dt', {}, '결제 시각'), h('dd', {}, fmtDateTime(p.approvedAt))] : null,
          h('dt', {}, '주문번호'), h('dd.small', {}, p.orderId)),
        p.receiptUrl ? h('a.btn.ghost.small', { href: p.receiptUrl, target: '_blank', rel: 'noopener' }, '영수증') : null,
        ['paid', 'partial_canceled'].includes(p.status)
          ? h('button.btn.ghost.small', { onclick: () => openRefund(p) }, '환불하기') : null);
    }));
  }).catch((e) => box.replaceChildren(h('p.muted.small', {}, `결제 내역을 불러오지 못했어요: ${e.message}`)));
  return h('section.card', {}, h('h2', {}, '결제 · 환불'), box);
}

/** 환불: 서버 미리보기(고객이 동의한 문구·자동 계산 제안) → 금액 확인·입력 → 실행 */
async function openRefund(pay) {
  if (!functionsBase()) { toast('서버 미연결 상태라 환불할 수 없어요.'); return; }
  let pv;
  try { pv = await callFn('cancelPayment', { orderId: pay.orderId, preview: true }); } catch (e) { toast(e.message, 4500); return; }
  const ag = pv.agreed || {};
  const v = { amount: pv.suggested ?? '', reason: '고객 요청 취소' };
  const dlg = h('dialog.sheet', {},
    h('h2', {}, '계약금 환불'),
    h('p.muted.small', {}, '고객이 결제할 때 동의한 내용이에요. 이 기준으로 환불 금액을 정해 주세요.'),
    h('dl.kv', {},
      h('dt', {}, '취소 규정'), h('dd', {}, ag.cancelPolicyText || '-'),
      ag.refundRulesText ? [h('dt', {}, '환불 계산'), h('dd', {}, ag.refundRulesText)] : null,
      ag.customMade ? [h('dt', {}, '맞춤 제작 고지'), h('dd', {}, ag.customMadeText || '동의함')] : null,
      h('dt', {}, '동의 시각'), h('dd', {}, ag.agreedAt ? fmtDateTime(ag.agreedAt) : '-'),
      h('dt', {}, '환불 가능 금액'), h('dd', {}, formatWon(pv.refundable)),
      pv.suggested != null ? [h('dt', {}, '규칙 계산'), h('dd', {}, `${formatWon(pv.suggested)} (작업 ${pv.calc?.daysBefore}일 전, ${pv.calc?.pct}%)`)] : null),
    h('label.field', {}, h('span.label', {}, '환불 금액 (원)'),
      h('input.input', { type: 'number', inputMode: 'numeric', min: 1, max: pv.refundable, value: v.amount,
        oninput: (e) => { v.amount = e.target.value; } })),
    h('label.field', {}, h('span.label', {}, '사유'),
      h('input.input', { value: v.reason, maxLength: 200, oninput: (e) => { v.reason = e.target.value; } })),
    h('div.btn-col', {},
      h('button.btn.primary', {
        onclick: async (e) => {
          const amount = Math.round(Number(v.amount));
          if (!(amount > 0) || amount > pv.refundable) { toast(`환불 금액은 1원 ~ ${formatWon(pv.refundable)} 사이로 입력해주세요.`); return; }
          if (!confirm(`${formatWon(amount)}을 환불할까요? 되돌릴 수 없어요.`)) return;
          e.target.disabled = true;
          try {
            await callFn('cancelPayment', { orderId: pay.orderId, amount, reason: v.reason });
            dlg.close(); dlg.remove();
            toast('환불했어요.');
            openDetail(S.detail.id);
          } catch (err) { toast(err.message, 4500); e.target.disabled = false; }
        },
      }, '환불 실행'),
      h('button.btn.ghost', { onclick: () => { dlg.close(); dlg.remove(); } }, '닫기')));
  document.body.append(dlg);
  dlg.showModal();
}

/** 사진을 칸·컷 이름별로 묶어 보여준다. 템플릿에 없는 칸의 사진은 '기타'로. */
function renderPhotoGroups(tpl, req) {
  const byKey = new Map((req.photos || []).map((p) => [photoKeyOf(p, tpl), p]));
  const used = new Set();
  const groups = expandPhotoSlots(tpl, req.answers || {}).map((sl) => {
    const items = sl.shots.map((sh) => {
      const k = photoKey(sl.slot, sl.index, sh.key);
      const p = byKey.get(k);
      if (p) used.add(k);
      return p ? renderPhoto(p, sl.shots.length > 1 ? (sh.label || sh.key) : sl.label)
        : (sh.required ? h('div.photo-slot.missing', {}, h('div.photo-plus', {}, '없음'), h('div.photo-label', {}, sl.shots.length > 1 ? (sh.label || sh.key) : sl.label)) : null);
    }).filter(Boolean);
    if (!items.length) return null;
    return h('div.photo-group', {}, sl.shots.length > 1 ? h('div.photo-group-title', {}, sl.label) : null, h('div.photo-grid.view', {}, items));
  });
  const rest = [...byKey.entries()].filter(([k]) => !used.has(k)).map(([, p]) => p);
  return h('div', {}, groups,
    rest.length ? h('div.photo-group', {}, h('div.photo-group-title', {}, '기타'), h('div.photo-grid.view', {}, rest.map((p) => renderPhoto(p, p.slot)))) : null);
}

const photoUrls = new Map();
function renderPhoto(p, label) {
  const img = h('img', { alt: label, loading: 'lazy' });
  const link = h('a.photo-slot', { target: '_blank', rel: 'noopener' }, img, h('div.photo-label', {}, label));
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
  const p = d.tpl.pricing;
  const depositPct = d.pt.policy.depositPct;
  const toggle = (group, item, state) => h('label.toggle', {},
    h('input', {
      type: 'checkbox', checked: !!state?.on,
      onchange: (e) => {
        if (d.edited && !confirm('항목을 다시 자동 계산합니다. 직접 고친 금액은 사라져요. 계속할까요?')) { e.target.checked = !e.target.checked; return; }
        d.overrides[group][item.key] = e.target.checked;
        d.edited = false;
        recalc(req); renderDetail();
      },
    }),
    ` ${item.label}`, state?.auto ? h('span.muted.small', {}, ' 자동') : null);

  const totals = finalizeLines(d.lines, depositPct);
  const max = maxTotal(totals.total, d.conditions);
  const totalBox = h('div.total-box', {},
    h('div', {}, '합계', h('b', {}, formatWon(totals.total))),
    h('div.muted', {}, `계약금 ${depositPct}%`, h('span', {}, formatWon(totals.deposit))),
    max > totals.total ? h('div.muted', {}, '조건 해당 시 최대', h('span', {}, formatWon(max))) : null);

  const refreshTotals = () => {
    const t = finalizeLines(d.lines, depositPct);
    d.lines = t.lines;
    renderDetail();
  };

  const lineRow = (l, idx) => {
    if (l.key === ROUNDING_KEY) {
      return h('div.line.rounding', {}, h('span', {}, l.label), h('span', {}, formatWon(l.amount)));
    }
    return h('div.line', {},
      h('input.input.line-label', { value: l.label, oninput: (e) => { l.label = e.target.value; d.edited = true; } }),
      h('input.input.line-amount', {
        type: 'number', inputMode: 'numeric', value: l.amount, step: 1000,
        onchange: (e) => { l.amount = Math.round(Number(e.target.value) || 0); d.edited = true; refreshTotals(); },
      }),
      h('button.btn.round.ghost', { title: '삭제', onclick: () => { d.lines.splice(idx, 1); d.edited = true; refreshTotals(); } }, '×'),
      l.note ? h('div.line-note.muted.small', {}, l.note) : null);
  };

  const listEditor = (title, arr, key) => h('label.field', {}, h('span.label', {}, title),
    h('textarea.input', {
      rows: Math.max(3, arr.length + 1), value: arr.join('\n'),
      oninput: (e) => { d[key] = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean); },
    }));

  // 조건: 행 단위 (항목 · 금액(선택) · 설명) — amount 를 견적서 "최대 금액"에 쓴다 (M11a)
  const condRow = (c, idx) => h('div.cond-row', {},
    h('div.line', {},
      h('input.input.line-label', { value: c.label || '', placeholder: '항목', oninput: (e) => { c.label = e.target.value; } }),
      h('input.input.line-amount', {
        type: 'number', inputMode: 'numeric', value: c.amount ?? '', placeholder: '금액(선택)', step: 1000,
        onchange: (e) => { c.amount = e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value) || 0)); renderDetail(); },
      }),
      h('button.btn.round.ghost', { title: '삭제', onclick: () => { d.conditions.splice(idx, 1); renderDetail(); } }, '×')),
    h('input.input', { value: c.text || '', placeholder: '언제 추가되는지 (예: 곰팡이가 확인되면)', oninput: (e) => { c.text = e.target.value; } }));

  const paidLocked = !!d.quote?.payment;
  const blockers = [
    ...sendBlockReasons(d.calc, totals.total, d.tpl),
    ...(d.noPricing ? [`'${d.tpl.name}' 업종 단가표가 없어요. 업체 정보에서 이 업종을 다시 켜고 단가표를 저장해주세요.`] : []),
    ...(paidLocked ? ['계약금이 결제된 견적은 금액·조건을 바꿔 다시 보낼 수 없어요.'] : []),
  ];
  // 사장님이 직접 고친 합계가 0보다 크면 '합계 0원' 사유는 사라진다 (sendBlockReasons 가 total 로 판단)

  return h('section.card.quote-editor', {},
    h('h2', {}, '견적 계산'),
    d.oldType ? h('div.warn-box', {}, `이전 업종(${d.tpl.name}) 요청이에요. 그 업종 단가표로 계산합니다.`) : null,
    h('p.muted.small', {}, '자동으로 켜진 항목은 "자동" 표시가 있어요. 체크를 바꾸면 다시 계산합니다.'),
    h('div.toggles', {},
      (p.surcharges || []).length ? h('div.toggle-group', {}, h('b', {}, '할증'), p.surcharges.map((s) => toggle('surcharges', s, d.calc.surchargeState[s.key]))) : null,
      h('div.toggle-group', {}, h('b', {}, '옵션'), p.options.map((o) => toggle('options', o, d.calc.optionState[o.key])))),
    h('h3', {}, '항목별 금액 (직접 수정 가능)'),
    h('div.lines', {}, d.lines.map(lineRow)),
    h('button.btn.ghost.small', {
      onclick: () => { d.lines.push({ key: `custom:${Date.now()}`, type: 'custom', label: '추가 항목', amount: 0 }); d.edited = true; refreshTotals(); },
    }, '+ 항목 추가'),
    totalBox,
    h('div.field', {}, h('span.label', {}, '⚠️ 현장 추가요금 조건 (금액을 적으면 견적서에 "최대 금액"으로 보여요)'),
      h('div.conds', {}, d.conditions.map(condRow)),
      h('button.btn.ghost.small', { onclick: () => { d.conditions.push({ label: '', text: '', amount: null }); renderDetail(); } }, '+ 조건 추가')),
    listEditor('✅ 포함 항목', d.included, 'included'),
    listEditor('❌ 불포함 항목', d.excluded, 'excluded'),
    blockers.length ? h('div.warn-box', {}, h('b', {}, '발송할 수 없어요'), h('ul', {}, blockers.map((b) => h('li', {}, b)))) : null,
    h('p.muted.small', {}, '금액·추가요금 조건·취소 규정을 확인했나요? 발송하면 이 내용이 고객과의 약속이 돼요.'),
    h('div.btn-row', {},
      h('button.btn.ghost', { disabled: paidLocked, onclick: () => { d.overrides = { surcharges: {}, options: {} }; d.edited = false; recalc(req); renderDetail(); } }, '자동 계산으로 되돌리기'),
      h('button.btn.primary.big', { disabled: blockers.length > 0, onclick: (e) => sendQuote(req, e.target) },
        `${formatWon(totals.total)}으로 ${req.quoteId ? '견적 다시 발송' : '견적 발송'}`)));
}

async function sendQuote(req, btn) {
  const d = S.detail;
  const tpl = d.tpl;
  const pt = d.pt;
  const t = finalizeLines(d.lines, pt.policy.depositPct);
  if (!S.shop.name || !S.shop.phone) { toast('업체 정보(상호·연락처)를 먼저 저장해주세요.'); return; }
  const blockers = sendBlockReasons(d.calc, t.total, tpl);
  if (blockers.length || d.noPricing || d.quote?.payment) { toast(blockers[0] || '발송할 수 없는 견적이에요.'); return; }
  if (!confirm(`합계 ${formatWon(t.total)} (계약금 ${formatWon(t.deposit)})\n이 금액으로 견적서를 만들까요?`)) return;
  btn.disabled = true;
  try {
    const quoteRef = req.quoteId ? doc(db, 'quotes', req.quoteId) : doc(collection(db, 'quotes'));
    const today = toDateStr(new Date());
    const a = req.answers || {};
    const timeField = tpl.steps.flatMap((s) => s.fields).find((f) => f.key === 'timeSlot');
    const quote = {
      shopId: S.user.uid,
      requestId: req.id,
      templateId: tpl.id,
      templateName: tpl.name,
      number: `Q${today.replace(/-/g, '').slice(2)}-${quoteRef.id.slice(0, 4).toUpperCase()}`,
      shop: {
        name: S.shop.name, ownerName: S.shop.ownerName || '', phone: S.shop.phone, bizNo: S.shop.bizNo || '', logoUrl: S.shop.logoUrl || '',
        bizVerified: S.shop.bizVerified === true,
      },
      customer: { name: req.customer?.name || '', region: req.customer?.region || '' },
      service: {
        templateId: tpl.id,
        customMade: tpl.customMade === true,
        date: a.date || '', timeSlot: timeField ? (optionLabel(timeField, a.timeSlot) || '') : '',
        summary: summarize(tpl, a),
      },
      lines: t.lines.map(({ key, type, label, note, amount }) => ({ key, type: type || 'custom', label, note: note || '', amount: Math.round(Number(amount) || 0) })),
      total: t.total,
      depositPct: pt.policy.depositPct,
      deposit: t.deposit,
      included: d.included,
      excluded: d.excluded,
      conditions: d.conditions.filter((c) => (c.label || '').trim())
        .map(({ label, text, amount }) => ({ label: label.trim(), text: (text || '').trim(), amount: Number(amount) > 0 ? Math.round(Number(amount)) : null })),
      cancelPolicy: pt.policy.cancelPolicy || '',
      // 고객이 견적서·결제창에서 보는 환불 계산 규칙. 서버는 이 값(고객이 본 것)만으로 환불을 계산한다 (M13)
      refundRules: cleanRefundRules(pt.policy.refundRules),
      validDays: pt.policy.validDays,
      issuedAt: today,
      validUntil: addDays(today, pt.policy.validDays),
      verified: d.calc.verified,
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
