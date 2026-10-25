// 견적 계산 순수 함수 모음 (Firebase·DOM 의존 없음 → Node 테스트 가능)
// 업종별 규칙은 templates/*.json 에 있고, 이 파일은 그 규칙을 "해석"만 한다.
//
// 합계 = max(최소금액, 수량 × 단가) × (1 + 해당 할증% 합) + 선택된 옵션 금액 합
//       → 1,000원 단위 반올림

export const ROUNDING_KEY = '_rounding';

export function round1000(n) {
  return Math.round(n / 1000) * 1000;
}

export function formatWon(n) {
  return `${Math.round(Number(n) || 0).toLocaleString('ko-KR')}원`;
}

// ---------- 날짜 → 자동 플래그 (주말/공휴일/손 없는 날) ----------

function parseLocalDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

let lunarFmt = null;
function lunarOf(date) {
  try {
    lunarFmt ||= new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric' });
    const parts = lunarFmt.formatToParts(date);
    const month = parts.find((p) => p.type === 'month')?.value || '';
    const day = parts.find((p) => p.type === 'day')?.value;
    return { month: parseInt(month, 10), day: parseInt(day, 10), leap: /bis/.test(month) };
  } catch {
    return null; // 음력 달력을 지원하지 않는 브라우저 → 사장님이 수동 체크
  }
}

const SOLAR_HOLIDAYS = ['01-01', '03-01', '05-05', '06-06', '08-15', '10-03', '10-09', '12-25'];

// 음력 기준 공휴일: 설날(전날·당일·다음날), 부처님오신날, 추석(전날·당일·다음날)
function isLunarHoliday(date) {
  const l = lunarOf(date);
  if (!l || l.leap) return false;
  if (l.month === 1 && (l.day === 1 || l.day === 2)) return true;
  if (l.month === 4 && l.day === 8) return true;
  if (l.month === 8 && l.day >= 14 && l.day <= 16) return true;
  const next = lunarOf(new Date(date.getTime() + 86400000));
  return !!(next && !next.leap && next.month === 1 && next.day === 1); // 설 전날
}

/**
 * 희망 날짜 문자열(YYYY-MM-DD)로 자동 판정 가능한 플래그를 돌려준다.
 * 대체공휴일·임시공휴일은 판정하지 않으므로 사장님 화면에서 수동 조정한다.
 */
export function dateFlags(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return { $month: 0, $monthEnd: false, $weekend: false, $holiday: false, $sonEomneun: false };
  const mmdd = dateStr.slice(5);
  const lunar = lunarOf(d);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return {
    $month: d.getMonth() + 1,
    $monthEnd: d.getDate() >= lastDay - 2, // 말일 포함 마지막 3일
    $weekend: d.getDay() === 0 || d.getDay() === 6,
    $holiday: SOLAR_HOLIDAYS.includes(mmdd) || isLunarHoliday(d),
    // 손 없는 날: 음력 끝자리가 9, 0 인 날
    $sonEomneun: !!lunar && [9, 0].includes(lunar.day % 10),
  };
}

// ---------- 조건식 ----------

/** 템플릿의 when 조건 평가. {field, equals} | {field, in:[]} | {field, gt} | {any:[...]} | {all:[...]} */
export function evalWhen(when, ctx) {
  if (!when) return false;
  if (Array.isArray(when.any)) return when.any.some((w) => evalWhen(w, ctx));
  if (Array.isArray(when.all)) return when.all.every((w) => evalWhen(w, ctx));
  const v = ctx[when.field];
  if ('equals' in when) return v === when.equals;
  if (Array.isArray(when.in)) return when.in.includes(v);
  if ('gt' in when) return Number(v) > when.gt;
  return false;
}

// ---------- 조건부 질문 ----------
// 필드에 showIf 가 있으면 조건이 맞을 때만 보인다 (문법은 when 과 같음, 예: {"field":"hasCloset","equals":true}).
// 숨겨진 질문의 답은 계산에 쓰지 않는다. 고객이 개수를 넣었다가 "없음"으로 바꿔도 금액이 남지 않게 하기 위함.

