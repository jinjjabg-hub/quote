// 실행: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  calculateQuote, mergePriceTable, finalizeLines, dateFlags, isVerified, priceWarnings, round1000,
  evalWhen, buildContext, validateAnswers, sendBlockReasons, maxTotal, summarize, shopTemplateIds, normalizePricingDoc,
  toWon, expandPhotoSlots, missingRequiredShots, photoLimit, photoKeyOf, cleanRefundRules,
} from '../js/calc.js';
import { normalizeRefundRules } from '../functions/lib/rules.js';
import { isValidBizNo, formatBizNo } from '../js/util.js';
import { TEMPLATE_IDS } from '../js/templates.js';

const loadTpl = (id) => JSON.parse(readFileSync(new URL(`../templates/${id}.json`, import.meta.url)));
const clone = (o) => structuredClone(o);
const template = loadTpl('move-in-cleaning');
/** 템플릿 필수 컷을 모두 채운 사진 목록 (2차 photoSlots.shots) */
const requiredPhotos = (tpl, answers) => expandPhotoSlots(tpl, answers)
  .flatMap((sl) => sl.shots.filter((x) => x.required).map((x) => ({ slot: sl.slot, index: sl.index, shot: x.key, path: 'p' })));
const allNo = Object.fromEntries(template.checklist.map((i) => [i.key, i.risk === 'yes' ? 'no' : 'yes']));

// 완료 확인 시나리오 1~4
test('시나리오: 34평 신축 + 곰팡이 예 + 붙박이장 모름 → 560,000원', () => {
  const pt = mergePriceTable(template, {
    unitPrice: 13000,
    surcharges: { newBuild: 20, weekend: 0, sonEomneun: 0, firstSlot: 0 },
    options: { mold: 30000 },
  });
  const req = {
    answers: { area: 34, isNew: true, date: '2026-10-14', timeSlot: 'am', balconies: 2, extras: [] },
    checklist: { ...allNo, mold: 'yes', closet: 'unknown' },
  };
  req.photos = requiredPhotos(template, req.answers);
  const r = calculateQuote(template, pt, req);
  assert.equal(r.subtotal, 560400);
  assert.equal(r.total, 560000);
  assert.deepEqual(r.lines.map((l) => l.amount), [442000, 88400, 30000, -400]);
  const closet = r.conditions.find((c) => c.key === 'closet');
  assert.ok(closet, '붙박이장이 ⚠️ 조건에 있어야 함');
  assert.match(closet.label, /붙박이장/);
  assert.ok(!r.excluded.some((e) => e.includes('붙박이장')), '조건에 있으면 불포함에 중복 표기 안 함');
  assert.ok(r.included.includes('곰팡이 제거'));
  assert.equal(r.verified, true);
});

test('최소 금액 적용', () => {
  const pt = mergePriceTable(template, { unitPrice: 10000, minPrice: 250000 });
  const r = calculateQuote(template, pt, { answers: { area: 10, isNew: false, date: '2026-10-14', balconies: 1 } });
  assert.equal(r.lines[0].amount, 250000);
  assert.equal(r.total, 250000);
});

test('베란다: 기본 2개 초과분만 과금', () => {
  const pt = mergePriceTable(template, { unitPrice: 10000, minPrice: 0, options: { balcony: 20000 } });
  const r = calculateQuote(template, pt, { answers: { area: 30, isNew: false, date: '2026-10-14', balconies: 4 } });
  assert.equal(r.lines.find((l) => l.key === 'option:balcony').amount, 40000);
});

test('사장님 수동 조정: 할증 끄기, 옵션 켜기 → 조건에서 빠짐', () => {
  const pt = mergePriceTable(template, { unitPrice: 13000 });
  const req = { answers: { area: 34, isNew: true, date: '2026-10-14' }, checklist: { closet: 'unknown' } };
  const r = calculateQuote(template, pt, req, { surcharges: { newBuild: false }, options: { closet: true } });
  assert.ok(!r.lines.some((l) => l.key === 'surcharge:newBuild'));
  assert.ok(r.lines.some((l) => l.key === 'option:closet'));
  assert.ok(!r.conditions.some((c) => c.key === 'closet'));
});

