// 사업자 인증·업체 신원 변경 규칙 (docs/round2/contract.md "업체 신원")
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBizNo, isValidBizNo, formatBizNo, parseNtsStatus, canChangeIdentity, planVerify, planIdentityUpdate,
  normalizeShopName, historyEntry, hasServiceKey, IDENTITY_CHANGE_DAYS, BIZ_TAKEN_MESSAGE, tooSoonMessage,
} from '../lib/biz.js';
import { checkBusinessStatus, NtsError } from '../lib/nts.js';

const VALID = '1248100998'; // 공개된 대기업 사업자번호 (체크섬 예시)
/** 앞 9자리로 체크 숫자를 붙여 유효 번호 생성 */
function makeValid(nine) {
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const d = [...nine].map(Number);
  let s = d.reduce((acc, x, i) => acc + x * w[i], 0) + Math.floor((d[8] * 5) / 10);
  return nine + String((10 - (s % 10)) % 10);
}
const VALID2 = makeValid('220811234');
const NOW = new Date('2026-10-11T03:00:00Z');

test('체크섬: 가중치 1,3,7,1,3,7,1,3,5 + 9번째×5 의 10의 자리', () => {
  assert.equal(isValidBizNo(VALID), true);
  assert.equal(isValidBizNo('124-81-00998'), true);
  assert.equal(isValidBizNo(' 124 81 00998 '), true);
  assert.equal(isValidBizNo('1248100999'), false);
  assert.equal(isValidBizNo('124810099'), false);
  assert.equal(isValidBizNo('12481009981'), false);
  assert.equal(isValidBizNo('abcdefghij'), false);
  assert.equal(isValidBizNo(null), false);
  assert.equal(isValidBizNo(VALID2), true);
  // 9번째 자리 × 5 의 올림 부분이 결과를 바꾸는 경우까지 확인 (모든 끝자리 중 정확히 하나만 유효)
  for (const nine of ['000000009', '999999999', '123456789', '220811234']) {
    const ok = [...'0123456789'].filter((c) => isValidBizNo(nine + c));
    assert.equal(ok.length, 1, nine);
  }
  assert.equal(normalizeBizNo('124-81-00998'), VALID);
  assert.equal(normalizeBizNo('12-34'), null);
  assert.equal(formatBizNo(VALID), '124-81-00998');
});

test('클라이언트 js/util.js isValidBizNo 와 같은 결과', async (t) => {
  let util;
  try { util = await import('../../js/util.js'); } catch (e) { t.skip(e.message); return; }
  if (typeof util.isValidBizNo !== 'function') { t.skip('js/util.js 에 isValidBizNo 없음'); return; }
  const samples = [VALID, '124-81-00998', '1248100999', VALID2, '0000000000', '9999999999', '123', ''];
  for (let i = 0; i < 300; i += 1) samples.push(String(1_000_000_000 + ((i * 7_919_773) % 8_999_999_999)).padStart(10, '0'));
  for (const s of samples) assert.equal(util.isValidBizNo(s), isValidBizNo(s), s);
});

test('국세청 응답: 계속사업자(01)만 통과', () => {
  const res = (row) => ({ status_code: 'OK', request_cnt: 1, match_cnt: 1, data: [{ b_no: VALID, ...row }] });
  assert.deepEqual(parseNtsStatus(res({ b_stt: '계속사업자', b_stt_cd: '01', tax_type: '부가가치세 일반과세자' }), VALID),
    { ok: true, code: '01', taxType: '부가가치세 일반과세자' });
  assert.equal(parseNtsStatus(res({ b_stt: '휴업자', b_stt_cd: '02' }), VALID).code, 'nts_02');
  assert.equal(parseNtsStatus(res({ b_stt: '폐업자', b_stt_cd: '03' }), VALID).code, 'nts_03');
  assert.equal(parseNtsStatus(res({ b_stt: '', b_stt_cd: '', tax_type: '국세청에 등록되지 않은 사업자등록번호입니다.' }), VALID).code, 'nts_unregistered');
  assert.equal(parseNtsStatus({ status_code: 'BAD_JSON_REQUEST' }, VALID).code, 'nts_error');
  assert.equal(parseNtsStatus(null, VALID).ok, false);
  assert.equal(parseNtsStatus(res({ b_no: '0000000000', b_stt_cd: '01' }), VALID).ok, false); // 다른 번호의 결과
});

test('국세청 호출: POST, serviceKey 인코딩, 본문 b_no 배열', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ status_code: 'OK', data: [{ b_no: VALID, b_stt_cd: '01' }] }) };
  };
  const r = await checkBusinessStatus('a+b/c==', VALID, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=a%2Bb%2Fc%3D%3D');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { b_no: [VALID] });
  await assert.rejects(checkBusinessStatus('k', VALID, { fetchImpl: async () => { throw new Error('down'); } }), NtsError);
  await assert.rejects(checkBusinessStatus('k', VALID, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }), NtsError);
});

