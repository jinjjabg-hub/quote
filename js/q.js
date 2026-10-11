// 고객 입력 화면 (q.html?shop=업체ID[&t=업종ID]) — 로그인 없음
// 순서: ① 개인정보 동의 → ② (업종 2개 이상이면) 서비스 선택 → ③ 업종 템플릿 steps 를 그대로 그림
// 질문 목록은 업종 템플릿의 steps 에 있다. (업종이 바뀌어도 이 파일은 그대로)
import {
  db, storage, doc, collection, getDoc, setDoc, serverTimestamp, storageRef, uploadBytes, isConfigured,
} from './firebase.js';
import { appConfig, legalUrl } from './config.js';
import { loadTemplate, templateName } from './templates.js';
import {
  shopTemplateIds, validateAnswers, expandPhotoSlots, photoKey, photoLimit, missingRequiredShots,
} from './calc.js';
import { $, h, toast, compressImage, registerSW, showFatal, telHref } from './util.js';

registerSW();

const params = new URLSearchParams(location.search);
const shopId = params.get('shop');
const app = $('#app');
// 화면 교체 (null·false 자식은 건너뜀 — 기본 replaceChildren 은 null 을 글자로 그린다)
const show = (...nodes) => app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
const state = {
  phase: 'consent', consent: false, step: 0,
  answers: {}, checklist: {}, extras: [], photos: {}, submitting: false,
};
let shop; let tpl; let draftKey; let templateIds = [];

// 메모 칸 공통 경고 (legal copy-snippets §2)
const MEMO_WARNING = '현관 비밀번호·주민등록번호·계좌번호는 적지 마세요. 출입 방법은 계약 후 사장님이 따로 여쭤봐요.';

init().catch((e) => showFatal(e.message));

async function init() {
  if (!isConfigured) throw new Error('Firebase 설정이 아직 없습니다. js/config.js 를 채워주세요.');
  if (!shopId || !/^[A-Za-z0-9_-]{6,128}$/.test(shopId)) throw new Error('견적 링크가 올바르지 않습니다. 업체에 링크를 다시 요청해주세요.');
  const snap = await getDoc(doc(db, 'shops', shopId));
  if (!snap.exists()) throw new Error('업체 정보를 찾을 수 없습니다. 업체에 링크를 다시 요청해주세요.');
  shop = snap.data();
  templateIds = shopTemplateIds(shop, appConfig.defaultTemplateId);
  const t = params.get('t');
  if (t && templateIds.includes(t)) await chooseTemplate(t, false);
  else if (templateIds.length === 1) await chooseTemplate(templateIds[0], false);
  document.title = `${shop.name || '견적'} · 견적 요청`;
  render();
}

async function chooseTemplate(id, rerender = true) {
  tpl = await loadTemplate(id);
  document.title = `${shop.name || '견적'} · ${tpl.name} 견적 요청`;
  state.answers = {}; state.checklist = {}; state.extras = []; state.photos = {}; state.step = 0;
  // 기본값 + 임시 저장 복원 (업종별로 따로 저장)
  for (const step of tpl.steps) for (const f of step.fields) if (f.default != null) state.answers[f.key] = f.default;
  draftKey = `draft:${shopId}:${id}`;
  try {
    let raw = localStorage.getItem(draftKey);
    if (!raw && id === shop.templateId) raw = localStorage.getItem(`draft:${shopId}`); // 1차 버전 임시저장
    const d = JSON.parse(raw || 'null');
    if (d) Object.assign(state, { answers: { ...state.answers, ...d.answers }, checklist: d.checklist || {}, extras: d.extras || [] });
  } catch { /* 저장소 사용 불가 */ }
  if (rerender) { state.phase = 'steps'; render(); }
}

function saveDraft() {
  try {
    localStorage.setItem(draftKey, JSON.stringify({ answers: state.answers, checklist: state.checklist, extras: state.extras }));
  } catch { /* 무시 */ }
}

// ---------- 렌더링 ----------

function shopHead(sub) {
  return h('header.shop-head', {},
    shop.logoUrl ? h('img.logo', { src: shop.logoUrl, alt: '' }) : null,
    h('div', {}, h('div.shop-name', {}, shop.name || '업체'), h('div.muted', {}, sub)));
}

function footer() {
  const link = (url, label) => (url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, label) : null);
  return h('footer.legal-foot.muted.small', {},
    h('div', {}, '만 14세 미만은 이용할 수 없어요. 이 화면은 T.M LINK 견적 프로그램으로 만들어졌어요.'),
    h('div', {}, link(legalUrl('termsUrl'), '이용 안내'), ' ', link(legalUrl('privacyUrl'), '개인정보처리방침')));
}

