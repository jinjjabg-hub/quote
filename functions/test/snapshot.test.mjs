// 견적 스냅샷·해시 (검수 M9) — 서버(functions/lib/snapshot.js)와 고객 화면(js/payment.js)이 같은 해시를 내야 한다
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, quoteSnapshot, snapshotWithHash, sha256Hex, isSnapshotHash, SNAPSHOT_FIELDS } from '../lib/snapshot.js';

const quote = (over = {}) => ({
  number: 'Q261011-ABCD',
  lines: [{ label: '기본 (32평)', amount: 480000, reason: '평당 15,000원' }, { label: '베란다', amount: 80000 }],
  total: 560000, deposit: 112000, depositPct: 20,
  conditions: [{ label: '곰팡이', text: '심하면 +50,000원', amount: 50000 }],
  included: ['욕실', '주방'], excluded: ['외부 유리창 (요청 시 +30,000원)'],
  cancelPolicy: '작업 3일 전까지 전액 환불',
  // 스냅샷에 안 들어가는 필드
  status: 'sent', customer: { name: '김고객', phone: '010-0000-0000' }, updatedAt: new Date('2026-10-11T00:00:00Z'),
  ...over,
});

test('스냅샷은 정해진 필드만, 없는 필드는 null 로', () => {
  const s = quoteSnapshot(quote());
  assert.deepEqual(Object.keys(s), SNAPSHOT_FIELDS);
  assert.equal(s.refundRules, null);
  assert.equal(s.customer, undefined);
  for (const k of ['number', 'lines', 'total', 'deposit', 'depositPct', 'conditions', 'included', 'excluded', 'cancelPolicy']) {
    assert.ok(SNAPSHOT_FIELDS.includes(k), k);
  }
});

test('해시: 키 순서·스냅샷 밖 필드와 무관, 내용이 바뀌면 달라진다', () => {
  const a = snapshotWithHash(quote());
  assert.ok(isSnapshotHash(a.hash));
  const reordered = Object.fromEntries(Object.entries(quote()).reverse());
  assert.equal(snapshotWithHash(reordered).hash, a.hash);
  assert.equal(snapshotWithHash(quote({ status: 'paid_deposit', customer: { name: '다른' } })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ total: 560001 })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ cancelPolicy: '환불 불가' })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ lines: [{ label: '기본', amount: 480000 }] })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ conditions: [] })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ included: ['욕실'] })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ excluded: [] })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ depositPct: 30 })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ number: 'Q2' })).hash, a.hash);
  assert.notEqual(snapshotWithHash(quote({ refundRules: [{ daysBefore: 3, pct: 100 }] })).hash, a.hash);
});

test('canonicalJson: 중첩 키 정렬, undefined 제거, Timestamp 는 ISO', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, undefined], c: 'x' }, z: undefined }), '{"a":{"c":"x","d":[1,null]},"b":1}');
  const ts = { toDate: () => new Date('2026-10-11T01:02:03Z') };
  assert.equal(canonicalJson({ t: ts }), '{"t":"2026-10-11T01:02:03.000Z"}');
  assert.equal(canonicalJson(NaN), 'null');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('고객 화면(js/payment.js)과 서버가 같은 해시를 계산한다', async (t) => {
  let client;
  try { client = await import('../../js/payment.js'); } catch (e) { t.skip(`js/payment.js 를 Node 에서 불러오지 못함: ${e.message}`); return; }
  assert.deepEqual(client.SNAPSHOT_FIELDS, SNAPSHOT_FIELDS);
  const samples = [
    quote(),
    quote({ refundRules: [{ daysBefore: 3, pct: 100 }, { type: 'withinDaysOfPayment', days: 7, pct: 100 }] }),
    quote({ lines: [], conditions: null, included: undefined, number: undefined, cancelPolicy: '줄바꿈\n"따옴표" 🙂' }),
    {},
  ];
  for (const q of samples) {
    assert.equal(client.canonicalJson(client.quoteSnapshot(q)), canonicalJson(quoteSnapshot(q)));
    assert.equal(await client.quoteSnapshotHash(q), snapshotWithHash(q).hash);
  }
});
