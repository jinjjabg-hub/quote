// 고객 입력 화면 (q.html?shop=업체ID) — 로그인 없음
// 질문 목록은 업종 템플릿의 steps 를 그대로 그린다. (업종이 바뀌어도 이 파일은 그대로)
import {
  db, storage, doc, collection, getDoc, setDoc, serverTimestamp, storageRef, uploadBytes, isConfigured,
} from './firebase.js';
import { loadTemplate } from './templates.js';
import { $, h, toast, compressImage, registerSW, showFatal, telHref, manduHref, setChildren } from './util.js';
import { appConfig } from './config.js';

registerSW();

const params = new URLSearchParams(location.search);
const shopId = params.get('shop');
const isTest = params.get('test') === '1'; // 사장님 테스트 모드에서 연 고객 화면
const app = $('#app');
const EXTRA_PHOTOS = 5;
const state = { step: 0, answers: {}, checklist: {}, extras: [], photos: {}, submitting: false };
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
  draftKey = `draft:${shopId}${isTest ? ':test' : ''}`;
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

function render() {
  const steps = tpl.steps;
  const step = steps[state.step];
  const pct = Math.round(((state.step + 1) / steps.length) * 100);
  setChildren(app, 
    isTest ? h('div.test-banner', {}, '🧪 테스트 모드: 사장님 확인용이며 실제 요청으로 집계되지 않습니다.') : null,
    h('header.shop-head', {},
      shop.logoUrl ? h('img.logo', { src: shop.logoUrl, alt: '' }) : null,
      h('div.grow', {}, h('div.shop-name', {}, shop.name || '업체'), h('div.muted', {}, `${tpl.name} 견적 요청`)),
      manduLink() ? h('a.btn.ghost.small', { href: manduLink(), target: '_blank', rel: 'noopener' }, '💬 채팅') : null),
    h('div.progress', { role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('div.progress-bar', { style: `width:${pct}%` })),
    h('div.step-count.muted', {}, `${state.step + 1} / ${steps.length}`),
    h('section.card.step', {},
      h('h1', {}, step.title),
      step.description ? h('p.muted', {}, step.description) : null,
      ...step.fields.map(renderField)),
    h('div.nav-row', {},
      state.step > 0 ? h('button.btn.ghost', { type: 'button', onclick: prev }, '이전') : h('span'),
      h('button.btn.primary', { type: 'button', onclick: next, disabled: state.submitting },
        state.step === steps.length - 1 ? (state.submitting ? '보내는 중…' : '견적 요청 보내기') : '다음')),
  );
  const first = app.querySelector('.step input, .step textarea');
  if (first && first.type !== 'file') first.focus({ preventScroll: true });
}

function renderField(f) {
  const v = state.answers[f.key];
  const set = (val) => { state.answers[f.key] = val; saveDraft(); };
  switch (f.type) {
    case 'text': case 'tel': case 'date': case 'number': {
      const input = h('input.input', {
        type: f.type, value: v ?? '', placeholder: f.placeholder || '', maxLength: f.maxLength || 100,
        inputMode: f.type === 'number' ? 'decimal' : f.type === 'tel' ? 'tel' : undefined,
        min: f.type === 'date' ? new Date().toISOString().slice(0, 10) : f.min, max: f.max,
        oninput: (e) => set(f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value),
        onkeydown: (e) => { if (e.key === 'Enter') next(); },
      });
      return fieldWrap(f, input);
    }
    case 'textarea':
      return fieldWrap(f, h('textarea.input', {
        rows: 4, value: v ?? '', placeholder: f.placeholder || '', maxLength: f.maxLength || 500,
        oninput: (e) => set(e.target.value),
      }));
    case 'choice':
      return fieldWrap(f, h('div.choices', {}, f.options.map((o) => h(`button.chip${v === o.value ? '.on' : ''}`, {
        type: 'button', onclick: () => { set(o.value); render(); },
      }, o.label))));
    case 'stepper': {
      const val = Number(v ?? f.min ?? 0);
      const change = (d) => { set(Math.min(f.max ?? 99, Math.max(f.min ?? 0, val + d))); render(); };
      return h('div.stepper-row', {}, h('span.label', {}, f.label),
        h('div.stepper', {},
          h('button.btn.round', { type: 'button', onclick: () => change(-1), 'aria-label': `${f.label} 줄이기` }, '−'),
          h('span.num', {}, val),
          h('button.btn.round', { type: 'button', onclick: () => change(1), 'aria-label': `${f.label} 늘리기` }, '+')));
    }
    case 'checklist':
      return h('div.checklist', {}, tpl.checklist.map((item) => h('div.check-item', {},
        h('div.check-q', {}, item.label),
        h('div.choices.three', {}, [['yes', '예'], ['no', '아니오'], ['unknown', '모름']].map(([val, label]) => h(
          `button.chip${state.checklist[item.key] === val ? '.on' : ''}`,
          { type: 'button', onclick: () => { state.checklist[item.key] = val; saveDraft(); render(); } }, label,
        ))))));
    case 'extras': {
      const opts = tpl.pricing.options.filter((o) => o.customerSelectable);
      return h('div.choices.col', {}, opts.map((o) => {
        const on = state.extras.includes(o.key);
        return h(`button.chip${on ? '.on' : ''}`, {
          type: 'button',
          onclick: () => { state.extras = on ? state.extras.filter((k) => k !== o.key) : [...state.extras, o.key]; saveDraft(); render(); },
        }, `${on ? '✓ ' : ''}${o.label}`);
      }));
    }
    case 'photos': {
      // 업종별 권장 칸 + 기타 최대 5장 (합계 10장, 보안 규칙과 같음)
      const used = Object.keys(state.photos).filter((k) => k.startsWith('extra')).length;
      const extras = Array.from({ length: Math.min(EXTRA_PHOTOS, used + 1) }, (_, i) => ({ key: `extra${i + 1}`, label: `기타 ${i + 1}` }));
      return h('div', {}, h('div.photo-grid', {}, [...tpl.photoSlots, ...extras].map(renderPhotoSlot)),
        h('p.hint', {}, `권장 사진 외에 기타 사진을 ${EXTRA_PHOTOS}장까지 더 올릴 수 있어요.`));
    }
    default:
      return h('p.muted', {}, `알 수 없는 항목 유형: ${f.type}`);
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
  return h('div.photo-slot', { onclick: (e) => { if (e.target !== input) input.click(); } },
    blob ? h('img', { src: URL.createObjectURL(blob), alt: slot.label }) : h('div.photo-plus', {}, '+'),
    h('div.photo-label', {}, slot.label, blob ? ' ✓' : ''),
    blob ? h('button.photo-del', {
      type: 'button', 'aria-label': `${slot.label} 사진 삭제`,
      onclick: (e) => { e.stopPropagation(); delete state.photos[slot.key]; render(); },
    }, '×') : null,
    input);
}

// ---------- 이동·검증 ----------

function validateStep() {
  for (const f of tpl.steps[state.step].fields) {
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
  if (state.step < tpl.steps.length - 1) { state.step += 1; render(); window.scrollTo(0, 0); return; }
  submit();
}

async function submit() {
  if (state.submitting) return;
  if (!Object.keys(state.photos).length && !confirm('사진 없이 보낼까요?\n사진이 있으면 현장 추가요금 없이 더 정확한 견적을 받을 수 있어요.')) return;
  state.submitting = true; render();
  try {
    const requestRef = doc(collection(db, 'requests'));
    const photos = [];
    for (const [slot, blob] of Object.entries(state.photos)) {
      const path = `requests/${shopId}/${requestRef.id}/${slot}.jpg`;
      await uploadBytes(storageRef(storage, path), blob, { contentType: 'image/jpeg' });
      photos.push({ slot, path }); // 다운로드 URL은 사장님 화면에서 권한 확인 후 받는다
    }
    const { name, phone, region, ...rest } = state.answers;
    await setDoc(requestRef, {
      shopId,
      templateId: shop.templateId,
      status: 'new',
      ...(isTest ? { test: true } : {}),
      customer: { name: String(name).trim(), phone: String(phone).trim(), region: String(region || '').trim() },
      answers: { ...rest, extras: state.extras },
      checklist: state.checklist,
      photos,
      quoteId: null,
      createdAt: serverTimestamp(),
    });
    try { localStorage.removeItem(draftKey); } catch { /* 무시 */ }
    renderDone();
  } catch (e) {
    console.error(e);
    state.submitting = false; render();
    toast('전송에 실패했어요. 인터넷 연결을 확인하고 다시 눌러주세요.', 4000);
  }
}

function renderDone() {
  setChildren(app, h('section.card.done', {},
    h('div.done-icon', {}, '✓'),
    h('h1', {}, '요청이 접수되었습니다'),
    h('p', {}, `${shop.name || '사장님'}이 확인 후 견적을 보내드립니다.`),
    h('p.muted', {}, '보통 작업이 끝난 뒤 순서대로 확인합니다. 급하시면 전화 주세요.'),
    h('div.btn-col', {},
      shop.phone ? h('a.btn.primary', { href: telHref(shop.phone) }, `📞 ${shop.phone} 전화하기`) : null,
      manduLink() ? h('a.btn.ghost', { href: manduLink(), target: '_blank', rel: 'noopener' }, '💬 만두로 채팅 문의') : null)));
}

function manduLink() {
  return manduHref(appConfig.manduBaseUrl, shop.manduId);
}
