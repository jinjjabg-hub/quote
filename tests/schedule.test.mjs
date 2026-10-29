// 일정·인력 계산 테스트 (설계도 10-1장, 청소 업체 사례: 연중무휴, 직원 주5일, 프리랜서)
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayOfWeek, shiftDate, dateRange, monthDates, workStatus, roster, toggleDay, pruneDates, newToken } from '../js/schedule.js';

const kim = { id: 'a', name: '김정규', type: 'employee', weeklyOff: [1, 2] }; // 월·화 정기 휴무
const lee = { id: 'b', name: '이정규', type: 'employee', weeklyOff: [0, 6], offDates: ['2026-11-04'] };
const park = { id: 'c', name: '박프리', type: 'freelancer', availDates: ['2026-11-02', '2026-11-04'] };
const gone = { id: 'd', name: '최퇴사', type: 'employee', weeklyOff: [], active: false };

test('날짜 계산: 요일·이동·월 (시간대 영향 없음)', () => {
  assert.equal(dayOfWeek('2026-11-02'), 1); // 월요일
  assert.equal(dayOfWeek('2026-11-01'), 0);
  assert.equal(shiftDate('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(dateRange('2026-12-30', 3), ['2026-12-30', '2026-12-31', '2027-01-01']);
  assert.equal(monthDates('2026-02').length, 28);
  assert.equal(monthDates('2028-02').length, 29);
});

test('출근 판정: 정규(정기 휴무·개인 휴무) / 프리랜서(가능일만) / 비활성', () => {
  assert.deepEqual(workStatus(kim, '2026-11-02'), { working: false, reason: '정기 휴무' }); // 월
  assert.deepEqual(workStatus(kim, '2026-11-04'), { working: true, reason: '' }); // 수
  assert.deepEqual(workStatus(lee, '2026-11-04'), { working: false, reason: '개인 휴무' });
  assert.deepEqual(workStatus(lee, '2026-11-01'), { working: false, reason: '정기 휴무' }); // 일
  assert.deepEqual(workStatus(park, '2026-11-04'), { working: true, reason: '' });
  assert.deepEqual(workStatus(park, '2026-11-05'), { working: false, reason: '가능일 아님' });
  assert.equal(workStatus(gone, '2026-11-04').reason, '비활성');
});

test('하루 출근 명단: 연중무휴 회사에서 날마다 출근 인원이 다름', () => {
  const all = [kim, lee, park, gone];
  const mon = roster(all, '2026-11-02'); // 월: 김 정기휴무, 이 출근, 박 가능
  assert.deepEqual(mon.working.map((s) => s.name), ['이정규', '박프리']);
  assert.deepEqual(mon.off.map((o) => [o.staff.name, o.reason]), [['김정규', '정기 휴무']]);
  const wed = roster(all, '2026-11-04'); // 수: 김 출근, 이 개인휴무, 박 가능
  assert.deepEqual(wed.working.map((s) => s.name), ['김정규', '박프리']);
  assert.equal(roster(all, '2026-11-05').working.length, 2, '목: 김·이 출근, 박 불가');
  assert.ok(!roster(all, '2026-11-04').off.some((o) => o.staff.name === '최퇴사'), '비활성은 명단에서 뺌');
});

test('하루 누르기: 정규는 개인 휴무 켜고 끄기(정기 휴무일은 그대로), 프리랜서는 가능일 켜고 끄기', () => {
  assert.deepEqual(toggleDay(kim, '2026-11-04'), { field: 'offDates', value: ['2026-11-04'] });
  assert.deepEqual(toggleDay(lee, '2026-11-04'), { field: 'offDates', value: [] });
  assert.equal(toggleDay(kim, '2026-11-02'), null, '월요일은 이미 정기 휴무');
  assert.deepEqual(toggleDay(park, '2026-11-03'), { field: 'availDates', value: ['2026-11-02', '2026-11-03', '2026-11-04'] });
  assert.deepEqual(toggleDay(park, '2026-11-02'), { field: 'availDates', value: ['2026-11-04'] });
});

test('지난 날짜 정리·초대 값', () => {
  assert.deepEqual(pruneDates(['2026-01-01', '2026-10-01', '2026-11-04', '2026-11-04', 'x'], '2026-10-27', 60), ['2026-10-01', '2026-11-04']);
  const t = newToken();
  assert.match(t, /^[A-Za-z2-9]{24}$/);
  assert.notEqual(newToken(), t);
});

// ---------- ②단계: 일정 · 일정표 ----------
import { toMin, toHHMM, jobEnd, overlaps, jobsOn, crewStatus, candidatesFor, boardRows, blockPos, jobFromRequest } from '../js/schedule.js';

const D = '2026-11-04'; // 수요일: 김(월·화 휴무) 출근, 이(개인 휴무), 박(가능)
const job = (id, start, hours, crew, staffIds = [], extra = {}) => ({ id, date: D, start, hours, crew, staffIds, title: id, status: 'scheduled', ...extra });

test('시간 계산: 끝나는 시각, 이동 시간 60분을 넣은 겹침', () => {
  assert.equal(toMin('09:30'), 570);
  assert.equal(toHHMM(570), '09:30');
  assert.equal(jobEnd(job('a', '09:00', 6.5, 2)), '15:30');
  assert.equal(overlaps(job('a', '09:00', 3, 2), job('b', '12:30', 2, 2)), true, '12:00 끝 + 이동 60분 → 13:00 전 시작은 겹침');
  assert.equal(overlaps(job('a', '09:00', 3, 2), job('b', '13:00', 2, 2)), false);
  assert.equal(overlaps(job('a', '09:00', 3, 2), job('b', '12:30', 2, 2), 0), false, '이동 시간 0이면 안 겹침');
  assert.equal(overlaps(job('a', '09:00', 3, 2), { ...job('b', '09:00', 3, 2), date: '2026-11-05' }), false);
});

test('그날 일정·배정 인원 상태 (취소 제외, 시간순)', () => {
  const jobs = [job('b', '13:00', 3, 2), job('a', '09:00', 3, 3, ['a']), job('c', '08:00', 2, 2, [], { status: 'canceled' })];
  assert.deepEqual(jobsOn(jobs, D).map((j) => j.id), ['a', 'b']);
  assert.deepEqual(crewStatus(jobs[1]), { need: 3, have: 1, short: 2, state: 'short' });
  assert.equal(crewStatus(job('x', '09:00', 1, 1, ['a', 'b'])).state, 'over');
});

test('배정 후보: 휴무·겹침은 이유와 함께 막고, 출근·안 겹침만 ok', () => {
  const staff = [kim, lee, park, gone];
  const morning = job('m', '09:00', 4, 2, ['a']); // 김이 오전 현장
  const after = job('p', '13:30', 3, 2);          // 13:00 끝 + 60분 → 14:00 전이라 김과 겹침
  const c = candidatesFor(after, staff, [morning, after]);
  const by = Object.fromEntries(c.map((x) => [x.staff.name, x]));
  assert.equal(by['김정규'].ok, false);
  assert.match(by['김정규'].reason, /^겹침: 09:00/);
  assert.equal(by['이정규'].reason, '개인 휴무');
  assert.equal(by['박프리'].ok, true);
  assert.ok(!by['최퇴사'], '비활성 제외');
  assert.equal(c[0].staff.name, '박프리', '가능한 사람이 위로');
});

test('일정표: 출근 직원 줄 + 배정 필요 일정, 블록 위치', () => {
  const jobs = [job('m', '09:00', 4, 2, ['a']), job('p', '14:00', 3, 1, ['c'])];
  const b = boardRows([kim, lee, park, gone], jobs, D);
  assert.deepEqual(b.rows.map((r) => [r.staff.name, r.jobs.map((j) => j.id)]), [['김정규', ['m']], ['박프리', ['p']]]);
  assert.deepEqual(b.unassigned.map((j) => j.id), ['m'], '2명 중 1명 → 배정 필요');
  const p = blockPos(job('x', '08:00', 13, 1));
  assert.equal(Math.round(p.left), 0);
  assert.equal(Math.round(p.width), 100);
  assert.ok(blockPos(job('y', '20:30', 3, 1)).width > 0, '범위 밖으로 나가도 잘려서 보임');
});

test('견적 요청 → 일정: 희망일·시간대·인력 예상으로, 날짜 없으면 만들지 않음', () => {
  const req = { id: 'r1', customer: { name: '김고객', phone: '010', region: '부산 수영구' }, answers: { date: '2026-11-04', timeSlot: 'pm', areaLookup: { bdNm: '더샵', dongNm: '202동', hoNm: '701' } } };
  const j = jobFromRequest(req, { templateName: '입주청소', labor: { crew: 3, hours: 5.5 }, sizeText: '38평' });
  assert.deepEqual([j.date, j.start, j.hours, j.crew, j.title, j.place, j.source, j.requestId], ['2026-11-04', '13:00', 5.5, 3, '입주청소 38평', '더샵 202동 701', 'quote', 'r1']);
  assert.equal(jobFromRequest({ ...req, answers: { timeSlot: 'am' } }), null);
  assert.deepEqual([jobFromRequest({ id: 'r2', answers: { date: D } }).start, jobFromRequest({ id: 'r2', answers: { date: D } }).crew], ['09:00', 2], '정보가 없으면 9시·2명×4시간');
});
