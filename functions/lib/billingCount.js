// Firestore 트리거 countQuote — 견적서(quotes)가 새로 만들어질 때마다 서버가 직접 건수를 다시 센다.
// 왜: 예전에는 사장님 화면이 billingStatus 를 불러야만 건수·canSend 가 갱신됐다. 화면이 부르지 않으면
//     상태 문서가 예전 값(canSend: true)으로 남아 무료 10건을 넘겨도 계속 보낼 수 있었다 (감사 2026-11-21 ①).
// 세는 방법은 billingStatus 와 같다(handleStatus: 실제 견적서 수 − 테스트, 지금까지의 최댓값). 그래서 여러 번 실행돼도 결과가 같다.
// 막기(canSend=false)는 config/billing.enforce 가 true 일 때만 — 지금처럼 꺼져 있으면 세기만 한다.
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { initializeApp, getApps } from 'firebase-admin/app';
import { handleStatus, shouldCount } from './billing.js';
import { firestoreBillingDeps } from './billingStatus.js';

if (!getApps().length) initializeApp();

export const countQuote = onDocumentCreated({
  document: 'quotes/{quoteId}', region: 'asia-northeast3', maxInstances: 5, memory: '256MiB', timeoutSeconds: 30,
}, async (event) => {
  const quote = event.data?.data();
  if (!shouldCount(quote)) return;
  const state = await handleStatus(firestoreBillingDeps(quote.shopId));
  logger.info('countQuote', { used: state.used, freeLeft: state.freeLeft, canSend: state.canSend });
});
