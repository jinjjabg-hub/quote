// 요금제 테스트 (설계도 12장)
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePlan, monthKey, canSend, hasTeam, canAddStaff, untilText, FEATURE_ROWS, PLAN_ORDER } from '../js/plan.js';

const NOW = Date.parse('2026-11-05T03:00:00Z');

test('적용 요금제: 문서 없음·모르는 값·만료 → 무료', () => {
  assert.equal(effectivePlan(null, NOW), 'free');
  assert.equal(effectivePlan({ plan: 'vip' }, NOW), 'free');
  assert.equal(effectivePlan({ plan: 'team' }, NOW), 'team', '만료일 없음 = 계속');
  assert.equal(effectivePlan({ plan: 'team', until: '2026-12-01T00:00:00Z' }, NOW), 'team');
  assert.equal(effectivePlan({ plan: 'team', until: '2026-11-01T00:00:00Z' }, NOW), 'free');
  assert.equal(effectivePlan({ plan: 'solo', until: { toMillis: () => NOW - 1 } }, NOW), 'free', 'Firestore 시간 값');
});

test('이번 달 키: 한국 시간 기준 (UTC 15시 이후는 한국은 다음 날)', () => {
  assert.equal(monthKey(Date.parse('2026-11-30T14:59:00Z')), '202611');
  assert.equal(monthKey(Date.parse('2026-11-30T15:00:00Z')), '202612');
  assert.equal(monthKey(Date.parse('2026-12-31T15:00:00Z')), '202701');
});

test('무료는 월 5건, 유료는 무제한, 테스트 견적은 안 셈', () => {
  assert.deepEqual(canSend('free', 4), { ok: true, left: 1 });
  assert.deepEqual(canSend('free', 5), { ok: false, left: 0 });
  assert.deepEqual(canSend('free', 9, { test: true }), { ok: true, left: null });
  assert.deepEqual(canSend('solo', 500), { ok: true, left: null });
  assert.deepEqual(canSend(undefined, 0), { ok: true, left: 5 });
});

test('팀 기능·직원 수 한도', () => {
  assert.equal(hasTeam('team'), true);
  assert.equal(hasTeam('company'), true);
  assert.equal(hasTeam('solo'), false);
  assert.deepEqual(canAddStaff('team', 9), { ok: true, max: 10 });
  assert.deepEqual(canAddStaff('team', 10), { ok: false, max: 10 });
  assert.deepEqual(canAddStaff('solo', 0), { ok: false, max: 0 });
});

test('비교표는 요금제 4개 열, 만료일 표기', () => {
  assert.ok(FEATURE_ROWS.every((r) => r.length === PLAN_ORDER.length + 1));
  assert.equal(untilText({ until: '2026-12-31T14:00:00Z' }), '2026.12.31까지');
  assert.equal(untilText({}), '');
});

import { extendUntil } from '../js/plan.js';

test('운영자 기간 연장: 남은 기간 끝에서 이어서, 월말 처리, 그날 한국 시간 끝까지', () => {
  const kst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19);
  assert.equal(kst(extendUntil(null, 1, NOW)), '2026-12-05T23:59:59', '오늘(11/5)부터 1개월');
  assert.equal(kst(extendUntil(Date.parse('2026-11-20T14:59:59Z'), 1, NOW)), '2026-12-20T23:59:59', '남은 기간(11/20) 끝에서');
  assert.equal(kst(extendUntil(Date.parse('2026-10-01T00:00:00Z'), 3, NOW)), '2027-02-05T23:59:59', '이미 끝난 기간 → 오늘부터');
  assert.equal(kst(extendUntil(null, 1, Date.parse('2027-01-31T03:00:00Z'))), '2027-02-28T23:59:59', '1/31 + 1개월');
});
