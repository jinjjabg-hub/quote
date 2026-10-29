// 일정 배정 알림 (설계도 10-1장 ③단계)
// 직원: 이 기기에서 알림 받기 (FCM 토큰을 내 직원 문서 pushTokens 에 저장)
// 사장님: 일정 저장 뒤 서버 함수 notifyJob 호출 → 바뀐 직원에게만 알림
import { app, auth, db, doc, updateDoc, serverTimestamp, useEmulator } from './firebase.js';
import { pushConfig } from './config.js';

const MSG = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js';
const MAX_TOKENS = 5; // 한 직원이 쓰는 기기 수 (휴대폰 바꿔도 예전 것은 서버가 정리)

export const pushReady = () => !!pushConfig.vapidKey || !!globalThis.__pushTest;

/** 이 기기 상태: 'unsupported' | 'ios-install' | 'off' | 'denied' | 'granted' */
export function pushState() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (ios && !standalone) return 'ios-install'; // 아이폰은 홈 화면에 추가한 앱에서만 알림 가능 (iOS 16.4+)
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' ? 'granted' : 'off';
}

/** 알림 허용 → 토큰 저장. 성공하면 토큰을 돌려준다 */
export async function enablePush(shopId, staffId, current = []) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? '알림이 차단돼 있어요. 휴대폰 설정에서 이 앱의 알림을 켜주세요.' : '알림을 허용해야 받을 수 있어요.');
  const { getMessaging, getToken, isSupported } = await import(MSG);
  if (!(await isSupported())) throw new Error('이 브라우저는 알림을 지원하지 않아요. 크롬이나 삼성 인터넷으로 열어주세요.');
  const reg = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(app), { vapidKey: pushConfig.vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error('알림 등록에 실패했어요. 잠시 뒤 다시 눌러주세요.');
  const list = [...current.filter((t) => t !== token), token].slice(-MAX_TOKENS);
  await updateDoc(doc(db, 'shops', shopId, 'staff', staffId), { pushTokens: list, updatedAt: serverTimestamp() });
  try { localStorage.setItem('pushToken', token); } catch { /* 무시 */ }
  return token;
}

export function thisDeviceToken() {
  try { return localStorage.getItem('pushToken') || ''; } catch { return ''; }
}

/**
 * 사장님: 일정 저장 뒤 호출. 알림 설정 전(vapidKey 없음)이거나 에뮬레이터면 아무것도 안 함.
 * @returns { sent: [이름], noToken: [이름] } | null
 */
export async function notifyJob(shopId, jobId) {
  if (!pushReady() || (useEmulator && !globalThis.__pushTest)) return null;
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return null;
    const res = await fetch(pushConfig.notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ shopId, jobId }),
    });
    const data = await res.json().catch(() => ({}));
    return data.ok ? { sent: data.sent || [], noToken: data.noToken || [] } : null;
  } catch { return null; } // 알림 실패가 일정 저장을 막지는 않는다
}

/** 알림 결과 한 줄 ("김정규님께 알림 보냄 · 박프리님은 알림 꺼짐") */
export function notifyText(r) {
  if (!r) return '';
  return [
    r.sent.length ? `${r.sent.join(', ')}님께 알림 보냄` : '',
    r.noToken.length ? `${r.noToken.join(', ')}님은 알림 꺼짐 (전화로 알려주세요)` : '',
  ].filter(Boolean).join(' · ');
}
