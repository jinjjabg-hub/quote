// 개발자 모드 · 업종 시뮬레이터 (dev.html)
// 로그인·Firebase 없이 업종 템플릿 + 계산 엔진만으로 "고객 입력 → 계산 → 견적서 → 인력 예상"을 한 화면에서 확인한다.
// 실제 앱과 같은 calc.js·templates/*.json 을 쓰므로, 여기서 맞으면 실제 앱 계산도 같다.
import {
  calculateQuote, mergePriceTable, lintTemplate, buildContext, isFieldVisible, formatWon, addDays, toDateStr, isVerified, ROUNDING_KEY,
} from './calc.js';
import { $, h, toast, setChildren } from './util.js';
import { devlog } from './devtools.js';

const app = $('#app');
const S = { list: [], id: null, tpl: null, pt: null, answers: {}, checklist: {}, photos: 0, overrides: { surcharges: {}, options: {} }, open: { price: false, dev: false } };

init().catch((e) => { devlog('error', e); setChildren(app, h('div.card.error', {}, '불러오기 실패: ', e.message)); });

async function init() {
  S.list = await (await fetch('templates/index.json')).json();
  const want = location.hash.slice(1);
  await selectTemplate(S.list.some((t) => t.id === want) ? want : S.list[0].id);
}

async function selectTemplate(id) {
  const res = await fetch(`templates/${id}.json`);
  if (!res.ok) throw new Error(`템플릿 파일을 찾을 수 없음: ${id}`);
  S.id = id;
  S.tpl = await res.json();
  S.pt = mergePriceTable(S.tpl, {});
  S.overrides = { surcharges: {}, options: {} };
  fillSample();
  history.replaceState(null, '', `#${id}`);
  for (const l of lintTemplate(S.tpl)) devlog(l.level === 'error' ? 'error' : 'warn', `[템플릿 점검] ${S.tpl.name}: ${l.msg}`);
  render();
}

function fillSample() {
  const s = S.tpl.sample || { answers: {}, checklist: {} };
  S.answers = { date: addDays(toDateStr(new Date()), 3), ...structuredClone(s.answers || {}) };
  for (const st of S.tpl.steps) for (const f of st.fields) if (f.default != null && S.answers[f.key] == null) S.answers[f.key] = f.default;
  if (s.customer) Object.assign(S.answers, s.customer);
  S.checklist = structuredClone(s.checklist || {});
  S.photos = (S.tpl.photoSlots || []).length;
}

function request() {
  return { answers: S.answers, checklist: S.checklist, photos: Array.from({ length: S.photos }, (_, i) => ({ slot: `p${i}` })) };
}

// ---------- 렌더 ----------

function render() {
  let r = null; let error = null;
  try { r = calculateQuote(S.tpl, S.pt, request(), S.overrides); } catch (e) { error = e; devlog('error', `[계산] ${S.tpl.name}:`, e); }
  const lint = lintTemplate(S.tpl);
  setChildren(app, 
    h('header.dev-head', {},
      h('div', {}, h('div.eyebrow', {}, '개발자 모드'), h('h1', {}, '업종 시뮬레이터'),
        h('p.muted', {}, '로그인 없이 업종별로 고객 입력 → 계산 → 견적서 → 인력 예상을 확인합니다. 왼쪽 값을 바꾸면 오른쪽이 바로 바뀝니다. 저장되지 않습니다.')),
      h('a.btn.ghost.small', { href: 'owner.html' }, '사장님 화면으로')),
    h('nav.dev-tabs', {}, S.list.map((t) => h(`button.chip${t.id === S.id ? '.on' : ''}`, { type: 'button', onclick: () => selectTemplate(t.id).catch((e) => devlog('error', e)) },
      t.name, h(`span.mini.${t.status === 'live' ? 'live' : 'draft'}`, {}, t.status === 'live' ? '운영' : '초안')))),
    S.tpl.status === 'draft' ? h('div.warn-box', {}, S.tpl.draftNote || '초안입니다.') : null,
    lint.length ? h('div.lint', {}, h('b', {}, `템플릿 점검 ${lint.length}건`), h('ul', {}, lint.map((l) => h(`li.${l.level}`, {}, l.level === 'error' ? '오류 · ' : '주의 · ', l.msg)))) : h('div.lint.ok', {}, '✓ 템플릿 점검 통과'),
    h('div.dev-grid', {},
      h('section.card', {}, h('h2', {}, '① 고객 입력'),
        h('p.muted.small', {}, `견적 형태: ${S.tpl.quoteMode === 'range' ? '범위 견적 → 실측 후 확정' : '확정 견적'} · 질문 ${S.tpl.steps.length}단계`),
        h('div.btn-row', {}, h('button.btn.ghost.small', { onclick: () => { fillSample(); render(); } }, '샘플로 채우기'),
          h('button.btn.ghost.small', { onclick: () => { S.answers = { date: S.answers.date }; S.checklist = {}; S.photos = 0; render(); } }, '비우기')),
        S.tpl.steps.map(renderStep)),
      h('section.card', {}, h('h2', {}, '② 계산 결과 (견적서)'), error ? h('div.card.error', {}, `계산 오류: ${error.message}`) : renderResult(r))),
    renderOverrides(r),
    renderPriceTable(),
    renderDevInfo(r),
  );
}

