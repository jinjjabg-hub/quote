// 견적 계산 순수 함수 모음 (Firebase·DOM 의존 없음 → Node 테스트 가능)
// 업종별 규칙은 templates/*.json 에 있고, 이 파일은 그 규칙을 "해석"만 한다.
//
// 합계 = max(최소금액, 수량 × 단가) × (1 + 해당 할증% 합) + 선택된 옵션 금액 합
//       → 1,000원 단위 반올림. 각 줄은 원 단위 정수(toWon)로 만든 뒤 합산한다.

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

/** 'checklist.mold' 같은 점 경로도 읽는다. */
export function getPath(ctx, path) {
  if (path == null) return undefined;
  if (!String(path).includes('.')) return ctx?.[path];
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
}

/**
 * 템플릿의 조건 평가. {field, equals} | {field, in:[]} | {field, gt} | {any:[...]} | {all:[...]}
 * field 에는 답변 키, 날짜 플래그($weekend 등), 체크리스트 답(checklist.<key> → 'yes'|'no'|'unknown')을 쓸 수 있다.
 */
export function evalWhen(when, ctx) {
  if (!when) return false;
  if (Array.isArray(when.any)) return when.any.some((w) => evalWhen(w, ctx));
  if (Array.isArray(when.all)) return when.all.every((w) => evalWhen(w, ctx));
  const v = getPath(ctx, when.field);
  if ('equals' in when) return v === when.equals;
  if (Array.isArray(when.in)) return when.in.includes(v);
  if ('gt' in when) return Number(v) > when.gt;
  return false;
}

function allFields(template) {
  return (template?.steps || []).flatMap((s) => s.fields || []);
}

/**
 * 계산용 문맥: 답변 + 날짜 플래그 + checklist.
 * template 을 주면 maxField(다른 답보다 클 수 없음)를 넘는 값을 잘라낸다(clamp).
 */
export function buildContext(answers = {}, checklist = {}, template = null) {
  const ctx = { ...answers, ...dateFlags(answers.date), checklist: { ...(checklist || {}) } };
  if (template) {
    for (const f of allFields(template)) {
      if (!f.maxField || ctx[f.key] === '' || ctx[f.key] == null) continue;
      const capRaw = ctx[f.maxField];
      if (capRaw === '' || capRaw == null || Number.isNaN(Number(capRaw))) continue;
      const cap = Number(capRaw);
      if (Number(ctx[f.key]) > cap) ctx[f.key] = cap;
    }
  }
  return ctx;
}

/** 원 단위 정수. 부동소수 오차(499499.99999999994)를 먼저 걷어낸 뒤 반올림한다 (M4). */
export function toWon(n) {
  const x = Number(n) || 0;
  return Math.round(Number(x.toPrecision(12)));
}

// ---------- 입력 교차검증 ----------

/**
 * 고객 답변 검증 (고객 제출 차단 + 사장님 발송 차단에 같이 쓴다).
 * - steps 필드의 maxField: 값이 다른 답변보다 크면 오류
 * - 템플릿 최상위 validation: { requireAny:[키…], minTotal?:1, message? } (배열도 가능)
 *   → requireAny 키들의 값 합계가 minTotal(기본 1) 이상이어야 한다.
 * @returns {string[]} 오류 문구 목록 (없으면 [])
 */
export function validateAnswers(template, request = {}) {
  const a = request.answers || {};
  const fields = allFields(template);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const errors = [];
  for (const f of fields) {
    if (!f.maxField) continue;
    const v = a[f.key]; const cap = a[f.maxField];
    if (v === '' || v == null || cap === '' || cap == null) continue;
    if (Number(v) > Number(cap)) {
      errors.push(`${f.label || f.key}은(는) ${byKey[f.maxField]?.label || f.maxField}(${cap})보다 많을 수 없어요.`);
    }
  }
  const rules = template.validation == null ? [] : [].concat(template.validation);
  for (const r of rules) {
    const keys = r?.requireAny;
    if (!Array.isArray(keys) || !keys.length) continue;
    const min = r.minTotal == null ? 1 : Number(r.minTotal);
    const sum = keys.reduce((acc, k) => acc + (a[k] === true ? 1 : Number(a[k]) || 0), 0);
    if (sum < min) {
      errors.push(r.message || `${keys.map((k) => byKey[k]?.label || k).join(', ')} 중 하나 이상 입력해주세요.`);
    }
  }
  return errors;
}

