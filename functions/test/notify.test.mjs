// 일정 배정 알림 테스트 (설계도 10-1장 ③단계). Firebase 없이 가짜 저장소·발송으로 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNotices, noticeText, signature, handleNotify, koreaToday, NotifyError } from '../lib/notify.js';

const TODAY = '2026-11-01';
const job = { date: '2026-11-04', start: '09:00', hours: 4, crew: 2, staffIds: ['a', 'b'], title: '입주청소 34평', place: '수영구 팍스타운', customer: '김고객', phone: '010-9999-8888', memo: '비번 1234', status: 'scheduled' };

test('처음 배정 → 모두 "새 일정", 같은 내용 다시 저장 → 알림 없음', () => {
  const p = planNotices(job, null, TODAY);
  assert.deepEqual(p.notices, [{ staffId: 'a', kind: 'assigned' }, { staffId: 'b', kind: 'assigned' }]);
  assert.deepEqual(planNotices(job, p.next, TODAY).notices, []);
});

test('시간 변경 → "변경", 빠진 사람 → "제외", 새로 들어온 사람 → "새 일정"', () => {
  const { next } = planNotices(job, null, TODAY);
  const p = planNotices({ ...job, start: '10:00', staffIds: ['a', 'c'] }, next, TODAY);
  assert.deepEqual(p.notices, [{ staffId: 'a', kind: 'changed' }, { staffId: 'c', kind: 'assigned' }, { staffId: 'b', kind: 'removed' }]);
  assert.deepEqual(Object.keys(p.next.staff), ['a', 'c']);
});

test('고객 연락처·메모만 바뀌면 직원에게 다시 알리지 않음', () => {
  const { next } = planNotices(job, null, TODAY);
  assert.deepEqual(planNotices({ ...job, phone: '010-0000-0000', memo: '바뀜', customer: '이고객' }, next, TODAY).notices, []);
});

test('취소·삭제 → 배정됐던 사람에게 "취소", 완료 → 알림 없음, 지난 일정 → 보내지 않음', () => {
  const { next } = planNotices(job, null, TODAY);
  assert.deepEqual(planNotices({ ...job, status: 'canceled' }, next, TODAY).notices.map((n) => n.kind), ['canceled', 'canceled']);
  assert.deepEqual(planNotices(null, { ...next, job }, TODAY).notices.length, 2);
  assert.deepEqual(planNotices({ ...job, status: 'done' }, next, TODAY).notices, []);
  assert.deepEqual(planNotices({ ...job, date: '2026-10-30' }, null, TODAY).notices, [], '지난 날짜');
  assert.deepEqual(planNotices(null, { ...next, job: { ...job, date: '2026-10-30' } }, TODAY).notices, []);
});

test('알림 문구: 날짜·요일·시간·같이 가는 사람, 고객 연락처·메모 없음 (잠금화면 노출)', () => {
  const t = noticeText('assigned', job, ['김정규', '박프리']);
  assert.equal(t.title, '새 일정 11/4(수) 09:00');
  assert.match(t.body, /입주청소 34평 · 수영구 팍스타운 · 4시간 · 같이: 김정규, 박프리/);
  for (const k of ['assigned', 'changed', 'removed', 'canceled']) {
    const x = noticeText(k, job, ['김정규']);
    assert.doesNotMatch(`${x.title} ${x.body}`, /김고객|9999|1234/);
  }
  assert.doesNotMatch(signature(job), /김고객|9999|1234/);
});

test('한국 날짜: UTC 15시 이후는 다음 날', () => {
  assert.equal(koreaToday(new Date('2026-11-01T14:59:00Z')), '2026-11-01');
  assert.equal(koreaToday(new Date('2026-11-01T15:00:00Z')), '2026-11-02');
});