test('체크리스트 위험 답변(옵션 없음) → 조건 문구', () => {
  const pt = mergePriceTable(template, {});
  const r = calculateQuote(template, pt, { answers: { area: 30, date: '2026-10-14' }, checklist: { parking: 'no', leftover: 'yes', elevator: 'no' } });
  assert.ok(r.conditions.some((c) => c.key === 'parking'));
  assert.ok(r.conditions.some((c) => c.key === 'leftover'));
  assert.equal(r.lines.find((l) => l.key === 'option:noElevator').note, '엘리베이터: 아니오', '옵션 연결 항목은 금액 줄');
});

test('finalizeLines: 수정 후 합계·계약금 재계산', () => {
  const r = finalizeLines([{ key: 'a', amount: 333300 }, { key: '_rounding', amount: 999 }], 10);
  assert.equal(r.total, 333000);
  assert.equal(r.deposit, 33000);
  assert.equal(r.lines.at(-1).amount, -300);
});

test('dateFlags: 주말·공휴일·손 없는 날', () => {
  assert.equal(dateFlags('2026-10-17').$weekend, true);   // 토
  assert.equal(dateFlags('2026-10-14').$weekend, false);  // 수
  assert.equal(dateFlags('2026-10-09').$holiday, true);   // 한글날
  assert.equal(dateFlags('2026-09-25').$holiday, true);   // 추석
  assert.equal(dateFlags('2026-02-16').$holiday, true);   // 설 전날
  assert.equal(dateFlags('2026-02-25').$sonEomneun, true); // 음력 1/9
  assert.equal(dateFlags('2026-02-24').$sonEomneun, false);
});

test('isVerified / priceWarnings / round1000', () => {
  assert.equal(isVerified(template, { photos: [], checklist: allNo }), false);
  assert.equal(isVerified(template, { photos: [1], checklist: { mold: 'yes' } }), false);
  assert.equal(priceWarnings(template, { unitPrice: 8500 }).length, 1);
  assert.equal(priceWarnings(template, { unitPrice: 13000 }).length, 0);
  assert.equal(round1000(560400), 560000);
  assert.equal(round1000(560500), 561000);
});


// ===================== 2차: 새 엔진 기능 · 버그 회귀 =====================

test('M4: 33.3평 × 15,000원 = 500,000원 (부동소수 오차로 499,000 이 되면 안 됨)', () => {
  const pt = mergePriceTable(template, { unitPrice: 15000, minPrice: 0 });
  const r = calculateQuote(template, pt, { answers: { area: 33.3, isNew: false, date: '2026-10-14', balconies: 2 } });
  assert.equal(r.lines[0].amount, 499500);
  assert.ok(r.lines.every((l) => Number.isInteger(l.amount)), '모든 줄이 원 단위 정수');
  assert.equal(r.total, 500000);
  // 10.0~80.0평 전 구간에서 정수 계산과 같은지
  for (let t = 100; t <= 800; t += 1) {
    const area = t / 10;
    const got = calculateQuote(template, pt, { answers: { area, isNew: false, date: '2026-10-14', balconies: 2 } }).total;
    assert.equal(got, round1000(t * 1500), `${area}평`);
  }
  assert.equal(toWon(49500.00000000001), 49500);
});

test('M3: 옵션 사유는 고객 실제 답 (엘리베이터 "아니오" → "예" 로 찍지 않음)', () => {
  const tpl = loadTpl('home-cleaning');
  const r = calculateQuote(tpl, mergePriceTable(tpl, {}), { answers: { area: 30, date: '2026-10-14' }, checklist: { elevator: 'no' } });
  const line = r.lines.find((l) => l.key === 'option:noElevator');
  assert.ok(line);
  assert.equal(line.note, '엘리베이터: 아니오');
  assert.ok(!r.lines.some((l) => /"예"/.test(l.note || '')));
});

