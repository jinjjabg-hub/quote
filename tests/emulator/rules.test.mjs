// 보안 규칙 테스트 (Firebase 에뮬레이터 필요: Java 11+)
// 실행: cd tests/rules && npm install && npm test
import test, { before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, collection, getDocs, query, where, serverTimestamp, writeBatch, Timestamp } from 'firebase/firestore';
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
  createdAt: serverTimestamp(), consentAt: serverTimestamp(), ...over,
});

test('고객: 요청 생성 가능 / 잘못된 요청 거부', async () => {
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'n1'), newRequest()));
  await assertFails(setDoc(doc(guest(), 'requests', 'n2'), newRequest({ status: 'confirmed' })));
  await assertFails(setDoc(doc(guest(), 'requests', 'n3'), newRequest({ shopId: 'nope' })));
  await assertFails(setDoc(doc(guest(), 'requests', 'n4'), newRequest({ hack: 1 })));
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'n5'), newRequest({ test: true })));
  await assertFails(setDoc(doc(guest(), 'requests', 'n6'), newRequest({ test: 'yes' })));
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'n7'), newRequest({ source: 'phone' })));
  await assertFails(setDoc(doc(guest(), 'requests', 'n8'), newRequest({ source: 'kakao' })));
  // 개인정보 수집·이용 동의(consentAt) 없이는 요청을 만들 수 없다
  const { consentAt, ...noConsent } = newRequest();
  await assertFails(setDoc(doc(guest(), 'requests', 'n9'), noConsent));
  await assertFails(setDoc(doc(guest(), 'requests', 'n10'), newRequest({ consentAt: Timestamp.fromMillis(Date.now() - 60000) })));
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

test('요금: 무료 견적을 다 쓰면(canSend=false) 새 견적서 X, 테스트 견적·보낸 견적 수정은 O, 요금 문서는 화면에서 읽기·쓰기 X', async () => {
  const db = owner();
  const state = doc(db, 'shops', OWNER, 'billing', 'state');
  await assertFails(setDoc(state, { canSend: true }));
  await assertFails(getDoc(state));
  await assertFails(getDoc(doc(db, 'shops', OWNER, 'billing', 'secret')));
  await assertFails(setDoc(doc(db, 'subscriptions', OWNER), { status: 'active' }));
  const q = (id, over = {}) => setDoc(doc(db, 'quotes', id), { shopId: OWNER, requestId: 'r1', status: 'sent', total: 1, ...over });
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'shops', OWNER, 'billing', 'state'), { used: 3, canSend: true }));
  await assertSucceeds(q('q10'));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'shops', OWNER, 'billing', 'state'), { used: 10, canSend: false }));
  await assertFails(q('q11'));
  // 테스트 견적은 테스트 요청에만. 실제 고객 요청(r1)에 test 견적을 만들어 한도를 피할 수 없다
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'requests', 'rt'), { shopId: OWNER, status: 'new', test: true, customer: { name: 't' } }));
  await assertSucceeds(q('q12', { test: true, requestId: 'rt' }));
  await assertFails(q('q13', { test: true }));
  await assertFails(q('q14', { requestId: 'rt' }), '테스트 요청에 실제 견적(test 없음)도 X');
  await assertSucceeds(updateDoc(doc(db, 'quotes', 'q1'), { total: 570000 }));
});

test('요금: 보낸 견적서를 다른 요청용으로 고쳐 쓰거나 test 표시를 바꿀 수 없다', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    await setDoc(doc(a, 'requests', 'r2'), { shopId: OWNER, status: 'new', customer: { name: 'b' } });
    await setDoc(doc(a, 'requests', 'rt'), { shopId: OWNER, status: 'sent', test: true, customer: { name: 't' } });
    await setDoc(doc(a, 'quotes', 'qt'), { shopId: OWNER, requestId: 'rt', status: 'sent', total: 1, test: true });
  });
  const db = owner();
  await assertFails(updateDoc(doc(db, 'quotes', 'q1'), { requestId: 'r2' }));
  await assertFails(updateDoc(doc(db, 'quotes', 'q1'), { test: true }));
  await assertFails(updateDoc(doc(db, 'quotes', 'qt'), { test: false }));
  await assertFails(updateDoc(doc(db, 'requests', 'r1'), { test: true }), '요청의 test 표시도 고정');
  await assertFails(updateDoc(doc(db, 'requests', 'rt'), { test: false }));
  // 다시 보내기(같은 요청·같은 표시로 통째로 덮어쓰기)는 된다
  await assertSucceeds(setDoc(doc(db, 'quotes', 'q1'), { shopId: OWNER, requestId: 'r1', status: 'sent', total: 600000 }));
  await assertSucceeds(updateDoc(doc(db, 'requests', 'r1'), { status: 'hold' }));
});

