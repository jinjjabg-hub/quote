// HTTP 함수 notifyJob — 사장님 화면이 일정을 저장한 뒤 불러, 배정·변경·취소된 직원 휴대폰에 알림(FCM)을 보낸다.
// 사장님 확인: 요청에 붙은 Firebase 로그인 토큰(ID token)의 uid 가 shopId 와 같아야 한다. 키·비밀값 없음.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { ALLOWED_ORIGINS } from './area.js';
import { handleNotify, NotifyError, koreaToday } from './notify.js';

if (!getApps().length) initializeApp();

// 더 이상 쓸 수 없는 기기 토큰 (앱 삭제·알림 끔 등) → 직원 문서에서 지운다
const BAD_TOKEN = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'];

export const notifyJob = onRequest({
  region: 'asia-northeast3',
  cors: ALLOWED_ORIGINS,
  maxInstances: 5,
  memory: '256MiB',
  timeoutSeconds: 30,
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, reason: 'method' }); return; }
  const origin = req.get('origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) { res.status(403).json({ ok: false, reason: 'origin' }); return; }
  try {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const uid = m ? (await getAuth().verifyIdToken(m[1]).catch(() => null))?.uid : null;
    if (!uid) throw new NotifyError(401, 'auth', '로그인이 필요합니다.');
    const db = getFirestore();
    const out = await handleNotify(req.body, {
      uid,
      today: koreaToday(),
      getDoc: async (path) => { const s = await db.doc(path).get(); return s.exists ? s.data() : null; },
      setDoc: (path, data) => db.doc(path).set(data),
      removeTokens: (path, tokens) => db.doc(path).update({ pushTokens: FieldValue.arrayRemove(...tokens) }),
      send: async ({ tokens, data }) => {
        const r = await getMessaging().sendEachForMulticast({
          tokens,
          data, // 알림 모양은 서비스워커(sw.js)가 만든다
          webpush: { headers: { Urgency: 'high', TTL: '86400' } },
        });
        return r.responses.map((x) => ({ ok: x.success, badToken: !x.success && BAD_TOKEN.includes(x.error?.code) }));
      },
    });
    logger.info('notifyJob', { sent: out.sent.length, noToken: out.noToken.length });
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof NotifyError) { res.status(e.status).json({ ok: false, reason: e.reason, message: e.message }); return; }
    logger.error('notifyJob 오류', { error: e?.code || e?.name || 'Error', detail: String(e?.message || '').slice(0, 200) });
    res.status(500).json({ ok: false, reason: 'server', message: '알림을 보내지 못했습니다.' });
  }
});