export function isFieldVisible(field, answers = {}) {
  return !field.showIf || evalWhen(field.showIf, answers);
}

/** 화면에 보이는 질문만 남긴 단계 목록. 질문이 모두 숨겨진 단계는 건너뛴다. */
export function visibleSteps(template, answers = {}) {
  return (template.steps || [])
    .map((s) => ({ ...s, fields: s.fields.filter((f) => isFieldVisible(f, answers)) }))
    .filter((s) => s.fields.length);
}

/** 숨겨진 질문의 답을 뺀 answers (순서대로 판정하므로 조건이 이어져도 맞게 빠진다) */
export function pruneHidden(template, answers = {}) {
  const out = { ...answers };
  for (const f of (template?.steps || []).flatMap((s) => s.fields)) {
    if (!isFieldVisible(f, out)) delete out[f.key];
  }
  return out;
}

export function buildContext(answers = {}, template = null) {
  answers = template ? pruneHidden(template, answers) : answers;
  const ctx = { ...answers, ...dateFlags(answers.date) };
  const itemsField = template?.pricing?.base?.itemsField;
  const items = itemsField && Array.isArray(answers[itemsField]) ? answers[itemsField] : [];
  ctx.$itemsCount = items.reduce((a, it) => a + (Number(it.count) || 0), 0);
  ctx.$itemsSizeSum = items.reduce((a, it) => a + (Number(it.count) || 0) * (Number(it.size) || 0), 0);
  return ctx;
}

// ---------- 기본값 ----------

/** 템플릿 기본값과 사장님 저장값을 합쳐 빈 칸이 없는 단가표를 만든다. (업종마다 모양이 달라 깊은 병합) */
export function mergePriceTable(template, saved = {}) {
  return deepMerge(template.defaults || {}, saved || {});
}

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? deepMerge(base[k], v) : v;
    return out;
  }
  if (typeof base === 'number') return num(over, base);
  return over ?? base;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return v === '' || v == null || Number.isNaN(n) ? Number(fallback) || 0 : n;
}

// ---------- 기본 금액 (base.type) ----------
// perUnit   : 수량 × 단가 (최소 금액)                 예) 입주청소 평수
// itemized  : Σ 항목 수 × 종류별 단가 (× 크기)        예) 에어컨 대수, 커튼 창마다 폭
// composite : 구성요소 합 (선택·수량·구간·고정)        예) 이사, 중문

