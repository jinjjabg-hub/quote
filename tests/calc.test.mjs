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