test('L2: 0원 옵션은 줄·조건·포함 목록을 만들지 않는다', () => {
  const pt = mergePriceTable(template, { options: { mold: 0, closet: 0 } });
  const r = calculateQuote(template, pt, { answers: { area: 30, date: '2026-10-14' }, checklist: { mold: 'yes', closet: 'unknown' } });
  assert.ok(!r.lines.some((l) => l.key === 'option:mold' || l.key === 'option:closet'));
  assert.ok(!r.conditions.some((c) => c.key === 'closet'));
  assert.ok(!r.included.includes('곰팡이 제거'));
  assert.ok(!r.lines.some((l) => l.amount === 0));
});

test('조건 amount 보존 + 최대 금액 = 합계 + Σamount', () => {
  const pt = mergePriceTable(template, { unitPrice: 13000, options: { closet: 30000 } });
  const r = calculateQuote(template, pt, { answers: { area: 30, date: '2026-10-14' }, checklist: { closet: 'unknown', parking: 'no' } });
  const closet = r.conditions.find((c) => c.key === 'closet');
  assert.equal(closet.amount, 30000);
  assert.match(closet.text, /30,000원/);
  assert.equal(r.conditions.find((c) => c.key === 'parking').amount, null);
  assert.equal(maxTotal(r.total, r.conditions), r.total + 30000);
  assert.equal(maxTotal(100000, [{ amount: null }, { amount: 5000 }, {}]), 105000);
});

test('조건 문법: checklist.<key> 점 경로', () => {
  const ctx = buildContext({ area: 30 }, { ladderFrom: 'yes' });
  assert.equal(evalWhen({ field: 'checklist.ladderFrom', equals: 'yes' }, ctx), true);
  assert.equal(evalWhen({ field: 'checklist.ladderTo', equals: 'yes' }, ctx), false);
  assert.equal(evalWhen({ all: [{ field: 'area', gt: 20 }, { field: 'checklist.ladderFrom', in: ['yes', 'unknown'] }] }, ctx), true);
});

test('offWhen (M1): 같은 쪽 사다리차가 켜지면 계단 운반을 끈다', () => {
  const tpl = clone(loadTpl('moving'));
  tpl.pricing.options.find((o) => o.key === 'stairsFrom').offWhen = { field: 'checklist.ladderFrom', equals: 'yes' };
  const pt = mergePriceTable(tpl, {});
  const req = { answers: { tons: 1, moveType: 'general', distanceKm: 10, fromStairFloor: 5, toStairFloor: 1, date: '2026-10-14' }, checklist: { ladderFrom: 'yes' } };
  const r = calculateQuote(tpl, pt, req);
  assert.ok(r.lines.some((l) => l.key === 'option:ladderFrom'));
  assert.ok(!r.lines.some((l) => l.key === 'option:stairsFrom'), '계단 운반 중복 과금 없음');
  // 사다리차 '아니오' 면 계단 운반 그대로
  const r2 = calculateQuote(tpl, pt, { ...req, checklist: { ladderFrom: 'no' } });
  assert.equal(r2.lines.find((l) => l.key === 'option:stairsFrom').amount, 80000);
  // 실제 moving.json 도 같은 결과
  assert.ok(!calculateQuote(loadTpl('moving'), pt, req).lines.some((l) => l.key === 'option:stairsFrom'));
  // offWhen 없는 기존 템플릿은 기존 동작
  const legacy = clone(loadTpl('moving'));
  for (const o of legacy.pricing.options) delete o.offWhen;
  const r3 = calculateQuote(legacy, pt, req);
  assert.ok(r3.lines.some((l) => l.key === 'option:stairsFrom'));
});

test('requires: 보관이사가 아니면 보관 개월이 있어도 보관료 0', () => {
  const tpl = clone(loadTpl('moving'));
  tpl.pricing.options.find((o) => o.key === 'storageFee').requires = { field: 'storage', equals: true };
  const pt = mergePriceTable(tpl, {});
  const base = { tons: 1, moveType: 'general', distanceKm: 10, fromStairFloor: 1, toStairFloor: 1, date: '2026-10-14', storageMonths: 3 };
  const r = calculateQuote(tpl, pt, { answers: { ...base, storage: false } });
  assert.ok(!r.lines.some((l) => l.key === 'option:storageFee'));
  const r2 = calculateQuote(tpl, pt, { answers: { ...base, storage: true } });
  assert.equal(r2.lines.find((l) => l.key === 'option:storageFee').amount, 600000);
});

