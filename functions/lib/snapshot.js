// 견적 스냅샷 + 해시 (검수 M9: 분쟁 증거)
//
// 왜: 결제 후 사장님이 견적 금액·조건을 바꾸면 "고객이 무엇에 동의했는지" 증명할 수 없다.
//     결제 준비 시점의 견적 내용을 payments 문서에 그대로 복사하고, SHA-256 해시를 함께 남긴다.
//     고객 화면(js/payment.js)도 같은 방식으로 해시를 계산해 보내므로, 두 값이 같으면
//     "고객이 본 화면 = 서버가 저장한 견적"이 증명된다.
//
// ★ js/payment.js 의 canonicalJson / quoteSnapshot 과 알고리즘이 같아야 한다.
//   (functions/test/snapshot.test.mjs 가 두 구현의 결과를 비교한다)
import { createHash } from 'node:crypto';

export const SNAPSHOT_VERSION = 1;

/** 스냅샷에 들어가는 견적 필드 (docs/round2/contract.md M9 + 환불 규칙) */
export const SNAPSHOT_FIELDS = [
  'number', 'lines', 'total', 'deposit', 'depositPct',
  'conditions', 'included', 'excluded', 'cancelPolicy', 'refundRules',
];

/** 키 정렬·undefined 제거한 결정적 JSON (Firestore Timestamp 같은 객체는 toJSON/ISO 로) */
export function canonicalJson(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x) ?? 'null').join(',')}]`;
  if (typeof v.toDate === 'function') return JSON.stringify(v.toDate().toISOString());
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

/** 견적 문서 → 스냅샷 (없는 필드는 null 로 고정해 해시가 흔들리지 않게) */
export function quoteSnapshot(quote = {}) {
  const q = quote || {};
  const snap = {};
  for (const k of SNAPSHOT_FIELDS) snap[k] = q[k] === undefined ? null : q[k];
  return snap;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** @returns { snapshot, hash, version } */
export function snapshotWithHash(quote) {
  const snapshot = quoteSnapshot(quote);
  return { snapshot, hash: sha256Hex(canonicalJson(snapshot)), version: SNAPSHOT_VERSION };
}

export function isSnapshotHash(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}
