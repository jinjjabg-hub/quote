// ★ Firebase 설정은 이 파일 한 곳에서만 관리합니다.
// Firebase 콘솔 → 프로젝트 설정 → 일반 → 내 앱(웹) → "SDK 설정 및 구성"의 값을 그대로 붙여넣으세요.
export const firebaseConfig = {
  apiKey: 'AIzaSyDRELyucaHXroQdMM_0-2H52Lkc2srWKiM',
  authDomain: 'quote-640f4.firebaseapp.com',
  projectId: 'quote-640f4',
  storageBucket: 'quote-640f4.firebasestorage.app',
  messagingSenderId: '700989757565',
  appId: '1:700989757565:web:23e54c65d33f230f69b914',
};

// 앱 기본값
export const appConfig = {
  defaultTemplateId: 'move-in-cleaning',
  // 이용 안내(약관)·개인정보처리방침 링크 (legal 담당 확정 후 입력). paymentConfig 에 같은 이름 값이 있으면 그쪽이 우선.
  // privacyUrl 이 비어 있으면 고객 화면에 동의 내용 전문을 바로 보여준다.
  termsUrl: '',
  privacyUrl: '',
  // 고객 개인정보 동의 문구 버전 (legal copy-snippets §1). 문구를 바꾸면 consent-v2 로 올린다. 규칙은 'consent-v' 로 시작하는지만 본다.
  consentVersion: 'consent-v1',
  // 보관 기간(개월) — 동의 문구 "[3개월]" 칸. 대표 결정 전 임시값.
  retentionMonths: 3,
  // 사업자 인증 서버 주소. 비어 있으면 paymentConfig.functionsBaseUrl 을 쓰고, 둘 다 비면 체크섬만 확인("서버 미연결").
  functionsBaseUrl: '',
};

// ★ 온라인 결제(계약금) — 기본은 꺼짐. 꺼져 있으면 견적서에 기존 "예약 요청" 버튼이 그대로 나온다.
// 켜는 법·주의사항: quote-agents/docs/payment-flow.md "사장님/대표용 3단계 사용법"
// - clientKey 는 공개돼도 되는 "클라이언트 키"만. 시크릿키(…_sk_…)는 절대 여기에 넣지 않는다(서버 Secret Manager 전용).
// - 지금은 테스트 키만 사용한다. 실결제 전환은 대표가 PG 계약·키 발급 후 직접 한다.
export const paymentConfig = {
  enabled: false,
  provider: 'toss',                 // 토스페이먼츠 결제창 SDK v2
  mode: 'test',                     // 'test' 이면 결제창 위에 "테스트 결제" 안내 표시
  clientKey: 'test_ck_REPLACE_ME',  // 토스 개발자센터 > API 키 > 테스트 클라이언트 키 (서버가 내려주면 그 값을 우선 사용)
  functionsBaseUrl: '',             // 예: https://asia-northeast3-<프로젝트ID>.cloudfunctions.net  (비어 있으면 결제 버튼 안 나옴)
  termsUrl: '',                     // 이용약관 링크 (legal 담당 작성 중 — 비어 있으면 "준비 중" 표시)
  privacyUrl: '',                   // 개인정보 수집·이용 및 제3자(결제대행사) 제공 동의 링크
  termsVersion: 'draft-2026-10',    // 고객이 동의한 약관 버전 → payments 문서에 증거로 기록
  sdkUrl: 'https://js.tosspayments.com/v2/standard',
};

/** 약관·처리방침 링크: paymentConfig 우선, 없으면 appConfig (payment.js 와 같은 규칙) */
export function legalUrl(name) {
  return String(paymentConfig?.[name] || appConfig?.[name] || '').trim();
}