function render() {
  if (state.phase === 'consent') return renderConsent();
  if (state.phase === 'service' || !tpl) return renderService();
  return renderSteps();
}

// ① 개인정보 수집·이용 동의 — legal copy-snippets §1 consent-v1 (체크 기본 해제). 문구를 바꾸면 appConfig.consentVersion 도 올린다.
function renderConsent() {
  const name = shop.name || '업체';
  const privacyUrl = legalUrl('privacyUrl');
  const detail = h('div.consent-detail', { hidden: !!privacyUrl },
    h('dl.kv', {},
      h('dt', {}, '받는 곳'), h('dd', {}, name),
      h('dt', {}, '항목'), h('dd', {}, '이름, 휴대전화번호, 주소(시/구까지), 고르신 서비스의 질문 답변(집 크기·짐 양·에어컨 대수·창 치수 등), 희망 일정'),
      h('dt', {}, '목적'), h('dd', {}, '견적 계산·전달, 일정 연락'),
      h('dt', {}, '보관'), h('dd', {}, '계약하지 않으면 견적 유효기간이 끝난 뒤 3개월 후 삭제해요. 계약하면 관련 법령에 따라 최대 5년 보관해요.'),
      h('dt', {}, '견적 프로그램 운영'), h('dd', {}, 'T.M LINK(데이터 보관은 Google Cloud 서울 리전)')),
    h('p.muted.small', {}, '동의하지 않으면 견적을 받을 수 없어요.'));
  const startBtn = h('button.btn.primary.block', {
    type: 'button', disabled: !state.consent,
    onclick: () => {
      if (!state.consent) return;
      state.phase = tpl ? 'steps' : 'service';
      render(); window.scrollTo(0, 0);
    },
  }, '시작하기');
  const check = h('input', {
    type: 'checkbox', checked: state.consent, id: 'consent',
    onchange: (e) => { state.consent = e.target.checked; startBtn.disabled = !state.consent; },
  });
  show(
    shopHead('견적 요청'),
    h('section.card.step', {},
      h('h1', {}, `${name} 견적 요청`),
      h('p', {}, `몇 가지만 알려주시면 ${name} 사장님이 확인해서 견적을 보내드려요.\n견적 요청은 계약이 아니며 비용이 들지 않아요.`),
      h('div.consent-row', {},
        h('label.consent-label', { for: 'consent' }, check, ' (필수) 개인정보 수집·이용에 동의해요'),
        h('button.btn.ghost.small', {
          type: 'button', onclick: () => { detail.hidden = !detail.hidden; },
        }, '보기'),
        privacyUrl ? h('a.small', { href: privacyUrl, target: '_blank', rel: 'noopener' }, '처리방침 전문') : null),
      detail),
    h('div.nav-row', {}, h('span'), startBtn),
    footer(),
  );
}

// ② 서비스 선택 (업종 2개 이상)
function renderService() {
  show(
    shopHead('견적 요청'),
    h('section.card.step', {},
      h('h1', {}, '어떤 서비스가 필요하세요?'),
      h('div.choices.col', {}, templateIds.map((id) => h('button.chip', {
        type: 'button',
        onclick: (e) => { e.target.disabled = true; chooseTemplate(id).catch((err) => showFatal(err.message)); },
      }, templateName(id))))),
    h('div.nav-row', {},
      h('button.btn.ghost', { type: 'button', onclick: () => { state.phase = 'consent'; render(); } }, '이전'), h('span')),
    footer(),
  );
}

