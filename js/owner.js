// 사장님 화면 (owner.html) — 구글 로그인 필요
// 탭: 요청 목록 / 단가표 / 업체 정보,  상세: #req=요청ID
import {
  auth, db, storage, isConfigured, signInWithGoogle, onAuthStateChanged, signOut,
  doc, collection, getDoc, setDoc, updateDoc, onSnapshot, query, where, serverTimestamp, writeBatch,
  storageRef, uploadBytes, getDownloadURL,
} from './firebase.js';
import { appConfig } from './config.js';
import { loadTemplate } from './templates.js';
import {
  calculateQuote, finalizeLines, mergePriceTable, priceWarnings, formatWon, addDays, toDateStr, dateFlags, ROUNDING_KEY,
} from './calc.js';
import {
  $, h, toast, copyText, pageUrl, compressImage, STATUS, statusBadge, fmtDateTime, optionLabel, telHref,
  registerSW, showFatal, MANDU_ID_RE,
} from './util.js';

registerSW();

const app = $('#app');
const S = {
  user: null, shop: null, tpl: null, priceTable: null,
  requests: new Map(), filter: 'all', tab: 'list', unsub: null, detail: null,
};

if (!isConfigured) showFatal('Firebase 설정이 아직 없습니다. js/config.js 를 채운 뒤 다시 열어주세요. (배포.md 참고)');
else onAuthStateChanged(auth, (user) => onUser(user).catch((e) => showFatal(e.message)));

window.addEventListener('hashchange', route);

async function onUser(user) {
  S.unsub?.(); S.unsub = null;
  S.user = user;
  if (!user) { renderLogin(); return; }
  app.replaceChildren(h('p.muted.center', {}, '불러오는 중…'));
  await loadShop();
  subscribeRequests();
  route();
}

function renderLogin() {
  app.replaceChildren(h('section.card.center', {},
    h('h1', {}, '견적 자동화'),
    h('p.muted', {}, '고객이 링크로 정보를 입력하면 내 단가표로 견적이 자동 계산됩니다.\n사장님은 확인 후 1번 눌러 보내기만 하세요.'),
    h('button.btn.primary.big', {
      onclick: () => signInWithGoogle().catch((e) => toast(`로그인 실패: ${e.message}`)),
    }, 'Google 계정으로 시작하기')));
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
  if (m) openDetail(m[1]); else { S.detail = null; renderMain(); }
}

// ---------- 메인 (탭) ----------

function shopLink() { return pageUrl('q.html', { shop: S.user.uid }); }

function renderMain() {
  if (!S.shop) return;
  const tabs = [['list', '견적 요청'], ['price', '단가표'], ['shop', '업체 정보']];
  app.replaceChildren(
    topBar(),
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
    h('div.shop-name', {}, S.shop.name || '내 업체'),
    h('button.btn.ghost.small', { onclick: () => signOut(auth) }, '로그아웃'));
}

function countBadge() {
  const n = [...S.requests.values()].filter((r) => r.status === 'new' || r.status === 'booking_requested').length;
  return n ? h('span.count', {}, n) : null;
}

function renderList() {
  const all = [...S.requests.values()].sort((a, b) => (b.createdAt?.seconds ?? 9e9) - (a.createdAt?.seconds ?? 9e9));
  const filters = [['all', '전체'], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])];
  const shown = S.filter === 'all' ? all : all.filter((r) => r.status === S.filter);
  return h('section', {},
    h('div.choices.filter', {}, filters.map(([k, label]) => {
      const n = k === 'all' ? all.length : all.filter((r) => r.status === k).length;
      return h(`button.chip.small${S.filter === k ? '.on' : ''}`, { onclick: () => { S.filter = k; renderMain(); } }, `${label} ${n}`);
    })),
    shown.length ? h('ul.req-list', {}, shown.map(renderListItem))
      : h('div.card.empty', {}, h('p', {}, '아직 견적 요청이 없습니다.'),
        h('p.muted', {}, '위 "링크 복사"를 눌러 고객에게 보내보세요.')));
}