export function computeBase(template, pt, ctx) {
  const b = template.pricing.base;
  const type = b.type || 'perUnit';
  let lines = [];
  if (type === 'perUnit') {
    const qty = Number(ctx[b.quantityField]) || 0;
    const unitPrice = Number(pt[b.unitPriceKey || 'unitPrice']) || 0;
    lines.push({ key: 'base', type: 'base', label: b.label, note: `${qty}${b.unit || ''} × ${formatWon(unitPrice)}`, amount: qty * unitPrice });
  } else if (type === 'itemized') {
    const items = Array.isArray(ctx[b.itemsField]) ? ctx[b.itemsField] : [];
    const prices = pt[b.priceKey || 'items'] || {};
    for (const it of b.itemTypes) {
      const rows = items.filter((x) => x.type === it.key && Number(x.count) > 0);
      if (!rows.length) continue;
      const count = rows.reduce((a, x) => a + Number(x.count), 0);
      const price = Number(prices[it.key]) || 0;
      if (it.bySize) {
        const sizeSum = rows.reduce((a, x) => a + Number(x.count) * (Number(x.size) || 0), 0);
        lines.push({ key: `base:${it.key}`, type: 'base', label: it.label, note: `${count}${it.unit || '개'}, 합계 ${round1(sizeSum)}${it.sizeUnit || ''} × ${formatWon(price)}`, amount: Math.round(sizeSum * price) });
      } else {
        lines.push({ key: `base:${it.key}`, type: 'base', label: it.label, note: `${count}${it.unit || '개'} × ${formatWon(price)}`, amount: count * price });
      }
    }
    if (b.perItemFeeKey && ctx.$itemsCount > 0) {
      const fee = Number(pt[b.perItemFeeKey]) || 0;
      if (fee) lines.push({ key: 'base:perItemFee', type: 'base', label: b.perItemFeeLabel || '설치비', note: `${ctx.$itemsCount}${b.perItemFeeUnit || '개'} × ${formatWon(fee)}`, amount: ctx.$itemsCount * fee });
    }
  } else if (type === 'composite') {
    let running = 0;
    for (const c of b.components) {
      if (c.when && !evalWhen(c.when, ctx)) continue;
      const v = ctx[c.field];
      let amount = 0; let note = '';
      if (c.type === 'select') {
        amount = Number((pt[c.priceKey] || {})[v]) || 0;
        note = c.optionsLabel?.[v] || String(v ?? '');
      } else if (c.type === 'perUnit') {
        const q = Math.max(0, (Number(v) || 0) - (Number(c.freeQty) || 0));
        const price = Number(pt[c.priceKey]) || 0;
        amount = q * price; note = `${q}${c.unit || ''} × ${formatWon(price)}`;
      } else if (c.type === 'tier') {
        const tiers = pt[c.tiersKey] || [];
        const t = tiers.find((x) => (Number(v) || 0) <= Number(x.upTo)) || tiers[tiers.length - 1];
        if (t) {
          if ('pct' in t) { amount = Math.round((running * Number(t.pct)) / 100); note = `${v}${c.unit || ''} → +${t.pct}%`; }
          else { amount = Number(t.price) || 0; note = `${v}${c.unit || ''} (${t.upTo}${c.unit || ''} 이하 구간)`; }
        }
      } else if (c.type === 'fixed') {
        amount = Number(pt[c.priceKey]) || 0;
      }
      running += amount;
      if (amount) lines.push({ key: `base:${c.key}`, type: 'base', label: c.label, note, amount });
    }
  }
  const raw = lines.reduce((a, l) => a + l.amount, 0);
  const minPrice = Number(pt[b.minPriceKey || 'minPrice']) || 0;
  if (raw < minPrice) {
    lines = [{ key: 'base', type: 'base', label: b.label, note: `최소 금액 적용 (계산 ${formatWon(raw)})`, amount: minPrice }];
  }
  return { lines, base: Math.max(raw, minPrice) };
}

function round1(n) { return Math.round(n * 10) / 10; }

// ---------- 메인 계산 ----------

/**
 * @param {object} template   업종 템플릿 JSON
 * @param {object} priceTable 사장님 단가표 (mergePriceTable 결과)
 * @param {object} request    { answers, checklist:{key:'yes'|'no'|'unknown'}, photos:[] }
 * @param {object} overrides  사장님 수동 조정 { surcharges:{key:bool}, options:{key:bool} }
 */
