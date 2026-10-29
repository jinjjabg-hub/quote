// 일정 배정 알림 (설계도 10-1장 ③단계) — 계산과 처리 순서. Firebase 연결은 notifyJob.js 에서 넣어준다(테스트 가능하게).
// 마지막으로 알린 상태를 shops/{shopId}/jobNotices/{jobId} 에 두고(서버만 읽고 씀), 지금 일정과 비교해 바뀐 사람에게만 보낸다.
// → 같은 일정을 여러 번 저장해도 바뀐 게 없으면 다시 알리지 않는다.

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
export const STAFF_URL = 'https://quote.bizmy.net/staff.html';

export class NotifyError extends Error {
  constructor(status, reason, message) { super(message); this.status = status; this.reason = reason; }
}

/** 직원에게 알릴 내용이 바뀌었는지 비교하는 값 (고객 연락처·메모는 넣지 않음) */
export function signature(job) {
  return [job.date, job.start, Number(job.hours) || 0, job.place || '', job.title || ''].join('|');
}

function when(job) {
  const [y, m, d] = String(job.date).split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${wd}) ${job.start}`;
}

/** 직원 휴대폰 알림 문구. 고객 이름·연락처·메모는 넣지 않는다 (잠금화면에 보이므로) */
export function noticeText(kind, job, crewNames = []) {
  const what = [job.title, job.place].filter(Boolean).join(' · ');
  const detail = [what, job.hours ? `${job.hours}시간` : '', crewNames.length > 1 ? `같이: ${crewNames.join(', ')}` : ''].filter(Boolean).join(' · ');
  switch (kind) {
    case 'assigned': return { title: `새 일정 ${when(job)}`, body: detail };
    case 'changed': return { title: `일정 변경 ${when(job)}`, body: `바뀐 내용을 확인해주세요. ${detail}` };
    case 'removed': return { title: `일정 제외 ${when(job)}`, body: `${job.title || '일정'}에서 빠졌어요.` };
    case 'canceled': return { title: `일정 취소 ${when(job)}`, body: `${job.title || '일정'}이(가) 취소됐어요.` };
    default: return { title: '일정 알림', body: detail };
  }
}

/**
 * 누구에게 무엇을 알릴지.
 * @param job   지금 일정 (없으면 삭제된 것 → 취소로 처리)
 * @param last  { staff: { staffId: signature } } 마지막으로 알린 상태
 * @param today 'YYYY-MM-DD' (한국 날짜). 지난 일정은 상태만 맞추고 보내지 않는다
 * @returns { notices: [{ staffId, kind }], next: { staff } }
 */
export function planNotices(job, last, today) {
  const prev = last?.staff || {};
  const gone = !job || job.status === 'canceled';
  const notices = [];
  if (gone) {
    for (const id of Object.keys(prev)) notices.push({ staffId: id, kind: 'canceled' });
    const date = (job || last?.job)?.date || '';
    return { notices: date && date < today ? [] : notices, next: { staff: {} } };
  }
  if (job.status === 'done') return { notices: [], next: { staff: prev } };
  const sig = signature(job);
  const ids = [...new Set(job.staffIds || [])];
  for (const id of ids) {
    if (!(id in prev)) notices.push({ staffId: id, kind: 'assigned' });
    else if (prev[id] !== sig) notices.push({ staffId: id, kind: 'changed' });
  }
  for (const id of Object.keys(prev)) if (!ids.includes(id)) notices.push({ staffId: id, kind: 'removed' });
  return { notices: job.date < today ? [] : notices, next: { staff: Object.fromEntries(ids.map((id) => [id, sig])) } };
}

/** 한국 날짜 'YYYY-MM-DD' */
export function koreaToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 사장님 화면이 일정을 저장한 뒤 부른다.
 * deps: { uid (확인된 로그인 사용자), getDoc(path) → data|null, setDoc(path, data), send({ tokens, data }) → [{ ok, badToken }],
 *         removeTokens(staffPath, tokens), today }
 * @returns { sent: [이름], noToken: [이름 (알림을 안 켠 직원)] }
 */
export async function handleNotify(body, deps) {
  const shopId = String(body?.shopId || '');
  const jobId = String(body?.jobId || '');
  if (!ID_RE.test(shopId) || !ID_RE.test(jobId)) throw new NotifyError(400, 'bad_request', '요청 형식이 올바르지 않습니다.');
  if (!deps.uid || deps.uid !== shopId) throw new NotifyError(403, 'forbidden', '이 업체의 사장님만 보낼 수 있습니다.');

  const base = `shops/${shopId}`;
  const job = await deps.getDoc(`${base}/jobs/${jobId}`);
  const last = await deps.getDoc(`${base}/jobNotices/${jobId}`);
  const { notices, next } = planNotices(job, last, deps.today);

  const ids = [...new Set([...notices.map((n) => n.staffId), ...(job?.staffIds || [])])];
  const staff = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await deps.getDoc(`${base}/staff/${id}`)])));
  const crewNames = (job?.staffIds || []).map((id) => staff[id]?.name).filter(Boolean);

  const sent = [];
  const noToken = [];
  for (const n of notices) {
    const s = staff[n.staffId];
    if (!s) continue; // 삭제된 직원
    const tokens = (s.pushTokens || []).filter((t) => typeof t === 'string' && t);
    if (!tokens.length) { noToken.push(s.name); continue; }
    const text = noticeText(n.kind, job || last?.job || {}, crewNames);
    const results = await deps.send({ tokens, data: { ...text, link: STAFF_URL, kind: n.kind, jobId } });
    const bad = tokens.filter((t, i) => results[i]?.badToken);
    if (bad.length) await deps.removeTokens(`${base}/staff/${n.staffId}`, bad);
    if (results.some((r) => r.ok)) sent.push(s.name); else noToken.push(s.name);
  }
  // 삭제된 일정의 알림 문구를 위해 마지막 일정 요약을 같이 남긴다 (고객 정보 제외)
  const keep = job ? { date: job.date, start: job.start, hours: job.hours || 0, title: job.title || '', place: job.place || '' } : null;
  await deps.setDoc(`${base}/jobNotices/${jobId}`, { ...next, job: keep, at: new Date().toISOString() });
  return { sent, noToken };
}