function renderListItem(r) {
  let est = '';
  try { est = formatWon(calculateQuote(S.tpl, S.priceTable, r).total); } catch { /* 템플릿 불일치 */ }
  const a = r.answers || {};
  return h('li.req-item', { onclick: () => { location.hash = `req=${r.id}`; } },
    h('div.req-main', {},
      h('div', {}, h('b', {}, r.customer?.name || '이름 없음'), ' ', h('span.muted', {}, r.customer?.region || '')),
      h('div.muted.small', {}, [a.area ? `${a.area}평` : '', a.date || '', r.photos?.length ? `사진 ${r.photos.length}` : ''].filter(Boolean).join(' · '))),
    h('div.req-side', {}, statusBadge(r.status), h('div.amount', {}, est), h('div.muted.small', {}, fmtDateTime(r.createdAt))));
}

// ---------- 단가표 ----------

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
  const row = (label, control, sub) => h('label.price-row', {}, h('span', {}, label, sub ? h('span.muted.small', {}, ` ${sub}`) : null), control);

  updateWarn();
  return h('section.card', {},
    h('p.muted.small', {}, `${S.tpl.name} 기본값이 채워져 있어요. 숫자만 고치고 저장하세요.`),
    h('h3', {}, '기본'),
    row(p.base.unitPriceLabel, numInput(() => pt.unitPrice, (v) => { pt.unitPrice = v; }, `원/${p.base.unit}`)),
    warn,
    row(p.base.minPriceLabel, numInput(() => pt.minPrice, (v) => { pt.minPrice = v; }, '원')),
    h('h3', {}, '할증'),
    p.surcharges.map((s) => row(s.label, numInput(() => pt.surcharges[s.key] ?? 0, (v) => { pt.surcharges[s.key] = v; }, '%'))),
    h('p.muted.small', {}, '주말·공휴일·손 없는 날은 고객 희망 날짜로 자동 판단합니다. (대체공휴일은 상세 화면에서 직접 체크)'),
    h('h3', {}, '옵션'),
    p.options.map((o) => row(o.priceLabel || o.label, numInput(() => pt.options[o.key] ?? 0, (v) => { pt.options[o.key] = v; }, '원'))),
    h('h3', {}, '정책'),
    row('견적 유효기간', numInput(() => pt.policy.validDays, (v) => { pt.policy.validDays = v; }, '일')),
    row('계약금 비율', numInput(() => pt.policy.depositPct, (v) => { pt.policy.depositPct = v; }, '%')),
    h('label.field', {}, h('span.label', {}, '취소 규정'),
      h('textarea.input', { rows: 3, value: pt.policy.cancelPolicy || '', oninput: (e) => { pt.policy.cancelPolicy = e.target.value; } })),
    h('button.btn.primary.block', {
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          await setDoc(doc(db, 'shops', S.user.uid, 'private', 'pricing'), { priceTable: pt, updatedAt: serverTimestamp() });
          S.priceTable = mergePriceTable(S.tpl, pt);
          toast('단가표를 저장했어요.');
        } catch (err) { toast(`저장 실패: ${err.message}`); }
        e.target.disabled = false;
      },
    }, '단가표 저장'));
}

// ---------- 업체 정보 ----------

