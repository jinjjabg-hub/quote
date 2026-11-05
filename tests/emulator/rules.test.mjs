// 보안 규칙 테스트 (Firebase 에뮬레이터 필요: Java 11+)
// 실행: cd tests/rules && npm install && npm test
import test, { before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, collection, getDocs, query, where, serverTimestamp, writeBatch, increment, Timestamp } from 'firebase/firestore';
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
    await setDoc(doc(db, 'shops', OWNER, 'billing', 'plan'), { plan: 'team' }); // 기존 테스트는 팀 요금제로 (무료는 아래 요금제 테스트에서)
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
  await assertSucceeds(setDoc(doc(guest(), 'requests', 'n5'), newRequest({ test: true })));
  await assertFails(setDoc(doc(guest(), 'requests', 'n6'), newRequest({ test: 'yes' })));
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
  b.set(doc(db, 'shops', OWNER, 'usage', thisMonth()), { sent: increment(1) }, { merge: true });
  await assertSucceeds(b.commit());
  await assertFails(setDoc(doc(other(), 'quotes', 'q3'), { shopId: OTHER, requestId: 'r1', status: 'sent' }));
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

// 한국 시간 기준 이번 달 (규칙과 같은 계산)
function thisMonth() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const ADMIN = 'adminUid789';
const admin = () => env.authenticatedContext(ADMIN).firestore();
const setPlan = (plan) => env.withSecurityRulesDisabled((ctx) => (plan
  ? setDoc(doc(ctx.firestore(), 'shops', OWNER, 'billing', 'plan'), plan)
  : import('firebase/firestore').then(({ deleteDoc }) => deleteDoc(doc(ctx.firestore(), 'shops', OWNER, 'billing', 'plan')))));
// 새 요청 + 견적서 생성 배치 (사장님 화면의 sendQuote 와 같은 모양)
async function sendNew(id, { test = false, count = true } = {}) {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'requests', `r_${id}`), { shopId: OWNER, status: 'new', customer: { name: 'a' } }));
  const db = owner();
  const b = writeBatch(db);
  b.set(doc(db, 'quotes', `q_${id}`), { shopId: OWNER, requestId: `r_${id}`, status: 'sent', total: 1, test });
  b.update(doc(db, 'requests', `r_${id}`), { status: 'sent', quoteId: `q_${id}` });
  if (count) b.set(doc(db, 'shops', OWNER, 'usage', thisMonth()), { sent: increment(1), updatedAt: serverTimestamp() }, { merge: true });
  return b.commit();
}

test('요금제: 무료는 이번 달 견적 5건까지, 6번째는 거절. 테스트 견적·재발송은 안 셈', async () => {
  await setPlan(null); // 문서 없음 = 무료
  for (let i = 1; i <= 5; i += 1) await assertSucceeds(sendNew(`f${i}`));
  await assertFails(sendNew('f6'), '무료 6번째');
  await assertSucceeds(sendNew('t1', { test: true, count: false }), '테스트 견적');
  await assertSucceeds(updateDoc(doc(owner(), 'quotes', 'q_f1'), { total: 2 }), '재발송(수정)은 제한 없음');
  await assertFails(sendNew('f7', { count: false }), '발송 수를 안 올리고 만들기 X');
  const u = await getDoc(doc(owner(), 'shops', OWNER, 'usage', thisMonth()));
  assert.equal(u.data().sent, 5);
  await assertFails(updateDoc(doc(owner(), 'shops', OWNER, 'usage', thisMonth()), { sent: 0 }), '줄이기 X');
  await assertFails(setDoc(doc(owner(), 'shops', OWNER, 'usage', '202001'), { sent: 1 }), '지난 달 X');
});

test('요금제: 혼자는 무제한, 만료되면 무료로 돌아감', async () => {
  await setPlan({ plan: 'solo' });
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'shops', OWNER, 'usage', thisMonth()), { sent: 5 }));
  await assertSucceeds(sendNew('s6'));
  await setPlan({ plan: 'solo', until: Timestamp.fromMillis(Date.now() - 1000) });
  await assertFails(sendNew('s7'), '만료 → 무료 → 이미 6건');
});

test('요금제: 팀 기능(직원·일정 저장)은 팀·회사만, 직원 본인 휴무 설정은 요금제와 무관', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'shops', OWNER, 'staff', 'k1'), newStaff({ uid: STAFF_UID })));
  await setPlan({ plan: 'solo' });
  await assertFails(setDoc(doc(owner(), 'shops', OWNER, 'staff', 'k2'), newStaff()), '혼자: 직원 등록 X');
  const j = { date: '2026-11-04', start: '09:00', hours: 4, crew: 2, staffIds: [], title: 't', source: 'phone', status: 'scheduled' };
  await assertFails(setDoc(doc(owner(), 'shops', OWNER, 'jobs', 'j1'), j), '혼자: 일정 저장 X');
  await assertSucceeds(updateDoc(doc(staffCtx(), 'shops', OWNER, 'staff', 'k1'), { offDates: ['2026-11-10'] }), '직원 본인 휴무');
  await assertSucceeds(getDoc(doc(owner(), 'shops', OWNER, 'staff', 'k1')), '내려가도 보기는 가능');
  await setPlan({ plan: 'company' });
  await assertSucceeds(setDoc(doc(owner(), 'shops', OWNER, 'jobs', 'j1'), j));
});

test('요금제: 사장님은 읽기만, 운영자만 바꿈. 운영자는 업체 목록·사용량을 봄', async () => {
  const planRef = (db) => doc(db, 'shops', OWNER, 'billing', 'plan');
  await assertSucceeds(getDoc(planRef(owner())));
  await assertFails(setDoc(planRef(owner()), { plan: 'company' }), '사장님 스스로 올리기 X');
  await assertFails(getDoc(planRef(other())));
  await assertFails(setDoc(planRef(admin()), { plan: 'team' }), '운영자 표시 전');
  await assertFails(getDocs(collection(admin(), 'shops')));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'admins', ADMIN), { name: '운영자' }));
  await assertSucceeds(getDoc(doc(admin(), 'admins', ADMIN)));
  await assertFails(getDoc(doc(owner(), 'admins', ADMIN)), '남의 운영자 표시 못 봄');
  await assertFails(setDoc(doc(owner(), 'admins', OWNER), {}), '스스로 운영자 X');
  await assertSucceeds(setDoc(planRef(admin()), { plan: 'team', until: Timestamp.fromMillis(Date.now() + 86400000), note: '11월 입금', updatedAt: serverTimestamp(), updatedBy: ADMIN }));
  await assertFails(setDoc(planRef(admin()), { plan: 'vip' }), '모르는 요금제');
  await assertFails(setDoc(doc(admin(), 'shops', OWNER, 'billing', 'other'), { plan: 'team' }), 'plan 문서만');
  await assertSucceeds(getDocs(collection(admin(), 'shops')));
  await assertSucceeds(getDoc(doc(admin(), 'shops', OWNER, 'usage', thisMonth())));
  await assertFails(getDocs(collection(owner(), 'shops')), '사장님은 업체 목록 X');
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
