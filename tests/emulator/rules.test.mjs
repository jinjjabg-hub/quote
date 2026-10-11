// 보안 규칙 테스트 (Firebase 에뮬레이터 필요: Java 11+)
// 실행: cd tests/rules && npm install && npm test
import test, { before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, collection, getDocs, query, where, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';

let env;
const OWNER = 'ownerUid123';
const OTHER = 'otherUid456';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-quote',
    firestore: { rules: readFileSync('../../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8180 },
    storage: { rules: readFileSync('../../storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'shops', OWNER), { ownerUid: OWNER, templateId: 'move-in-cleaning', name: '반짝', phone: '010' });
    await setDoc(doc(db, 'shops', OWNER, 'private', 'pricing'), { priceTable: { unitPrice: 13000 } });
    await setDoc(doc(db, 'requests', 'r1'), { shopId: OWNER, status: 'sent', quoteId: 'q1', customer: { name: 'a' } });
    await setDoc(doc(db, 'quotes', 'q1'), { shopId: OWNER, requestId: 'r1', status: 'sent', total: 560000 });
  });
});

const guest = () => env.unauthenticatedContext().firestore();
const owner = () => env.authenticatedContext(OWNER).firestore();
const other = () => env.authenticatedContext(OTHER).firestore();

const newRequest = (over = {}) => ({
  shopId: OWNER, templateId: 'move-in-cleaning', status: 'new', quoteId: null,
  customer: { name: '홍길동', phone: '010-1234-5678', region: '서울 송파구' },
  answers: { area: 34, isNew: true }, checklist: { mold: 'yes' }, photos: [{ slot: 'bath', path: 'x' }],
  createdAt: serverTimestamp(), ...over,
});

test('고객: 요청 생성 가능 / 잘못된 요청 거부', async () => {
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'n1'), newRequest()));
  await assertFails(setDoc(doc(guest(), 'requests', 'n2'), newRequest({ status: 'confirmed' })));
  await assertFails(setDoc(doc(guest(), 'requests', 'n3'), newRequest({ shopId: 'nope' })));
  await assertFails(setDoc(doc(guest(), 'requests', 'n4'), newRequest({ hack: 1 })));
});

test('고객: 요청·단가표 읽기 불가, 업체 공개정보 읽기 가능', async () => {
  await assertFails(getDoc(doc(guest(), 'requests', 'r1')));
  await assertFails(getDoc(doc(guest(), 'shops', OWNER, 'private', 'pricing')));
  await assertSucceeds(getDoc(doc(guest(), 'shops', OWNER)));
});

test('고객: 견적서 단건 읽기 O, 목록 X', async () => {
  await assertSucceeds(getDoc(doc(guest(), 'quotes', 'q1')));
  await assertFails(getDocs(collection(guest(), 'quotes')));
});

test('고객: 예약 요청(상태만 변경) O, 금액 변경 X', async () => {
  const db = guest();
  await assertFails(updateDoc(doc(db, 'quotes', 'q1'), { total: 1 }));
  await assertFails(updateDoc(doc(db, 'quotes', 'q1'), { status: 'confirmed' }));
  const b = writeBatch(db);
  const patch = { status: 'booking_requested', bookingRequestedAt: serverTimestamp() };
  b.update(doc(db, 'quotes', 'q1'), patch);
  b.update(doc(db, 'requests', 'r1'), patch);
  await assertSucceeds(b.commit());
  // 두 번째 요청은 sent 상태가 아니므로 거부
  await assertFails(updateDoc(doc(db, 'quotes', 'q1'), patch));
});

test('사장님: 내 요청 목록 O, 남의 것 X', async () => {
  await assertSucceeds(getDocs(query(collection(owner(), 'requests'), where('shopId', '==', OWNER))));
  await assertFails(getDocs(query(collection(other(), 'requests'), where('shopId', '==', OWNER))));
  await assertFails(getDoc(doc(other(), 'shops', OWNER, 'private', 'pricing')));
  await assertFails(updateDoc(doc(other(), 'shops', OWNER), { name: '탈취' }));
});

test('사장님: 견적 발송(배치) O, 남의 요청으로 견적 생성 X', async () => {
  const db = owner();
  const b = writeBatch(db);
  b.set(doc(db, 'quotes', 'q2'), { shopId: OWNER, requestId: 'r1', status: 'sent', total: 1 });
  b.update(doc(db, 'requests', 'r1'), { status: 'sent', quoteId: 'q2' });
  await assertSucceeds(b.commit());
  await assertFails(setDoc(doc(other(), 'quotes', 'q3'), { shopId: OTHER, requestId: 'r1', status: 'sent' }));
});

test('사장님: 업체 최초 생성은 본인 uid 로만', async () => {
  await assertSucceeds(setDoc(doc(other(), 'shops', OTHER), { ownerUid: OTHER, templateId: 'move-in-cleaning', name: '' }));
  await assertFails(setDoc(doc(other(), 'shops', 'someoneElse'), { ownerUid: OTHER, templateId: 'move-in-cleaning' }));
});

test('Storage: 고객 사진 업로드 O, 읽기 X, 사장님 읽기 O', async () => {
  const img = new Uint8Array([1, 2, 3]);
  const path = `requests/${OWNER}/n1/bath.jpg`;
  await assertSucceeds(uploadBytes(ref(env.unauthenticatedContext().storage(), path), img, { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(), path), img, { contentType: 'image/jpeg' })); // 덮어쓰기
  await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(), `requests/${OWNER}/n1/a.txt`), img, { contentType: 'text/plain' }));
  await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), path)));
  await assertSucceeds(getBytes(ref(env.authenticatedContext(OWNER).storage(), path)));
});