function renderSteps() {
  const steps = tpl.steps;
  const step = steps[state.step];
  const pct = Math.round(((state.step + 1) / steps.length) * 100);
  show(
    shopHead(`${tpl.name} 견적 요청`),
    h('div.progress', { role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('div.progress-bar', { style: `width:${pct}%` })),
    h('div.step-count.muted', {}, `${state.step + 1} / ${steps.length}`),
    h('section.card.step', {},
      h('h1', {}, step.title),
      step.description ? h('p.muted', {}, step.description) : null,
      ...step.fields.map(renderField)),
    h('div.nav-row', {},
      h('button.btn.ghost', { type: 'button', onclick: prev }, '이전'),
      h('button.btn.primary', { type: 'button', onclick: next, disabled: state.submitting },
        state.step === steps.length - 1 ? (state.submitting ? '보내는 중…' : '견적 요청 보내기') : '다음')),
    footer(),
  );
  const first = app.querySelector('.step input, .step textarea');
  if (first && first.type !== 'file') first.focus({ preventScroll: true });
}

/** maxField: 다른 답변 값이 상한이 된다 (예: 완전분해 대수 ≤ 벽걸이 대수) */
function capOf(f) {
  let max = f.max;
  if (f.maxField) {
    const cap = state.answers[f.maxField];
    if (cap !== '' && cap != null && !Number.isNaN(Number(cap))) max = max == null ? Number(cap) : Math.min(max, Number(cap));
  }
  return max;
}

function renderField(f) {
  const v = state.answers[f.key];
  const set = (val) => { state.answers[f.key] = val; saveDraft(); };
  switch (f.type) {
    case 'text': case 'tel': case 'date': case 'number': {
      const input = h('input.input', {
        type: f.type, value: v ?? '', placeholder: f.placeholder || '', maxLength: f.maxLength || 100,
        inputMode: f.type === 'number' ? 'decimal' : f.type === 'tel' ? 'tel' : undefined,
        min: f.type === 'date' ? new Date().toISOString().slice(0, 10) : f.min, max: f.type === 'number' ? capOf(f) : f.max,
        oninput: (e) => set(f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value),
        onkeydown: (e) => { if (e.key === 'Enter') next(); },
      });
      return fieldWrap(f, input);
    }
    case 'textarea':
      return fieldWrap(f, h('textarea.input', {
        rows: 4, value: v ?? '', placeholder: f.placeholder || '', maxLength: f.maxLength || 500,
        oninput: (e) => set(e.target.value),
      }), h('span.hint.warn-text', {}, MEMO_WARNING));
    case 'choice':
      return fieldWrap(f, h('div.choices', {}, f.options.map((o) => h(`button.chip${v === o.value ? '.on' : ''}`, {
        type: 'button', onclick: () => { set(o.value); render(); },
      }, o.label))));
    case 'stepper': {
      const max = capOf(f) ?? 99;
      const min = f.min ?? 0;
      const val = Math.min(Number(v ?? min), Math.max(min, max));
      const change = (d) => { set(Math.min(max, Math.max(min, val + d))); render(); };
      return h('div.stepper-field', {},
        h('div.stepper-row', {}, h('span.label', {}, f.label),
          h('div.stepper', {},
            h('button.btn.round', { type: 'button', onclick: () => change(-1), 'aria-label': `${f.label} 줄이기` }, '−'),
            h('span.num', {}, val),
            h('button.btn.round', { type: 'button', onclick: () => change(1), disabled: val >= max, 'aria-label': `${f.label} 늘리기` }, '+'))),
        f.hint ? h('span.hint', {}, f.hint) : null);
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
    case 'photos':
      return renderPhotos();
    default:
      return h('p.muted', {}, `알 수 없는 항목 유형: ${f.type}`);
  }
}

function fieldWrap(f, control, extra = null) {
  // 버튼 묶음은 <label> 안에 넣으면 제목을 눌러도 첫 버튼이 선택되므로 div 로 감싼다
  return h(f.type === 'choice' ? 'div.field' : 'label.field', {}, h('span.label', {}, f.label, f.required ? null : h('span.muted', {}, ' (선택)')),
    control, f.hint ? h('span.hint', {}, f.hint) : null, extra);
}

// ---------- 사진: 칸(반복) × 컷, 바텀시트 촬영 안내 ----------

function currentSlots() {
  return expandPhotoSlots(tpl, state.answers);
}

/** 화면에 없는 칸(반복 수가 줄어든 경우)의 사진은 버린다 */
function prunePhotos() {
  const valid = new Set(currentSlots().flatMap((sl) => sl.shots.map((sh) => photoKey(sl.slot, sl.index, sh.key))));
  for (const k of Object.keys(state.photos)) if (!valid.has(k)) delete state.photos[k];
}

function renderPhotos() {
  prunePhotos();
  const limit = photoLimit(tpl);
  const count = Object.keys(state.photos).length;
  return h('div', {},
    h('div.photo-tips.muted.small', {},
      h('div', {}, '📷 이렇게 찍어 주세요'),
      h('div', {}, '· 사람 얼굴, 가족사진, 우편물·서류가 나오지 않게'),
      h('div', {}, '· 거울에 비친 모습도 피해 주세요'),
      h('div', {}, '· 사진은 사장님만 볼 수 있어요')),
    h('div.muted.small', {}, `${count} / ${limit}장`),
    currentSlots().map((sl) => h('div.photo-group', {},
      sl.shots.length > 1 ? h('div.photo-group-title', {}, sl.label) : null,
      h('div.photo-grid', {}, sl.shots.map((sh) => renderPhotoShot(sl, sh, count >= limit))))));
}

function renderPhotoShot(sl, sh, full) {
  const key = photoKey(sl.slot, sl.index, sh.key);
  const blob = state.photos[key];
  const title = sl.shots.length > 1 ? (sh.label || sh.key) : sl.label;
  return h('div.photo-slot', {
    onclick: () => {
      if (!blob && full) { toast(`사진은 최대 ${photoLimit(tpl)}장까지 올릴 수 있어요.`); return; }
      openShotSheet(sl, sh, key);
    },
  },
  blob ? h('img', { src: URL.createObjectURL(blob), alt: title }) : h('div.photo-plus', {}, '+'),
  h('div.photo-label', {}, title, sh.required ? null : h('span.muted', {}, ' (선택)'), blob ? ' ✓' : ''),
  blob ? h('button.photo-del', {
    type: 'button', 'aria-label': `${title} 사진 삭제`,
    onclick: (e) => { e.stopPropagation(); delete state.photos[key]; render(); },
  }, '×') : null);
}

const svgCache = new Map();
/**
 * 촬영 안내 그림(img/guide/{name}.svg)을 읽어 인라인 삽입한다 → currentColor 로 다크모드·테마를 따라감.
 * 이름은 /^[a-z-]+$/ 만 허용(경로 조작 방지). 파일이 없거나 실패하면 null → tip 만 보여준다.
 */
async function loadGuideSvg(name) {
  if (!name || !/^[a-z-]+$/.test(name)) return null;
  if (!svgCache.has(name)) {
    svgCache.set(name, fetch(new URL(`../img/guide/${name}.svg`, import.meta.url))
      .then((r) => (r.ok ? r.text() : null)).catch(() => null));
  }
  const text = await svgCache.get(name);
  if (!text) return null;
  const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null;
  svg.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  svg.removeAttribute('role'); svg.removeAttribute('aria-labelledby');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  return document.importNode(svg, true);
}

/** 바텀시트: "이렇게 찍어주세요" 그림(있으면) + tip → [촬영] [앨범] */
function openShotSheet(sl, sh, key) {
  const pick = async (file) => {
    if (!file) return;
    try {
      state.photos[key] = await compressImage(file);
      dlg.close(); dlg.remove();
      render();
    } catch (err) { toast(err.message); }
  };
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: (e) => pick(e.target.files?.[0]) });
  const album = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => pick(e.target.files?.[0]) });
  const ill = h('div.guide-ill', { 'aria-hidden': 'true', hidden: true });
  loadGuideSvg(sh.illustration).then((svg) => { if (svg) { ill.replaceChildren(svg); ill.hidden = false; } });
  const dlg = h('dialog.sheet', {},
    h('h2', {}, `${sl.label}${sl.shots.length > 1 && sh.label ? ` · ${sh.label}` : ''}`),
    h('p.muted', {}, '이렇게 찍어주세요'),
    ill,
    sh.tip ? h('p.guide-tip', {}, sh.tip) : null,
    h('div.btn-col', {},
      h('button.btn.primary.big', { type: 'button', onclick: () => camera.click() }, '촬영'),
      h('button.btn.ghost', { type: 'button', onclick: () => album.click() }, '앨범에서 고르기'),
      h('button.btn.ghost', { type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, '닫기')),
    camera, album);
  document.body.append(dlg);
  dlg.showModal();
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
  return crossCheck(state.step);
}

