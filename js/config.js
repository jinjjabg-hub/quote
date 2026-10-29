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
  // 만두(번역 메신저) 게스트 채팅 주소. 만두 ID를 붙이면 고객이 가입 없이 바로 채팅한다.
  manduBaseUrl: 'https://jinjjabg-hub.github.io/MANDU/',
};

// 주소 → 평수 자동 조회 (설계도 4-4장). 서버 함수 areaLookup 주소 (배포하면 터미널에 "Function URL" 로 나옴).
// enabled: 실제 단지로 검증(dev.html "평수 조회 시험")이 끝나면 true 로. 그 전에는 고객 링크 끝에 &lookup=1 을 붙여 사장님만 시험.
export const areaLookupConfig = {
  url: 'https://asia-northeast3-quote-640f4.cloudfunctions.net/areaLookup',
  enabled: false,
};

// 일정 배정 알림 (설계도 10-1장 ③단계). 직원 휴대폰 푸시(FCM).
// vapidKey: Firebase 콘솔 → 프로젝트 설정 → 클라우드 메시징 → 웹 푸시 인증서 → "키 쌍 생성"의 공개 키 (비밀값 아님).
// 비어 있으면 직원 화면의 "알림 받기"와 알림 발송이 꺼져 있다.
export const pushConfig = {
  vapidKey: '',
  notifyUrl: 'https://asia-northeast3-quote-640f4.cloudfunctions.net/notifyJob',
};
