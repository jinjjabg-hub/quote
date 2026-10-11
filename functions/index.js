// 결제 Cloud Functions (테스트 모드 골격) — 토스페이먼츠 결제위젯/결제창 v2 기준
//
//   [고객] view.html  ─ preparePayment ─▶ payments/{orderId} = ready (서버가 quotes 로 금액 계산·동의 기록)
//          토스 결제창 → pay-success.html ─ confirmPayment ─▶ 금액 3중 비교 → 토스 승인 API → 상태 기록
//   [토스] 결제 상태 변경 ─ tossWebhook ─▶ 본문은 믿지 않고 토스 조회 API 로 다시 확인 후 동기화
//   [사장님] 취소·환불 ─ cancelPayment (Firebase 로그인 토큰 필수) ─▶ 업체 환불 규칙으로 금액 계산 → 토스 취소 API
//
// 보안 원칙
// - 시크릿키는 Secret Manager(TOSS_SECRET_KEY)에만. 코드·config.js·Firestore 에 쓰지 않는다.
// - 결제 상태(payments, quotes.payment, status=paid_*)는 이 서버만 쓴다. 규칙상 고객은 못 쓴다.
// - 카드번호 등 결제수단 정보는 받지도 저장하지도 않는다(토스 결제창이 처리). 영수증 URL 만 저장.
//
// 설정 (docs/payment-flow.md "사장님/대표용 3단계" 참고)
//   firebase functions:secrets:set TOSS_SECRET_KEY        ← 토스 개발자센터의 "테스트" 시크릿키(test_sk_… 또는 test_gsk_…)
//   functions/.env  →  PAYMENT_MODE=test
//                      TOSS_CLIENT_KEY=test_ck_…   (공개돼도 되는 클라이언트 키)
//                      ALLOWED_ORIGINS=https://<아이디>.github.io,http://localhost:8080

import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import {
  checkPayable, makeOrderId, parseConfirmInput, checkAgreements, isQuoteId, isOrderId,
  refundByRules, refundable, describeRefundRules, STATUS_AFTER_PAID,
} from './lib/rules.js';
import * as toss from './lib/toss.js';

initializeApp();
const db = getFirestore();

const TOSS_SECRET_KEY = defineSecret('TOSS_SECRET_KEY');
const PAYMENT_MODE = defineString('PAYMENT_MODE', { default: 'test' });
const TOSS_CLIENT_KEY = defineString('TOSS_CLIENT_KEY', { default: '' });
const ALLOWED_ORIGINS = defineString('ALLOWED_ORIGINS', { default: 'http://localhost:8080' });

const OPTS = { region: 'asia-northeast3', secrets: [TOSS_SECRET_KEY], maxInstances: 10 };

/**
 * 업체별 시크릿키 조회.
 * - test: 플랫폼 공용 테스트 키 1개 (실제 돈 이동 없음)
 * - live: 방식 ①(업체별 PG 계약)에서는 업체마다 키가 다르다 → Secret Manager `toss-sk-{shopId}` 로 분리 저장 예정.
 *         대표가 PG 방식을 확정하기 전까지는 막아 둔다. (docs/payment-flow.md 2장)
 */
function secretKeyFor(/* shopId */) {
  const mode = PAYMENT_MODE.value();
  if (mode === 'live') throw httpError(503, '실결제 연결은 아직 설정되지 않았습니다.');
  const sk = TOSS_SECRET_KEY.value();
  toss.assertKeyMatchesMode(sk, mode);
  return sk;
}