function renderStep(step, i) {
  // 조건부 질문은 조건이 안 맞으면 고객 화면에 안 보인다 → 여기서는 흐리게 표시만
  return h('fieldset.dev-step', {}, h('legend', {}, `${i + 1}. ${step.title}`), step.fields.map((f) => {
    if (isFieldVisible(f, S.answers)) return renderField(f);
    return h('p.muted.small.dev-hidden', {}, `↳ 숨김: ${f.label || f.key} (조건 ${JSON.stringify(f.showIf)} 불일치)`);
  }));
}

function set(key, v) { S.answers[key] = v; render(); }

function renderField(f) {
  const v = S.answers[f.key];
  const row = (control) => h('label.dev-field', {}, h('span', {}, f.label || f.key, f.required ? h('b.req', {}, ' *') : null), control);
  switch (f.type) {
    case 'text': case 'tel': case 'textarea':
      return row(h('input.input', { value: v ?? '', onchange: (e) => set(f.key, e.target.value) }));
    case 'date':
      return row(h('input.input', { type: 'date', value: v ?? '', onchange: (e) => set(f.key, e.target.value) }));
    case 'number': case 'stepper':
      return row(h('input.input', { type: 'number', value: v ?? '', min: f.min, max: f.max, step: 'any', onchange: (e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value)) }));
    case 'choice':
      return row(h('select.input', { onchange: (e) => set(f.key, f.options[Number(e.target.value)]?.value) },
        h('option', { value: '' }, '— 선택 —'),
        f.options.map((o, i) => h('option', { value: i, selected: o.value === v }, o.label))));
    case 'checklist':
      return h('div.dev-check', {}, S.tpl.checklist.map((c) => h('div.dev-check-row', {},
        h('span', {}, c.label, h('span.muted.small', {}, c.risk === 'yes' ? ' (예=위험)' : ' (아니오=위험)')),
        h('div.seg', {}, [['yes', '예'], ['no', '아니오'], ['unknown', '모름']].map(([val, label]) => h(`button.seg-btn${S.checklist[c.key] === val ? '.on' : ''}`, {
          type: 'button', onclick: () => { S.checklist[c.key] = val; render(); },
        }, label))))));
    case 'extras': {
      const opts = S.tpl.pricing.options.filter((o) => o.customerSelectable);
      if (!opts.length) return h('p.muted.small', {}, '고객이 고를 추가 서비스 없음');
      const cur = Array.isArray(v) ? v : [];
      return h('div.dev-extras', {}, opts.map((o) => h('label.toggle', {},
        h('input', { type: 'checkbox', checked: cur.includes(o.key), onchange: (e) => set(f.key, e.target.checked ? [...cur, o.key] : cur.filter((k) => k !== o.key)) }), ` ${o.label}`)));
    }
    case 'photos':
      return h('div', {},
        h('p.small', {}, '권장 사진 칸: ', (S.tpl.photoSlots || []).map((p) => p.label).join(' · ') || '없음', ' (+ 기타 최대 5장, 합계 10장)'),
        row(h('input.input', { type: 'number', min: 0, max: 10, value: S.photos, onchange: (e) => { S.photos = Number(e.target.value) || 0; render(); } })));
    case 'items':
      return renderItems(f);
    default:
      return h('p.error', {}, `알 수 없는 입력 형태: ${f.type}`);
  }
}

