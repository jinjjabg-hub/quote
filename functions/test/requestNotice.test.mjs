// 새 견적 요청 → 사장님 알림 테스트. Firebase 없이 가짜 저장소·발송으로 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequestNotice, requestNoticeText, noticeWindow, FRESH_MS, NOTICE_MAX, NOTICE_WINDOW_MS } from '../lib/requestNotice.js';
import { NotifyError } from '../lib/notify.js';

const NOW = 1_800_000_000_000;
const ts = (ms) => ({ toMillis: () => ms });
const request = { shopId: 'shop1', status: 'new', createdAt: ts(NOW - 5000), customer: { name: '김고객', phone: '010-9999-8888', region: '부산 수영구' }, answers: { date: '2026-11-21' } };

function fake(docs, results) {
  const log = { sent: [], marked: [], removed: [] };
  return {
    log,
    deps: {
      now: NOW,
      getDoc: async (p) => docs[p] ?? null,
      markNotified: async (p) => { log.marked.push(p); docs[p] = { ...docs[p], notifiedAt: ts(NOW) }; },
      send: async (m) => { log.sent.push(m); return results || m.tokens.map(() => ({ ok: true })); },
      removeTokens: async (p, t) => { log.removed.push([p, t]); },
      takeSlot: async (shopId) => { const r = noticeWindow(docs[`slot/${shopId}`], NOW); docs[`slot/${shopId}`] = r.next; return r.allowed; },
    },
  };
}

test('알림 문구에 고객 이름·연락처가 없고, 지역·희망일만 있다', () => {
  const t = requestNoticeText(request);
  assert.equal(t.title, '새 견적 요청이 왔어요');
  assert.match(t.body, /부산 수영구 · 희망일 11\/21/);
  assert.doesNotMatch(JSON.stringify(t), /김고객|9999/);
  assert.match(requestNoticeText({ ...request, test: true }).title, /^\[테스트\]/);
  assert.equal(requestNoticeText({}).body, '눌러서 견적 보내기');
});

test('새 요청 → 사장님 기기에 1번 보내고, 다시 불러도 또 보내지 않는다', async () => {
  const f = fake({ 'requests/r1': request, 'shops/shop1/private/push': { tokens: ['t1', 't2'] } });
  assert.deepEqual(await handleRequestNotice({ requestId: 'r1' }, f.deps), { sent: true });
  assert.deepEqual(f.log.sent[0].tokens, ['t1', 't2']);
  assert.match(f.log.sent[0].data.link, /owner\.html#req=r1$/);
  assert.deepEqual(await handleRequestNotice({ requestId: 'r1' }, f.deps), { sent: false, reason: 'already' });
  assert.equal(f.log.sent.length, 1);
});

test('알림을 안 켠 사장님 → 보내지 않음, 못 쓰는 기기 토큰은 지운다', async () => {
  const none = fake({ 'requests/r1': request });
  assert.deepEqual(await handleRequestNotice({ requestId: 'r1' }, none.deps), { sent: false, reason: 'no_token' });
  const bad = fake({ 'requests/r1': request, 'shops/shop1/private/push': { tokens: ['old', 'ok'] } }, [{ ok: false, badToken: true }, { ok: true }]);
  assert.deepEqual(await handleRequestNotice({ requestId: 'r1' }, bad.deps), { sent: true });
  assert.deepEqual(bad.log.removed, [['shops/shop1/private/push', ['old']]]);
});

test('없는 요청·이미 답한 요청·오래된 요청·이상한 ID 는 거절 (가짜 알림 방지)', async () => {
  const f = fake({
    'requests/sent': { ...request, status: 'sent' },
    'requests/old': { ...request, createdAt: ts(NOW - FRESH_MS - 1) },
  });
  for (const [id, reason] of [['nope', 'not_found'], ['sent', 'not_found'], ['old', 'stale'], ['a/b', 'bad_request'], ['', 'bad_request']]) {
    await assert.rejects(handleRequestNotice({ requestId: id }, f.deps), (e) => e instanceof NotifyError && e.reason === reason, id);
  }
  assert.equal(f.log.sent.length, 0);
});

test('알림 상한: 한 업체에 10분에 5건까지만 울리고, 10분이 지나면 다시 울린다', async () => {
  const docs = { 'shops/shop1/private/push': { tokens: ['t1'] } };
  for (let i = 0; i < NOTICE_MAX + 2; i += 1) docs[`requests/r${i}`] = { ...request };
  const f = fake(docs);
  const out = [];
  for (let i = 0; i < NOTICE_MAX + 2; i += 1) out.push(await handleRequestNotice({ requestId: `r${i}` }, f.deps));
  assert.equal(out.filter((o) => o.sent).length, NOTICE_MAX);
  assert.deepEqual(out.at(-1), { sent: false, reason: 'throttled' });
  assert.equal(f.log.marked.length, NOTICE_MAX + 2, '넘친 요청도 알림 처리 표시는 남긴다 (다시 불러도 안 울림)');
  // 창이 끝나면 다시 허용
  assert.equal(noticeWindow({ start: 0, count: NOTICE_MAX }, NOTICE_WINDOW_MS).allowed, true);
  assert.equal(noticeWindow({ start: 0, count: NOTICE_MAX }, NOTICE_WINDOW_MS - 1).allowed, false);
  assert.deepEqual(noticeWindow(null, 7).next, { start: 7, count: 1 });
});