test('maxField: 완전분해 대수 ≤ 벽걸이 대수 (calc clamp + 검증 오류)', () => {
  const tpl = clone(loadTpl('aircon-cleaning'));
  const fw = tpl.steps.flatMap((s) => s.fields).find((f) => f.key === 'fullWallUnits');
  fw.maxField = 'wallUnits';
  const pt = mergePriceTable(tpl, {});
  const req = { answers: { wallUnits: 1, fullWallUnits: 5, date: '2026-10-14' } };
  const r = calculateQuote(tpl, pt, req);
  const line = r.lines.find((l) => l.key === 'option:fullWall');
  assert.equal(line.amount, Number(pt.options.fullWall) * 1, '5대가 아니라 1대로 잘림');
  assert.equal(validateAnswers(tpl, req).length, 1);
  assert.ok(sendBlockReasons(r, r.total, tpl).length >= 1, '검증 오류가 있으면 발송 불가');
});

test('validation.requireAny: 기종 대수 합계 0 → 제출·발송 불가, 스탠드만 있어도 발송 가능', () => {
  const tpl = clone(loadTpl('aircon-cleaning'));
  const keys = ['wallUnits', 'standUnits', 'twoInOneSets', 'ceiling1wayUnits', 'ceiling4wayUnits'];
  tpl.validation = { requireAny: keys, minTotal: 1, message: '에어컨 대수를 1대 이상 입력해주세요.' };
  const pt = mergePriceTable(tpl, {});
  const zero = { answers: Object.fromEntries(keys.map((k) => [k, 0])) };
  assert.deepEqual(validateAnswers(tpl, zero), ['에어컨 대수를 1대 이상 입력해주세요.']);
  const r0 = calculateQuote(tpl, pt, zero);
  assert.ok(sendBlockReasons(r0, r0.total, tpl).length >= 1);
  assert.ok(!r0.lines.some((l) => l.key === 'base'), '"벽걸이 0대 = 0원" 기본 줄 없음');
  const standOnly = { answers: { ...zero.answers, standUnits: 1 } };
  const r1 = calculateQuote(tpl, pt, standOnly);
  assert.deepEqual(validateAnswers(tpl, standOnly), []);
  assert.ok(r1.total > 0);
  assert.deepEqual(sendBlockReasons(r1, r1.total, tpl), []);
});

test('발송 차단: 합계 0원 / 기본 수량 0 (최소금액만 붙은 경우)', () => {
  const pt = mergePriceTable(template, {});
  const r = calculateQuote(template, pt, { answers: { area: 0, date: '2026-10-14' } });
  assert.ok(r.total > 0, '최소 금액은 붙지만');
  assert.ok(sendBlockReasons(r, r.total, template).some((m) => /기본 수량/.test(m)));
  const ok = calculateQuote(template, pt, { answers: { area: 30, date: '2026-10-14' } });
  assert.deepEqual(sendBlockReasons(ok, ok.total, template), []);
  assert.ok(sendBlockReasons(ok, 0, template).some((m) => /0원/.test(m)), '사장님이 0원으로 고치면 차단');
});

test('summaryFields 요약 (없으면 기본 수량 1개)', () => {
  assert.equal(summarize(template, { area: 34, isNew: true }), '34평');
  const t = clone(template);
  t.summaryFields = [{ key: 'area', unit: '평' }, { key: 'isNew', label: '신축' }, { key: 'buildingType' }];
  assert.equal(summarize(t, { area: 34, isNew: true, buildingType: 'apt' }), '34평 · 신축 · 아파트');
  assert.equal(summarize(t, { area: 34, isNew: false }), '34평');
});