export function calculateQuote(template, priceTable, request = {}, overrides = {}) {
  const pricing = template.pricing;
  const answers = request.answers || {};
  const checklist = request.checklist || {};
  const ctx = buildContext(answers, template);
  const pt = priceTable;

  // 1) 기본 (base.type 에 따라)
  const { lines: baseLines, base } = computeBase(template, pt, ctx);
  const lines = [...baseLines];

  // 2) 할증 (base에 대해 % 합산)
  const appliedSurcharges = [];
  for (const s of pricing.surcharges || []) {
    const auto = evalWhen(s.when, ctx);
    const on = overrides.surcharges?.[s.key] ?? auto;
    const pct = Number(pt.surcharges?.[s.key]) || 0;
    if (on && pct) {
      appliedSurcharges.push({ key: s.key, pct, auto });
      lines.push({
        key: `surcharge:${s.key}`, type: 'surcharge', label: `${s.label} 할증`,
        note: `+${pct}%`, amount: Math.round((base * pct) / 100),
      });
    }
  }

  // 3) 옵션 + 체크리스트
  const optionByKey = Object.fromEntries((pricing.options || []).map((o) => [o.key, o]));
  const extras = Array.isArray(answers.extras) ? answers.extras : [];
  const optionState = {}; // key → { on, auto, reason }
  for (const o of pricing.options || []) {
    let auto = false;
    let reason = '';
    if (extras.includes(o.key)) { auto = true; reason = '고객 요청'; }
    if (o.when) { // 조건이 있는 옵션은 조건이 맞을 때만 자동으로 켜짐 (수량은 quantityField)
      if (evalWhen(o.when, ctx)) { auto = true; reason = reason || '조건 해당'; }
    } else if (o.quantityField && optionQty(o, ctx) > 0) { auto = true; reason = `${ctx[o.quantityField]}${o.unit || ''}`; }
    optionState[o.key] = { on: auto, auto, reason };
  }
  const conditions = [];
  for (const item of template.checklist || []) {
    const ans = checklist[item.key];
    const opt = item.optionKey ? optionByKey[item.optionKey] : null;
    if (ans === item.risk) {
      if (opt) optionState[opt.key] = { on: true, auto: true, reason: '체크리스트 "예"' };
      else if (item.conditionText) conditions.push({ key: item.key, label: (item.short || item.label), text: item.conditionText, source: 'risk' });
    } else if (ans === 'unknown') {
      conditions.push({ key: item.key, optionKey: opt?.key, label: opt ? opt.label : (item.short || item.label), text: '', source: 'unknown' });
    }
  }
  for (const [key, on] of Object.entries(overrides.options || {})) {
    if (optionState[key] && typeof on === 'boolean') optionState[key].on = on;
  }

  for (const o of pricing.options || []) {
    if (!optionState[o.key].on) continue;
    const price = Number(pt.options?.[o.key]) || 0;
    const q = o.quantityField ? Math.max(optionQty(o, ctx), 1) : 1;
    lines.push({
      key: `option:${o.key}`, type: 'option', label: o.label,
      note: o.quantityField ? `${q}${o.unit || ''} × ${formatWon(price)}` : optionState[o.key].reason,
      amount: price * q,
    });
  }

  // "모름" 조건 문구 완성 (사장님이 옵션을 켰다면 조건에서 제외)
  const finalConditions = conditions
    .filter((c) => !(c.optionKey && optionState[c.optionKey]?.on))
    .map((c) => {
      if (c.text) return c;
      const item = (template.checklist || []).find((i) => i.key === c.key);
      const price = c.optionKey ? Number(pt.options?.[c.optionKey]) || 0 : 0;
      const text = c.optionKey
        ? `현장 확인 시 필요하면 ${formatWon(price)} 추가됩니다.`
        : (item?.conditionText || '현장 확인 후 추가요금이 발생할 수 있습니다.');
      return { ...c, text, amount: price || undefined };
    });

  // 포함 / 불포함
  const included = [...(template.included || [])];
  const excluded = [...(template.excluded || [])];
  const conditionOptionKeys = new Set(finalConditions.map((c) => c.optionKey).filter(Boolean));
  for (const o of pricing.options || []) {
    const price = Number(pt.options?.[o.key]) || 0;
    if (optionState[o.key].on) included.push(o.label);
    else if (!conditionOptionKeys.has(o.key) && !o.quantityField && price > 0) {
      excluded.push(`${o.label} (요청 시 +${formatWon(price)})`);
    }
  }

  const finalized = finalizeLines(lines, pt.policy?.depositPct);
  const rangePct = template.quoteMode === 'range' ? Number(template.rangePct ?? 15) : 0;
  return {
    ...finalized,
    quoteMode: template.quoteMode || 'fixed',
    range: rangePct ? { low: round1000(finalized.total * (1 - rangePct / 100)), high: round1000(finalized.total * (1 + rangePct / 100)), pct: rangePct } : null,
    labor: estimateLabor(template, ctx, optionState),
    surchargePct: appliedSurcharges.reduce((a, s) => a + s.pct, 0),
    surchargeState: Object.fromEntries((pricing.surcharges || []).map((s) => [s.key, {
      on: overrides.surcharges?.[s.key] ?? evalWhen(s.when, ctx),
      auto: evalWhen(s.when, ctx),
    }])),
    optionState,
    conditions: finalConditions,
    included,
    excluded,
    verified: isVerified(template, request),
  };
}

