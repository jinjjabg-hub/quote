// 고객 입력 화면 (q.html?shop=업체ID) — 로그인 없음
// 질문 목록은 업종 템플릿의 steps 를 그대로 그린다. (업종이 바뀌어도 이 파일은 그대로)
import {
  db, storage, doc, collection, getDoc, setDoc, serverTimestamp, storageRef, uploadBytes, isConfigured,
} from './firebase.js';
import { loadTemplate } from './templates.js';
import { visibleSteps, pruneHidden, toDateStr } from './calc.js';
import { $, h, toast, compressImage, registerSW, showFatal, telHref, manduHref, setChildren, icon, footerNote } from './util.js';
import { appConfig } from './config.js';
import { lookupEnabled, newLookupState, renderLookupPanel } from './areaLookup.js';
import { notifyNewRequest } from './push.js';

registerSW();

const params = new URLSearchParams(location.search);
const shopId = params.get('shop');
const isTest = params.get('test') === '1'; // 사장님 테스트 모드에서 연 고객 화면
const byPhone = !isTest && params.get('by') === 'phone'; // 전화 문의를 사장님이 대신 입력 (알림 안 보냄, 사진 선택)
const app = $('#app');
const EXTRA_PHOTOS = 5;
const state = { step: 0, answers: {}, checklist: {}, extras: [], photos: {}, consent: false, submitting: false, lookup: newLookupState() };
const LOOKUP_ON = lookupEnabled(params);
let shop; let tpl; let draftKey;

init().catch((e) => showFatal(e.message));

async function init() {
  if (!isConfigured) throw new Error('Firebase 설정이 아직 없습니다. js/config.js 를 채워주세요.');
  if (!shopId || !/^[A-Za-z0-9_-]{6,128}$/.test(shopId)) throw new Error('견적 링크가 올바르지 않습니다. 업체에 링크를 다시 요청해주세요.');
  const snap = await getDoc(doc(db, 'shops', shopId));
  if (!snap.exists()) throw new Error('업체 정보를 찾을 수 없습니다. 업체에 링크를 다시 요청해주세요.');
  shop = snap.data();
  tpl = await loadTemplate(shop.templateId);
  document.title = `${shop.name || '견적'} · ${tpl.name} 견적 요청`;

  // 기본값 + 임시 저장 복원
  for (const step of tpl.steps) for (const f of step.fields) if (f.default != null) state.answers[f.key] = f.default;
  draftKey = `draft:${shopId}${isTest ? ':test' : byPhone ? ':phone' : ''}`;
  try {
    const d = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (d) Object.assign(state, { answers: { ...state.answers, ...d.answers }, checklist: d.checklist || {}, extras: d.extras || [] });
  } catch { /* 저장소 사용 불가 */ }
  render();
}

function saveDraft() {
  try {
    localStorage.setItem(draftKey, JSON.stringify({ answers: state.answers, checklist: state.checklist, extras: state.extras }));
  } catch { /* 무시 */ }
}

// ---------- 렌더링 ----------

// 조건부 질문(showIf) 때문에 답에 따라 단계 수가 달라질 수 있다
const steps = () => visibleSteps(tpl, state.answers);

