// 업종 템플릿 목록 + 로더.
// ★ 업종 목록은 이 파일의 TEMPLATE_LIST 한 곳에서만 관리한다. (templates/{id}.json 과 id 가 같아야 함 — npm test 가 확인)
// 로더: 1순위 Firestore templates/{id} (관리자가 콘솔에서 올린 경우), 2순위 저장소의 templates/{id}.json

export const TEMPLATE_LIST = [
  { id: 'move-in-cleaning', name: '입주청소' },
  { id: 'home-cleaning', name: '거주청소' },
  { id: 'moving', name: '이사' },
  { id: 'aircon-cleaning', name: '에어컨 청소' },
  { id: 'aircon-install', name: '에어컨 설치' },
  { id: 'curtain', name: '커튼·블라인드' },
  { id: 'jungmun', name: '중문' },
];
export const TEMPLATE_IDS = TEMPLATE_LIST.map((t) => t.id);

export function templateName(id) {
  return TEMPLATE_LIST.find((t) => t.id === id)?.name || id;
}

const cache = {};

export async function loadTemplate(templateId) {
  if (!/^[a-z0-9-]+$/.test(templateId || '')) throw new Error(`잘못된 템플릿 ID: ${templateId}`);
  if (cache[templateId]) return cache[templateId];
  let tpl = null;
  try {
    // firebase.js 는 브라우저 전용(CDN) → 여기서만 늦게 불러온다 (Node 테스트에서 TEMPLATE_LIST 를 쓰기 위해)
    const { db, doc, getDoc } = await import('./firebase.js');
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

/** 이미 불러온 템플릿 (없으면 null) — 목록 화면에서 동기적으로 쓴다 */
export function cachedTemplate(templateId) {
  return cache[templateId] || null;
}
