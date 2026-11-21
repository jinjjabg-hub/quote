// 고객 개인정보 자동 파기 (감사 2026-11-21 ④) — 계산과 처리 순서. Firebase 연결은 purgeOld.js 에서 넣어준다(테스트 가능하게).
// 왜: 개인정보처리방침·고객 화면 안내에 "요청일로부터 6개월 뒤 자동 파기"라고 적었다. 적은 대로 동작해야 한다.
// 지우는 것: 현장 사진(Storage 폴더째), 연락처, 남긴 말씀(memo), 평수 조회 결과(단지·동·호), 사장님 내부 메모.
// 가리는 것: 이름(김*수), 지역(앞 두 단어만 — "부산 수영구"). 금액·답변·상태는 남긴다 (사장님 매출·통계용, 개인을 알아볼 수 없음).

export const RETENTION_DAYS = 180; // 6개월. 바꾸면 privacy.html 3항과 고객 화면(q.js consentBox) 문구도 같이
export const SCAN_DAYS = 30;       // 매일 [기한 − 30일, 기한) 구간을 다시 본다 → 함수가 며칠 실패해도 30일 안에 따라잡는다
const DAY = 86400000;

/** 오늘 처리할 요청의 createdAt 구간 */
export function purgeWindow(nowMs) {
  const to = nowMs - RETENTION_DAYS * DAY;
  return { from: new Date(to - SCAN_DAYS * DAY), to: new Date(to) };
}

export function maskName(name) {
  const s = String(name || '').trim();
  if (s.length <= 1) return s;
  if (s.length === 2) return `${s[0]}*`;
  return s[0] + '*'.repeat(s.length - 2) + s.at(-1);
}

export function coarseRegion(region) {
  return String(region || '').trim().split(/\s+/).slice(0, 2).join(' ');
}

/**
 * 요청 1건을 어떻게 처리할지. 이미 처리한 요청이면 null.
 * @returns { set: {필드경로: 값}, remove: [필드경로], storagePrefix } — 호출하는 쪽이 purgedAt 을 붙여 저장한다
 */
export function planRequestPurge(id, req) {
  if (!req || req.purgedAt) return null;
  const answers = req.answers || {};
  return {
    set: {
      'customer.name': maskName(req.customer?.name),
      'customer.phone': '',
      'customer.region': coarseRegion(req.customer?.region),
      photos: [],
    },
    remove: [
      ...Object.keys(answers).filter((k) => k === 'memo' || k.endsWith('Lookup')).map((k) => `answers.${k}`),
      ...('ownerMemo' in req ? ['ownerMemo'] : []),
    ],
    storagePrefix: req.shopId ? `requests/${req.shopId}/${id}/` : null,
  };
}

/** 견적서(링크로 누구나 열 수 있는 문서)의 고객 표시 가리기. 이미 처리했으면 null */
export function planQuotePurge(quote) {
  if (!quote || quote.purgedAt) return null;
  return { set: { 'customer.name': maskName(quote.customer?.name), 'customer.region': coarseRegion(quote.customer?.region) }, remove: [] };
}

/**
 * deps: { now(ms), listRequests(from, to) → [{ id, data }], getQuote(id) → data|null,
 *         update(path, plan) (plan.set + plan.remove 를 적용하고 purgedAt 기록), deletePrefix(prefix) }
 * @returns { requests, quotes, skipped }
 */
export async function runPurge(deps) {
  const { from, to } = purgeWindow(deps.now);
  const out = { requests: 0, quotes: 0, skipped: 0 };
  for (const { id, data } of await deps.listRequests(from, to)) {
    const plan = planRequestPurge(id, data);
    if (!plan) { out.skipped += 1; continue; }
    if (plan.storagePrefix) await deps.deletePrefix(plan.storagePrefix); // 사진 먼저 → 문서 표시는 마지막 (중간에 실패하면 내일 다시)
    if (data.quoteId) {
      const qp = planQuotePurge(await deps.getQuote(data.quoteId));
      if (qp) { await deps.update(`quotes/${data.quoteId}`, qp); out.quotes += 1; }
    }
    await deps.update(`requests/${id}`, plan);
    out.requests += 1;
  }
  return out;
}
