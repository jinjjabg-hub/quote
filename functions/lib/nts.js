// 국세청 사업자등록 상태조회 (공공데이터포털 '국세청_사업자등록정보 진위확인 및 상태조회 서비스')
// POST https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=<인증키>
// 본문: { "b_no": ["1234567890"] }  (최대 100개, 하이픈 없이)
// 인증키: data.go.kr 마이페이지의 "일반 인증키(Decoding)" 값을 Secret Manager(NTS_SERVICE_KEY)에 넣는다.
//         여기서 encodeURIComponent 로 한 번만 인코딩한다.
import { parseNtsStatus } from './biz.js';

const URL_BASE = 'https://api.odcloud.kr/api/nts-businessman/v1/status';

export class NtsError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

/** @returns parseNtsStatus 결과 (네트워크·HTTP 오류는 NtsError) */
export async function checkBusinessStatus(serviceKey, bizNo, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${URL_BASE}?serviceKey=${encodeURIComponent(serviceKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ b_no: [bizNo] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new NtsError(`국세청 조회 연결 실패: ${e.message}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new NtsError(`국세청 조회 HTTP ${res.status}`, res.status);
  return parseNtsStatus(json, bizNo);
}