function render({ focus = true } = {}) {
  const all = steps();
  state.step = Math.min(state.step, all.length - 1);
  const step = all[state.step];
  const pct = Math.round(((state.step + 1) / all.length) * 100);
  setChildren(app,
    shopHeader(),
    isTest ? h('div.test-banner', {}, '🧪 테스트 모드: 사장님 확인용이며 실제 요청으로 집계되지 않습니다.') : null,
    byPhone ? h('div.test-banner', {}, '📞 전화 문의 받아 적기: 통화하면서 고객 대신 입력하세요. 사진은 건너뛰어도 됩니다.') : null,
    state.step === 0 && !byPhone ? h('div.intro', {},
      h('b', {}, `${tpl.name} 견적을 3분 만에 받아보세요`),
      h('p.small', {}, [shop.intro, shop.serviceArea && `서비스 지역: ${shop.serviceArea}`].filter(Boolean).join('\n') || '질문에 답하고 사진을 올리면, 사장님이 확인 후 견적서를 보내드립니다.')) : null,
    h('div.progress-wrap', {},
      h('div.step-count', {}, `${state.step + 1} / ${all.length}`),
      h('div.progress', { role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': '진행' },
        h('div.progress-bar', { style: `width:${pct}%` }))),
    h('section.card.step', {},
      h('h1', {}, step.title),
      step.description ? h('p.muted', {}, step.description) : null,
      ...step.fields.map(renderField)),
    state.step === all.length - 1 ? consentBox() : null,
    footerNote('입력하신 정보는 이 업체에만 전달됩니다.'),
    h('div.nav-row', {},
      state.step > 0 ? h('button.btn.prev', { type: 'button', onclick: prev }, '이전') : null,
      h('button.btn.primary', { type: 'button', onclick: next, disabled: state.submitting },
        state.step === all.length - 1 ? (state.submitting ? '보내는 중…' : '견적 요청 보내기') : '다음')),
  );
  const first = app.querySelector('.step input, .step textarea');
  if (focus && first && first.type !== 'file') first.focus({ preventScroll: true });
}

// 상단 업체 바. 로고는 올린 업체만, 채팅은 만두 ID가 있을 때만 (시안: 전화 버튼 없음, 전화는 접수 완료 화면에서)
function shopHeader() {
  return h('header.shop-head', {},
    shop.logoUrl ? h('img.logo', { src: shop.logoUrl, alt: '' }) : null,
    h('div.grow', {}, h('div.shop-name', {}, shop.name || '업체'), h('div.shop-sub', {}, `${tpl.name} 견적 요청`)),
    manduLink() ? h('a.btn-chat', { href: manduLink(), target: '_blank', rel: 'noopener' }, icon('chat'), '채팅') : null);
}

function renderField(f) {
  const v = state.answers[f.key];
  const set = (val) => { state.answers[f.key] = val; saveDraft(); };
  switch (f.type) {
    case 'text': case 'tel': case 'date': case 'number': {
      const input = h('input.input', {
        type: f.type, value: v ?? '', placeholder: f.placeholder || '', maxLength: f.maxLength || 100,
        inputMode: f.type === 'number' ? 'decimal' : f.type === 'tel' ? 'tel' : undefined,
        min: f.type === 'date' ? toDateStr(new Date()) : f.min, max: f.max, // 현지 날짜 (toISOString 은 UTC라 한국 오전 9시 전엔 어제가 됨)
        oninput: (e) => {
          set(f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value);
          if (f.lookup) markManualIfChanged(f);
        },
        onkeydown: (e) => { if (e.key === 'Enter') next(); },
      });
      // 단위(템플릿 unit)는 입력칸 안쪽 오른쪽에 표시
      const control = fieldWrap(f, f.unit ? h('div.input-unit', {}, input, h('span', { 'aria-hidden': 'true' }, f.unit)) : input);
      return f.lookup === 'registry' && LOOKUP_ON ? [lookupPanel(f), control] : control;
    }
    case 'textarea':
      return fieldWrap(f, h('textarea.input', {
        rows: 4, value: v ?? '', placeholder: f.placeholder || '', maxLength: f.maxLength || 500,
        oninput: (e) => set(e.target.value),
      }));
    case 'choice': {
      // 짧은 보기는 가로로, 긴 보기는 세로 카드로 (40~60대도 한눈에 읽게)
      const long = f.options.length > 4 || f.options.some((o) => String(o.label).length > 8);
      return fieldWrap(f, h(long ? 'div.choice-list' : 'div.choices.three', {}, f.options.map((o) => h(`button.chip${v === o.value ? '.on' : ''}`, {
        type: 'button', 'aria-pressed': v === o.value, onclick: () => { set(o.value); render(); },
      }, v === o.value ? icon('check_circle', true) : null, o.label))));
    }
    case 'stepper': {
      const val = Number(v ?? f.min ?? 0);
      const change = (d) => { set(Math.min(f.max ?? 99, Math.max(f.min ?? 0, val + d))); render(); };
      return h('div.stepper-row', {}, h('span', {}, h('span.label', {}, f.label), f.hint ? h('span.hint', { style: 'margin-top:2px' }, f.hint) : null),
        h('div.stepper', {},
          h('button.btn.round', { type: 'button', onclick: () => change(-1), 'aria-label': `${f.label} 줄이기` }, icon('remove')),
          h('span.num', {}, val),
          h('button.btn.round', { type: 'button', onclick: () => change(1), 'aria-label': `${f.label} 늘리기` }, icon('add'))));
    }
    case 'checklist':
      return h('div.checklist', {}, tpl.checklist.map((item, i) => h('div.check-item', {},
        h('div.check-q', {}, h('span.check-no', {}, `${i + 1}.`), item.label),
        h('div.choices.three', {}, [['yes', '예'], ['no', '아니오'], ['unknown', '모름']].map(([val, label]) => h(
          `button.chip${state.checklist[item.key] === val ? '.on' : ''}`,
          { type: 'button', 'aria-pressed': state.checklist[item.key] === val, onclick: () => { state.checklist[item.key] = val; saveDraft(); render(); } }, label,
        ))))));
    case 'extras': {
      const opts = tpl.pricing.options.filter((o) => o.customerSelectable);
      return h('div.choices.col', {}, opts.map((o) => {
        const on = state.extras.includes(o.key);
        return h(`button.chip${on ? '.on' : ''}`, {
          type: 'button', 'aria-pressed': on,
          onclick: () => { state.extras = on ? state.extras.filter((k) => k !== o.key) : [...state.extras, o.key]; saveDraft(); render(); },
        }, on ? icon('check_circle', true) : null, o.label);
      }));
    }
    case 'photos': {
      // 업종별 권장 칸 + 기타 최대 5장 (합계 10장, 보안 규칙과 같음)
      const used = Object.keys(state.photos).filter((k) => k.startsWith('extra')).length;
      const extras = Array.from({ length: Math.min(EXTRA_PHOTOS, used + 1) }, (_, i) => ({ key: `extra${i + 1}`, label: `기타 ${i + 1}` }));
      return h('div', {}, h('div.photo-grid', {}, [...tpl.photoSlots, ...extras].map(renderPhotoSlot)),
        h('p.hint.with-icon', {}, icon('info'), `권장 사진 외에 기타 사진을 ${EXTRA_PHOTOS}장까지 더 올릴 수 있어요.`));
    }
    default:
      return h('p.muted', {}, `알 수 없는 항목 유형: ${f.type}`);
  }
}

// ---------- 주소 → 평수 자동 조회 (설계도 4-4장) ----------
// 템플릿 숫자 질문에 "lookup": "registry" 가 있으면 위에 조회 패널을 붙인다. 결과는 answers 의
// {key}Source ('registry'|'manual') 와 {key}Lookup (단지명·동·호·면적) 에 남긴다. 고객 공개 견적서에는 복사하지 않는다.

function lookupPanel(f) {
  return renderLookupPanel(state.lookup, state.answers[`${f.key}Source`] === 'registry' ? state.answers[`${f.key}Lookup`] : null, {
    rerender: () => render({ focus: false }),
    onApply: (info) => {
      state.answers[f.key] = Math.round(info.pyeong);
      state.answers[`${f.key}Source`] = 'registry';
      state.answers[`${f.key}Lookup`] = info;
      saveDraft();
    },
    onManual: () => {
      state.answers[`${f.key}Source`] = 'manual';
      saveDraft();
      setTimeout(() => app.querySelector('.step input[type=number]')?.focus(), 0);
    },
  });
}

// 대장 평수를 적용한 뒤 고객이 숫자를 고치면 "직접 입력"으로 기록 (대장 값은 비교용으로 남김)
function markManualIfChanged(f) {
  const info = state.answers[`${f.key}Lookup`];
  if (state.answers[`${f.key}Source`] === 'registry' && info && Number(state.answers[f.key]) !== Math.round(info.pyeong)) {
    state.answers[`${f.key}Source`] = 'manual';
    saveDraft();
  }
}

function fieldWrap(f, control) {
  // 버튼 묶음은 <label> 안에 넣으면 제목을 눌러도 첫 버튼이 선택되므로 div 로 감싼다
  return h(f.type === 'choice' ? 'div.field' : 'label.field', {}, h('span.label', {}, f.label, f.required ? null : h('span.muted', {}, ' (선택)')),
    control, f.hint ? h('span.hint', {}, f.hint) : null);
}

function renderPhotoSlot(slot) {
  const blob = state.photos[slot.key];
  const input = h('input', {
    type: 'file', accept: 'image/*', hidden: true,
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        state.photos[slot.key] = await compressImage(file);
        render();
      } catch (err) { toast(err.message); }
    },
  });
  // 칸(사진) + 아래 이름표. 올린 사진은 오른쪽 위 ✓, 왼쪽 위 ×
  return h(`div.photo-cell${blob ? '.filled' : ''}`, {},
    h('div.photo-slot', {
      role: 'button', tabIndex: 0, 'aria-label': blob ? `${slot.label} 사진 바꾸기` : `${slot.label} 사진 추가`,
      onclick: (e) => { if (e.target !== input) input.click(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    },
    blob ? h('img', { src: URL.createObjectURL(blob), alt: slot.label }) : h('div.photo-plus', {}, icon('add')),
    blob ? h('span.photo-ok', { 'aria-hidden': 'true' }, icon('check')) : null,
    blob ? h('button.photo-del', {
      type: 'button', 'aria-label': `${slot.label} 사진 삭제`,
      onclick: (e) => { e.stopPropagation(); delete state.photos[slot.key]; render(); },
    }, icon('close')) : null,
    input),
    h('div.photo-label', {}, slot.label));
}

// ---------- 개인정보 수집·이용 안내 (개인정보보호법: 수집 전에 목적·항목·보유기간·거부권 고지) ----------
// 마지막 단계(보내기 버튼 바로 위)에만 보인다. 체크해야 보낼 수 있고, 보안 규칙도 consentAt 이 없는 요청은 막는다.
function consentBox() {
  const who = shop.name || '이 업체';
  return h('section.card.consent', {},
    h('div.card-title', {}, icon('info'), '개인정보 수집·이용 안내 (필수)'),
    h('dl.kv.small', {},
      h('dt', {}, '받는 곳'), h('dd', {}, who),
      h('dt', {}, '항목'), h('dd', {}, '이름, 연락처, 지역(주소), 요청 내용, 현장 사진, 희망 일정'),
      h('dt', {}, '목적'), h('dd', {}, '견적 산출·발송, 작업 일정 안내'),
      h('dt', {}, '보관'), h('dd', {}, '견적 상담과 작업이 끝나면 지체 없이 파기 (법령상 보관 의무가 있으면 그 기간)')),
    h('p.small.muted', {}, '동의하지 않을 수 있으며, 이 경우 링크로 견적을 요청할 수 없습니다. 전화로 문의해주세요. ',
      h('a', { href: 'privacy.html', target: '_blank', rel: 'noopener' }, '개인정보처리방침')),
    h('label.consent-check', {},
      h('input', { type: 'checkbox', checked: state.consent, onchange: (e) => { state.consent = e.target.checked; } }),
      h('span', {}, byPhone ? '고객에게 위 내용을 안내하고 동의를 받았습니다' : '위 내용을 확인했고 동의합니다')));
}

// ---------- 이동·검증 ----------

function validateStep() {
  for (const f of steps()[state.step].fields) {
    const v = state.answers[f.key];
    if (f.type === 'checklist') {
      const missing = tpl.checklist.find((i) => !state.checklist[i.key]);
      if (f.required && missing) return `"${missing.label}"에 답해주세요. 모르면 '모름'을 누르세요.`;
      continue;
    }
    if (['extras', 'photos'].includes(f.type)) continue;
    if (f.required && (v === undefined || v === null || v === '')) return `${f.label}을(를) 입력해주세요.`;
    if (f.type === 'number' && v !== '' && v != null) {
      if (Number.isNaN(Number(v)) || (f.min != null && v < f.min) || (f.max != null && v > f.max)) {
        return `${f.label}은(는) ${f.min}~${f.max} 사이로 입력해주세요.`;
      }
    }
    if (f.type === 'tel' && v && !/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(String(v).replace(/\s/g, ''))) {
      return '연락처를 정확히 입력해주세요. (예: 010-1234-5678)';
    }
  }
  return null;
}

function prev() { state.step = Math.max(0, state.step - 1); render(); window.scrollTo(0, 0); }

function next() {
  const err = validateStep();
  if (err) { toast(err); return; }
  if (state.step < steps().length - 1) { state.step += 1; render(); window.scrollTo(0, 0); return; }
  if (!state.consent) { toast('개인정보 수집·이용 안내에 동의해야 보낼 수 있어요.'); app.querySelector('.consent')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  submit();
}

async function submit() {
  if (state.submitting) return;
  if (!byPhone && !Object.keys(state.photos).length && !confirm('사진 없이 보낼까요?\n사진이 있으면 현장 추가요금 없이 더 정확한 견적을 받을 수 있어요.')) return;
  state.submitting = true; render();
  // 순서: ① 요청 문서(올릴 사진 목록 포함)를 먼저 저장 → ② 사진 업로드 → ③ 사장님 알림.
  // 사진 업로드 규칙(storage.rules)이 "방금 만든 신규 요청의 사진 목록에 적힌 파일"만 받기 때문.
  // 사진 일부가 실패해도 요청은 이미 들어가 있으므로 고객을 놓치지 않는다 (실패한 사진은 완료 화면에서 안내).
  const requestRef = doc(collection(db, 'requests'));
  const uploads = Object.entries(state.photos).map(([slot, blob]) => ({ slot, blob, path: `requests/${shopId}/${requestRef.id}/${slot}.jpg` }));
  try {
    const { name, phone, region, ...rest } = pruneHidden(tpl, state.answers);
    if (LOOKUP_ON) {
      for (const f of tpl.steps.flatMap((st) => st.fields).filter((x) => x.lookup)) {
        if (rest[f.key] !== undefined && !rest[`${f.key}Source`]) rest[`${f.key}Source`] = 'manual';
      }
    }
    await setDoc(requestRef, {
      shopId,
      templateId: shop.templateId,
      status: 'new',
      ...(isTest ? { test: true } : {}),
      ...(byPhone ? { source: 'phone' } : {}),
      customer: { name: String(name).trim(), phone: String(phone).trim(), region: String(region || '').trim() },
      answers: { ...rest, extras: state.extras },
      checklist: state.checklist,
      photos: uploads.map(({ slot, path }) => ({ slot, path })), // 다운로드 URL은 사장님 화면에서 권한 확인 후 받는다
      quoteId: null,
      createdAt: serverTimestamp(),
      consentAt: serverTimestamp(),
    });
  } catch (e) {
    console.error(e);
    state.submitting = false; render();
    toast('전송에 실패했어요. 인터넷 연결을 확인하고 다시 눌러주세요.', 4000);
    return;
  }
  try { localStorage.removeItem(draftKey); } catch { /* 무시 */ }
  const failed = [];
  for (let i = 0; i < uploads.length; i += 1) {
    const u = uploads[i];
    setChildren(app, shopHeader(), h('section.card.done', {}, h('h1', {}, '사진 보내는 중…'), h('p.muted', {}, `${i + 1} / ${uploads.length}`)));
    if (!(await uploadWithRetry(u))) failed.push(photoLabel(u.slot));
  }
  if (!byPhone) notifyNewRequest(requestRef.id); // 사장님 휴대폰 알림 (1순위: 문의를 놓치지 않기). 사장님이 직접 적은 건 알릴 필요 없음
  if (byPhone) { location.href = `owner.html#req=${requestRef.id}`; return; } // 바로 견적 상세로 → 금액 확인 후 문자 발송
  renderDone(failed);
}

// 휴대폰 데이터가 잠깐 끊기는 경우가 많아 사진마다 3번까지 시도
async function uploadWithRetry({ path, blob }, tries = 3) {
  for (let t = 1; t <= tries; t += 1) {
    try { await uploadBytes(storageRef(storage, path), blob, { contentType: 'image/jpeg' }); return true; } catch (e) {
      console.error(e);
      if (t < tries) await new Promise((r) => setTimeout(r, 1500 * t));
    }
  }
  return false;
}

function photoLabel(slot) {
  return tpl.photoSlots.find((s) => s.key === slot)?.label || slot.replace(/^extra(\d+)$/, '기타 $1');
}

function renderDone(failed = []) {
  setChildren(app, shopHeader(), h('section.card.done', {},
    h('div.done-icon', {}, icon('check', true)),
    h('h1', {}, '요청이 접수되었습니다'),
    h('p', {}, `${shop.name || '사장님'}이 확인 후 견적을 보내드립니다.`),
    failed.length ? h('p.risk', {}, `사진 ${failed.length}장(${failed.join(', ')})은 보내지 못했어요. 채팅이나 문자로 따로 보내주세요.`) : null,
    h('p.muted', {}, '보통 작업이 끝난 뒤 순서대로 확인합니다. 급하시면 전화 주세요.'),
    h('div.btn-col', {},
      shop.phone ? h('a.btn.primary.big', { href: telHref(shop.phone) }, icon('call', true), `${shop.phone} 전화 상담하기`) : null,
      manduLink() ? h('a.btn.ghost', { href: manduLink(), target: '_blank', rel: 'noopener' }, '💬 만두로 채팅 문의') : null)),
    footerNote());
}

function manduLink() {
  return manduHref(appConfig.manduBaseUrl, shop.manduId);
}
