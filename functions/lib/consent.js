// 결제 전 동의 규칙 (검수 S4) — 순수 함수
//
// ① 이용약관·개인정보 링크가 없으면 고객이 "보지 못한 약관"에 동의하게 된다 → 결제 자체를 열지 않는다.
// ② 맞춤제작(커튼·중문)은 청약철회 제한을 "별도 박스 + 별도 체크(기본 해제)"로 고지·동의받아야 한다.
//    (전자상거래법 §17②6호, 시행령 §21 / docs/legal/quote-notice.md §4-5, copy-snippets.md §3)
//    증명 책임은 업체 → 고객이 본 문구 원문·버전·시각을 저장한다.
//
// ★ CUSTOM_MADE_NOTICE 의 문구는 js/payment.js 의 CUSTOM_MADE_NOTICE 와 글자까지 같아야 한다.
//   (functions/test/consent.test.mjs 가 비교한다) 문구를 바꾸면 version 을 올린다.

export const CUSTOM_MADE_NOTICE = {
  version: 'custom-made-v1',
  title: '맞춤 제작 상품 취소 안내',
  lines: [
    '이 상품은 고객님 치수에 맞춰 개별 제작하여 다른 곳에 쓸 수 없어요.',
    '제작 시작 전: 취소할 수 있어요. (실측비가 있으면 위 취소·환불 규정에 따라 빼고 환불)',
    '제작 시작 후: 단순 변심으로는 취소·환불이 안 돼요.',
    '제품 하자나 주문과 다르게 만들어진 경우는 언제든 교환·환불받을 수 있어요.',
  ],
  checkbox: '[필수] 위 맞춤 제작 취소 제한 내용을 따로 확인했고 동의해요.',
};

export function customMadeNoticeText(n = CUSTOM_MADE_NOTICE) {
  return [n.title, ...n.lines.map((l) => `· ${l}`), n.checkbox].join('\n');
}

/** 견적이 맞춤제작인지 (템플릿 customMade:true → 발송 시 quotes.service.customMade) */
export function isCustomMade(quote) {
  return quote?.service?.customMade === true;
}

/** 결제 전에 고객이 반드시 체크해야 하는 동의 항목 (맞춤제작이면 1개 추가) */
export const BASE_AGREEMENTS = ['cancelPolicy', 'terms', 'privacy'];
export function requiredAgreements(quote) {
  return isCustomMade(quote) ? [...BASE_AGREEMENTS, 'customMade'] : [...BASE_AGREEMENTS];
}

/**
 * @param agreements  고객이 보낸 { cancelPolicy, terms, privacy, customMade? } (모두 true 여야)
 * @param quote       견적 문서 (맞춤제작 여부 판단)
 * @param input       { customMadeNoticeVersion } 고객 화면이 보여준 맞춤제작 문구 버전
 */
export function checkAgreements(agreements, quote = null, input = {}) {
  const missing = requiredAgreements(quote).filter((k) => agreements?.[k] !== true);
  if (missing.length) return { ok: false, code: 'AGREEMENT_MISSING', missing };
  if (isCustomMade(quote) && input.customMadeNoticeVersion !== CUSTOM_MADE_NOTICE.version) {
    // 고객 화면이 옛 문구를 보여줬다 → 새로고침 후 다시 동의
    return { ok: false, code: 'NOTICE_OUTDATED', missing: ['customMade'] };
  }
  return { ok: true };
}

/** 약관·처리방침 링크가 둘 다 있어야 결제를 열 수 있다 (S4①) */
export function legalLinksReady({ termsUrl, privacyUrl } = {}) {
  // https 주소 또는 같은 사이트 상대경로(terms.html 등). 빈칸·javascript: 는 불가
  const ok = (u) => typeof u === 'string' && /^(https?:\/\/|\.{0,2}\/|[A-Za-z0-9_-]+\.html)\S*$/.test(u.trim());
  return ok(termsUrl) && ok(privacyUrl);
}
