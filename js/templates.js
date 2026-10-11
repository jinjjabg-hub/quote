// 업종 템플릿 로더.
// 1순위: Firestore templates/{id} (관리자가 콘솔에서 올린 경우), 2순위: 저장소의 templates/{id}.json
import { db, doc, getDoc } from './firebase.js';

const cache = {};

export async function loadTemplate(templateId) {
  if (!/^[a-z0-9-]+$/.test(templateId || '')) throw new Error(`잘못된 템플릿 ID: ${templateId}`);
  if (cache[templateId]) return cache[templateId];
  let tpl = null;
  try {
    const snap = await getDoc(doc(db, 'templates', templateId));
    if (snap.exists()) tpl = snap.data();
  } catch { /* 오프라인·미설정 → JSON 사용 */ }
  if (!tpl) {
    const res = await fetch(new URL(`../templates/${templateId}.json`, import.meta.url));
    if (!res.ok) throw new Error(`템플릿을 찾을 수 없습니다: ${templateId}`);
    tpl = await res.json();
  }
  cache[templateId] = tpl;
  return tpl;
}
