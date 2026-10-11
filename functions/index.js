// 결제 Cloud Functions (테스트 모드 골격) — 토스페이먼츠 결제위젯/결제창 v2 기준
//
//   [고객] view.html  ─ preparePayment ─▶ payments/{orderId} = ready (서버가 quotes 로 금액 계산·동의 기록)
//          토스 결제창 → pay-success.html ─ confirmPayment ─▶ 금액 3중 비교 → 토스 승인 API → 상태 기록
//   [토스] 결제 상태 변경 ─ tossWebhook ─▶ 본문은 믿지 않고 토스 조회 API 로 다시 확인 후 동기화
//   [사장님] 취소·환불 ─ cancelPayment (Firebase 로그인 토큰 필수) ─▶ 고객이 결제 때 본 환불 규칙 스냅샷으로 계산 → 토스 취소 API
//   [사장님] 사업자 인증 ─ verifyBusiness / updateIdentity (로그인 필수) ─▶ 체크섬 → 국세청 상태조회 → bizNos 선점
//
// 보안 원칙
// - 시크릿키는 Secret Manager(TOSS_SECRET_KEY)에만. 코드·config.js·Firestore 에 쓰지 않는다.
// - 결제 상태(payments, quotes.payment, status=paid_*)는 이 서버만 쓴다. 규칙상 고객은 못 쓴다.
// - 카드번호 등 결제수단 정보는 받지도 저장하지도 않는다(토스 결제창이 처리). 영수증 URL 은 payments 에만 저장.
// - 고객 공개 quotes.payment 에는 금액·상태·시각만 (orderId·영수증 URL 은 비공개, 검수 L8).
// - 약관·처리방침 링크(TERMS_URL·PRIVACY_URL)가 비어 있으면 결제를 열지 않는다 (검수 S4).
//
// 설정 (docs/payment-flow.md "사장님/대표용 3단계" 참고)
//   firebase functions:secrets:set TOSS_SECRET_KEY        ← 토스 개발자센터의 "테스트" 시크릿키(test_sk_… 또는 test_gsk_…)
//   functions/.env  →  PAYMENT_MODE=test
//                      TOSS_CLIENT_KEY=test_ck_…   (공개돼도 되는 클라이언트 키)
//                      ALLOWED_ORIGINS=https://<아이디>.github.io,http://localhost:8080
//                      TERMS_URL=…, PRIVACY_URL=…   (js/config.js paymentConfig 와 같은 값)
//   firebase functions:secrets:set NTS_SERVICE_KEY        ← data.go.kr 국세청 상태조회 "일반 인증키(Decoding)" (키 발급 전엔 none)

import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import {
  checkPayable, makeOrderId, parseConfirmInput, isQuoteId, isOrderId,
  refundByRules, refundable, describeRefundRules, STATUS_AFTER_PAID, SETTLED_STATUS,
  classifyTossUpdate, quotePaymentSummary, pickServiceDate, normalizeRefundRules,
} from './lib/rules.js';
import {
  checkAgreements, isCustomMade, legalLinksReady, CUSTOM_MADE_NOTICE, customMadeNoticeText,
} from './lib/consent.js';
import { snapshotWithHash, isSnapshotHash } from './lib/snapshot.js';
import {
  planVerify, planIdentityUpdate, canChangeIdentity, historyEntry, hasServiceKey, normalizeBizNo, formatBizNo,
} from './lib/biz.js';
import * as toss from './lib/toss.js';
import * as nts from './lib/nts.js';

initializeApp();
const db = getFirestore();

const TOSS_SECRET_KEY = defineSecret('TOSS_SECRET_KEY');
const PAYMENT_MODE = defineString('PAYMENT_MODE', { default: 'test' });
const TOSS_CLIENT_KEY = defineString('TOSS_CLIENT_KEY', { default: '' });
const ALLOWED_ORIGINS = defineString('ALLOWED_ORIGINS', { default: 'http://localhost:8080' });
const TERMS_URL = defineString('TERMS_URL', { default: '' });
const PRIVACY_URL = defineString('PRIVACY_URL', { default: '' });
const NTS_SERVICE_KEY = defineSecret('NTS_SERVICE_KEY');