test('서비스 키 없음 판정 (none/빈칸 → 테스트 모드에서 체크섬만)', () => {
  assert.equal(hasServiceKey(''), false);
  assert.equal(hasServiceKey(undefined), false);
  assert.equal(hasServiceKey('none'), false);
  assert.equal(hasServiceKey('abc123'), true);
});

test('30일 변경 제한', () => {
  assert.equal(IDENTITY_CHANGE_DAYS, 30);
  assert.equal(canChangeIdentity(null, NOW).ok, true);
  const r = canChangeIdentity(new Date('2026-10-01T03:00:00Z'), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.nextAt, '2026-10-31T03:00:00.000Z');
  assert.equal(canChangeIdentity(new Date('2026-09-11T03:00:00Z'), NOW).ok, true); // 정확히 30일
  assert.equal(canChangeIdentity({ toDate: () => new Date('2026-10-10T00:00:00Z') }, NOW).ok, false); // Firestore Timestamp
});

test('verifyBusiness 판단', () => {
  assert.equal(planVerify({ name: 'A' }, { bizNo: '1248100999' }).code, 'invalid_biz_no');
  assert.equal(planVerify(null, { bizNo: VALID }).code, 'no_shop');
  assert.deepEqual(planVerify({ name: 'A' }, { bizNo: '124-81-00998' }), { ok: true, bizNo: VALID });
  assert.equal(planVerify({ bizVerified: true, bizNo: VALID }, { bizNo: VALID }).already, true);
  const other = planVerify({ bizVerified: true, bizNo: VALID }, { bizNo: VALID2 });
  assert.equal(other.code, 'use_update');
  assert.equal(other.status, 409);
});

test('updateIdentity 판단: 인증 후에만, 30일 1회, 번호 바꾸면 재인증', () => {
  const shop = { name: '반짝청소', bizNo: VALID, bizVerified: true };
  assert.equal(planIdentityUpdate({ ...shop, bizVerified: false }, { name: 'B' }, NOW).code, 'not_verified');
  assert.equal(planIdentityUpdate(shop, { name: '반짝청소' }, NOW).code, 'no_change');
  assert.equal(planIdentityUpdate(shop, { name: '   ' }, NOW).code, 'no_change'); // 빈 값은 "안 바꿈"
  assert.equal(planIdentityUpdate(shop, { name: 'x'.repeat(61) }, NOW).code, 'invalid_name');
  assert.equal(planIdentityUpdate(shop, { bizNo: '1248100999' }, NOW).code, 'invalid_biz_no');
  // 화면이 저장한 하이픈 형식 번호도 같은 번호로 본다
  assert.equal(planIdentityUpdate({ ...shop, bizNo: '124-81-00998' }, { bizNo: VALID }, NOW).code, 'no_change');
  const nameOnly = planIdentityUpdate(shop, { name: ' 반짝  청소 ' }, NOW);
  assert.deepEqual(nameOnly, { ok: true, name: '반짝 청소', bizNo: VALID, nameChanged: true, bizNoChanged: false });
  const biz = planIdentityUpdate(shop, { bizNo: VALID2 }, NOW);
  assert.equal(biz.bizNoChanged, true);
  assert.equal(biz.nameChanged, false);
  const soon = planIdentityUpdate({ ...shop, identityChangedAt: new Date('2026-10-01T00:00:00Z') }, { name: 'B' }, NOW);
  assert.equal(soon.code, 'too_soon');
  assert.equal(soon.status, 409);
  assert.equal(soon.nextAt, '2026-10-31T00:00:00.000Z');
  assert.equal(planIdentityUpdate(null, { name: 'B' }, NOW).code, 'no_shop');
});

test('이력 1줄 모양', () => {
  const at = new Date('2026-10-11T00:00:00Z');
  assert.deepEqual(historyEntry({ kind: 'update', name: 'B', bizNo: VALID, prevName: 'A', at }),
    { kind: 'update', name: 'B', bizNo: VALID, prevName: 'A', prevBizNo: null, mode: null, at });
  assert.equal(normalizeShopName('  a   b '), 'a b');
  assert.equal(normalizeShopName(''), null);
});

test('오류 문구 = legal copy-snippets.md §5', () => {
  assert.equal(BIZ_TAKEN_MESSAGE, '이 사업자번호는 이미 다른 계정에 등록되어 있어요. 본인 사업자인데 등록한 적이 없다면 고객센터로 알려주세요.');
  assert.equal(tooSoonMessage('2026-10-31T16:00:00.000Z'), '업체명·사업자번호는 30일에 한 번만 바꿀 수 있어요. 2026-11-01부터 다시 바꿀 수 있어요.'); // KST
  assert.equal(planIdentityUpdate({ name: 'A', bizNo: VALID, bizVerified: true, identityChangedAt: new Date('2026-10-01T00:00:00Z') }, { name: 'B' }, NOW).message,
    tooSoonMessage('2026-10-31T00:00:00.000Z'));
});
