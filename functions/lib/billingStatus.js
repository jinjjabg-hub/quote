// HTTP 함수 billingStatus — 사장님 화면이 부른다. 키·비밀값 없음 (결제 키가 없어도 배포된다).
//   action 'status' (기본): 무료 견적 남은 건수·요금제 상태. 서버가 실제 견적서 수를 센다
//   action 'cancel': 요금제 해지 (다음 결제일부터 결제 안 함)
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { ALLOWED_ORIGINS } from './area.js';
import { handleStatus, handleCancel, BillingError, koreaToday } from './billing.js';

if (!getApps().length) initializeApp();

/** 로그인 확인 + Firestore 연결 (billingPay.js 와 같이 쓴다) */
export async function billingDeps(req) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  const user = m ? await getAuth().verifyIdToken(m[1]).catch(() => null) : null;
  const db = getFirestore();
  return {
    uid: user?.uid || null,
    email: user?.email || '',
    today: koreaToday(),
    getDoc: async (path) => { const s = await db.doc(path).get(); return s.exists ? s.data() : null; },
    setDoc: (path, data, merge) => db.doc(path).set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: !!merge }),
    // 테스트 견적은 세지 않는다. (test 필드가 없는 옛 견적도 세도록 전체 − 테스트)
    countQuotes: async (shopId) => {
      const q = db.collection('quotes').where('shopId', '==', shopId);
      const [all, tests] = await Promise.all([q.count().get(), q.where('test', '==', true).count().get()]);
      return all.data().count - tests.data().count;
    },
  };
}

export function billingHttp(handler, name) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.status(405).json({ ok: false, reason: 'method' }); return; }
    if (!ALLOWED_ORIGINS.includes(req.get('origin') || '')) { res.status(403).json({ ok: false, reason: 'origin' }); return; }
    try {
      res.json({ ok: true, ...(await handler(req)) });
    } catch (e) {
      if (e instanceof BillingError) { res.status(e.status).json({ ok: false, reason: e.reason, message: e.message }); return; }
      logger.error(`${name} 오류`, { error: e?.code || e?.name || 'Error', detail: String(e?.message || '').slice(0, 200) });
      res.status(500).json({ ok: false, reason: 'server', message: '처리하지 못했습니다. 잠시 뒤 다시 시도해주세요.' });
    }
  };
}

export const billingStatus = onRequest({
  region: 'asia-northeast3', cors: ALLOWED_ORIGINS, maxInstances: 5, memory: '256MiB', timeoutSeconds: 30,
}, billingHttp(async (req) => {
  const deps = await billingDeps(req);
  if (req.body?.action === 'cancel') {
    const out = await handleCancel(deps);
    return { canceled: true, ...out, state: await handleStatus(deps) };
  }
  return { state: await handleStatus(deps) };
}, 'billingStatus'));