function renderItems(f) {
  const types = S.tpl.pricing.base.itemTypes || [];
  const items = Array.isArray(S.answers[f.key]) ? S.answers[f.key] : [];
  const update = (next) => set(f.key, next);
  return h('div.dev-items', {},
    h('span.label', {}, f.label),
    items.map((it, i) => {
      const t = types.find((x) => x.key === it.type);
      return h('div.dev-item', {},
        h('select.input', { onchange: (e) => update(items.map((x, j) => (j === i ? { ...x, type: e.target.value } : x))) },
          types.map((tt) => h('option', { value: tt.key, selected: tt.key === it.type }, tt.label))),
        h('input.input', { type: 'number', min: 0, value: it.count ?? 1, title: '개수', onchange: (e) => update(items.map((x, j) => (j === i ? { ...x, count: Number(e.target.value) } : x))) }),
        t?.bySize ? h('input.input', { type: 'number', min: 0, step: 'any', value: it.size ?? '', placeholder: t.sizeLabel || '크기', title: t.sizeLabel, onchange: (e) => update(items.map((x, j) => (j === i ? { ...x, size: Number(e.target.value) } : x))) }) : h('span.muted.small', {}, t?.unit || ''),
        h('button.btn.round.ghost', { type: 'button', title: '삭제', onclick: () => update(items.filter((_, j) => j !== i)) }, '×'));
    }),
    h('button.btn.ghost.small', { type: 'button', onclick: () => update([...items, { type: types[0]?.key, count: 1 }]) }, '+ 항목 추가'));
}

function renderResult(r) {
  const ctx = buildContext(S.answers, S.tpl);
  const flags = [ctx.$weekend && '주말', ctx.$holiday && '공휴일', ctx.$sonEomneun && '손 없는 날', ctx.$monthEnd && '월말'].filter(Boolean);
  return h('div.dev-result', {},
    h('div.chips', {},
      h(`span.badge.${r.quoteMode === 'range' ? 'st-req' : 'st-ok'}`, {}, r.quoteMode === 'range' ? '범위 견적' : '확정 견적'),
      r.verified ? h('span.badge.verified', {}, '📷 사진 확인 완료') : h('span.badge', {}, '사진·체크리스트 미완료'),
      flags.length ? h('span.badge.st-new', {}, `날짜: ${flags.join('·')}`) : null),
    h('table.lines-table', {}, h('tbody', {}, r.lines.map((l) => h(`tr${l.key === ROUNDING_KEY ? '.muted' : ''}`, {},
      h('td', {}, h('span.kind', {}, { base: '기본', surcharge: '할증', option: '옵션', rounding: '조정' }[l.type] || l.type), ' ', l.label, l.note ? h('div.muted.small', {}, l.note) : null),
      h('td.num', {}, formatWon(l.amount)))))),
    h('div.total-box', {},
      h('div', {}, r.range ? '예상 금액' : '합계', h('b', {}, r.range ? `${formatWon(r.range.low)} ~ ${formatWon(r.range.high)}` : formatWon(r.total))),
      r.range ? h('div.muted', {}, `기준 금액 ±${r.range.pct}% (실측 후 확정)`, h('span', {}, formatWon(r.total))) : null,
      h('div.muted', {}, `계약금 ${S.pt.policy?.depositPct ?? 0}%`, h('span', {}, formatWon(r.deposit)))),
    r.labor ? h('div.labor', {}, h('b', {}, '👷 인력 예상: '), `${r.labor.crew}명 × ${r.labor.hours}시간`, h('span.muted.small', {}, ` (총 ${r.labor.manHours}인시간${r.labor.overDay ? ' · 하루 초과 → 이틀 작업' : ''})`)) : h('div.labor.muted', {}, '인력 예상 규칙 없음'),
    list('⚠️ 현장 추가요금 조건', r.conditions.map((c) => `${c.label} — ${c.text}`), 'cond'),
    list('✅ 포함', r.included, 'ok'),
    list('❌ 불포함', r.excluded, 'no'));
}

function list(title, items, cls) {
  return h(`div.dev-list.${cls}`, {}, h('h3', {}, title), items.length ? h('ul', {}, items.map((t) => h('li', {}, t))) : h('p.muted.small', {}, '없음'));
}

function renderOverrides(r) {
  if (!r) return null;
  const p = S.tpl.pricing;
  const toggle = (group, item, st) => h('label.toggle', {},
    h('input', { type: 'checkbox', checked: !!st?.on, onchange: (e) => { S.overrides[group][item.key] = e.target.checked; render(); } }),
    ` ${item.label}`, st?.auto ? h('span.muted.small', {}, ' 자동') : null);
  return h('section.card', {}, h('h2', {}, '③ 사장님 수동 조정 (견적 상세 화면과 같음)'),
    h('div.toggle-group', {}, h('b', {}, '할증'), p.surcharges.length ? p.surcharges.map((s) => toggle('surcharges', s, r.surchargeState[s.key])) : h('span.muted.small', {}, '없음')),
    h('div.toggle-group', {}, h('b', {}, '옵션'), p.options.map((o) => toggle('options', o, r.optionState[o.key]))),
    h('button.btn.ghost.small', { onclick: () => { S.overrides = { surcharges: {}, options: {} }; render(); } }, '자동 계산으로 되돌리기'));
}

