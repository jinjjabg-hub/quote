// 업체 신원(사업자 인증·변경 제한) 순수 규칙 — Firebase·네트워크 의존 없음
//
// 왜 (docs/decisions.md 2026-10-11): 1계정 = 1사업자번호, 업체명·사업자번호 변경은 30일에 1회 + 이력.
//   견적서·결제가 업체명에 묶여 있으므로 "남의 이름으로 견적·결제"를 막는다.
//
// ★ isValidBizNo 는 js/util.js 의 isValidBizNo 와 같은 알고리즘이어야 한다 (test/biz.test.mjs 가 비교)

const WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];
export const IDENTITY_CHANGE_DAYS = 30;
const DAY_MS = 86_400_000;

/** '123-45-67890' → '1234567890' (10자리 숫자가 아니면 null) */
export function normalizeBizNo(v) {
  const d = String(v ?? '').replace(/[\s-]/g, '');
  return /^\d{10}$/.test(d) ? d : null;
}

/**
 * 사업자등록번호 체크섬 (국세청 공개 알고리즘)
 * 앞 9자리 × 가중치 1,3,7,1,3,7,1,3,5 의 합 + (9번째 자리 × 5 의 10의 자리) → 10 - (합 % 10) 의 끝자리 = 10번째 자리
 */