test('사장님: 만두 ID 형식 검사', async () => {
  const base = { ownerUid: OTHER, templateId: 'move-in-cleaning', name: '' };
  await assertSucceeds(setDoc(doc(other(), 'shops', OTHER), { ...base, manduId: 'banjjak_1' }));
  await assertSucceeds(setDoc(doc(other(), 'shops', OTHER), { ...base, manduId: '' }));
  await assertFails(setDoc(doc(other(), 'shops', OTHER), { ...base, manduId: 'javascript:alert(1)' }));
});

test('사장님: 한 줄 소개·서비스 지역 저장 O, 60자 초과 X', async () => {
  const base = { ownerUid: OTHER, templateId: 'move-in-cleaning', name: '' };
  await assertSucceeds(setDoc(doc(other(), 'shops', OTHER), { ...base, intro: '10년 경력 직영팀', serviceArea: '부산 전 지역' }));
  await assertFails(setDoc(doc(other(), 'shops', OTHER), { ...base, intro: 'x'.repeat(61) }));
});

test('사장님: 내부 메모(ownerMemo) 저장 O, 남의 요청 X', async () => {
  await assertSucceeds(updateDoc(doc(owner(), 'requests', 'r1'), { ownerMemo: '주차 확인' }));
  await assertFails(updateDoc(doc(other(), 'requests', 'r1'), { ownerMemo: '탈취' }));
});

test('사장님: 업체 최초 생성은 본인 uid 로만', async () => {
  await assertSucceeds(setDoc(doc(other(), 'shops', OTHER), { ownerUid: OTHER, templateId: 'move-in-cleaning', name: '' }));
  await assertFails(setDoc(doc(other(), 'shops', 'someoneElse'), { ownerUid: OTHER, templateId: 'move-in-cleaning' }));
});

// ---------- 직원 (설계도 10-1장) ----------
const STAFF_UID = 'staffUid789';
const staffCtx = () => env.authenticatedContext(STAFF_UID).firestore();
const TOKEN = 'Abcdefghijkmnopqrstuvwx';
const staffDoc = (db, id = 's1') => doc(db, 'shops', OWNER, 'staff', id);
const newStaff = (over = {}) => ({ name: '김정규', phone: '010-1111-2222', type: 'employee', weeklyOff: [1, 2], offDates: [], availDates: [], active: true, inviteToken: TOKEN, uid: null, ...over });

test('직원: 사장님만 등록·수정·삭제, 남의 업체·형식 오류 거부', async () => {
  await assertSucceeds(setDoc(staffDoc(owner()), newStaff()));
  await assertFails(setDoc(staffDoc(other(), 's2'), newStaff()));
  await assertFails(setDoc(staffDoc(owner(), 's3'), newStaff({ type: 'boss' })));
  await assertFails(setDoc(staffDoc(owner(), 's4'), newStaff({ inviteToken: 'short' })));
  await assertFails(setDoc(staffDoc(owner(), 's5'), newStaff({ salary: 1 })));
  await assertSucceeds(updateDoc(staffDoc(owner()), { weeklyOff: [0, 6] }));
  await assertFails(getDoc(staffDoc(other())));
});