function optionQty(o, ctx) {
  return Math.max(0, (Number(ctx[o.quantityField]) || 0) - (Number(o.includedQty) || 0));
}


/**
 * 항목 배열 → 합계·계약금. 사장님이 금액을 손으로 고친 뒤에도 이 함수만 다시 부르면 된다.
 * 1,000원 단위 반올림 차액은 별도 줄(단수 조정)로 보여줘 항목 합과 합계가 항상 일치하게 한다.
 */
export function finalizeLines(lines, depositPct = 0) {
  const items = lines.filter((l) => l.key !== ROUNDING_KEY);
  const sum = items.reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const total = Math.max(0, round1000(sum));
  const diff = total - sum;
  const out = diff
    ? [...items, { key: ROUNDING_KEY, type: 'rounding', label: '1,000원 단위 조정', note: '', amount: diff }]
    : items;
  return { lines: out, subtotal: sum, total, deposit: round1000((total * (Number(depositPct) || 0)) / 100) };
}

/** "사진 확인 완료 견적" 배지 조건: 사진 1장 이상 + 체크리스트 전 항목 답변 */
export function isVerified(template, request = {}) {
  const photos = request.photos || [];
  const cl = request.checklist || {};
  return photos.length > 0 && (template.checklist || []).every((i) => ['yes', 'no', 'unknown'].includes(cl[i.key]));
}

/** 단가표 경고 (강제 아님) */
export function priceWarnings(template, priceTable) {
  return (template.pricing.warnings || [])
    .filter((w) => Number(priceTable[w.key]) > 0 && Number(priceTable[w.key]) < w.below)
    .map((w) => w.message);
}

export function addDays(dateStr, days) {
  const d = parseLocalDate(dateStr) || new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return toDateStr(d);
}

export function toDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 인력 예상 (몇 명 × 몇 시간) ----------
/**
 * template.labor = {
 *   perField: 'area', manHoursPer: 0.27,          // 수량 기반 (예: 평당 0.27인시간)
 *   perItem: { wall: 1, stand: 1.5 },             // 항목 기반 (itemized)
 *   fixed: 4,                                      // 고정
 *   min: 6, adjust: [{when, pct}|{option, manHours}],
 *   crew: { min: 2, max: 5, maxHours: 8 }
 * }
 */
export function estimateLabor(template, ctx, optionState = {}) {
  const L = template.labor;
  if (!L) return null;
  let mh = Number(L.fixed) || 0;
  if (L.perField) mh += (Number(ctx[L.perField]) || 0) * (Number(L.manHoursPer) || 0);
  if (L.perItem) {
    const items = Array.isArray(ctx[template.pricing.base.itemsField]) ? ctx[template.pricing.base.itemsField] : [];
    for (const it of items) mh += (Number(it.count) || 0) * (Number(L.perItem[it.type]) || 0) * (L.perItemBySize?.includes(it.type) ? (Number(it.size) || 1) : 1);
  }
  for (const a of L.adjust || []) {
    if (a.option && optionState[a.option]?.on) mh += Number(a.manHours) || 0;
    if (a.when && evalWhen(a.when, ctx)) mh *= 1 + (Number(a.pct) || 0) / 100;
  }
  mh = Math.max(mh, Number(L.min) || 0);
  if (!mh) return null;
  const c = L.crew || { min: 1, max: 1, maxHours: 8 };
  const crew = Math.min(c.max, Math.max(c.min, Math.ceil(mh / c.maxHours)));
  const hours = Math.ceil((mh / crew) * 2) / 2; // 30분 단위
  return { manHours: round1(mh), crew, hours, overDay: hours > c.maxHours };
}

// ---------- 템플릿 점검 (개발자 모드) ----------
function whenFields(w) {
  if (!w) return [];
  if (Array.isArray(w.any)) return w.any.flatMap(whenFields);
  if (Array.isArray(w.all)) return w.all.flatMap(whenFields);
  return w.field ? [w.field] : [];
}