/**
 * 교차검증을 "판단할 수 있게 된 단계"에서만 한다.
 * - maxField: 이 단계에 그 필드나 상한 필드가 있고, 둘 다 이미 나온 경우
 * - validation.requireAny: 키들 중 마지막으로 나오는 단계에서
 */
function crossCheck(stepIdx) {
  const here = new Set(tpl.steps[stepIdx].fields.map((f) => f.key));
  const stepOf = (k) => tpl.steps.findLastIndex((st) => st.fields.some((f) => f.key === k));
  const fields = tpl.steps.flatMap((st) => st.fields).map((f) => (
    f.maxField && (here.has(f.key) || here.has(f.maxField)) && stepOf(f.key) <= stepIdx && stepOf(f.maxField) <= stepIdx
      ? f : { ...f, maxField: undefined }));
  const rules = (tpl.validation == null ? [] : [].concat(tpl.validation))
    .filter((r) => Array.isArray(r?.requireAny) && r.requireAny.length && Math.max(...r.requireAny.map(stepOf)) === stepIdx);
  return validateAnswers({ steps: [{ fields }], validation: rules }, { answers: state.answers })[0] || null;
}

function prev() {
  if (state.step === 0) { state.phase = templateIds.length > 1 ? 'service' : 'consent'; render(); window.scrollTo(0, 0); return; }
  state.step = Math.max(0, state.step - 1); render(); window.scrollTo(0, 0);
}