test('다업종: templateIds 기본값 · 평면 단가표 마이그레이션', () => {
  assert.deepEqual(shopTemplateIds({ templateId: 'move-in-cleaning' }), ['move-in-cleaning']);
  assert.deepEqual(shopTemplateIds({ templateId: 'moving', templateIds: ['moving', 'curtain'] }), ['moving', 'curtain']);
  assert.deepEqual(shopTemplateIds({}), ['move-in-cleaning']);
  const legacy = normalizePricingDoc({ priceTable: { unitPrice: 13000 } }, { templateId: 'move-in-cleaning' });
  assert.deepEqual(legacy, { byTemplate: { 'move-in-cleaning': { unitPrice: 13000 } } });
  const now = normalizePricingDoc({ byTemplate: { moving: { unitPrice: 1 } }, priceTable: { unitPrice: 9 } }, { templateId: 'move-in-cleaning' });
  assert.deepEqual(now, { byTemplate: { moving: { unitPrice: 1 } } });
  assert.deepEqual(normalizePricingDoc(null, {}), { byTemplate: {} });
});

test('사업자번호 체크섬', () => {
  assert.equal(isValidBizNo('124-81-00998'), true);
  assert.equal(isValidBizNo('1248100998'), true);
  assert.equal(isValidBizNo('124-81-00999'), false);
  assert.equal(isValidBizNo('123'), false);
  assert.equal(isValidBizNo(''), false);
  assert.equal(formatBizNo('1248100998'), '124-81-00998');
});

test('사진: repeatField·shots 펼치기, 필수 컷 기준 isVerified, 기존 템플릿은 1장 기준', () => {
  const t = clone(template);
  t.photoSlots = [
    { key: 'bath', label: '욕실', repeatField: 'baths', shots: [
      { key: 'wide', label: '전체', required: true, tip: '문 앞에서', illustration: 'room-wide' },
      { key: 'close', label: '가까이', required: false } ] },
    { key: 'kitchen', label: '주방' },
  ];
  const answers = { baths: 2 };
  const slots = expandPhotoSlots(t, answers);
  assert.deepEqual(slots.map((s) => s.label), ['욕실 1', '욕실 2', '주방']);
  assert.equal(expandPhotoSlots(t, { baths: 0 }).length, 1, '0이면 칸 없음');
  assert.equal(expandPhotoSlots(t, { baths: 99 }).length, 7, '최대 6칸');
  const cl = Object.fromEntries(t.checklist.map((i) => [i.key, 'no']));
  const some = [{ slot: 'bath', index: 1, shot: 'wide', path: 'x' }, { slot: 'kitchen', index: 1, shot: 'main', path: 'y' }];
  assert.equal(missingRequiredShots(t, answers, some).length, 1);
  assert.equal(isVerified(t, { answers, checklist: cl, photos: some }), false);
  const all = [...some, { slot: 'bath', index: 2, shot: 'wide', path: 'z' }];
  assert.equal(isVerified(t, { answers, checklist: cl, photos: all }), true, '선택 컷(close)은 없어도 됨');
  // 반복 3번째 칸부터는 필수 컷이 선택으로 (PM 결정 Q1)
  const four = expandPhotoSlots(t, { baths: 4 });
  assert.deepEqual(four.filter((s) => s.slot === 'bath').map((s) => s.shots[0].required), [true, true, false, false]);
  assert.equal(isVerified(t, { answers: { baths: 4 }, checklist: cl, photos: all }), true, '욕실 3·4 사진 없어도 배지');
  // 새 필드 없는 기존 템플릿: 칸당 1장, 배지는 기존처럼 사진 1장 이상
  const legacy = clone(template);
  legacy.photoSlots = legacy.photoSlots.map(({ key, label }) => ({ key, label }));
  assert.deepEqual(expandPhotoSlots(legacy, {}).map((s) => s.shots.length), [1, 1, 1, 1, 1]);
  assert.equal(isVerified(legacy, { checklist: cl, photos: [{ slot: 'bath', path: 'requests/a/b/bath.jpg' }] }), true);
  assert.equal(photoKeyOf({ slot: 'bath', path: 'old' }), 'bath-1-main', '1차 형식 사진은 1번 칸·첫 컷');
  assert.equal(photoLimit(template), 20);
  assert.equal(photoLimit({ photoLimit: 50 }), 20);
  assert.equal(photoLimit({ photoLimit: 8 }), 8);
});

