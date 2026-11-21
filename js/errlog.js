// 고객 화면 오류 기록 → Firestore clientErrors (읽기는 Firebase 콘솔에서만).
// 왜: 1순위 성공 기준 "응답 누락 0건"을 재려면, 고객이 보내다 실패한 건수를 알아야 한다.
// 고객 이름·연락처 등 입력값은 절대 넣지 않는다 — 어디서(where) 어떤 오류(code·message)였는지만.
import { db, doc, collection, setDoc, serverTimestamp } from './firebase.js';

export function logClientError(page, where, err, shopId) {
  try {
    const data = {
      page: String(page).slice(0, 20),
      where: String(where).slice(0, 40),
      code: String(err?.code || err?.name || 'error').slice(0, 60),
      message: String(err?.message || err || '').slice(0, 300),
      at: serverTimestamp(),
    };
    if (typeof shopId === 'string' && shopId) data.shopId = shopId.slice(0, 128);
    setDoc(doc(collection(db, 'clientErrors')), data).catch(() => {}); // 기록 실패는 무시 (오프라인 등)
  } catch { /* 무시 */ }
}