const KNOWN_FIELD_TYPES = ['text', 'tel', 'date', 'number', 'textarea', 'choice', 'stepper', 'checklist', 'extras', 'photos', 'items'];

/** 템플릿 JSON의 흔한 실수를 찾아 [{level:'error'|'warn', msg}] 로 돌려준다. */
export function lintTemplate(t) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  const d = t.defaults || {};
  const p = t.pricing || {};
  if (!t.id || !t.name) err('id 또는 name 이 없습니다');
  if (!p.base) { err('pricing.base 가 없습니다'); return out; }
  const type = p.base.type || 'perUnit';
  if (!['perUnit', 'itemized', 'composite'].includes(type)) err(`알 수 없는 base.type: ${type}`);
  const fields = (t.steps || []).flatMap((s) => s.fields || []);
  const keys = new Set(fields.map((f) => f.key));
  for (const f of fields) if (!KNOWN_FIELD_TYPES.includes(f.type)) err(`알 수 없는 입력 형태: ${f.key} (${f.type})`);
  const seen = new Set();
  for (const f of fields) {
    for (const ref of whenFields(f.showIf)) {
      if (!keys.has(ref)) err(`"${f.key}" 의 showIf 가 없는 질문 "${ref}" 를 봅니다`);
      else if (!seen.has(ref)) err(`"${f.key}" 의 showIf 질문 "${ref}" 가 뒤에 있습니다 (앞에서 먼저 물어야 함)`);
    }
    if (f.showIf && ['name', 'phone', 'region'].includes(f.key)) err(`공통 필드 "${f.key}" 는 숨길 수 없습니다`);
    seen.add(f.key);
  }
  for (const k of ['name', 'phone', 'region']) if (!keys.has(k)) err(`공통 필드 "${k}" 가 질문에 없습니다`);
  if (type === 'perUnit') {
    if (!keys.has(p.base.quantityField)) err(`수량 필드 "${p.base.quantityField}" 가 질문에 없습니다`);
    if (d[p.base.unitPriceKey || 'unitPrice'] == null) err('기본 단가 기본값이 없습니다');
  }
  if (type === 'itemized') {
    if (!keys.has(p.base.itemsField)) err(`항목 필드 "${p.base.itemsField}" 가 질문에 없습니다`);
    for (const it of p.base.itemTypes || []) if (d[p.base.priceKey || 'items']?.[it.key] == null) err(`항목 단가 기본값 없음: ${it.label}`);
  }
  if (type === 'composite') {
    for (const c of p.base.components || []) {
      if (c.field && !keys.has(c.field)) err(`구성요소 "${c.label}" 의 필드 "${c.field}" 가 질문에 없습니다`);
      const k = c.priceKey || c.tiersKey;
      if (k && d[k] == null) err(`구성요소 "${c.label}" 의 단가 기본값(${k})이 없습니다`);
    }
  }
  for (const s of p.surcharges || []) if (d.surcharges?.[s.key] == null) warn(`할증 기본값 없음: ${s.label}`);
  const optKeys = new Set((p.options || []).map((o) => o.key));
  for (const o of p.options || []) if (d.options?.[o.key] == null) warn(`옵션 기본값 없음: ${o.label}`);
  for (const c of t.checklist || []) {
    if (c.optionKey && !optKeys.has(c.optionKey)) err(`체크리스트 "${c.short || c.key}" 의 옵션 "${c.optionKey}" 이 없습니다`);
    if (!c.optionKey && !c.conditionText) warn(`체크리스트 "${c.short || c.key}" 에 옵션도 조건 문구도 없습니다`);
  }
  if (!t.sample) warn('sample(테스트용 샘플 입력)이 없습니다');
  if (!t.labor) warn('labor(인력 예상 규칙)가 없습니다');
  if (!t.photoSlots?.length) warn('photoSlots(권장 사진 칸)가 없습니다');
  if (!d.policy) warn('policy(유효기간·계약금·취소 규정) 기본값이 없습니다');
  return out;
}
