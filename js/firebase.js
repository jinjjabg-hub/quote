// Firebase 초기화 + 앱에서 쓰는 함수 재수출. (CDN 모듈 사용 → 빌드 불필요)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
  connectAuthEmulator, signInWithCredential,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, setDoc, updateDoc, onSnapshot, query, where,
  serverTimestamp, writeBatch, connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject, connectStorageEmulator,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import { firebaseConfig } from './config.js';

// 개발용 에뮬레이터 모드: localhost 에서 주소 뒤에 ?emulator=1 을 한 번 붙이면 켜진다. (?emulator=0 으로 끔)
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const emuParam = new URLSearchParams(location.search).get('emulator');
try { if (isLocal && emuParam != null) localStorage.setItem('emulator', emuParam); } catch { /* 무시 */ }
let emuStored = null;
try { emuStored = localStorage.getItem('emulator'); } catch { /* 무시 */ }
export const useEmulator = isLocal && emuStored === '1';

export const isConfigured = useEmulator || !String(firebaseConfig.apiKey).startsWith('YOUR_');

const app = initializeApp(useEmulator
  ? { apiKey: 'demo-key', projectId: 'demo-quote', storageBucket: 'demo-quote.appspot.com', authDomain: 'localhost' }
  : firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

if (useEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8180);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}

export async function signInWithGoogle() {
  if (useEmulator) {
    // 에뮬레이터: 가짜 구글 계정으로 즉시 로그인 (?as=staff1 이면 다른 계정 — 직원 화면 시험용)
    const who = (new URLSearchParams(location.search).get('as') || 'owner').replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'owner';
    const fake = JSON.stringify({ sub: `test-${who}`, email: `${who}@example.com`, email_verified: true, name: who === 'owner' ? '테스트 사장님' : `테스트 ${who}` });
    await signInWithCredential(auth, GoogleAuthProvider.credential(fake));
    return;
  }
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
    } else throw e;
  }
}

export {
  onAuthStateChanged, signOut, doc, collection, getDoc, setDoc, updateDoc, onSnapshot, query, where,
  serverTimestamp, writeBatch, storageRef, uploadBytes, getDownloadURL, deleteObject,
};
