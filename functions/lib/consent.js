// 결제 전 동의 규칙 (검수 S4) — 순수 함수
//
// ① 이용약관·개인정보 링크가 없으면 고객이 "보지 못한 약관"에 동의하게 된다 → 결제 자체를 열지 않는다.
// ② 맞춤제작(커튼·중문)은 청약철회 제한을 "별도 박스 + 별도 체크(기본 해제)"로 고지·동의받아야 한다.
//    (전자상거래법 §17②6호, 시행령 §21 / docs/legal/cancel-policies.md §3 `custommade-v1` 원문 그대로)
//    증명 책임은 업체 → 고객이 본 문구 원문·버전·시각을 저장한다.
//
// ★ CUSTOM_MADE_NOTICE 의 문구는 js/payment.js 의 CUSTOM_MADE_NOTICE 와 글자까지 같아야 한다.
//   (functions/test/consent.test.mjs 가 비교한다) 문구를 바꾸면 version 을 올린다.

export const CUSTOM_MADE_NOTICE = {
  version: 'custommade-v1',
  title: '맞춤 제작 상품 취소 안내 (꼭 읽어 주세요)',
  body: '이 상품은 고객님 현장 치수에 맞춰 개별 제작하므로 다른 곳에 다시 쓸 수 없습니다.\n'
    + '· 제작은 방문 실측 후 확정 견적서를 보내드리고, 고객님이 동의하신 뒤에만 시작합니다.\n'
    + '· 제작 시작 전: 언제 취소하셔도 계약금 전액을 돌려드립니다.\n'
    + '· 제작 시작 후: 단순 변심에 의한 청약철회는 제한됩니다. 그래도 취소하시면 이미 들어간 자재·제작 비용을 발주서·영수증으로 보여드리고, 그 금액을 계약금에서 뺀 나머지를 돌려드립니다.\n'
    + '· 제품 하자, 확정 견적서와 다르게 만들어진 경우, 업체가 잰 치수가 틀린 경우에는 이 제한과 관계없이 다시 만들어 드리거나 환불합니다.',
  checkbox: '(필수) 맞춤 제작 상품은 제작 시작 후 단순 변심에 의한 청약철회가 제한된다는 위 안내를 따로 확인했고, 이에 동의합니다.',
};

/** 저장용 원문 = 박스 본문 + 체크박스 문장 (cancel-policies.md §3 `agreements.customMadeText`) */
export function customMadeNoticeText(n = CUSTOM_MADE_NOTICE) {
  return `${n.body}\n${n.checkbox}`;
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