function renderShopForm() {
  const f = { ...S.shop };
  const text = (key, label, opts = {}) => h('label.field', {}, h('span.label', {}, label, opts.optional ? h('span.muted', {}, ' (선택)') : null),
    h('input.input', { type: opts.type || 'text', value: f[key] || '', placeholder: opts.placeholder || '', maxLength: 60,
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
  return h('section.card', {},
    !S.shop.name ? h('p.notice', {}, '처음 오셨네요! 견적서에 표시될 업체 정보를 먼저 입력해주세요.') : null,
    text('name', '상호', { placeholder: '예) 반짝입주청소' }),
    text('ownerName', '대표자'),
    text('phone', '연락처', { type: 'tel', placeholder: '010-0000-0000' }),
    text('bizNo', '사업자번호', { optional: true, placeholder: '000-00-00000' }),
    text('manduId', '만두 ID', { optional: true, placeholder: '예) banjjak (@ 없이)' }),
    h('p.muted.small', {}, '넣으면 고객 화면·견적서에 "💬 만두로 채팅 문의" 버튼이 생깁니다. 외국인 고객과도 자동 번역으로 대화할 수 있어요.'),
    h('div.field', {}, h('span.label', {}, '로고', h('span.muted', {}, ' (선택)')),
      h('div.logo-row', {}, logoImg, h('button.btn.ghost', { onclick: () => logoInput.click() }, '로고 올리기'), logoInput)),
    h('button.btn.primary.block', {
      onclick: async (e) => {
        if (!f.name || !f.phone) { toast('상호와 연락처는 꼭 입력해주세요.'); return; }
        f.manduId = (f.manduId || '').replace(/^@/, '').toLowerCase();
        if (f.manduId && !MANDU_ID_RE.test(f.manduId)) { toast('만두 ID는 영문 소문자·숫자·_ 3~20자입니다.'); return; }
        e.target.disabled = true;
        try {
          const data = { name: f.name, ownerName: f.ownerName || '', phone: f.phone, bizNo: f.bizNo || '', logoUrl: f.logoUrl || '', manduId: f.manduId || '', updatedAt: serverTimestamp() };
          await updateDoc(doc(db, 'shops', S.user.uid), data);
          S.shop = { ...S.shop, ...data };
          toast('저장했어요.');
          S.tab = 'price'; renderMain();
        } catch (err) { toast(`저장 실패: ${err.message}`); e.target.disabled = false; }
      },
    }, '저장'));
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
  if (box && req) box.replaceChildren(statusBadge(req.status), ' ', statusActions(req));
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
  const req = currentReq();
  const a = req.answers || {};
  const fields = S.tpl.steps.flatMap((s) => s.fields);
  const flags = dateFlags(a.date);

  const infoRows = fields
    .filter((f) => !['checklist', 'extras', 'photos', 'name', 'phone', 'region'].includes(f.type) && !['name', 'phone', 'region'].includes(f.key))
    .map((f) => [f.label, a[f.key] === undefined || a[f.key] === '' ? '-' : String(optionLabel(f, a[f.key]))]);
  if (a.date) {
    const tags = [flags.$weekend && '주말', flags.$holiday && '공휴일', flags.$sonEomneun && '손 없는 날'].filter(Boolean);
    if (tags.length) infoRows.push(['날짜 판정', tags.join(', ')]);
  }
  const extras = (a.extras || []).map((k) => S.tpl.pricing.options.find((o) => o.key === k)?.label || k);
  if (extras.length) infoRows.push(['고객 요청 서비스', extras.join(', ')]);

  const ansLabel = { yes: '예', no: '아니오', unknown: '모름' };

  app.replaceChildren(
    h('header.topbar', {},
      h('button.btn.ghost.small', { onclick: () => { location.hash = ''; } }, '← 목록'),
      h('div.status-box', { id: 'status-box' })),
    h('section.card', {},
      h('div.cust-head', {},
        h('div', {}, h('h2', {}, req.customer?.name || '고객'), h('div.muted', {}, req.customer?.region || ''),
          h('div.muted.small', {}, `접수 ${fmtDateTime(req.createdAt)}`)),
        req.customer?.phone ? h('a.btn.primary.small', { href: telHref(req.customer.phone) }, `📞 ${req.customer.phone}`) : null),
      h('dl.kv', {}, infoRows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('h3', {}, '추가요금 체크리스트'),
      h('dl.kv', {}, S.tpl.checklist.map((i) => {
        const ans = req.checklist?.[i.key];
        const risky = ans === i.risk || ans === 'unknown';
        return [h('dt', {}, i.label), h(`dd${risky ? '.risk' : ''}`, {}, ansLabel[ans] || '-')];
      })),
      a.memo ? [h('h3', {}, '요청사항'), h('p.memo', {}, a.memo)] : null,
      h('h3', {}, `사진 ${req.photos?.length || 0}장`),
      req.photos?.length
        ? h('div.photo-grid.view', {}, req.photos.map(renderPhoto))
        : h('p.muted', {}, '사진 없음 — 현장 추가요금 조건을 꼼꼼히 적어주세요.')),
    renderQuoteEditor(req),
  );
  renderDetailStatus();
}

const photoUrls = new Map();
function renderPhoto(p) {
  const img = h('img', { alt: p.slot, loading: 'lazy' });
  const link = h('a.photo-slot', { target: '_blank', rel: 'noopener' }, img,
    h('div.photo-label', {}, S.tpl.photoSlots.find((s) => s.key === p.slot)?.label || p.slot));
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
    ` ${item.label}`, state.auto ? h('span.muted.small', {}, ' 자동') : null);

  const totals = finalizeLines(d.lines, S.priceTable.policy.depositPct);
  const totalBox = h('div.total-box', {},
    h('div', {}, '합계', h('b', {}, formatWon(totals.total))),
    h('div.muted', {}, `계약금 ${S.priceTable.policy.depositPct}%`, h('span', {}, formatWon(totals.deposit))));

  const refreshTotals = () => {
    const t = finalizeLines(d.lines, S.priceTable.policy.depositPct);
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
        onchange: (e) => { l.amount = Number(e.target.value) || 0; d.edited = true; refreshTotals(); },
      }),
      h('button.btn.round.ghost', { title: '삭제', onclick: () => { d.lines.splice(idx, 1); d.edited = true; refreshTotals(); } }, '×'),
      l.note ? h('div.line-note.muted.small', {}, l.note) : null);
  };

  const listEditor = (title, arr, key) => h('label.field', {}, h('span.label', {}, title),
    h('textarea.input', {
      rows: Math.max(3, arr.length + 1), value: arr.join('\n'),
      oninput: (e) => { d[key] = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean); },
    }));

  const condText = d.conditions.map((c) => `${c.label}: ${c.text}`);

  return h('section.card.quote-editor', {},
    h('h2', {}, '견적 계산'),
    h('p.muted.small', {}, '자동으로 켜진 항목은 "자동" 표시가 있어요. 체크를 바꾸면 다시 계산합니다.'),
    h('div.toggles', {},
      h('div.toggle-group', {}, h('b', {}, '할증'), p.surcharges.map((s) => toggle('surcharges', s, d.calc.surchargeState[s.key]))),
      h('div.toggle-group', {}, h('b', {}, '옵션'), p.options.map((o) => toggle('options', o, d.calc.optionState[o.key])))),
    h('h3', {}, '항목별 금액 (직접 수정 가능)'),
    h('div.lines', {}, d.lines.map(lineRow)),
    h('button.btn.ghost.small', {
      onclick: () => { d.lines.push({ key: `custom:${Date.now()}`, type: 'custom', label: '추가 항목', amount: 0 }); d.edited = true; refreshTotals(); },
    }, '+ 항목 추가'),
    totalBox,
    h('label.field', {}, h('span.label', {}, '⚠️ 현장 추가요금 조건 (한 줄에 하나, "항목: 설명")'),
      h('textarea.input', {
        rows: Math.max(3, condText.length + 1), value: condText.join('\n'),
        oninput: (e) => {
          d.conditions = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
            const i = line.indexOf(':');
            return i > 0 ? { label: line.slice(0, i).trim(), text: line.slice(i + 1).trim() } : { label: line, text: '' };
          });
        },
      })),
    listEditor('✅ 포함 항목', d.included, 'included'),
    listEditor('❌ 불포함 항목', d.excluded, 'excluded'),
    h('div.btn-row', {},
      h('button.btn.ghost', { onclick: () => { d.overrides = { surcharges: {}, options: {} }; d.edited = false; recalc(req); renderDetail(); } }, '자동 계산으로 되돌리기'),
      h('button.btn.primary.big', { onclick: (e) => sendQuote(req, e.target) }, req.quoteId ? '견적 다시 발송' : '견적 발송')));
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
