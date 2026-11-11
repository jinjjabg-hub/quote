// 요금제 (설계도 12장) — 순수 함수. 실제로 막는 것은 보안 규칙(firestore.rules)이고, 이 파일은 화면 안내용이다.
// 규칙과 숫자가 같아야 한다: FREE_MONTHLY(5), TEAM_PLANS.

export const FREE_MONTHLY = 5;
export const TEAM_PLANS = ['team', 'company'];

export const PLANS = {
  free: { key: 'free', name: '무료', price: 0, monthly: FREE_MONTHLY, staffMax: 0, team: false, lookup: false, templates: 1 },
  solo: { key: 'solo', name: '혼자', price: 19900, monthly: null, staffMax: 0, team: false, lookup: true, templates: 2 },
  team: { key: 'team', name: '팀', price: 49000, monthly: null, staffMax: 10, team: true, lookup: true, templates: 3 },
  company: { key: 'company', name: '회사', price: 99000, monthly: null, staffMax: 30, team: true, lookup: true, templates: null },
};
export const PLAN_ORDER = ['free', 'solo', 'team', 'company'];

/** 비교표 행: [기능, 무료, 혼자, 팀, 회사] */
export const FEATURE_ROWS = [
  ['견적 발송', '월 5건', '무제한', '무제한', '무제한'],
  ['고객 확정 안내', '✅', '✅', '✅', '✅'],
  ['주소 → 평수 자동 조회', '—', '✅', '✅', '✅'],
  ['일정표 · 추천 배정', '—', '—', '✅', '✅'],
  ['직원 등록 · 직원 알림', '—', '—', '10명', '30명'],
  ['업종 수', '1', '2', '3', '무제한'],
  ['지원', '안내 문서', '채팅', '채팅', '전화·우선'],
];

const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : typeof v.toMillis === 'function' ? v.toMillis() : Date.parse(v));

/** billing/plan 문서 → 지금 적용되는 요금제 키 (없음·모르는 값·만료 → free) */
export function effectivePlan(doc, now = Date.now()) {
  if (!doc || !PLANS[doc.plan]) return 'free';
  const until = toMs(doc.until);
  return until != null && until <= now ? 'free' : doc.plan;
}

/** 한국 시간 기준 이번 달 키 'YYYYMM' (규칙의 계산과 같음: UTC + 9시간) */
export function monthKey(now = Date.now()) {
  const d = new Date(toMs(now) + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 견적서를 새로 만들 수 있는지. test 견적은 세지 않는다 */
export function canSend(plan, used, { test = false } = {}) {
  if (test) return { ok: true, left: null };
  const p = PLANS[plan] || PLANS.free;
  if (p.monthly == null) return { ok: true, left: null };
  const left = Math.max(0, p.monthly - (Number(used) || 0));
  return { ok: left > 0, left };
}

export const hasTeam = (plan) => TEAM_PLANS.includes(plan);

/** 직원을 더 등록할 수 있는지 (①단계는 화면에서만 확인) */
export function canAddStaff(plan, activeCount) {
  const max = (PLANS[plan] || PLANS.free).staffMax;
  return { ok: activeCount < max, max };
}

export const won = (n) => (n ? `월 ${n.toLocaleString('ko-KR')}원` : '0원');

/** "2026.12.31까지" / "" */
export function untilText(doc) {
  const ms = toMs(doc?.until);
  if (ms == null) return '';
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}까지`;
}

/**
 * 운영자: 이용 기간 연장. 아직 남은 기간이 있으면 그 끝에서, 없으면 오늘부터 months 개월 뒤 그날 끝(한국 시간 23:59:59)
 * @returns ms
 */
export function extendUntil(currentUntil, months, now = Date.now()) {
  const cur = toMs(currentUntil);
  const base = cur != null && cur > toMs(now) ? cur : toMs(now);
  const k = new Date(base + 9 * 3600 * 1000); // 한국 날짜로 계산
  const y = k.getUTCFullYear();
  const m = k.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(k.getUTCDate(), lastDay); // 1/31 + 1개월 → 2/28
  return Date.UTC(y, m, d, 23, 59, 59) - 9 * 3600 * 1000;
}
