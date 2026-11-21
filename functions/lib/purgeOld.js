// 매일 04:20(한국) — 요청일로부터 6개월이 지난 고객 개인정보 파기. 키 없음. 처리 규칙은 retention.js
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { runPurge } from './retention.js';

if (!getApps().length) initializeApp();

export const purgeOld = onSchedule({
  schedule: '20 4 * * *', timeZone: 'Asia/Seoul', region: 'asia-northeast3', memory: '256MiB', timeoutSeconds: 540,
}, async () => {
  const db = getFirestore();
  const out = await runPurge({
    now: Date.now(),
    listRequests: async (from, to) => (await db.collection('requests')
      .where('createdAt', '>=', Timestamp.fromDate(from)).where('createdAt', '<', Timestamp.fromDate(to)).get())
      .docs.map((d) => ({ id: d.id, data: d.data() })),
    getQuote: async (id) => { const s = await db.doc(`quotes/${id}`).get(); return s.exists ? s.data() : null; },
    update: (path, plan) => db.doc(path).update({
      ...plan.set,
      ...Object.fromEntries(plan.remove.map((k) => [k, FieldValue.delete()])),
      purgedAt: FieldValue.serverTimestamp(),
    }),
    deletePrefix: (prefix) => getStorage().bucket().deleteFiles({ prefix, force: true }),
  });
  logger.info('purgeOld', out);
});