// ---------- 기본값 ----------

/** 템플릿 기본값과 사장님 저장값을 합쳐 빈 칸이 없는 단가표를 만든다. */
export function mergePriceTable(template, saved = {}) {
  const d = template.defaults || {};
  saved = saved || {};
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

// ---------- 여러 업종 (shops.templateIds, private/pricing.byTemplate) ----------

/** 업체가 쓰는 업종 ID 목록. templateIds 가 없던 기존 업체는 templateId 1개. */
export function shopTemplateIds(shop, fallback = 'move-in-cleaning') {
  const ids = Array.isArray(shop?.templateIds) ? shop.templateIds.filter(Boolean) : [];
  if (ids.length) return [...new Set(ids)];
  return [shop?.templateId || fallback];
}

/**
 * private/pricing 문서 → { byTemplate: { [templateId]: priceTable } }
 * 기존 평면 문서({ priceTable }) 는 shop.templateId 업종의 단가표로 간주한다(마이그레이션).
 */
export function normalizePricingDoc(data, shop) {
  const byTemplate = { ...(data?.byTemplate || {}) };
  if (!data?.byTemplate && data?.priceTable) {
    const legacyId = shop?.templateId || shopTemplateIds(shop)[0];
    byTemplate[legacyId] = data.priceTable;
  }
  return { byTemplate };
}

// ---------- 요약 문구 (견적서 '내용', 목록 부제) ----------

/**
 * 템플릿 summaryFields: [{key, label?, unit?}] 로 "34평 · 신축" 같은 요약을 만든다.
 * - 값이 비었거나 false·0 이면 생략
 * - true 이면 label(없으면 질문 라벨)만
 * - 선택형은 선택지 라벨, 그 외 값 + unit. label 이 있으면 앞에 붙인다.
 * summaryFields 가 없으면 기본 수량(pricing.base.quantityField + unit) 1개.
 */
export function summarize(template, answers = {}) {
  const fields = allFields(template);
  const base = template?.pricing?.base;
  const spec = Array.isArray(template?.summaryFields) && template.summaryFields.length
    ? template.summaryFields
    : (base?.quantityField ? [{ key: base.quantityField, unit: base.unit || '' }] : []);
  return spec.map((s) => {
    const v = answers?.[s.key];
    if (v === '' || v == null || v === false || v === 0) return '';
    const f = fields.find((x) => x.key === s.key);
    if (v === true) return s.label || f?.label || s.key;
    const opt = f?.options?.find((o) => o.value === v);
    const shown = opt ? opt.label : `${v}${s.unit || ''}`;
    return s.label ? `${s.label} ${shown}` : shown;
  }).filter(Boolean).join(' · ');
}

// ---------- 메인 계산 ----------

const ANSWER_LABEL = { yes: '예', no: '아니오', unknown: '모름' };

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
  const ctx = buildContext(answers, checklist, template);
  const pt = priceTable;
  overrides = overrides || {};

  // 1) 기본 (원 단위 정수)
  const qty = Number(ctx[pricing.base.quantityField]) || 0;
  const unitPrice = Number(pt.unitPrice) || 0;
  const minPrice = Number(pt.minPrice) || 0;
  const rawBase = toWon(qty * unitPrice);
  const base = Math.max(toWon(minPrice), rawBase);
  const baseNote = rawBase >= minPrice
    ? `${qty}${pricing.base.unit} × ${formatWon(unitPrice)}`
    : `최소 금액 적용 (${qty}${pricing.base.unit} × ${formatWon(unitPrice)} = ${formatWon(rawBase)})`;

  // 기본 수량 0 + 금액 0 이면 "0대 × 70,000원 = 0원" 같은 줄을 만들지 않는다 (M2)
  const lines = base > 0 || qty > 0
    ? [{ key: 'base', type: 'base', label: pricing.base.label, note: baseNote, amount: base }]
    : [];

  // 2) 할증 (base에 대해 % 합산)
  const appliedSurcharges = [];
  for (const s of pricing.surcharges || []) {
    const auto = evalWhen(s.when, ctx);
    const on = overrides.surcharges?.[s.key] ?? auto;
    const pct = Number(pt.surcharges?.[s.key]) || 0;
    const amount = toWon((base * pct) / 100);
    if (on && pct && amount) {
      appliedSurcharges.push({ key: s.key, pct, auto });
      lines.push({
        key: `surcharge:${s.key}`, type: 'surcharge', label: `${s.label} 할증`,
        note: `+${pct}%`, amount,
      });
    }
  }

  // 3) 옵션 + 체크리스트
  const options = pricing.options || [];
  const optionByKey = Object.fromEntries(options.map((o) => [o.key, o]));
  const extras = Array.isArray(answers.extras) ? answers.extras : [];
  const allowed = (o) => !o.requires || evalWhen(o.requires, ctx);   // requires 거짓 → 수량이 있어도 0
  const forcedOff = (o) => !!o.offWhen && evalWhen(o.offWhen, ctx); // offWhen 참 → 자동 켜짐보다 우선해서 끔
  const qtyOf = (o) => (o.quantityField && allowed(o) ? optionQty(o, ctx) : 0);
  const priceOf = (o) => Number(pt.options?.[o.key]) || 0;
  const amountOf = (o) => toWon(priceOf(o) * (o.quantityField ? Math.max(qtyOf(o), 1) : 1));

  const optionState = {}; // key → { on, auto, reason }
  for (const o of options) {
    let auto = false;
    let reason = '';
    if (extras.includes(o.key)) { auto = true; reason = '고객 요청'; }
    if (o.quantityField && qtyOf(o) > 0) { auto = true; reason = `${ctx[o.quantityField]}${o.unit || ''}`; }
    if (!allowed(o)) { auto = false; reason = ''; }
    optionState[o.key] = { on: auto, auto, reason };
  }
  const conditions = [];
  for (const item of template.checklist || []) {
    const ans = checklist[item.key];
    const opt = item.optionKey ? optionByKey[item.optionKey] : null;
    const name = item.short || item.label;
    if (ans === item.risk) {
      if (opt) {
        // 사유는 고객의 실제 답으로 (M3: '아니오'를 '예'로 찍지 않는다)
        if (allowed(opt)) optionState[opt.key] = { on: true, auto: true, reason: `${name}: ${ANSWER_LABEL[ans] || ans}` };
      } else if (item.conditionText) {
        conditions.push({ key: item.key, label: name, text: item.conditionText, amount: null, source: 'risk' });
      }
    } else if (ans === 'unknown') {
      if (opt) {
        if (allowed(opt) && !forcedOff(opt) && amountOf(opt) > 0) { // 0원 옵션은 조건을 만들지 않는다 (L2)
          conditions.push({ key: item.key, optionKey: opt.key, label: opt.label, text: '', amount: amountOf(opt), source: 'unknown' });
        }
      } else {
        conditions.push({
          key: item.key, label: name,
          text: item.conditionText || '현장 확인 후 추가요금이 발생할 수 있습니다.', amount: null, source: 'unknown',
        });
      }
    }
  }
  for (const o of options) {
    if (forcedOff(o)) optionState[o.key] = { on: false, auto: false, reason: '', offWhen: true };
  }
  for (const [key, on] of Object.entries(overrides.options || {})) {
    if (optionState[key] && typeof on === 'boolean') optionState[key].on = on;
  }

  for (const o of options) {
    if (!optionState[o.key].on) continue;
    const price = priceOf(o);
    const amount = amountOf(o);
    if (!amount) continue; // 0원 옵션은 줄을 만들지 않는다 (L2)
    const q = o.quantityField ? Math.max(qtyOf(o), 1) : 1;
    lines.push({
      key: `option:${o.key}`, type: 'option', label: o.label,
      note: o.quantityField ? `${q}${o.unit || ''} × ${formatWon(price)}` : optionState[o.key].reason,
      amount,
    });
  }

  // "모름" 조건 문구 완성 (사장님이 옵션을 켰다면 조건에서 제외). amount 는 견적서 "최대 금액" 계산용으로 보존.
  const finalConditions = conditions
    .filter((c) => !(c.optionKey && optionState[c.optionKey]?.on))
    .map((c) => (c.text ? c
      : { ...c, text: `현장에서 확인되면 ${formatWon(c.amount)} 추가. 작업 전 사진으로 보여드리고 동의 후 진행해요.` }));

  // 포함 / 불포함
  const included = [...(template.included || [])];
  const excluded = [...(template.excluded || [])];
  const conditionOptionKeys = new Set(finalConditions.map((c) => c.optionKey).filter(Boolean));
  const lineKeys = new Set(lines.map((l) => l.key));
  for (const o of options) {
    const price = priceOf(o);
    if (optionState[o.key].on) {
      if (lineKeys.has(`option:${o.key}`)) included.push(o.label);
    } else if (!conditionOptionKeys.has(o.key) && !o.quantityField && price > 0
      && o.listInExcluded !== false && allowed(o) && !forcedOff(o)) {
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
    baseQty: qty,
    hasQuantityLine: lines.some((l) => l.type === 'option' && optionByKey[l.key.slice(7)]?.quantityField && l.amount > 0),
    errors: validateAnswers(template, request),
  };
}

function optionQty(o, ctx) {
  return Math.max(0, (Number(ctx[o.quantityField]) || 0) - (Number(o.includedQty) || 0));
}

/**
 * 사장님 "견적 발송"을 막는 이유 목록 (빈 배열이면 발송 가능).
 * @param {object} calc  calculateQuote 결과
 * @param {number} total 사장님이 손으로 고친 뒤의 합계 (없으면 calc.total)
 * @param {object} template
 */
export function sendBlockReasons(calc, total = calc.total, template = null) {
  const reasons = [...(calc.errors || [])];
  if (!(Number(total) > 0)) reasons.push('합계가 0원이에요. 금액이나 수량을 확인해주세요.');
  if (!(calc.baseQty > 0) && !calc.hasQuantityLine) {
    const b = template?.pricing?.base;
    reasons.push(`기본 수량${b ? `(${b.label}, ${b.unit})` : ''}이 0이에요. 고객 답변을 확인해주세요.`);
  }
  return reasons;
}

/** 견적서 "최대 금액" = 합계 + 금액이 적힌 조건들의 합 (M11a) */
export function maxTotal(total, conditions = []) {
  return (Number(total) || 0) + (conditions || []).reduce((a, c) => a + (Number(c?.amount) > 0 ? Number(c.amount) : 0), 0);
}

/**
 * 항목 배열 → 합계·계약금. 사장님이 금액을 손으로 고친 뒤에도 이 함수만 다시 부르면 된다.
 * 1,000원 단위 반올림 차액은 별도 줄(단수 조정)로 보여줘 항목 합과 합계가 항상 일치하게 한다.
 */
export function finalizeLines(lines, depositPct = 0) {
  const items = lines.filter((l) => l.key !== ROUNDING_KEY);
  const sum = toWon(items.reduce((a, l) => a + (Number(l.amount) || 0), 0));
  const total = Math.max(0, round1000(sum));
  const diff = total - sum;
  const out = diff
    ? [...items, { key: ROUNDING_KEY, type: 'rounding', label: '1,000원 단위 조정', note: '', amount: diff }]
    : items;
  return { lines: out, subtotal: sum, total, deposit: round1000((total * (Number(depositPct) || 0)) / 100) };
}

// ---------- 사진 칸 (photoSlots: repeatField · shots · photoLimit) ----------

export const PHOTO_LIMIT_MAX = 20;
export const PHOTO_REPEAT_MAX = 6;
const DEFAULT_SHOT = 'main';

/** 요청 1건 총 사진 장수 상한 (템플릿 photoLimit, 기본·최대 20) */
export function photoLimit(template) {
  const n = Number(template?.photoLimit);
  return n > 0 ? Math.min(Math.floor(n), PHOTO_LIMIT_MAX) : PHOTO_LIMIT_MAX;
}

/**
 * 템플릿 photoSlots 를 답변에 맞게 펼친다.
 * - repeatField: 그 답변 값만큼 칸 반복("욕실 1", "욕실 2"), 0이면 칸 없음, 최대 6. 답이 없으면 1칸.
 *   3번째 반복부터는 필수 컷도 선택으로 바뀐다.
 * - shots: 칸 안의 촬영 컷. 없으면 [{key:'main', required:true}] 1장 (기존 템플릿과 같은 동작)
 * @returns {{slot, index, label, shots:{key,label,required,tip,illustration}[]}[]}
 */
export function expandPhotoSlots(template, answers = {}) {
  const out = [];
  for (const s of template?.photoSlots || []) {
    let count = 1;
    if (s.repeatField) {
      const v = answers?.[s.repeatField];
      count = v === '' || v == null ? 1 : Math.min(PHOTO_REPEAT_MAX, Math.max(0, Math.floor(Number(v) || 0)));
    }
    const shots = Array.isArray(s.shots) && s.shots.length
      ? s.shots.map((x, i) => ({ ...x, key: x.key || `shot${i + 1}`, required: x.required !== false }))
      : [{ key: DEFAULT_SHOT, label: '', required: true }];
    for (let i = 1; i <= count; i += 1) {
      // PM 결정(contract 4장 Q1): 반복 칸은 3번째부터 필수 컷을 선택으로 낮춘다 (photoLimit 초과 방지)
      const sh = i >= 3 ? shots.map((x) => ({ ...x, required: false })) : shots;
      out.push({ slot: s.key, index: i, label: s.repeatField && count > 1 ? `${s.label} ${i}` : s.label, shots: sh });
    }
  }
  return out;
}

/** 사진 1장의 저장 키 (Storage 파일명) = {slot}-{index}-{shot} */
export function photoKey(slot, index = 1, shot = DEFAULT_SHOT) {
  return `${slot}-${index}-${shot}`;
}

/** requests.photos[] 항목 → 같은 형식의 키. 예전 형식({slot, path})은 1번 칸·첫 컷으로 본다. */
export function photoKeyOf(p, template = null) {
  const def = template?.photoSlots?.find((s) => s.key === p?.slot)?.shots?.[0]?.key || DEFAULT_SHOT;
  return photoKey(p?.slot, Number(p?.index) || 1, p?.shot || def);
}

/** 펼친 칸 중 아직 없는 필수 컷 목록 [{label, shotLabel, key}] */
export function missingRequiredShots(template, answers = {}, photos = []) {
  const have = new Set((photos || []).map((p) => (typeof p === 'string' ? p : photoKeyOf(p, template))));
  const miss = [];
  for (const sl of expandPhotoSlots(template, answers)) {
    for (const sh of sl.shots) {
      const key = photoKey(sl.slot, sl.index, sh.key);
      if (sh.required && !have.has(key)) miss.push({ key, label: sl.label, shotLabel: sh.label || '' });
    }
  }
  return miss;
}

/**
 * "사진 확인 완료 견적" 배지 조건: 체크리스트 전 항목 답변 +
 * - 템플릿에 shots 가 정의된 칸이 하나라도 있으면: 반복 칸 포함 **모든 필수 컷**이 있을 때
 * - shots 가 없는 기존 템플릿: 사진 1장 이상 (기존 동작 유지)
 */
export function isVerified(template, request = {}) {
  const photos = request.photos || [];
  const cl = request.checklist || {};
  const checklistDone = (template.checklist || []).every((i) => ['yes', 'no', 'unknown'].includes(cl[i.key]));
  if (!checklistDone) return false;
  const strict = (template.photoSlots || []).some((s) => Array.isArray(s.shots) && s.shots.length);
  if (!strict) return photos.length > 0;
  return photos.length > 0 && missingRequiredShots(template, request.answers || {}, photos).length === 0;
}

/** 단가표 경고 (강제 아님) */
export function priceWarnings(template, priceTable) {
  return (template.pricing.warnings || [])
    .filter((w) => Number(priceTable[w.key]) > 0 && Number(priceTable[w.key]) < w.below)
    .map((w) => w.message);
}

/**
 * 환불 계산 규칙 정리 (사장님 입력 → 저장·견적서용). functions/lib/rules.js normalizeRefundRules 와 같은 결과 모양.
 * 고객은 견적서·결제창에서 같은 문장(payment.js describeRefundRules)을 본다.
 * 유형: { daysBefore, pct } = 작업 N일 전까지 취소 시 N% / { type:'withinDaysOfPayment', days, pct } = 결제 후 N일 이내
 */
export function cleanRefundRules(rules) {
  if (!Array.isArray(rules)) return null;
  const pct = (v) => Math.min(100, Math.max(0, Math.round(Number(v))));
  const out = [];
  for (const r of rules) {
    if (r?.type === 'withinDaysOfPayment') {
      const days = Math.round(Number(r.days));
      if (days > 0 && Number.isFinite(Number(r.pct))) out.push({ type: 'withinDaysOfPayment', days, pct: pct(r.pct) });
    } else {
      const d = Math.round(Number(r?.daysBefore));
      if (d >= 0 && r?.daysBefore !== '' && Number.isFinite(Number(r?.pct))) out.push({ daysBefore: d, pct: pct(r.pct) });
    }
  }
  return out.length ? out : null;
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
