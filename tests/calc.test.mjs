// 실행: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateQuote, mergePriceTable, finalizeLines, dateFlags, isVerified, priceWarnings, round1000 } from '../js/calc.js';

const template = JSON.parse(readFileSync(new URL('../templates/move-in-cleaning.json', import.meta.url)));
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
    photos: [{ url: 'a' }, { url: 'b' }],
  };
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
  const r = calculateQuote(template, pt, { answers: { area: 30, date: '2026-10-14' }, checklist: { elevator: 'no', pet: 'yes' } });
  assert.ok(r.conditions.some((c) => c.key === 'elevator'));
  assert.ok(r.conditions.some((c) => c.key === 'pet'));
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

// ---------- 업종 템플릿 전체 (개발자 모드 · 시뮬레이터와 같은 엔진) ----------
import { lintTemplate, estimateLabor, buildContext } from '../js/calc.js';
const index = JSON.parse(readFileSync(new URL('../templates/index.json', import.meta.url)));
const load = (id) => JSON.parse(readFileSync(new URL(`../templates/${id}.json`, import.meta.url)));

test('모든 업종 템플릿: 점검 오류 0건, 샘플 계산 결과가 0보다 큼', () => {
  assert.ok(index.length >= 6);
  for (const { id } of index) {
    const t = load(id);
    const errors = lintTemplate(t).filter((l) => l.level === 'error');
    assert.deepEqual(errors, [], `${id} 점검 오류`);
    const r = calculateQuote(t, mergePriceTable(t, {}), { answers: { date: '2026-10-21', ...t.sample.answers }, checklist: t.sample.checklist });
    assert.ok(r.total > 0, `${id} 합계`);
    assert.equal(r.lines.reduce((a, l) => a + l.amount, 0), r.total, `${id} 항목 합 = 합계`);
    assert.ok(r.labor && r.labor.crew >= 1, `${id} 인력 예상`);
  }
});

test('itemized: 에어컨 벽걸이 2 + 스탠드 1, 완전분해는 선택했을 때만', () => {
  const t = load('aircon-cleaning');
  const pt = mergePriceTable(t, {});
  const base = { date: '2026-10-21', units: [{ type: 'wall', count: 2 }, { type: 'stand', count: 1 }] };
  const r1 = calculateQuote(t, pt, { answers: { ...base, washLevel: 'normal' } });
  assert.equal(r1.lines.filter((l) => l.type === 'base').reduce((a, l) => a + l.amount, 0), 2 * 80000 + 120000);
  assert.ok(!r1.lines.some((l) => l.key === 'option:fullWash'));
  const r2 = calculateQuote(t, pt, { answers: { ...base, washLevel: 'full' } });
  assert.equal(r2.lines.find((l) => l.key === 'option:fullWash').amount, 3 * 30000);
});

test('itemized + 크기: 커튼 폭 합계 × 단가 + 창당 설치비, 범위 견적', () => {
  const t = load('curtain-blind');
  const r = calculateQuote(t, mergePriceTable(t, {}), { answers: { date: '2026-10-21', windows: [{ type: 'blackout', count: 2, size: 2.4 }] } });
  assert.equal(r.lines.find((l) => l.key === 'base:blackout').amount, Math.round(4.8 * 45000));
  assert.equal(r.lines.find((l) => l.key === 'base:perItemFee').amount, 2 * 20000);
  assert.equal(r.quoteMode, 'range');
  assert.ok(r.range.low < r.total && r.total < r.range.high);
});

test('composite: 중문 사이즈 구간 %, 이사 거리 구간·계단·사다리차', () => {
  const d = load('entrance-door');
  const rd = calculateQuote(d, mergePriceTable(d, {}), { answers: { date: '2026-10-21', doorType: 'sliding3', width: 200, glass: 'clear', removeOld: false } });
  assert.equal(rd.lines.find((l) => l.key === 'base:size').amount, 900000 * 0.25);
  const m = load('moving');
  const pm = mergePriceTable(m, {});
  const rm = calculateQuote(m, pm, { answers: { date: '2026-10-21', moveType: 'basic', truckTon: '1', crew: 2, distanceKm: 45, floors: 4, elevator: false, ladder: true } });
  assert.equal(rm.lines.find((l) => l.key === 'base:distance').amount, 150000);
  assert.equal(rm.lines.find((l) => l.key === 'base:stairs').amount, 3 * 20000);
  assert.equal(rm.lines.find((l) => l.key === 'base:ladder').amount, 150000);
  assert.ok(!rm.lines.some((l) => l.key === 'base:crew'), '기본 2명은 무료');
});

test('인력 예상: 입주청소 34평 신축 + 곰팡이', () => {
  const t = load('move-in-cleaning');
  const ctx = buildContext({ area: 34, isNew: true }, t);
  const lab = estimateLabor(t, ctx, { mold: { on: true } });
  // 34 × 0.27 = 9.18 + 곰팡이 2 = 11.18 → 신축 +20% = 13.4인시간 → 2명 × 7시간
  assert.equal(lab.crew, 2);
  assert.equal(lab.hours, 7);
});

test('lintTemplate: 흔한 실수를 잡는다', () => {
  const bad = { id: 'x', name: 'x', steps: [{ fields: [{ key: 'name', type: 'text' }, { key: 'q', type: 'weird' }] }], pricing: { base: { quantityField: 'area' }, surcharges: [], options: [] }, checklist: [{ key: 'c', optionKey: 'nope' }], defaults: {} };
  const msgs = lintTemplate(bad).map((l) => l.msg).join('\n');
  assert.match(msgs, /알 수 없는 입력 형태/);
  assert.match(msgs, /"phone"/);
  assert.match(msgs, /수량 필드/);
  assert.match(msgs, /옵션 "nope"/);
});