function fakeDeps(docs, { uid = 'shop1', fail = {} } = {}) {
  const store = new Map(Object.entries(docs));
  const sentLog = [];
  const removed = [];
  return {
    store, sentLog, removed,
    deps: {
      uid, today: TODAY,
      getDoc: async (p) => (store.has(p) ? structuredClone(store.get(p)) : null),
      setDoc: async (p, d) => { store.set(p, d); },
      removeTokens: async (p, t) => { removed.push([p, t]); },
      send: async ({ tokens, data }) => { sentLog.push({ tokens, data }); return tokens.map((t) => (fail[t] ? { ok: false, badToken: true } : { ok: true })); },
    },
  };
}

test('처리: 알림 켠 직원에게만 보내고, 안 켠 직원은 이름으로 알려줌, 상태 저장 → 다시 불러도 중복 없음', async () => {
  const f = fakeDeps({
    'shops/shop1/jobs/j1': job,
    'shops/shop1/staff/a': { name: '김정규', pushTokens: ['tok-a'] },
    'shops/shop1/staff/b': { name: '박프리' },
  });
  const r = await handleNotify({ shopId: 'shop1', jobId: 'j1' }, f.deps);
  assert.deepEqual(r, { sent: ['김정규'], noToken: ['박프리'] });
  assert.equal(f.sentLog.length, 1);
  assert.equal(f.sentLog[0].data.kind, 'assigned');
  assert.match(f.sentLog[0].data.link, /staff\.html$/);
  assert.doesNotMatch(JSON.stringify(f.sentLog), /김고객|9999|1234/);
  const saved = f.store.get('shops/shop1/jobNotices/j1');
  assert.deepEqual(Object.keys(saved.staff), ['a', 'b']);
  assert.doesNotMatch(JSON.stringify(saved), /김고객|9999|1234/, '알림 상태에도 고객 정보 없음');
  const again = await handleNotify({ shopId: 'shop1', jobId: 'j1' }, f.deps);
  assert.deepEqual(again, { sent: [], noToken: [] });
});

test('처리: 못 쓰는 기기 토큰은 지움', async () => {
  const f = fakeDeps({
    'shops/shop1/jobs/j1': { ...job, staffIds: ['a'] },
    'shops/shop1/staff/a': { name: '김정규', pushTokens: ['old', 'new'] },
  }, { fail: { old: true } });
  const r = await handleNotify({ shopId: 'shop1', jobId: 'j1' }, f.deps);
  assert.deepEqual(r.sent, ['김정규']);
  assert.deepEqual(f.removed, [['shops/shop1/staff/a', ['old']]]);
});

test('처리: 일정이 삭제되면 남겨둔 요약으로 취소 알림', async () => {
  const f = fakeDeps({
    'shops/shop1/jobs/j1': { ...job, staffIds: ['a'] },
    'shops/shop1/staff/a': { name: '김정규', pushTokens: ['tok-a'] },
  });
  await handleNotify({ shopId: 'shop1', jobId: 'j1' }, f.deps);
  f.store.delete('shops/shop1/jobs/j1');
  const r = await handleNotify({ shopId: 'shop1', jobId: 'j1' }, f.deps);
  assert.deepEqual(r.sent, ['김정규']);
  assert.equal(f.sentLog[1].data.kind, 'canceled');
  assert.match(f.sentLog[1].data.title, /일정 취소 11\/4\(수\) 09:00/);
});

test('처리: 다른 업체 사장님·이상한 요청은 거절', async () => {
  const f = fakeDeps({}, { uid: 'someone' });
  await assert.rejects(handleNotify({ shopId: 'shop1', jobId: 'j1' }, f.deps), (e) => e instanceof NotifyError && e.status === 403);
  await assert.rejects(handleNotify({ shopId: '../x', jobId: 'j1' }, f.deps), (e) => e.status === 400);
  await assert.rejects(handleNotify({ shopId: 'shop1', jobId: 'j1' }, { ...f.deps, uid: null }), (e) => e.status === 403);
});
