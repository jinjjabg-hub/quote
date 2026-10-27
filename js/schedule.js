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
