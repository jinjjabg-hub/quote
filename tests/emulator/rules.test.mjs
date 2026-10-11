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
  consent: { version: 'consent-v1', at: serverTimestamp() },
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

test('결제: payment 필드·payments 컬렉션은 서버만 쓴다 (고객·사장님 모두 X)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'payments', 'D-q1-abc'), { shopId: OWNER, quoteId: 'q1', amount: 112000, status: 'paid' });
  });
  // 고객: 결제완료 상태·결제 기록 위조 X
  await assertFails(updateDoc(doc(guest(), 'quotes', 'q1'), { status: 'paid_deposit' }));
  await assertFails(updateDoc(doc(guest(), 'quotes', 'q1'), { payment: { deposit: { amount: 1 } } }));
  await assertFails(setDoc(doc(guest(), 'payments', 'D-q1-xyz'), { shopId: OWNER, status: 'paid' }));
  await assertFails(getDoc(doc(guest(), 'payments', 'D-q1-abc')));
  // 사장님: 자기 결제 기록 읽기 O, 쓰기 X, quotes.payment 수정 X, 일반 상태 변경은 그대로 O
  await assertSucceeds(getDoc(doc(owner(), 'payments', 'D-q1-abc')));
  await assertSucceeds(getDocs(query(collection(owner(), 'payments'), where('shopId', '==', OWNER))));
  await assertFails(getDoc(doc(other(), 'payments', 'D-q1-abc')));
  await assertFails(updateDoc(doc(owner(), 'payments', 'D-q1-abc'), { status: 'canceled' }));
  await assertFails(updateDoc(doc(owner(), 'quotes', 'q1'), { payment: { deposit: { amount: 1 } } }));
  await assertFails(setDoc(doc(owner(), 'quotes', 'q9'), { shopId: OWNER, requestId: 'r1', status: 'sent', payment: {} }));
  await assertSucceeds(updateDoc(doc(owner(), 'quotes', 'q1'), { status: 'hold' }));
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


// ===================== 2차 =====================

test('동의(S3): consent 없거나 시각 위조면 요청 거부', async () => {
  const { consent, ...noConsent } = newRequest();
  await assertFails(setDoc(doc(guest(), 'requests', 'c1'), noConsent));
  await assertFails(setDoc(doc(guest(), 'requests', 'c2'), newRequest({ consent: { version: 'consent-v1', at: new Date('2020-01-01') } })));
  await assertFails(setDoc(doc(guest(), 'requests', 'c2b'), newRequest({ consent: { version: 'whatever', at: serverTimestamp() } })));
  await assertFails(setDoc(doc(guest(), 'requests', 'c3'), newRequest({ consent: { version: '', at: serverTimestamp() } })));
  await assertFails(setDoc(doc(guest(), 'requests', 'c4'), newRequest({ consent: { version: 'v1', at: serverTimestamp(), extra: 1 } })));
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'c5'), newRequest()));
});

test('다업종: 업체 업종(templateIds) 중 하나로만 요청, 기존 단일 업체는 templateId', async () => {
  await assertFails(setDoc(doc(guest(), 'requests', 't1'), newRequest({ templateId: 'moving' })));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'shops', OWNER), { templateIds: ['move-in-cleaning', 'moving'] });
  });
  await assertSucceeds(setDoc(doc(guest(), 'requests', 't2'), newRequest({ templateId: 'moving' })));
  await assertFails(setDoc(doc(guest(), 'requests', 't3'), newRequest({ templateId: 'curtain' })));
  // 사장님 업종 설정: 목록 첫 값 = templateId, 알려진 7개만
  await assertSucceeds(updateDoc(doc(owner(), 'shops', OWNER), { templateId: 'moving', templateIds: ['moving', 'curtain'] }));
  await assertFails(updateDoc(doc(owner(), 'shops', OWNER), { templateId: 'moving', templateIds: ['curtain', 'moving'] }));
  await assertFails(updateDoc(doc(owner(), 'shops', OWNER), { templateId: 'moving', templateIds: ['moving', 'hack'] }));
});

test('L7: answers 문자열 길이·체크리스트 값·사진 장수 상한', async () => {
  await assertFails(setDoc(doc(guest(), 'requests', 'l1'), newRequest({ answers: { memo: 'x'.repeat(200000) } })));
  await assertFails(setDoc(doc(guest(), 'requests', 'l2'), newRequest({ answers: { extras: ['x'.repeat(500)] } })));
  await assertFails(setDoc(doc(guest(), 'requests', 'l3'), newRequest({ answers: { windowSizes: 'x'.repeat(501) } })));
  await assertFails(setDoc(doc(guest(), 'requests', 'l3b'), newRequest({ answers: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, 1])) })));
  await assertFails(setDoc(doc(guest(), 'requests', 'l4'), newRequest({ checklist: { mold: 'hack' } })));
  await assertFails(setDoc(doc(guest(), 'requests', 'l4b'), newRequest({ answers: { extras: Array.from({ length: 13 }, (_, i) => `o${i}`) } })));
  const photos = Array.from({ length: 21 }, (_, i) => ({ slot: 'bath', index: 1, shot: `s${i}`, path: 'x' }));
  await assertFails(setDoc(doc(guest(), 'requests', 'l5'), newRequest({ photos })));
  // 최대 크기 정상 요청(답 40칸 + 추가서비스 12개 + 체크리스트 20개)도 규칙 계산 한도(1000식) 안에서 통과해야 한다
  const big = Object.fromEntries(Array.from({ length: 39 }, (_, i) => [`k${i}`, i % 3 === 0 ? 'abc' : i % 3 === 1 ? i : true]));
  big.extras = Array.from({ length: 12 }, (_, i) => `opt${i}`);
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'l7'), newRequest({ answers: big, checklist: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, 'no'])) })));
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'l6'), newRequest({
    answers: { area: 34, isNew: true, memo: '오후 3시 이후', extras: ['window', 'sickHouse'], date: '2026-10-14', rooms: 3 },
    photos: photos.slice(0, 20),
  })));
});