test('직원: 초대 값이 맞을 때만 자기 계정 연결, 연결 후 자기 문서만 읽고 휴무일·가능일만 수정', async () => {
  await assertSucceeds(setDoc(staffDoc(owner()), newStaff()));
  await assertFails(getDoc(staffDoc(staffCtx())), '연결 전에는 못 읽음');
  await assertFails(updateDoc(staffDoc(staffCtx()), { uid: STAFF_UID, inviteProof: 'wrong-token-xxxxxxxx', linkedAt: serverTimestamp() }));
  await assertFails(updateDoc(staffDoc(staffCtx()), { uid: 'someoneElse', inviteProof: TOKEN, linkedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(staffDoc(staffCtx()), { uid: STAFF_UID, inviteProof: TOKEN, linkedAt: serverTimestamp() }));
  await assertFails(updateDoc(staffDoc(other()), { uid: OTHER, inviteProof: TOKEN, linkedAt: serverTimestamp() }), '이미 연결되면 가로채기 불가');
  await assertSucceeds(getDoc(staffDoc(staffCtx())));
  await assertSucceeds(updateDoc(staffDoc(staffCtx()), { offDates: ['2026-11-04'], updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(staffDoc(staffCtx()), { weeklyOff: [] }), '정기 휴무는 사장님만');
  await assertFails(updateDoc(staffDoc(staffCtx()), { name: '사장' }));
  await assertFails(updateDoc(staffDoc(staffCtx()), { type: 'freelancer' }));
  await assertSucceeds(setDoc(staffDoc(owner(), 's2'), newStaff({ name: '이정규' })));
  await assertFails(getDoc(staffDoc(staffCtx(), 's2')), '다른 직원 문서는 못 읽음');
});

test('일정: 사장님만 읽고 씀, 형식 검사 (직원·남은 못 읽음)', async () => {
  const j = { date: '2026-11-04', start: '09:00', hours: 4.5, crew: 2, staffIds: [], title: '입주청소 34평', place: '부산 수영구', customer: '김고객', phone: '010', memo: '', source: 'phone', status: 'scheduled' };
  const ref = (db, id = 'j1') => doc(db, 'shops', OWNER, 'jobs', id);
  await assertSucceeds(setDoc(ref(owner()), j));
  await assertFails(setDoc(ref(owner(), 'j2'), { ...j, start: '9시' }));
  await assertFails(setDoc(ref(owner(), 'j3'), { ...j, crew: 0 }));
  await assertFails(setDoc(ref(owner(), 'j4'), { ...j, source: 'hack' }));
  await assertFails(setDoc(ref(owner(), 'j5'), { ...j, price: 1 }));
  await assertSucceeds(updateDoc(ref(owner()), { staffIds: ['s1', 's2'] }));
  await assertFails(getDoc(ref(other())));
  await assertFails(setDoc(ref(other(), 'j6'), j));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'shops', OWNER, 'staff', 's1'), newStaff({ uid: STAFF_UID })));
  await assertFails(getDoc(ref(staffCtx())), '직원 열람은 아직 닫혀 있음');
});

test('알림: 직원은 자기 기기 토큰(최대 5개)만 저장, 알림 기록(jobNotices)은 아무도 못 읽고 못 씀', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'shops', OWNER, 'staff', 'p1'), newStaff({ uid: STAFF_UID })));
  const ref = (db) => doc(db, 'shops', OWNER, 'staff', 'p1');
  await assertSucceeds(updateDoc(ref(staffCtx()), { pushTokens: ['tok1'] }));
  await assertFails(updateDoc(ref(staffCtx()), { pushTokens: ['1', '2', '3', '4', '5', '6'] }));
  await assertFails(updateDoc(ref(other()), { pushTokens: ['x'] }));
  await assertSucceeds(updateDoc(ref(owner()), { pushTokens: [] }), '사장님은 직원 문서 전체 수정 가능');
  const note = (db) => doc(db, 'shops', OWNER, 'jobNotices', 'j1');
  await assertFails(getDoc(note(owner())));
  await assertFails(setDoc(note(owner()), { staff: {} }));
  await assertFails(getDoc(note(staffCtx())));
});

test('Storage: 고객 사진 업로드 O, 읽기 X, 사장님 읽기 O', async () => {
  const img = new Uint8Array([1, 2, 3]);
  const path = `requests/${OWNER}/n1/bath.jpg`;
  // 고객 화면 순서: 요청 문서(사진 목록 포함)를 먼저 만든 뒤 사진을 올린다
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'n1'), newRequest({ photos: [{ slot: 'bath', path }, { slot: 'a', path: `requests/${OWNER}/n1/a.txt` }] })));
  await assertSucceeds(uploadBytes(ref(env.unauthenticatedContext().storage(), path), img, { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(), path), img, { contentType: 'image/jpeg' })); // 덮어쓰기
  await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(), `requests/${OWNER}/n1/a.txt`), img, { contentType: 'text/plain' }));
  await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), path)));
  await assertSucceeds(getBytes(ref(env.authenticatedContext(OWNER).storage(), path)));
});

test('Storage: 요청 문서에 적힌 사진만 · 신규 요청만 · 30분 안에만 업로드', async () => {
  const img = new Uint8Array([1, 2, 3]);
  const up = (p) => uploadBytes(ref(env.unauthenticatedContext().storage(), p), img, { contentType: 'image/jpeg' });
  const p = (req, file, shop = OWNER) => `requests/${shop}/${req}/${file}`;
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'm1'), newRequest({ photos: [{ slot: 'bath', path: p('m1', 'bath.jpg') }] })));
  await assertFails(up(p('m1', 'kitchen.jpg')), '목록에 없는 사진 X');
  await assertFails(up(p('nope', 'bath.jpg')), '없는 요청 X');
  await assertFails(up(p('m1', 'bath.jpg', OTHER)), '다른 업체 경로 X');
  await assertSucceeds(up(p('m1', 'bath.jpg')));
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'requests', 'm2'), { shopId: OWNER, status: 'sent', createdAt: Timestamp.now(), photos: [{ slot: 'bath', path: p('m2', 'bath.jpg') }] });
    await setDoc(doc(db, 'requests', 'm3'), { shopId: OWNER, status: 'new', createdAt: Timestamp.fromMillis(Date.now() - 31 * 60000), photos: [{ slot: 'bath', path: p('m3', 'bath.jpg') }] });
  });
  await assertFails(up(p('m2', 'bath.jpg')), '신규가 아닌 요청 X');
  await assertFails(up(p('m3', 'bath.jpg')), '30분 지난 요청 X');
});
