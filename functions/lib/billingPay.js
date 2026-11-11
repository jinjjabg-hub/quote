// 카드 자동결제 (토스페이먼츠 자동결제(빌링)). 비밀 키: Secret Manager TOSS_SECRET_KEY (읽기만 함)
//   billingPay    HTTP — 사장님이 카드 등록을 마치면 화면이 authKey 를 보낸다 → 자동결제 키 발급 + 첫 달 결제
//   billingRenew  매일 09:10(한국) — 결제일이 된 구독을 결제
// ★ 이 두 함수는 TOSS_SECRET_KEY 가 있어야 배포된다. 키를 넣기 전에는 배포 목록(.github/workflows/deploy-functions.yml)에 넣지 않는다 (배포.md ⑦).
import { randomUUID } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { ALLOWED_ORIGINS } from './area.js';
import { handleSubscribe, handleStatus, runRenewals, BillingError, koreaToday } from './billing.js';
import { billingDeps, billingHttp } from './billingStatus.js';

const TOSS_SECRET_KEY = defineSecret('TOSS_SECRET_KEY');
const TOSS_API = 'https://api.tosspayments.com/v1';

/** 토스페이먼츠 연결 (어댑터: 결제 업체를 바꾸면 이 함수만 바꾼다) */
export function tossPg(secretKey, fetchImpl = fetch) {
  const call = async (path, body) => {
    const res = await fetchImpl(`${TOSS_API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BillingError(402, 'pg', data.message || '결제가 승인되지 않았습니다. 카드를 확인해주세요.');
    return data;
  };
  return {
    issueKey: async ({ authKey, customerKey }) => {
      const d = await call('/billing/authorizations/issue', { authKey, customerKey });
      return { billingKey: d.billingKey, card: d.card ? { company: d.cardCompany || '', number: d.card.number || d.cardNumber || '' } : null };
    },
    charge: async ({ billingKey, customerKey, amount, orderId, orderName }) => {
      const d = await call(`/billing/${encodeURIComponent(billingKey)}`, { customerKey, amount, orderId, orderName });
      if (d.status && d.status !== 'DONE') throw new BillingError(402, 'pg', '결제가 완료되지 않았습니다.');
      return { paymentKey: d.paymentKey, approvedAt: d.approvedAt };
    },
  };
}

const orderId = () => `bm-${randomUUID()}`;

export const billingPay = onRequest({
  region: 'asia-northeast3', cors: ALLOWED_ORIGINS, secrets: [TOSS_SECRET_KEY], maxInstances: 5, memory: '256MiB', timeoutSeconds: 60,
}, billingHttp(async (req) => {
  const deps = { ...(await billingDeps(req)), pg: tossPg(TOSS_SECRET_KEY.value()), orderId };
  const out = await handleSubscribe(req.body, deps);
  logger.info('billingPay', { plan: out.plan });
  return { ...out, state: await handleStatus(deps) };
}, 'billingPay'));

export const billingRenew = onSchedule({
  schedule: '10 9 * * *', timeZone: 'Asia/Seoul', region: 'asia-northeast3', secrets: [TOSS_SECRET_KEY], memory: '256MiB', timeoutSeconds: 300,
}, async () => {
  const db = getFirestore();
  const out = await runRenewals({
    today: koreaToday(),
    pg: tossPg(TOSS_SECRET_KEY.value()),
    orderId,
    listDue: async (today) => (await db.collection('subscriptions').where('nextChargeDate', '<=', today).get()).docs.map((d) => d.data()),
    getDoc: async (path) => { const s = await db.doc(path).get(); return s.exists ? s.data() : null; },
    setDoc: (path, data, merge) => db.doc(path).set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: !!merge }),
  });
  logger.info('billingRenew', out);
});
