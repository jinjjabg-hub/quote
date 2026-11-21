// 고객 개인정보 자동 파기 테스트 (Firebase 없이 가짜 저장소로)
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPurge, planRequestPurge, planQuotePurge, purgeWindow, maskName, coarseRegion, RETENTION_DAYS, SCAN_DAYS } from '../lib/retention.js';

const DAY = 86400000;
const NOW = Date.UTC(2027, 5, 1);

test('기한 구간: 6개월 전부터 30일 더 이전까지', () => {
  const { from, to } = purgeWindow(NOW);
  assert.equal(NOW - to.getTime(), RETENTION_DAYS * DAY);
  assert.equal(to.getTime() - from.getTime(), SCAN_DAYS * DAY);
});

test('가리기: 이름 김*수, 지역은 앞 두 단어만', () => {
  assert.equal(maskName('김철수'), '김*수');
  assert.equal(maskName('남궁민수'), '남**수');
  assert.equal(maskName('이훈'), '이*');
  assert.equal(coarseRegion('부산 수영구 광안동 123-4 101동 202호'), '부산 수영구');
  assert.equal(coarseRegion(''), '');
});

test('요청: 연락처·사진·남긴 말씀·단지 정보·내부 메모 삭제, 금액·답변은 남김, 이미 처리한 건 건너뜀', () => {
  const req = {
    shopId: 's1', quoteTotal: 560000, status: 'confirmed', ownerMemo: '현관 1234',
    customer: { name: '김철수', phone: '010-1234-5678', region: '서울 송파구 잠실동 88' },
    answers: { area: 34, memo: '비밀번호 1234', areaLookup: { complex: '잠실엘스', dong: '101' }, areaSource: 'registry' },
    photos: [{ slot: 'bath', path: 'requests/s1/r1/bath.jpg' }],
  };
  const p = planRequestPurge('r1', req);
  assert.deepEqual(p.set, { 'customer.name': '김*수', 'customer.phone': '', 'customer.region': '서울 송파구', photos: [] });
  assert.deepEqual(p.remove.sort(), ['answers.areaLookup', 'answers.memo', 'ownerMemo']);
  assert.equal(p.storagePrefix, 'requests/s1/r1/');
  assert.equal(planRequestPurge('r1', { ...req, purgedAt: 1 }), null);
  assert.equal(planQuotePurge({ customer: { name: '김철수', region: '서울 송파구 잠실동' } }).set['customer.name'], '김*수');
  assert.equal(planQuotePurge({ purgedAt: 1 }), null);
});

test('실행: 사진 폴더 삭제 → 견적서 가리기 → 요청 처리, 두 번 돌려도 같은 결과', async () => {
  const docs = {
    'requests/r1': { shopId: 's1', quoteId: 'q1', customer: { name: '김철수', phone: '010' }, answers: { memo: 'x' } },
    'requests/r2': { shopId: 's1', customer: { name: '박영희', phone: '011' }, answers: {} },
    'quotes/q1': { customer: { name: '김철수', region: '부산 수영구 광안동' } },
  };
  const log = [];
  const deps = {
    now: NOW,
    listRequests: async (from, to) => {
      assert.ok(from < to);
      return ['r1', 'r2'].map((id) => ({ id, data: docs[`requests/${id}`] }));
    },
    getQuote: async (id) => docs[`quotes/${id}`] ?? null,
    update: async (path, plan) => { log.push(['update', path]); docs[path] = { ...docs[path], purgedAt: 1 }; },
    deletePrefix: async (p) => { log.push(['delete', p]); },
  };
  assert.deepEqual(await runPurge(deps), { requests: 2, quotes: 1, skipped: 0 });
  assert.deepEqual(log.slice(0, 3), [['delete', 'requests/s1/r1/'], ['update', 'quotes/q1'], ['update', 'requests/r1']]);
  assert.deepEqual(await runPurge(deps), { requests: 0, quotes: 0, skipped: 2 });
});