// ───────────────────────── 1) 결제 준비 ─────────────────────────
// 요청: { quoteId, kind: 'deposit', agreements: { cancelPolicy, terms, privacy }, termsVersion }
// 응답: { orderId, amount, orderName, customerName, clientKey }
export const preparePayment = onRequest(OPTS, (req, res) => handle(req, res, { cors: true }, async () => {
  const { quoteId, kind = 'deposit', agreements, termsVersion } = req.body || {};
  if (!isQuoteId(quoteId)) throw httpError(400, '견적서 정보가 올바르지 않습니다.');
  if (kind !== 'deposit') throw httpError(400, '지금은 계약금 결제만 지원합니다.'); // 잔금은 2단계
  const agreed = checkAgreements(agreements);
  if (!agreed.ok) throw httpError(400, '취소·환불 규정과 약관에 동의해야 결제할 수 있어요.');

  const quoteRef = db.doc(`quotes/${quoteId}`);
  const quoteSnap = await quoteRef.get();
  const quote = quoteSnap.exists ? quoteSnap.data() : null;
  const check = checkPayable(quote, kind);
  if (!check.ok) throw httpError(409, check.message);

  // 같은 견적에 이미 결제된 계약금이 있으면 중복 결제 차단
  // (단일 필드 조회 + 메모리 필터 → 복합 색인 불필요. 견적 1건의 결제 시도는 몇 건 안 된다)
  const tries = await db.collection('payments').where('quoteId', '==', quoteId).get();
  const busy = tries.docs.some((d) => d.data().kind === kind
    && ['confirming', 'paid', 'waiting_deposit', 'unknown', 'partial_canceled'].includes(d.data().status));
  if (busy) throw httpError(409, '이미 결제가 진행된 견적입니다.');
  if (tries.size >= 20) throw httpError(429, '결제 시도가 너무 많습니다. 업체에 문의해주세요.');

  // 결제 전 취소·환불 규정 고지 의무 → 업체 규정이 없으면 온라인 결제를 열지 않는다
  if (!String(quote.cancelPolicy || '').trim()) throw httpError(409, '업체 취소·환불 규정이 없어 온라인 결제를 할 수 없어요. 전화로 문의해주세요.');
  const refundRules = await shopRefundRules(quote.shopId);
  const orderId = makeOrderId(quoteId, kind);
  await db.doc(`payments/${orderId}`).create({
    shopId: quote.shopId,
    quoteId,
    requestId: quote.requestId || null,
    kind,
    amount: check.amount, // ★ 서버가 quotes 로 계산한 금액. 승인 때 이 값과 비교한다.
    orderName: check.orderName,
    status: 'ready',
    mode: PAYMENT_MODE.value(),
    // 분쟁 대비 증거: 고객이 "무엇을 보고" 동의했는지 원문 그대로 남긴다
    agreements: {
      cancelPolicy: true, terms: true, privacy: true,
      termsVersion: String(termsVersion || '').slice(0, 40),
      cancelPolicyText: String(quote.cancelPolicy || '').slice(0, 2000),
      refundRulesText: describeRefundRules(refundRules),
      agreedAt: FieldValue.serverTimestamp(),
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
    },
    refundedAmount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    orderId,
    amount: check.amount,
    orderName: check.orderName,
    customerName: String(quote.customer?.name || '').slice(0, 30),
    clientKey: TOSS_CLIENT_KEY.value() || null,
  };
}));

// ───────────────────────── 2) 결제 승인 ─────────────────────────
// pay-success.html 이 토스가 붙여준 ?paymentKey&orderId&amount 를 그대로 보낸다.
export const confirmPayment = onRequest(OPTS, (req, res) => handle(req, res, { cors: true }, async () => {
  const input = parseConfirmInput(req.body);
  if (!input.ok) throw httpError(400, input.message);
  const { paymentKey, orderId, amount } = input;
  const payRef = db.doc(`payments/${orderId}`);

  // (a) 준비 단계 기록과 대조 + 동시 승인 방지(ready → confirming 은 1번만)
  const pay = await db.runTransaction(async (tx) => {
    const snap = await tx.get(payRef);
    if (!snap.exists) throw httpError(404, '결제 준비 기록이 없습니다.');
    const p = snap.data();
    if (p.status === 'paid' && p.paymentKey === paymentKey) return { ...p, alreadyPaid: true };
    if (p.status !== 'ready') throw httpError(409, '이미 처리된 결제입니다.');
    if (amount !== p.amount) {
      // ★ 금액 위변조: 결제창 URL 의 amount 를 바꿔도 승인되지 않는다
      // (트랜잭션 안에서 throw 하면 기록이 롤백되므로 표시만 하고 밖에서 거절)
      tx.update(payRef, { status: 'amount_mismatch', requestedAmount: amount, updatedAt: FieldValue.serverTimestamp() });
      return { ...p, mismatch: true };
    }
    tx.update(payRef, { status: 'confirming', paymentKey, updatedAt: FieldValue.serverTimestamp() });
    return p;
  });
  if (pay.mismatch) throw httpError(400, '결제 금액이 견적과 다릅니다.');
  if (pay.alreadyPaid) return { ok: true, status: 'paid', quoteId: pay.quoteId };

  // (b) 승인 직전 견적을 다시 읽어 금액 재계산 (준비 이후 사장님이 금액을 바꿨을 수 있음)
  const quoteSnap = await db.doc(`quotes/${pay.quoteId}`).get();
  const check = checkPayable(quoteSnap.data(), pay.kind);
  if (!check.ok || check.amount !== pay.amount) {
    await payRef.update({ status: 'failed', failure: { code: 'QUOTE_CHANGED', message: check.message || '견적 금액 변경' }, updatedAt: FieldValue.serverTimestamp() });
    throw httpError(409, '견적 내용이 바뀌었습니다. 견적서를 새로고침해 다시 결제해주세요.');
  }

  // (c) 토스 승인 API
  let result;
  try {
    result = await toss.confirmPayment(secretKeyFor(pay.shopId), { paymentKey, orderId, amount: pay.amount });
  } catch (e) {
    if (e instanceof toss.TossError && e.status === 0) {
      // 결과를 모름 → 웹훅/조회로 나중에 맞춘다. 고객에게는 "확인 중"
      await payRef.update({ status: 'unknown', updatedAt: FieldValue.serverTimestamp() });
      throw httpError(502, '결제 확인이 늦어지고 있어요. 잠시 후 견적서에서 상태를 확인해주세요.');
    }
    await payRef.update({ status: 'failed', failure: { code: e.code || 'ERROR', message: e.message }, updatedAt: FieldValue.serverTimestamp() });
    throw httpError(400, e.message || '결제 승인에 실패했습니다.');
  }

  const status = await applyTossPayment(orderId, result);
  const ok = status === 'paid' || status === 'waiting_deposit';
  return {
    ok,
    message: ok ? undefined : '결제 확인 중 문제가 생겼어요. 업체에서 확인 후 연락드립니다.',
    status,
    quoteId: pay.quoteId,
    receiptUrl: result.receipt?.url || null,
    virtualAccount: result.virtualAccount ? pickVirtualAccount(result.virtualAccount) : null,
  };
}));

// ───────────────────────── 3) 웹훅 ─────────────────────────
// 토스 개발자센터 → 웹훅 → URL 등록, 이벤트: PAYMENT_STATUS_CHANGED, DEPOSIT_CALLBACK
// 본문은 위조될 수 있으므로 "알림"으로만 쓰고, 실제 상태는 토스 조회 API 로 다시 받아온다.
export const tossWebhook = onRequest(OPTS, (req, res) => handle(req, res, { cors: false }, async () => {
  const body = req.body || {};
  let orderId = null;
  let paymentKey = null;
  if (body.eventType === 'PAYMENT_STATUS_CHANGED') {
    orderId = body.data?.orderId;
    paymentKey = body.data?.paymentKey;
  } else if (body.secret && body.orderId) {
    // DEPOSIT_CALLBACK (가상계좌 입금/취소): 승인 때 받아 둔 secret 과 일치해야 한다
    orderId = body.orderId;
    const snap = isOrderId(orderId) ? await db.doc(`payments/${orderId}`).get() : null;
    if (!snap?.exists || snap.data().vaSecret !== body.secret) {
      logger.warn('webhook: secret 불일치', { orderId });
      return { ignored: true };
    }
  } else {
    return { ignored: true };
  }
  if (!isOrderId(orderId)) return { ignored: true };
  const paySnap = await db.doc(`payments/${orderId}`).get();
  if (!paySnap.exists) return { ignored: true }; // 우리 앱 주문이 아님

  const sk = secretKeyFor(paySnap.data().shopId);
  const fresh = paymentKey ? await toss.getPayment(sk, paymentKey) : await toss.getPaymentByOrderId(sk, orderId);
  const status = await applyTossPayment(orderId, fresh);
  return { ok: true, status };
}));

// ───────────────────────── 4) 취소·환불 (사장님만) ─────────────────────────
// 요청 헤더: Authorization: Bearer <Firebase ID 토큰>
// 본문: { orderId, reason, amount? }  amount 생략 → 업체 환불 규칙으로 계산
export const cancelPayment = onRequest(OPTS, (req, res) => handle(req, res, { cors: true }, async () => {
  const uid = await verifyOwner(req);
  const { orderId, reason, amount } = req.body || {};
  if (!isOrderId(orderId)) throw httpError(400, 'orderId 형식 오류');
  const payRef = db.doc(`payments/${orderId}`);
  const snap = await payRef.get();
  if (!snap.exists) throw httpError(404, '결제 기록이 없습니다.');
  const pay = snap.data();
  if (pay.shopId !== uid) throw httpError(403, '내 업체의 결제만 취소할 수 있습니다.');
  if (!['paid', 'partial_canceled'].includes(pay.status)) throw httpError(409, '취소할 수 없는 상태입니다.');

  const max = refundable(pay);
  let cancelAmount;
  let basis;
  if (amount != null) {
    cancelAmount = Number(amount);
    basis = 'manual';
  } else {
    const quote = (await db.doc(`quotes/${pay.quoteId}`).get()).data();
    const calc = refundByRules(pay.amount, await shopRefundRules(pay.shopId), quote?.service?.date);
    if (!calc) throw httpError(400, '환불 규칙이 없어 금액을 계산할 수 없습니다. 환불 금액을 직접 입력해주세요.');
    cancelAmount = Math.min(calc.amount, max);
    basis = `rule:${calc.daysBefore}일전 ${calc.pct}%`;
  }
  if (!Number.isSafeInteger(cancelAmount) || cancelAmount <= 0 || cancelAmount > max) {
    throw httpError(400, `환불 가능 금액은 0원 초과 ${max}원 이하입니다.`);
  }
  const cancelReason = String(reason || '고객 요청 취소').slice(0, 200);
  const n = (pay.refunds?.length || 0) + 1;
  const result = await toss.cancelPayment(secretKeyFor(pay.shopId), pay.paymentKey,
    { cancelReason, cancelAmount }, `cancel-${orderId}-${n}`);

  await payRef.update({
    refunds: FieldValue.arrayUnion({ n, amount: cancelAmount, reason: cancelReason, basis, by: uid, at: new Date() }),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const status = await applyTossPayment(orderId, result);
  return { ok: true, status, cancelAmount, basis };
}));

// ───────────────────────── 공통: 토스 결제 객체 → 우리 DB 반영 (멱등) ─────────────────────────
async function applyTossPayment(orderId, p) {
  const payRef = db.doc(`payments/${orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(payRef);
    if (!snap.exists) return 'not_found';
    const pay = snap.data();
    const now = FieldValue.serverTimestamp();

    if (p.orderId !== orderId || p.totalAmount !== pay.amount) {
      // 토스에 기록된 금액이 우리가 계산한 금액과 다름 → 절대 '결제완료'로 두지 않고 사람 확인
      logger.error('결제 금액 불일치', { orderId, toss: p.totalAmount, ours: pay.amount });
      tx.update(payRef, { status: 'amount_mismatch', tossStatus: p.status, updatedAt: now });
      return 'amount_mismatch';
    }

    const base = {
      paymentKey: p.paymentKey,
      tossStatus: p.status,
      method: p.method || null,
      receiptUrl: p.receipt?.url || null,
      updatedAt: now,
    };
    const quoteRef = db.doc(`quotes/${pay.quoteId}`);
    const reqRef = pay.requestId ? db.doc(`requests/${pay.requestId}`) : null;
    const setStatus = (status, extra = {}) => {
      tx.update(quoteRef, { status, updatedAt: now, ...extra });
      if (reqRef) tx.update(reqRef, { status, updatedAt: now });
    };

    switch (p.status) {
      case 'DONE': {
        if (pay.status === 'paid') return 'paid';
        tx.update(payRef, { ...base, status: 'paid', approvedAt: p.approvedAt || null });
        setStatus(STATUS_AFTER_PAID[pay.kind], {
          [`payment.${pay.kind}`]: {
            orderId, amount: pay.amount, method: p.method || null, approvedAt: p.approvedAt || null,
            receiptUrl: p.receipt?.url || null, mode: pay.mode,
          },
        });
        return 'paid';
      }
      case 'WAITING_FOR_DEPOSIT': {
        tx.update(payRef, {
          ...base, status: 'waiting_deposit', vaSecret: p.secret || null,
          virtualAccount: p.virtualAccount ? pickVirtualAccount(p.virtualAccount) : null,
        });
        return 'waiting_deposit';
      }
      case 'CANCELED':
      case 'PARTIAL_CANCELED': {
        const refunded = Math.max(0, p.totalAmount - (p.balanceAmount ?? 0));
        const status = p.status === 'CANCELED' ? 'canceled' : 'partial_canceled';
        tx.update(payRef, { ...base, status, refundedAmount: refunded });
        if (status === 'canceled' && pay.status !== 'canceled') {
          setStatus('canceled', { [`payment.${pay.kind}.refundedAmount`]: refunded });
        } else {
          tx.update(quoteRef, { [`payment.${pay.kind}.refundedAmount`]: refunded, updatedAt: now });
        }
        return status;
      }
      case 'ABORTED':
      case 'EXPIRED': {
        if (pay.status === 'paid') return 'paid';
        tx.update(payRef, { ...base, status: 'failed', failure: { code: p.status } });
        return 'failed';
      }
      default:
        tx.update(payRef, base);
        return pay.status;
    }
  });
}

// ───────────────────────── 도우미 ─────────────────────────
async function shopRefundRules(shopId) {
  const snap = await db.doc(`shops/${shopId}/private/pricing`).get();
  return snap.exists ? (snap.data().priceTable?.policy?.refundRules || null) : null;
}

function pickVirtualAccount(va) {
  return { bankCode: va.bankCode || null, accountNumber: va.accountNumber || null, dueDate: va.dueDate || null };
}

async function verifyOwner(req) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m) throw httpError(401, '로그인이 필요합니다.');
  try {
    return (await getAuth().verifyIdToken(m[1])).uid;
  } catch {
    throw httpError(401, '로그인이 만료되었습니다.');
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

async function handle(req, res, { cors }, fn) {
  if (cors) {
    const origin = req.get('origin');
    const allowed = ALLOWED_ORIGINS.value().split(',').map((s) => s.trim()).filter(Boolean);
    if (origin && allowed.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, message: 'POST only' }); return; }
  try {
    res.json(await fn());
  } catch (e) {
    const status = e.httpStatus || 500;
    if (status >= 500) logger.error(e);
    // 웹훅은 5xx 를 주면 토스가 재전송한다 → 일시 오류 복구용
    res.status(status).json({ ok: false, message: status >= 500 && !e.httpStatus ? '일시적인 오류입니다.' : e.message });
  }
}