async function next() {
  const err = validateStep();
  if (err) { toast(err); return; }
  const isPhotoStep = tpl.steps[state.step].fields.some((f) => f.type === 'photos');
  if (isPhotoStep && state.step < tpl.steps.length - 1 && !(await confirmMissingPhotos())) return;
  if (state.step < tpl.steps.length - 1) { state.step += 1; render(); window.scrollTo(0, 0); return; }
  submit();
}

/** 필수 컷이 비어 있으면 화면 안 안내 시트 (제출은 허용). true = 계속 진행 */
function confirmMissingPhotos() {
  prunePhotos();
  const miss = missingRequiredShots(tpl, state.answers, Object.keys(state.photos));
  if (!miss.length) return Promise.resolve(true);
  const names = miss.slice(0, 3).map((m) => (m.shotLabel ? `${m.label} ${m.shotLabel}` : m.label));
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const dlg = h('dialog.sheet', {},
      h('h2', {}, `${names.join(', ')}${miss.length > 3 ? ` 외 ${miss.length - 3}곳` : ''} 사진이 없어요`),
      h('p.muted', {}, '사진 없이 보내면 현장 확인 후 금액이 달라질 수 있어요.'),
      h('div.btn-col', {},
        h('button.btn.primary.big', { type: 'button', onclick: () => done(false) }, '사진 마저 올리기'),
        h('button.btn.ghost', { type: 'button', onclick: () => done(true) }, '사진 없이 다음')));
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

async function submit() {
  if (state.submitting) return;
  const errs = validateAnswers(tpl, { answers: state.answers });
  if (errs.length) { toast(errs[0], 4000); return; }
  if (!state.consent) { state.phase = 'consent'; render(); toast('개인정보 수집·이용에 동의해주세요.'); return; }
  // 사진 단계가 마지막이면 여기서 안내 (그 외에는 사진 단계에서 이미 안내함)
  if (tpl.steps.at(-1).fields.some((f) => f.type === 'photos') && !(await confirmMissingPhotos())) return;
  state.submitting = true; render();
  try {
    prunePhotos();
    const requestRef = doc(collection(db, 'requests'));
    const photos = [];
    const limit = photoLimit(tpl);
    for (const sl of currentSlots()) {
      for (const sh of sl.shots) {
        const key = photoKey(sl.slot, sl.index, sh.key);
        const blob = state.photos[key];
        if (!blob || photos.length >= limit) continue;
        const path = `requests/${shopId}/${requestRef.id}/${key}.jpg`;
        await uploadBytes(storageRef(storage, path), blob, { contentType: 'image/jpeg' });
        photos.push({ slot: sl.slot, index: sl.index, shot: sh.key, path }); // 다운로드 URL은 사장님 화면에서 권한 확인 후 받는다
      }
    }
    const { name, phone, region, ...rest } = state.answers;
    await setDoc(requestRef, {
      shopId,
      templateId: tpl.id,
      status: 'new',
      customer: { name: String(name).trim(), phone: String(phone).trim(), region: String(region || '').trim() },
      answers: { ...rest, extras: state.extras },
      checklist: state.checklist,
      photos,
      quoteId: null,
      consent: { version: appConfig.consentVersion, at: serverTimestamp() },
      createdAt: serverTimestamp(),
    });
    try { localStorage.removeItem(draftKey); localStorage.removeItem(`draft:${shopId}`); } catch { /* 무시 */ }
    renderDone();
  } catch (e) {
    console.error(e);
    state.submitting = false; render();
    toast('전송에 실패했어요. 인터넷 연결을 확인하고 다시 눌러주세요.', 4000);
  }
}

function renderDone() {
  show(h('section.card.done', {},
    h('div.done-icon', {}, '✓'),
    h('h1', {}, '요청이 접수되었습니다'),
    h('p', {}, `${shop.name || '사장님'}이 확인 후 견적을 보내드립니다.`),
    h('p.muted', {}, '보통 작업이 끝난 뒤 순서대로 확인합니다. 급하시면 전화 주세요.'),
    shop.phone ? h('a.btn.primary', { href: telHref(shop.phone) }, `📞 ${shop.phone} 전화하기`) : null),
  footer());
}