export function isValidBizNo(v) {
  const n = normalizeBizNo(v);
  if (!n) return false;
  const d = [...n].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += d[i] * WEIGHTS[i];
  sum += Math.floor((d[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === d[9];
}

export function formatBizNo(n) {
  const d = normalizeBizNo(n);
  return d ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : '';
}

/** 국세청 상태코드 → 고객(사장님)에게 보여줄 말 */
export const NTS_STATUS_MESSAGE = {
  '01': '계속사업자',
  '02': '휴업 중인 사업자번호예요. 휴업 중에는 인증할 수 없어요.',
  '03': '폐업한 사업자번호예요.',
};

/**
 * 국세청 사업자등록 상태조회 응답 해석.
 * 응답 예: { status_code: 'OK', match_cnt: 1, data: [{ b_no: '1234567890', b_stt: '계속사업자', b_stt_cd: '01', tax_type: '…', end_dt: '' }] }
 * 미등록 번호: b_stt_cd '' + tax_type '국세청에 등록되지 않은 사업자등록번호입니다.'
 * @returns { ok: true, code:'01', taxType } | { ok:false, code, message }
 */
export function parseNtsStatus(json, bizNo) {
  if (!json || json.status_code !== 'OK' || !Array.isArray(json.data)) {
    return { ok: false, code: 'nts_error', message: '국세청 조회 결과를 확인하지 못했어요. 잠시 후 다시 시도해주세요.' };
  }
  const row = json.data.find((r) => normalizeBizNo(r?.b_no) === bizNo);
  if (!row) return { ok: false, code: 'nts_error', message: '국세청 조회 결과를 확인하지 못했어요.' };
  const cd = String(row.b_stt_cd || '');
  if (cd === '01') return { ok: true, code: '01', taxType: String(row.tax_type || '').slice(0, 60) };
  if (cd === '02' || cd === '03') return { ok: false, code: `nts_${cd}`, message: NTS_STATUS_MESSAGE[cd] };
  return { ok: false, code: 'nts_unregistered', message: '국세청에 등록되지 않은 사업자등록번호예요. 번호를 다시 확인해주세요.' };
}

/** 업체명 검사: 앞뒤 공백 제거, 1~60자 (owner.js 입력칸 maxLength 60 과 같게) */
export function normalizeShopName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s && s.length <= 60 ? s : null;
}

/** Firestore Timestamp | Date | ISO 문자열 | ms → Date|null */
export function toDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 마지막 변경 후 30일이 지났는가 → { ok } | { ok:false, nextAt } */
export function canChangeIdentity(identityChangedAt, now = new Date()) {
  const last = toDate(identityChangedAt);
  if (!last) return { ok: true };
  const next = new Date(last.getTime() + IDENTITY_CHANGE_DAYS * DAY_MS);
  return now >= next ? { ok: true } : { ok: false, nextAt: next.toISOString() };
}

/**
 * verifyBusiness 판단 (조회·DB 쓰기 전)
 * @param shop   shops/{uid} 데이터 (없으면 null)
 * @param input  { bizNo }
 * @returns { ok:true, bizNo, already? } | { ok:false, status, code, message }
 */
export function planVerify(shop, input) {
  const bizNo = normalizeBizNo(input?.bizNo);
  if (!bizNo || !isValidBizNo(bizNo)) return err(400, 'invalid_biz_no', '사업자등록번호가 올바르지 않아요. 10자리를 다시 확인해주세요.');
  if (!shop) return err(404, 'no_shop', '업체 정보를 먼저 저장해주세요.');
  if (shop.bizVerified === true) {
    if (normalizeBizNo(shop.bizNo) === bizNo) return { ok: true, bizNo, already: true };
    return err(409, 'use_update', '이미 인증된 업체예요. 사업자번호를 바꾸려면 "변경 요청"을 이용해주세요.');
  }
  return { ok: true, bizNo };
}

/**
 * updateIdentity 판단 (조회·DB 쓰기 전)
 * @param shop   shops/{uid}
 * @param input  { name?, bizNo? }
 * @returns { ok:true, name, bizNo, nameChanged, bizNoChanged } | { ok:false, status, code, message, nextAt? }
 */
export function planIdentityUpdate(shop, input, now = new Date()) {
  if (!shop) return err(404, 'no_shop', '업체 정보를 먼저 저장해주세요.');
  if (shop.bizVerified !== true) {
    return err(409, 'not_verified', '인증 전에는 업체 정보 화면에서 바로 고칠 수 있어요.');
  }
  // 빈 값(공백 포함)은 "그 항목은 안 바꿈"
  const wantName = String(input?.name ?? '').trim() !== '';
  const wantBiz = String(input?.bizNo ?? '').trim() !== '';
  const name = wantName ? normalizeShopName(input.name) : shop.name;
  if (wantName && !name) return err(400, 'invalid_name', '업체명은 1~60자로 입력해주세요.');
  const bizNo = wantBiz ? normalizeBizNo(input.bizNo) : normalizeBizNo(shop.bizNo);
  if (wantBiz && (!bizNo || !isValidBizNo(bizNo))) return err(400, 'invalid_biz_no', '사업자등록번호가 올바르지 않아요.');
  const nameChanged = wantName && name !== shop.name;
  const bizNoChanged = wantBiz && bizNo !== normalizeBizNo(shop.bizNo);
  if (!nameChanged && !bizNoChanged) return err(400, 'no_change', '바뀐 내용이 없어요.');
  const gate = canChangeIdentity(shop.identityChangedAt, now);
  if (!gate.ok) {
    return { ...err(409, 'too_soon', `업체명·사업자번호는 30일에 한 번만 바꿀 수 있어요. ${gate.nextAt.slice(0, 10)} 이후에 다시 시도해주세요.`), nextAt: gate.nextAt };
  }
  return { ok: true, name, bizNo, nameChanged, bizNoChanged };
}

/** identityHistory 1줄 (서버만 씀) */
export function historyEntry({ kind, name, bizNo, prevName = null, prevBizNo = null, mode = null, at = new Date() }) {
  return { kind, name: name ?? null, bizNo: bizNo ?? null, prevName, prevBizNo, mode, at };
}

/** 키가 비었거나 자리표시값이면 "키 없음" */
export function hasServiceKey(key) {
  const k = String(key ?? '').trim();
  return !!k && !['none', 'REPLACE_ME', 'placeholder'].includes(k);
}

function err(status, code, message) { return { ok: false, status, code, message }; }
