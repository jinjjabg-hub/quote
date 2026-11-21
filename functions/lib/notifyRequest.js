// HTTP 함수 notifyRequest — 고객 화면이 견적 요청을 저장한 직후 불러, 사장님 휴대폰에 "새 견적 요청" 알림(FCM)을 보낸다.
// 로그인 없는 고객이 부르므로 검증은 요청 문서로 한다 (requestNotice.js: 실제로 있음 · 방금 만듦 · 아직 안 알림). 키·비밀값 없음.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAppCheck } from 'firebase-admin/app-check';
import { defineBoolean } from 'firebase-functions/params';
import { ALLOWED_ORIGINS } from './area.js';
import { NotifyError } from './notify.js';
import { handleRequestNotice, noticeWindow } from './requestNotice.js';

// App Check: 고객 화면(우리 앱)에서 온 요청인지 확인. 화면이 토큰을 보내면 항상 검사하고,
// REQUIRE_APP_CHECK=true 로 배포하면 토큰이 없는 요청(curl 등)도 거절한다. 켜는 순서는 배포.md ⑧.
const REQUIRE_APP_CHECK = defineBoolean('REQUIRE_APP_CHECK', { default: false });

async function appCheckOk(req) {
  const token = req.get('x-firebase-appcheck') || '';
  if (!token) return !REQUIRE_APP_CHECK.value();
  return getAppCheck().verifyToken(token).then(() => true, () => false);
}

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
  if (!(await appCheckOk(req))) { res.status(401).json({ ok: false, reason: 'app_check' }); return; }
  try {
    const db = getFirestore();
    const out = await handleRequestNotice(req.body, {
      now: Date.now(),
      getDoc: async (path) => { const s = await db.doc(path).get(); return s.exists ? s.data() : null; },
      markNotified: (path) => db.doc(path).update({ notifiedAt: FieldValue.serverTimestamp() }),
      removeTokens: (path, tokens) => db.doc(path).update({ tokens: FieldValue.arrayRemove(...tokens) }),
      // 업체당 알림 상한. shops/{id}/notice/requests 는 보안 규칙에 match 가 없어 서버만 읽고 쓴다
      takeSlot: (shopId) => db.runTransaction(async (tx) => {
        const ref = db.doc(`shops/${shopId}/notice/requests`);
        const snap = await tx.get(ref);
        const { allowed, next } = noticeWindow(snap.exists ? snap.data() : null, Date.now());
        if (allowed) tx.set(ref, next);
        return allowed;
      }),
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