const OPTS = { region: 'asia-northeast3', secrets: [TOSS_SECRET_KEY], maxInstances: 10 };
const BIZ_OPTS = { region: 'asia-northeast3', secrets: [NTS_SERVICE_KEY], maxInstances: 5 };

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
// 요청: { quoteId, kind: 'deposit', agreements: { cancelPolicy, terms, privacy, customMade? }, termsVersion,
//         quoteSnapshotHash?, customMadeNoticeVersion? }
// 응답: { orderId, amount, orderName, customerName, clientKey, quoteSnapshotHash }
export const preparePayment = onRequest(OPTS, (req, res) => handle(req, res, { cors: true }, async () => {
  const {
    quoteId, kind = 'deposit', agreements, termsVersion, quoteSnapshotHash: clientHash, customMadeNoticeVersion,
  } = req.body || {};
  if (!isQuoteId(quoteId)) throw httpError(400, '견적서 정보가 올바르지 않습니다.');
  if (kind !== 'deposit') throw httpError(400, '지금은 계약금 결제만 지원합니다.'); // 잔금은 2단계

  // S4①: 고객이 볼 수 있는 약관·처리방침이 없으면 동의 자체가 성립하지 않는다 → 결제를 열지 않는다
  const termsUrl = TERMS_URL.value();
  const privacyUrl = PRIVACY_URL.value();
  if (!legalLinksReady({ termsUrl, privacyUrl })) {
    throw httpError(503, '온라인 결제 준비 중이에요. 견적서에서 "예약 요청"으로 진행해주세요.', 'legal_not_ready');
  }

  const quoteRef = db.doc(`quotes/${quoteId}`);
  const quoteSnap = await quoteRef.get();
  const quote = quoteSnap.exists ? quoteSnap.data() : null;
  const check = checkPayable(quote, kind);
  if (!check.ok) throw httpError(409, check.message);

  // S4②: 맞춤제작이면 별도 동의(customMade)까지 필수
  const agreed = checkAgreements(agreements, quote, { customMadeNoticeVersion });
  if (!agreed.ok) {
    throw httpError(400, agreed.code === 'NOTICE_OUTDATED'
      ? '안내 문구가 바뀌었어요. 견적서를 새로고침한 뒤 다시 동의해주세요.'
      : '취소·환불 규정과 약관에 동의해야 결제할 수 있어요.', agreed.code, { missing: agreed.missing });
  }

  // 결제 전 취소·환불 규정 고지 의무 → 업체 규정이 없으면 온라인 결제를 열지 않는다
  if (!String(quote.cancelPolicy || '').trim()) throw httpError(409, '업체 취소·환불 규정이 없어 온라인 결제를 할 수 없어요. 전화로 문의해주세요.');

  // M9: 고객이 동의한 견적 내용 그대로 스냅샷 + 해시. 고객 화면이 계산한 해시와 다르면(그사이 견적 수정) 거절
  const snap = snapshotWithHash(quote);
  if (clientHash != null && clientHash !== '' && (!isSnapshotHash(clientHash) || clientHash !== snap.hash)) {
    throw httpError(409, '견적서 내용이 바뀌었어요. 새로고침한 뒤 다시 결제해주세요.', 'quote_changed');
  }

  // 같은 견적에 이미 결제된 계약금이 있으면 중복 결제 차단
  // (단일 필드 조회 + 메모리 필터 → 복합 색인 불필요. 견적 1건의 결제 시도는 몇 건 안 된다)
  const tries = await db.collection('payments').where('quoteId', '==', quoteId).get();
  const busy = tries.docs.some((d) => d.data().kind === kind
    && ['confirming', 'paid', 'waiting_deposit', 'unknown', 'partial_canceled'].includes(d.data().status));
  if (busy) throw httpError(409, '이미 결제가 진행된 견적입니다.');
  if (tries.size >= 20) throw httpError(429, '결제 시도가 너무 많습니다. 업체에 문의해주세요.');

  // M13: 환불 자동 계산은 "고객이 견적서·결제창에서 본" 규칙(quotes.refundRules)으로만. 없으면 사장님 수동 입력.
  const refundRules = normalizeRefundRules(quote.refundRules);
  const customMade = isCustomMade(quote);
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
    // M9: 결제 시점 견적 원본. 이후 견적이 바뀌어도 이 값이 "계약 내용"의 증거다.
    quoteSnapshot: snap.snapshot,
    quoteSnapshotHash: snap.hash,
    quoteSnapshotVersion: snap.version,
    refundRules, // 고객에게 보여준 환불 계산 규칙 (null 이면 자동 계산 안 함)
    // 분쟁 대비 증거: 고객이 "무엇을 보고" 동의했는지 원문 그대로 남긴다
    agreements: {
      cancelPolicy: true, terms: true, privacy: true,
      customMade, // 맞춤제작 별도 동의 여부 (맞춤제작 견적이면 반드시 true)
      customMadeConsent: customMade ? {
        agreed: true,
        version: CUSTOM_MADE_NOTICE.version,
        text: customMadeNoticeText(),
        agreedAt: FieldValue.serverTimestamp(),
      } : null,
      termsVersion: String(termsVersion || '').slice(0, 40),
      termsUrl, privacyUrl,
      cancelPolicyText: String(quote.cancelPolicy || '').slice(0, 2000),
      refundRulesText: describeRefundRules(refundRules), // 고객 화면에 같은 문장이 표시됨 (js/payment.js)
      quoteSnapshotHash: snap.hash,
      clientSnapshotHash: clientHash || null, // 고객 화면이 계산한 값 (같으면 "고객이 본 견적 = 스냅샷" 증명)
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
    quoteSnapshotHash: snap.hash,
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
  // (금액뿐 아니라 줄·조건·취소규정 등 스냅샷 전체가 같아야 한다 — 고객이 동의한 내용 그대로 결제, M9)
  const check = checkPayable(quoteSnap.data(), pay.kind);
  const sameSnapshot = !pay.quoteSnapshotHash || snapshotWithHash(quoteSnap.data()).hash === pay.quoteSnapshotHash;
  if (!check.ok || check.amount !== pay.amount || !sameSnapshot) {
    await payRef.update({ status: 'failed', failure: { code: 'QUOTE_CHANGED', message: check.message || '견적 내용 변경' }, updatedAt: FieldValue.serverTimestamp() });
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

  const status = await applyTossPayment(orderId, result, orderId);
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
// M10: 조회는 항상 "우리 문서의 orderId"로 하고, 조회 결과 orderId == 본문 orderId == 문서 ID 일 때만 반영.
//      본문의 paymentKey 는 쓰지 않는다 (남의 paymentKey 로 우리 결제를 덮어쓰는 공격 차단).
export const tossWebhook = onRequest(OPTS, (req, res) => handle(req, res, { cors: false }, async () => {
  const body = req.body || {};
  let orderId = null;
  if (body.eventType === 'PAYMENT_STATUS_CHANGED') {
    orderId = body.data?.orderId;
  } else if (body.secret && body.orderId) {
    // DEPOSIT_CALLBACK (가상계좌 입금/취소): 승인 때 받아 둔 secret 과 일치해야 한다
    orderId = body.orderId;
    const snap = isOrderId(orderId) ? await db.doc(`payments/${orderId}`).get() : null;
    if (!snap?.exists || !snap.data().vaSecret || snap.data().vaSecret !== body.secret) {
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
  let fresh;
  try {
    fresh = await toss.getPaymentByOrderId(sk, orderId);
  } catch (e) {
    if (e instanceof toss.TossError && e.status === 404) return { ignored: true }; // 토스에 없는 주문(미결제)
    throw e; // 그 외는 5xx → 토스가 재전송
  }
  const status = await applyTossPayment(orderId, fresh, orderId);
  return { ok: true, status };
}));

// ───────────────────────── 4) 취소·환불 (사장님만) ─────────────────────────
// 요청 헤더: Authorization: Bearer <Firebase ID 토큰>
// 본문: { orderId, reason, amount?, preview? }
//   preview:true → 환불하지 않고 { refundable, suggested, calc, agreed } 만 돌려줌 (사장님 환불 화면용)
//   amount 생략 → "고객이 결제 때 본 환불 규칙 스냅샷"(payments.refundRules)으로 계산. 없으면 직접 입력 요구 (M13)
export const cancelPayment = onRequest(OPTS, (req, res) => handle(req, res, { cors: true }, async () => {
  const uid = await verifyOwner(req);
  const { orderId, reason, amount, preview } = req.body || {};
  if (!isOrderId(orderId)) throw httpError(400, 'orderId 형식 오류');
  const payRef = db.doc(`payments/${orderId}`);
  const snap = await payRef.get();
  if (!snap.exists) throw httpError(404, '결제 기록이 없습니다.');
  const pay = snap.data();
  if (pay.shopId !== uid) throw httpError(403, '내 업체의 결제만 취소할 수 있습니다.');
  if (!['paid', 'partial_canceled'].includes(pay.status)) throw httpError(409, '취소할 수 없는 상태입니다.');

  const max = refundable(pay);
  const quote = (await db.doc(`quotes/${pay.quoteId}`).get()).data();
  const calc = refundByRules(pay.amount, pay.refundRules, pickServiceDate(quote), new Date(), { paidAt: pay.approvedAt });
  const agreed = agreedBasis(pay); // 고객이 결제 때 동의한 원문 → 사장님 환불 화면에 근거로 표시
  if (preview) {
    return { ok: true, preview: true, refundable: max, suggested: calc ? Math.min(calc.amount, max) : null, calc, agreed };
  }

  let cancelAmount;
  let basis;
  if (amount != null && amount !== '') {
    cancelAmount = Number(amount);
    basis = 'manual';
  } else {
    if (!calc) {
      throw httpError(400, '고객이 결제 때 동의한 환불 계산 규칙이 없어 자동 계산할 수 없어요. 동의한 취소·환불 규정을 보고 환불 금액을 직접 입력해주세요.',
        'no_rules', { agreed, refundable: max });
    }
    cancelAmount = Math.min(calc.amount, max);
    basis = `rule:${calc.rule}:${calc.daysBefore}일전 ${calc.pct}%`;
  }
  if (!Number.isSafeInteger(cancelAmount) || cancelAmount <= 0 || cancelAmount > max) {
    throw httpError(400, `환불 가능 금액은 0원 초과 ${max}원 이하입니다.`);
  }
  const cancelReason = String(reason || '고객 요청 취소').slice(0, 200);
  const n = (pay.refunds?.length || 0) + 1;
  const result = await toss.cancelPayment(secretKeyFor(pay.shopId), pay.paymentKey,
    { cancelReason, cancelAmount }, `cancel-${orderId}-${n}`);

  await payRef.update({
    refunds: FieldValue.arrayUnion({
      n, amount: cancelAmount, reason: cancelReason, basis, by: uid, at: new Date(),
      agreedSnapshotHash: pay.quoteSnapshotHash || null, // 어떤 동의 내용을 근거로 환불했는지
    }),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const status = await applyTossPayment(orderId, result, orderId);
  return { ok: true, status, cancelAmount, basis, agreed };
}));

// ───────────────────────── 5) 사업자 인증 (사장님만) ─────────────────────────
// docs/round2/contract.md "업체 신원". 1사업자번호 = 1계정, 인증 후 업체명·번호 변경은 30일 1회 + 이력.
// 요청 헤더: Authorization: Bearer <Firebase ID 토큰>

// POST /verifyBusiness { bizNo } → { ok, bizVerified, mode: 'nts'|'checksum_only', bizNo }
export const verifyBusiness = onRequest(BIZ_OPTS, (req, res) => handle(req, res, { cors: true }, async () => {
  const uid = await verifyOwner(req);
  const shopSnap = await db.doc(`shops/${uid}`).get();
  const shop = shopSnap.exists ? shopSnap.data() : null;
  const plan = planVerify(shop, req.body);
  if (!plan.ok) throw httpError(plan.status, plan.message, plan.code);
  if (plan.already) {
    return { ok: true, bizVerified: true, already: true, mode: shop.bizVerifiedMode || null, bizNo: formatBizNo(plan.bizNo) };
  }
  const mode = await checkBusinessWithNts(plan.bizNo);
  await writeIdentity(uid, { kind: 'verify', bizNo: plan.bizNo, mode });
  return { ok: true, bizVerified: true, mode, bizNo: formatBizNo(plan.bizNo) };
}));

// POST /updateIdentity { name?, bizNo? } → { ok, name, bizNo, mode, nextChangeAt }
//   409 too_soon {nextAt} / 409 biz_taken / 409 not_verified (인증 전엔 화면에서 직접 수정)
export const updateIdentity = onRequest(BIZ_OPTS, (req, res) => handle(req, res, { cors: true }, async () => {
  const uid = await verifyOwner(req);
  const shopSnap = await db.doc(`shops/${uid}`).get();
  const shop = shopSnap.exists ? shopSnap.data() : null;
  const plan = planIdentityUpdate(shop, req.body || {});
  if (!plan.ok) throw httpError(plan.status, plan.message, plan.code, plan.nextAt ? { nextAt: plan.nextAt } : undefined);
  // 사업자번호를 바꾸면 새 번호로 재인증 (국세청 조회)
  const mode = plan.bizNoChanged ? await checkBusinessWithNts(plan.bizNo) : (shop.bizVerifiedMode || null);
  const at = await writeIdentity(uid, {
    kind: 'update', name: plan.name, bizNo: plan.bizNo, mode, bizNoChanged: plan.bizNoChanged, nameChanged: plan.nameChanged,
  });
  const next = new Date(at.getTime() + 30 * 86_400_000).toISOString();
  return { ok: true, name: plan.name, bizNo: formatBizNo(plan.bizNo), mode, nextChangeAt: next };
}));

/** 체크섬은 planVerify 에서 통과. 국세청 상태조회 → 'nts'. 키가 없고 테스트 모드면 'checksum_only' */
async function checkBusinessWithNts(bizNo) {
  const key = NTS_SERVICE_KEY.value();
  if (!hasServiceKey(key)) {
    if (PAYMENT_MODE.value() !== 'live') return 'checksum_only';
    throw httpError(503, '사업자 조회 설정이 아직 안 됐어요. 잠시 후 다시 시도해주세요.', 'nts_not_configured');
  }
  let r;
  try {
    r = await nts.checkBusinessStatus(key, bizNo);
  } catch (e) {
    logger.warn('국세청 조회 실패', { message: e.message, status: e.status });
    throw httpError(503, '국세청 조회가 잠시 안 돼요. 잠시 후 다시 시도해주세요.', 'nts_unavailable');
  }
  if (!r.ok) throw httpError(r.code === 'nts_error' ? 503 : 422, r.message, r.code);
  return 'nts';
}

/**
 * 업체 신원 기록 (트랜잭션): bizNos/{bizNo} 선점 → shops/{uid} 갱신 → identityHistory 추가
 * kind 'verify': 첫 인증 (identityChangedAt 은 건드리지 않음 — 인증 직후 오타 수정 1회는 가능)
 * kind 'update': 변경 요청 (30일 제한을 트랜잭션 안에서 다시 확인)
 * @returns 기록 시각(Date)
 */
async function writeIdentity(uid, { kind, name, bizNo, mode, bizNoChanged = kind === 'verify', nameChanged = false }) {
  const shopRef = db.doc(`shops/${uid}`);
  const now = new Date();
  await db.runTransaction(async (tx) => {
    // 읽기는 모두 쓰기 전에
    const shopSnap = await tx.get(shopRef);
    if (!shopSnap.exists) throw httpError(404, '업체 정보를 먼저 저장해주세요.', 'no_shop');
    const shop = shopSnap.data();
    const prevBizNo = normalizeBizNo(shop.bizNo);
    const newRef = bizNoChanged ? db.doc(`bizNos/${bizNo}`) : null;
    const oldRef = bizNoChanged && prevBizNo && prevBizNo !== bizNo && shop.bizVerified === true ? db.doc(`bizNos/${prevBizNo}`) : null;
    const claim = newRef ? await tx.get(newRef) : null;
    const old = oldRef ? await tx.get(oldRef) : null;

    if (kind === 'update') {
      if (shop.bizVerified !== true) throw httpError(409, '인증 전에는 업체 정보 화면에서 바로 고칠 수 있어요.', 'not_verified');
      const gate = canChangeIdentity(shop.identityChangedAt, now);
      if (!gate.ok) throw httpError(409, '업체명·사업자번호는 30일에 한 번만 바꿀 수 있어요.', 'too_soon', { nextAt: gate.nextAt });
    } else if (shop.bizVerified === true && prevBizNo !== bizNo) {
      throw httpError(409, '이미 인증된 업체예요. 사업자번호를 바꾸려면 "변경 요청"을 이용해주세요.', 'use_update');
    }
    if (claim?.exists && claim.data().uid !== uid) {
      throw httpError(409, '이미 다른 계정에서 인증한 사업자번호예요. 본인 업체가 맞다면 고객센터로 문의해주세요.', 'biz_taken');
    }

    const update = { updatedAt: FieldValue.serverTimestamp() };
    if (newRef) {
      tx.set(newRef, { uid, verifiedAt: now, mode });
      if (old?.exists && old.data().uid === uid) tx.delete(oldRef); // 옛 번호 선점 해제
      // shops.bizNo 는 화면과 같은 000-00-00000 형식, bizNos 문서 ID 는 숫자 10자리
      Object.assign(update, { bizNo: formatBizNo(bizNo), bizVerified: true, bizVerifiedAt: now, bizVerifiedMode: mode });
    }
    if (kind === 'update') {
      if (nameChanged) update.name = name;
      update.identityChangedAt = now;
    }
    update.identityHistory = FieldValue.arrayUnion(historyEntry({
      kind,
      name: kind === 'update' ? name : (shop.name ?? null),
      bizNo,
      prevName: kind === 'update' && nameChanged ? (shop.name ?? null) : null,
      prevBizNo: bizNoChanged && prevBizNo !== bizNo ? prevBizNo : null,
      mode,
      at: now,
    }));
    tx.update(shopRef, update);
  });
  return now;
}

// ───────────────────────── 공통: 토스 결제 객체 → 우리 DB 반영 (멱등) ─────────────────────────
// requestedOrderId: 이 반영을 일으킨 요청(승인·웹훅·취소)이 말한 orderId. 셋이 모두 같아야 반영 (M10)
async function applyTossPayment(orderId, p, requestedOrderId) {
  const payRef = db.doc(`payments/${orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(payRef);
    if (!snap.exists) return 'not_found';
    const pay = snap.data();
    const now = FieldValue.serverTimestamp();

    const verdict = classifyTossUpdate(orderId, pay, p, requestedOrderId);
    if (verdict.action === 'ignore') {
      logger.warn('토스 결제 객체 무시 (주문 불일치)', { orderId, reason: verdict.reason, tossOrderId: p?.orderId });
      return 'ignored';
    }
    if (verdict.action === 'alert') {
      // 이미 결제된 건 → 상태는 그대로 두고 경고만 남긴다 (환불 길을 막지 않기 위해)
      logger.error('결제 후 금액 불일치 경고', { orderId, toss: p.totalAmount, ours: pay.amount });
      tx.update(payRef, {
        alerts: FieldValue.arrayUnion({ code: verdict.reason, tossStatus: p.status || null, tossAmount: p.totalAmount ?? null, at: new Date() }),
        updatedAt: now,
      });
      return pay.status;
    }
    if (verdict.action === 'mismatch') {
      // 토스에 기록된 금액이 우리가 계산한 금액과 다름 → 절대 '결제완료'로 두지 않고 사람 확인
      logger.error('결제 금액 불일치', { orderId, toss: p.totalAmount, ours: pay.amount });
      tx.update(payRef, { status: 'amount_mismatch', tossStatus: p.status, updatedAt: now });
      return 'amount_mismatch';
    }

    const base = {
      paymentKey: p.paymentKey,
      tossStatus: p.status,
      method: p.method || null,
      receiptUrl: p.receipt?.url || null, // 영수증은 payments(사장님만 읽기)와 결제 완료 화면에만
      updatedAt: now,
    };
    const quoteRef = db.doc(`quotes/${pay.quoteId}`);
    const reqRef = pay.requestId ? db.doc(`requests/${pay.requestId}`) : null;
    const setStatus = (status, extra = {}) => {
      tx.update(quoteRef, { status, updatedAt: now, ...extra });
      if (reqRef) tx.update(reqRef, { status, updatedAt: now });
    };
    const paidAt = p.approvedAt || pay.approvedAt || null;

    switch (p.status) {
      case 'DONE': {
        if (pay.status === 'paid') return 'paid';
        if (SETTLED_STATUS.includes(pay.status) && pay.status !== 'waiting_deposit') return pay.status; // 취소된 건을 되살리지 않음
        tx.update(payRef, { ...base, status: 'paid', approvedAt: p.approvedAt || null });
        // L8: 고객 공개 견적서에는 금액·상태·시각만
        setStatus(STATUS_AFTER_PAID[pay.kind], {
          [`payment.${pay.kind}`]: quotePaymentSummary({ amount: pay.amount, status: 'paid', paidAt }),
        });
        return 'paid';
      }
      case 'WAITING_FOR_DEPOSIT': {
        if (pay.status !== 'ready' && pay.status !== 'confirming' && pay.status !== 'unknown') return pay.status;
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
        const summary = quotePaymentSummary({
          amount: pay.amount, status, paidAt, refundedAmount: refunded,
          canceledAt: new Date().toISOString(),
        });
        if (status === 'canceled' && pay.status !== 'canceled') {
          setStatus('canceled', { [`payment.${pay.kind}`]: summary });
        } else {
          tx.update(quoteRef, { [`payment.${pay.kind}`]: summary, updatedAt: now });
        }
        return status;
      }
      case 'ABORTED':
      case 'EXPIRED': {
        if (SETTLED_STATUS.includes(pay.status)) return pay.status;
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
/** 고객이 결제 때 동의한 근거 (사장님 환불 화면 표시용, M13) */
function agreedBasis(pay) {
  const a = pay.agreements || {};
  return {
    cancelPolicyText: a.cancelPolicyText ?? pay.quoteSnapshot?.cancelPolicy ?? '',
    refundRulesText: a.refundRulesText || '',
    customMade: a.customMade === true,
    customMadeText: a.customMadeConsent?.text || null,
    quoteSnapshotHash: pay.quoteSnapshotHash || null,
    agreedAt: a.agreedAt?.toDate ? a.agreedAt.toDate().toISOString() : (a.agreedAt || null),
  };
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

function httpError(status, message, code = undefined, extra = undefined) {
  const e = new Error(message);
  e.httpStatus = status;
  if (code) e.code = code;
  if (extra) e.extra = extra;
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
    const body = { ok: false, message: status >= 500 && !e.httpStatus ? '일시적인 오류입니다.' : e.message };
    if (e.httpStatus && e.code) body.code = e.code; // 예: biz_taken, too_soon, legal_not_ready
    if (e.httpStatus && e.extra) Object.assign(body, e.extra); // 예: { nextAt }
    res.status(status).json(body);
  }
}
