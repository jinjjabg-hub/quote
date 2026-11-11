// HTTP 함수 notifyRequest — 고객 화면이 견적 요청을 저장한 직후 불러, 사장님 휴대폰에 "새 견적 요청" 알림(FCM)을 보낸다.
// 로그인 없는 고객이 부르므로 검증은 요청 문서로 한다 (requestNotice.js: 실제로 있음 · 방금 만듦 · 아직 안 알림). 키·비밀값 없음.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { ALLOWED_ORIGINS } from './area.js';
import { NotifyError } from './notify.js';
import { handleRequestNotice } from './requestNotice.js';

if (!getApps().length) initializeApp();

const BAD_TOKEN = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'];

export const notifyRequest = onRequest({
  region: 'asia-northeast3',
  cors: ALLOWED_ORIGINS,
  maxInstances: 5,
  memory: '256MiB',
  timeoutSeconds: 30,
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, reason: 'method' }); return; }
  if (!ALLOWED_ORIGINS.includes(req.get('origin') || '')) { res.status(403).json({ ok: false, reason: 'origin' }); return; }
  try {
    const db = getFirestore();
    const out = await handleRequestNotice(req.body, {
      now: Date.now(),
      getDoc: async (path) => { const s = await db.doc(path).get(); return s.exists ? s.data() : null; },
      markNotified: (path) => db.doc(path).update({ notifiedAt: FieldValue.serverTimestamp() }),
      removeTokens: (path, tokens) => db.doc(path).update({ tokens: FieldValue.arrayRemove(...tokens) }),
      send: async ({ tokens, data }) => {
        const r = await getMessaging().sendEachForMulticast({
          tokens,
          data, // 알림 모양은 서비스워커(sw.js)가 만든다
          webpush: { headers: { Urgency: 'high', TTL: '3600' } },
        });
        return r.responses.map((x) => ({ ok: x.success, badToken: !x.success && BAD_TOKEN.includes(x.error?.code) }));
      },
    });
    logger.info('notifyRequest', out);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof NotifyError) { res.status(e.status).json({ ok: false, reason: e.reason }); return; }
    logger.error('notifyRequest 오류', { error: e?.code || e?.name || 'Error', detail: String(e?.message || '').slice(0, 200) });
    res.status(500).json({ ok: false, reason: 'server' });
  }
});
