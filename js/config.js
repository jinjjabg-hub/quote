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
