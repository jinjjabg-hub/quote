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
