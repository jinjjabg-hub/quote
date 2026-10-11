// 토스페이먼츠 코어 API 얇은 래퍼 (Node 20+ 내장 fetch)
// 인증: Basic base64("시크릿키:")  — 시크릿키는 절대 브라우저로 보내지 않는다.
// 문서: https://docs.tosspayments.com/reference  (결제 승인 / 조회 / 취소)
//       https://docs.tosspayments.com/reference/using-api/authorization
//       https://docs.tosspayments.com/reference/using-api/idempotency-key

const API = 'https://api.tosspayments.com/v1';

export class TossError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status; // HTTP 상태 (0 = 네트워크 오류 → 결과 불명)
    this.code = code;
  }
}

/** 테스트 모드에서는 test_ 로 시작하는 키만 허용한다 (실키 사고 방지) */
export function assertKeyMatchesMode(secretKey, mode) {
  if (!secretKey) throw new Error('TOSS_SECRET_KEY 가 설정되지 않았습니다.');
  const isTest = secretKey.startsWith('test_');
  if (mode !== 'live' && !isTest) throw new Error('PAYMENT_MODE=test 인데 실(live) 키가 들어있습니다. 중단합니다.');
  if (mode === 'live' && isTest) throw new Error('PAYMENT_MODE=live 인데 테스트 키가 들어있습니다.');
}

async function call(secretKey, method, path, body, idempotencyKey) {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey; // 같은 요청 재시도 시 이중 승인·이중 환불 방지
  let res;
  try {
    res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new TossError(0, 'NETWORK', `토스페이먼츠 연결 실패: ${e.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new TossError(res.status, json.code, json.message);
  return json;
}

/** 결제 승인: 고객이 결제창에서 인증한 뒤 10분 안에 호출해야 한다 */
export const confirmPayment = (sk, { paymentKey, orderId, amount }) =>
  call(sk, 'POST', '/payments/confirm', { paymentKey, orderId, amount }, `confirm-${orderId}`);

export const getPayment = (sk, paymentKey) =>
  call(sk, 'GET', `/payments/${encodeURIComponent(paymentKey)}`);

export const getPaymentByOrderId = (sk, orderId) =>
  call(sk, 'GET', `/payments/orders/${encodeURIComponent(orderId)}`);

/** 취소(환불). cancelAmount 를 빼면 전액 취소. idempotencyKey 는 "환불 1건"마다 고유하게 */
export const cancelPayment = (sk, paymentKey, { cancelReason, cancelAmount }, idempotencyKey) =>
  call(sk, 'POST', `/payments/${encodeURIComponent(paymentKey)}/cancel`,
    cancelAmount == null ? { cancelReason } : { cancelReason, cancelAmount }, idempotencyKey);