// ===================== 7개 업종 스모크 테스트 =====================

/** 템플릿 steps 로 "보통 고객" 예시 답변을 만든다: 기본값 → 두 번째 선택지 → min/1 */
function sampleRequest(tpl) {
  const answers = {};
  for (const f of tpl.steps.flatMap((s) => s.fields)) {
    if (f.default != null) answers[f.key] = f.default;
    else if (f.type === 'choice') answers[f.key] = (f.options[1] || f.options[0]).value;
    else if (f.type === 'number' || f.type === 'stepper') answers[f.key] = Math.max(Number(f.min) || 0, 1) * (f.key === 'area' ? 30 : 1);
    else if (f.type === 'date') answers[f.key] = '2026-10-14';
    else if (['text', 'tel', 'textarea'].includes(f.type)) answers[f.key] = f.key === 'phone' ? '010-1234-5678' : '테스트';
  }
  answers.extras = tpl.pricing.options.filter((o) => o.customerSelectable).slice(0, 1).map((o) => o.key);
  const checklist = Object.fromEntries((tpl.checklist || []).map((i, n) => [i.key, ['yes', 'no', 'unknown'][n % 3]]));
  return { answers, checklist, photos: [{ slot: tpl.photoSlots?.[0]?.key, index: 1, shot: 'main', path: 'p' }] };
}

test('업종 목록(js/templates.js) = templates/*.json 7개', () => {
  const files = readdirSync(new URL('../templates/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual([...TEMPLATE_IDS].sort(), files.sort());
  assert.equal(TEMPLATE_IDS.length, 7);
  for (const id of TEMPLATE_IDS) assert.equal(loadTpl(id).id, id);
});

for (const id of TEMPLATE_IDS) {
  test(`스모크: ${id} 예시 1건이 예외 없이 계산되고 같은 입력은 같은 금액`, () => {
    const tpl = loadTpl(id);
    const pt = mergePriceTable(tpl, {});
    const req = sampleRequest(tpl);
    const r = calculateQuote(tpl, pt, req);
    assert.ok(Number.isInteger(r.total) && r.total > 0, `합계 ${r.total}`);
    assert.equal(r.total % 1000, 0);
    assert.equal(r.lines.reduce((a, l) => a + l.amount, 0), r.total, '항목 합 = 합계');
    assert.ok(r.lines.every((l) => Number.isInteger(l.amount) && l.amount !== 0));
    assert.ok(r.conditions.every((c) => 'amount' in c && (c.amount === null || c.amount > 0)));
    assert.deepEqual(calculateQuote(tpl, pt, req), r, '결정성');
    assert.equal(typeof summarize(tpl, req.answers), 'string');
    assert.ok(expandPhotoSlots(tpl, req.answers).length > 0);
    assert.deepEqual(validateAnswers(tpl, req), []);
  });
}

test('환불 규칙 정리: 서버 normalizeRefundRules 와 같은 결과', () => {
  const samples = [
    [{ daysBefore: 3, pct: 100 }, { daysBefore: 1, pct: 50 }, { daysBefore: 0, pct: 0 }],
    [{ type: 'withinDaysOfPayment', days: 7, pct: 100 }, { daysBefore: 2, pct: 120 }],
    [{ daysBefore: -1, pct: 10 }, { type: 'withinDaysOfPayment', days: 0, pct: 100 }],
    [], null,
  ];
  for (const r of samples) assert.deepEqual(cleanRefundRules(r), normalizeRefundRules(r));
  // 화면 입력은 문자열 숫자일 수 있다
  assert.deepEqual(cleanRefundRules([{ daysBefore: '3', pct: '100' }, { daysBefore: '', pct: 5 }]), [{ daysBefore: 3, pct: 100 }]);
});