// 단가표: 템플릿 기본값의 모양을 그대로 따라 숫자 칸을 만든다 (업종마다 모양이 달라도 코드 수정 없이)
function renderPriceTable() {
  const p = S.tpl.pricing;
  const labels = {
    ...Object.fromEntries((p.base.itemTypes || []).map((t) => [`items.${t.key}`, `${t.label}${t.bySize ? ` (${t.sizeUnit}당)` : ` (${t.unit || '개'}당)`}`])),
    ...Object.fromEntries(p.surcharges.map((s) => [`surcharges.${s.key}`, `${s.label} 할증 (%)`])),
    ...Object.fromEntries(p.options.map((o) => [`options.${o.key}`, o.priceLabel || o.label])),
    ...Object.fromEntries((p.base.components || []).flatMap((c) => {
      const k = c.priceKey || c.tiersKey;
      return c.optionsLabel ? Object.entries(c.optionsLabel).map(([ok, ol]) => [`${k}.${ok}`, `${c.label}: ${ol}`]) : [[k, c.label]];
    })),
    unitPrice: `${p.base.unitPriceLabel || '단가'}`, minPrice: '최소 금액', installFee: p.base.perItemFeeLabel || '설치비',
    'policy.validDays': '견적 유효기간 (일)', 'policy.depositPct': '계약금 (%)',
  };
  const rows = [];
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = path ? `${path}.${k}` : k;
      if (typeof v === 'number') {
        rows.push(h('label.price-row', {}, h('span', {}, labels[key] || key, h('span.muted.small', {}, ` ${key}`)),
          h('input.input', { type: 'number', value: v, step: 'any', onchange: (e) => { setPath(S.pt, key, Number(e.target.value) || 0); render(); } })));
      } else if (Array.isArray(v)) {
        v.forEach((tier, i) => walk(tier, `${key}.${i}`));
      } else if (v && typeof v === 'object') walk(v, key);
    }
  };
  walk(S.pt, '');
  return h('details.card', { open: S.open.price, ontoggle: (e) => { S.open.price = e.target.open; } },
    h('summary', {}, h('b', {}, '④ 사장님 단가표 (숫자를 바꾸면 바로 반영 · 예시값)')),
    h('div', {}, rows),
    h('button.btn.ghost.small', { onclick: () => { S.pt = mergePriceTable(S.tpl, {}); render(); } }, '기본값으로'));
}

function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k];
  o[ks.at(-1)] = val;
}

function renderDevInfo(r) {
  const ctx = buildContext(S.answers, S.tpl);
  const derived = Object.fromEntries(Object.entries(ctx).filter(([k]) => k.startsWith('$')));
  const copy = (txt) => navigator.clipboard.writeText(txt).then(() => toast('복사했어요')).catch(() => toast('복사 실패'));
  const pre = (title, data) => h('details', {}, h('summary', {}, title, ' ', h('button.btn.ghost.small', { type: 'button', onclick: (e) => { e.preventDefault(); copy(JSON.stringify(data, null, 2)); } }, '복사')),
    h('pre.json', {}, JSON.stringify(data, null, 2)));
  return h('details.card', { open: S.open.dev, ontoggle: (e) => { S.open.dev = e.target.open; } },
    h('summary', {}, h('b', {}, '⑤ 개발자 정보 (원본 데이터)')),
    h('p.muted.small', {}, '문제가 있을 때 아래 내용을 복사해서 전달하면 원인을 바로 찾을 수 있습니다.'),
    pre('날짜 자동 판정·파생값 ($)', derived),
    pre('고객 입력 (answers · checklist)', { answers: S.answers, checklist: S.checklist, photos: S.photos }),
    pre('계산 결과 (calculateQuote)', r),
    pre('단가표 (priceTable)', S.pt),
    pre(`업종 템플릿 (templates/${S.id}.json)`, S.tpl),
    h('p.muted.small', {}, `사진 확인 배지 조건: 사진 1장 이상 + 체크리스트 전부 답변 → 현재 ${isVerified(S.tpl, request()) ? '충족' : '미충족'}`));
}
