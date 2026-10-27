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
