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
  if (!d) return { $weekend: false, $holiday: false, $sonEomneun: false };
  const mmdd = dateStr.slice(5);
  const lunar = lunarOf(d);
  return {
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

export function buildContext(answers = {}) {
  return { ...answers, ...dateFlags(answers.date) };
}

// ---------- 기본값 ----------

/** 템플릿 기본값과 사장님 저장값을 합쳐 빈 칸이 없는 단가표를 만든다. */
export function mergePriceTable(template, saved = {}) {
  const d = template.defaults || {};
  return {
    unitPrice: num(saved.unitPrice, d.unitPrice),
    minPrice: num(saved.minPrice, d.minPrice),
    surcharges: { ...(d.surcharges || {}), ...(saved.surcharges || {}) },
    options: { ...(d.options || {}), ...(saved.options || {}) },
    policy: { ...(d.policy || {}), ...(saved.policy || {}) },
  };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return v === '' || v == null || Number.isNaN(n) ? Number(fallback) || 0 : n;
}

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
  const ctx = buildContext(answers);
  const pt = priceTable;

  // 1) 기본
  const qty = Number(ctx[pricing.base.quantityField]) || 0;
  const unitPrice = Number(pt.unitPrice) || 0;
  const minPrice = Number(pt.minPrice) || 0;
  const rawBase = qty * unitPrice;
  const base = Math.max(minPrice, rawBase);
  const baseNote = rawBase >= minPrice
    ? `${qty}${pricing.base.unit} × ${formatWon(unitPrice)}`
    : `최소 금액 적용 (${qty}${pricing.base.unit} × ${formatWon(unitPrice)} = ${formatWon(rawBase)})`;

  const lines = [{ key: 'base', type: 'base', label: pricing.base.label, note: baseNote, amount: base }];

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
    if (o.quantityField && optionQty(o, ctx) > 0) { auto = true; reason = `${ctx[o.quantityField]}${o.unit || ''}`; }
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
  return {
    ...finalized,
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