test('신원: bizVerified 등은 클라이언트가 못 쓰고, 인증 후 상호·사업자번호는 못 바꾼다', async () => {
  const db = owner();
  // 인증 전: 상호·번호 수정 O, 인증 필드 위조 X
  await assertSucceeds(updateDoc(doc(db, 'shops', OWNER), { name: '반짝2', bizNo: '124-81-00998' }));
  await assertFails(updateDoc(doc(db, 'shops', OWNER), { bizVerified: true }));
  await assertFails(updateDoc(doc(db, 'shops', OWNER), { identityHistory: [] }));
  await assertFails(updateDoc(doc(db, 'shops', OWNER), { bizVerifiedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(other(), 'shops', OTHER), { ownerUid: OTHER, templateId: 'move-in-cleaning', bizVerified: true }));
  // 서버가 인증 완료 기록
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'shops', OWNER), { bizVerified: true, bizVerifiedAt: new Date(), identityHistory: [] });
  });
  await assertFails(updateDoc(doc(db, 'shops', OWNER), { name: '바꿔치기' }));
  await assertFails(updateDoc(doc(db, 'shops', OWNER), { bizNo: '220-81-62517' }));
  await assertFails(updateDoc(doc(db, 'shops', OWNER), { bizVerified: false }));
  // 다른 필드는 계속 수정 가능
  await assertSucceeds(updateDoc(doc(db, 'shops', OWNER), { phone: '010-9999-0000', ownerName: '김사장' }));
});

test('bizNos: 클라이언트 읽기·쓰기 모두 불가', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'bizNos', '1248100998'), { uid: OWNER, verifiedAt: new Date() });
  });
  await assertFails(getDoc(doc(owner(), 'bizNos', '1248100998')));
  await assertFails(getDoc(doc(guest(), 'bizNos', '1248100998')));
  await assertFails(setDoc(doc(other(), 'bizNos', '2208162517'), { uid: OTHER }));
  await assertFails(updateDoc(doc(owner(), 'bizNos', '1248100998'), { uid: OWNER }));
});

test('M9: 결제된 견적은 사장님도 금액·조건·규정을 못 바꾼다 (상태는 가능)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'quotes', 'q1'), { payment: { deposit: { amount: 56000, status: 'paid' } }, status: 'paid_deposit' });
  });
  const db = owner();
  for (const patch of [{ total: 1 }, { lines: [] }, { deposit: 0 }, { conditions: [] }, { included: [] },
    { excluded: [] }, { cancelPolicy: '환불 불가' }, { depositPct: 50 }, { number: 'Q-HACK' }, { refundRules: [] }]) {
    await assertFails(updateDoc(doc(db, 'quotes', 'q1'), patch));
  }
  await assertSucceeds(updateDoc(doc(db, 'quotes', 'q1'), { status: 'hold' }));
  await assertSucceeds(updateDoc(doc(db, 'quotes', 'q1'), { status: 'paid_deposit' }));
  // 결제 없는 견적은 기존처럼 수정 가능
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'quotes', 'q5'), { shopId: OWNER, requestId: 'r1', status: 'sent', total: 1000 });
  });
  await assertSucceeds(updateDoc(doc(db, 'quotes', 'q5'), { total: 2000, conditions: [{ label: 'a', text: 'b', amount: 1000 }], refundRules: [{ daysBefore: 3, pct: 100 }] }));
});

test('Storage: 사진 파일 이름은 {칸}-{1~6}-{컷}.jpg 또는 {칸}.jpg', async () => {
  const img = new Uint8Array([1, 2, 3]);
  const st = () => env.unauthenticatedContext().storage();
  await assertSucceeds(uploadBytes(ref(st(), `requests/${OWNER}/n2/bath-2-wide.jpg`), img, { contentType: 'image/jpeg' }));
  await assertSucceeds(uploadBytes(ref(st(), `requests/${OWNER}/n2/kitchen.jpg`), img, { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(st(), `requests/${OWNER}/n2/bath-9-wide.jpg`), img, { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(st(), `requests/${OWNER}/n2/../x.jpg`), img, { contentType: 'image/jpeg' }).catch((e) => { throw e; }));
  await assertFails(uploadBytes(ref(st(), `requests/${OWNER}/n2/big.jpg`), new Uint8Array(3 * 1024 * 1024 + 1), { contentType: 'image/jpeg' }));
});
