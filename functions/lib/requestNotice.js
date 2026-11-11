// 새 견적 요청 → 사장님 휴대폰 알림 — 계산과 처리 순서. Firebase 연결은 notifyRequest.js 에서 넣어준다(테스트 가능하게).
// 왜: 이 서비스의 1순위는 "문의를 놓치지 않기". 사장님이 앱을 열어 봐야만 새 요청을 알 수 있으면 응답이 늦어진다.
// 고객 화면(로그인 없음)이 요청을 저장한 직후 부른다. 그래서 요청 문서가 실제로 있고, 방금 만들어졌고,
// 아직 알린 적이 없을 때만 1번 보낸다 → 아무나 불러도 가짜 알림·반복 알림을 만들 수 없다.
import { NotifyError } from './notify.js';

export const OWNER_URL = 'https://quote.bizmy.net/owner.html';
export const FRESH_MS = 10 * 60 * 1000; // 만든 지 10분이 지난 요청은 알리지 않는다
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 알림 문구. 고객 이름·연락처는 넣지 않는다 (잠금화면에 보이므로). 지역·희망일만 */
export function requestNoticeText(request) {
  const [, m, d] = /^\d{4}-(\d{2})-(\d{2})$/.exec(request.answers?.date || '') || [];
  const body = [request.customer?.region, m ? `희망일 ${Number(m)}/${Number(d)}` : ''].filter(Boolean).join(' · ');
  return {
    title: `${request.test ? '[테스트] ' : ''}새 견적 요청이 왔어요`,
    body: body ? `${body} · 눌러서 견적 보내기` : '눌러서 견적 보내기',
  };
}

/**
 * deps: { getDoc(path) → data|null, markNotified(path), send({ tokens, data }) → [{ ok, badToken }], removeTokens(path, tokens), now (ms) }
 * @returns { sent: boolean, reason?: 'already' | 'no_token' | 'failed' }
 */
export async function handleRequestNotice(body, deps) {
  const requestId = String(body?.requestId || '');
  if (!ID_RE.test(requestId)) throw new NotifyError(400, 'bad_request', '요청 형식이 올바르지 않습니다.');
  const path = `requests/${requestId}`;
  const request = await deps.getDoc(path);
  if (!request || request.status !== 'new') throw new NotifyError(404, 'not_found', '요청을 찾을 수 없습니다.');
  const created = request.createdAt?.toMillis ? request.createdAt.toMillis() : 0;
  if (!created || deps.now - created > FRESH_MS) throw new NotifyError(410, 'stale', '오래된 요청입니다.');
  if (request.notifiedAt) return { sent: false, reason: 'already' };

  await deps.markNotified(path); // 먼저 표시 → 동시에 두 번 불러도 한 번만 보낸다
  const pushPath = `shops/${request.shopId}/private/push`;
  const tokens = ((await deps.getDoc(pushPath))?.tokens || []).filter((t) => typeof t === 'string' && t);
  if (!tokens.length) return { sent: false, reason: 'no_token' };

  const results = await deps.send({
    tokens,
    data: { ...requestNoticeText(request), link: `${OWNER_URL}#req=${requestId}`, kind: 'request', requestId },
  });
  const bad = tokens.filter((t, i) => results[i]?.badToken);
  if (bad.length) await deps.removeTokens(pushPath, bad);
  return results.some((r) => r.ok) ? { sent: true } : { sent: false, reason: 'failed' };
}
