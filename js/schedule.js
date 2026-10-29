// 일정·인력 계산 (순수 함수). 화면·Firebase 에 의존하지 않아 단위 테스트로 검증한다. (설계도 10-1장)
//
// 출근 판정
//   정규 직원(employee): 정기 휴무 요일(weeklyOff, 사장님 설정) · 개인 휴무일(offDates, 본인·사장님)이 아니면 출근
//   프리랜서(freelancer): 일할 수 있는 날(availDates, 본인·사장님)만 출근
//   비활성(active === false): 항상 제외

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 'YYYY-MM-DD' → 요일 0(일)~6(토). 시간대 영향 없이 날짜만으로 계산 */
export function dayOfWeek(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 날짜에 n일 더하기 ('YYYY-MM-DD' 그대로) */
export function shiftDate(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function dateRange(startStr, days) {
  return Array.from({ length: days }, (_, i) => shiftDate(startStr, i));
}

/** 그 달의 모든 날짜 */
export function monthDates(yyyyMm) {
  const [y, m] = String(yyyyMm).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return dateRange(`${yyyyMm}-01`, last);
}

/**
 * 이 직원이 그날 일하는지와 이유.
 * @returns {{ working: boolean, reason: '' | '정기 휴무' | '개인 휴무' | '가능일 아님' | '비활성' }}
 */
export function workStatus(staff, dateStr) {
  if (!staff || staff.active === false) return { working: false, reason: '비활성' };
  if (staff.type === 'freelancer') {
    return (staff.availDates || []).includes(dateStr) ? { working: true, reason: '' } : { working: false, reason: '가능일 아님' };
  }
  if ((staff.weeklyOff || []).includes(dayOfWeek(dateStr))) return { working: false, reason: '정기 휴무' };
  if ((staff.offDates || []).includes(dateStr)) return { working: false, reason: '개인 휴무' };
  return { working: true, reason: '' };
}

/** 그날 출근하는 사람 / 쉬는 사람(이유와 함께). 비활성 직원은 목록에서 뺀다 */
export function roster(staffList, dateStr) {
  const working = [];
  const off = [];
  for (const s of staffList) {
    if (s.active === false) continue;
    const st = workStatus(s, dateStr);
    if (st.working) working.push(s); else off.push({ staff: s, reason: st.reason });
  }
  return { working, off };
}

/**
 * 하루를 눌렀을 때 바뀌는 값: 정규 직원은 개인 휴무일 켜고 끄기, 프리랜서는 가능일 켜고 끄기.
 * 정기 휴무 요일은 여기서 바꾸지 않는다(사장님이 직원 정보에서). 바뀌는 필드 이름과 새 배열을 돌려준다.
 */
export function toggleDay(staff, dateStr) {
  const field = staff.type === 'freelancer' ? 'availDates' : 'offDates';
  if (field === 'offDates' && (staff.weeklyOff || []).includes(dayOfWeek(dateStr))) return null; // 정기 휴무일은 이미 쉼
  const cur = new Set(staff[field] || []);
  if (cur.has(dateStr)) cur.delete(dateStr); else cur.add(dateStr);
  return { field, value: [...cur].sort() };
}

/** 지난 날짜 정리: 오늘 기준 keepDays 이전 날짜는 버려 문서가 커지지 않게 */
export function pruneDates(dates, todayStr, keepDays = 60) {
  const from = shiftDate(todayStr, -keepDays);
  return [...new Set(dates || [])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from).sort();
}

/** 초대 링크용 무작위 값 (24자) */
export function newToken(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return [...rand(24)].map((b) => abc[b % abc.length]).join('');
}

// ---------- ②단계: 일정(jobs) · 일정표 ----------
// 일정 문서: { date 'YYYY-MM-DD', start 'HH:MM', hours, crew(필요 인원), staffIds[](배정), title, place, customer,
//             source: 'quote'|'phone'|'soomgo'|'referral'|'other', status: 'scheduled'|'done'|'canceled', requestId? }

export const TRAVEL_MIN = 60; // 현장 사이 이동 시간 기본값 (설계도 10장). 겹침 판정에 쓴다
export const DAY_START = 8;   // 일정표 표시 범위 (시)
export const DAY_END = 21;
export const SOURCES = { quote: '견적앱', phone: '전화', soomgo: '숨고', referral: '소개', other: '기타' };

// 견적 희망 시간대 → 시작 시각 (템플릿 timeSlot 값. 없는 값은 오전 9시)
export const SLOT_START = { first: '08:00', am: '09:00', pm: '13:00', any: '09:00' };

export function toMin(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : NaN;
}
export function toHHMM(min) {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function jobEnd(job) {
  return toHHMM(toMin(job.start) + (Number(job.hours) || 0) * 60);
}

/** 같은 날 두 일정이 겹치는지 (사이에 이동 시간 travel 분이 필요) */
export function overlaps(a, b, travel = TRAVEL_MIN) {
  if (a.date !== b.date) return false;
  const as = toMin(a.start); const ae = as + (Number(a.hours) || 0) * 60;
  const bs = toMin(b.start); const be = bs + (Number(b.hours) || 0) * 60;
  return as < be + travel && bs < ae + travel;
}

const live = (j) => j.status !== 'canceled';

/** 그날 일정 (취소 제외, 시작 시각 순) */
export function jobsOn(jobs, dateStr) {
  return jobs.filter((j) => j.date === dateStr && live(j)).sort((a, b) => toMin(a.start) - toMin(b.start) || String(a.title).localeCompare(String(b.title)));
}

/** 배정 인원 상태: 모자람 / 맞음 / 많음 */
export function crewStatus(job) {
  const need = Number(job.crew) || 0;
  const have = (job.staffIds || []).length;
  return { need, have, short: Math.max(0, need - have), state: have < need ? 'short' : have > need ? 'over' : 'full' };
}

/**
 * 이 일정에 넣을 수 있는 직원 목록과 이유. 이미 배정된 사람도 포함(selected).
 * ok: 그날 출근 + 다른 일정과 안 겹침 / reason: '휴무 사유' 또는 '겹침: 10:00 ○○'
 */
export function candidatesFor(job, staffList, jobs, travel = TRAVEL_MIN) {
  const others = jobs.filter((j) => j.id !== job.id && live(j) && j.date === job.date);
  return staffList.filter((s) => s.active !== false).map((s) => {
    const selected = (job.staffIds || []).includes(s.id);
    const w = workStatus(s, job.date);
    if (!w.working) return { staff: s, selected, ok: false, reason: w.reason };
    const clash = others.find((o) => (o.staffIds || []).includes(s.id) && overlaps(job, o, travel));
    if (clash) return { staff: s, selected, ok: false, reason: `겹침: ${clash.start} ${clash.title}` };
    return { staff: s, selected, ok: true, reason: '' };
  }).sort((a, b) => b.selected - a.selected || b.ok - a.ok || String(a.staff.name).localeCompare(b.staff.name, 'ko'));
}

/** 직원별로 그날 맡은 일정 (일정표 행) */
export function boardRows(staffList, jobs, dateStr) {
  const day = jobsOn(jobs, dateStr);
  const rows = staffList.filter((s) => s.active !== false).map((s) => ({
    staff: s, status: workStatus(s, dateStr), jobs: day.filter((j) => (j.staffIds || []).includes(s.id)),
  })).filter((r) => r.status.working || r.jobs.length); // 쉬는 날인데 배정된 경우도 보여서 고치게
  return { rows, unassigned: day.filter((j) => crewStatus(j).short > 0) };
}

/** 일정표 블록 위치 (% 단위, DAY_START~DAY_END 범위로 자름) */
export function blockPos(job) {
  const span = (DAY_END - DAY_START) * 60;
  const s = Math.min(Math.max(toMin(job.start) - DAY_START * 60, 0), span);
  const e = Math.min(Math.max(toMin(job.start) + (Number(job.hours) || 0) * 60 - DAY_START * 60, 0), span);
  return { left: (s / span) * 100, width: Math.max(((e - s) / span) * 100, 2) };
}

/**
 * 견적 요청 → 일정 (계약확정 때 자동 등록). 날짜가 없으면 null.
 * labor: calculateQuote(...).labor ({ crew, hours }) — 없으면 기본 2명 × 4시간
 */
export function jobFromRequest(req, { templateName = '', labor = null, sizeText = '' } = {}) {
  const a = req.answers || {};
  if (!a.date) return null;
  const site = Object.values(a).find((v) => v && typeof v === 'object' && (v.roadAddr || v.bdNm)) || null; // areaLookup 결과
  return {
    date: a.date,
    start: SLOT_START[a.timeSlot] || '09:00',
    hours: Number(labor?.hours) || 4,
    crew: Number(labor?.crew) || 2,
    staffIds: [],
    title: [templateName, sizeText].filter(Boolean).join(' '),
    place: site ? [site.bdNm, site.dongNm, site.hoNm].filter(Boolean).join(' ') || site.roadAddr || '' : (req.customer?.region || ''),
    customer: req.customer?.name || '',
    phone: req.customer?.phone || '',
    source: 'quote',
    requestId: req.id,
    status: 'scheduled',
    memo: '',
  };
}

// ---------- ③단계: 자동 배정 제안 (설계도 10-1장) ----------
// 원칙: 앱은 "제안"만, 확정은 사장님. 정규 직원 먼저(프리랜서는 빈자리), 그날·그 주 일이 적은 사람 먼저.

/** 직원별 일한 시간 (live 일정, 날짜 구간 [from, to]) */
function hoursBy(jobs, from, to) {
  const m = new Map();
  for (const j of jobs) {
    if (!live(j) || j.date < from || j.date > to) continue;
    for (const id of j.staffIds || []) m.set(id, (m.get(id) || 0) + (Number(j.hours) || 0));
  }
  return m;
}

/**
 * 한 일정의 모자란 자리를 채울 추천. 이미 배정된 사람은 그대로 둔다.
 * @returns { staffIds: 추천 반영 후 전체, added: [staff], missing: 그래도 모자란 수 }
 */
export function suggestCrew(job, staffList, jobs, travel = TRAVEL_MIN) {
  const have = [...new Set(job.staffIds || [])];
  const need = Math.max(0, (Number(job.crew) || 0) - have.length);
  const day = hoursBy(jobs.filter((j) => j.id !== job.id), job.date, job.date);
  const week = hoursBy(jobs.filter((j) => j.id !== job.id), shiftDate(job.date, -6), job.date);
  const pool = candidatesFor(job, staffList, jobs, travel)
    .filter((c) => c.ok && !have.includes(c.staff.id))
    .map((c) => c.staff)
    .sort((a, b) => (a.type === 'freelancer') - (b.type === 'freelancer')
      || (day.get(a.id) || 0) - (day.get(b.id) || 0)
      || (week.get(a.id) || 0) - (week.get(b.id) || 0)
      || String(a.name).localeCompare(b.name, 'ko'));
  const added = pool.slice(0, need);
  return { staffIds: [...have, ...added.map((s) => s.id)], added, missing: need - added.length };
}

/**
 * 그날 인원이 모자란 일정 전체에 대한 추천 (이른 시간부터, 앞에서 고른 사람을 반영해 겹치지 않게)
 * @returns [{ job, staffIds, added, missing }]  (추가할 사람이 없거나 모자라지 않은 일정은 빠짐, missing 만 있는 건 포함)
 */
export function suggestDay(jobs, staffList, dateStr, travel = TRAVEL_MIN) {
  let work = jobs.map((j) => ({ ...j, staffIds: [...(j.staffIds || [])] }));
  const out = [];
  for (const job of jobsOn(work, dateStr)) {
    if (crewStatus(job).short === 0) continue;
    const s = suggestCrew(job, staffList, work, travel);
    out.push({ job: jobs.find((j) => j.id === job.id), ...s });
    work = work.map((j) => (j.id === job.id ? { ...j, staffIds: s.staffIds } : j));
  }
  return out;
}
