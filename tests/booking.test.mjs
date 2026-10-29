// 예약 확정 안내 (고객용) 테스트 — 설계도 10-2장
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultNotice, parseNotice, bookingFrom, dateKo, timeKo, bookingMessage, bookingChanged } from '../js/booking.js';

const job = { date: '2026-11-04', start: '09:00', hours: 4.5, crew: 3, staffIds: ['a', 'b'], memo: '현관 비번 1234', source: 'soomgo', title: '입주청소 34평' };

test('준비사항 기본값: 저장한 문구 → 템플릿 → 공통', () => {
  assert.deepEqual(defaultNotice({ bookingNotice: ['T'] }, ['S']), ['S']);
  assert.deepEqual(defaultNotice({ bookingNotice: ['T'] }, []), ['T']);
  assert.ok(defaultNotice({}, null).length > 0);
});

test('준비사항 글 → 목록: 빈 줄·앞 기호 제거, 10줄·120자 제한', () => {
  assert.deepEqual(parseNotice('- 전기 확인\n\n• 주차 안내\n1. 비밀번호 '), ['전기 확인', '주차 안내', '비밀번호']);
  assert.equal(parseNotice(Array(15).fill('a').join('\n')).length, 10);
  assert.equal(parseNotice('가'.repeat(200))[0].length, 120);
});

test('고객 안내에는 내부 정보(직원·메모·출처)가 들어가지 않음', () => {
  const b = bookingFrom(job, ['주차 안내']);
  assert.deepEqual(Object.keys(b).sort(), ['canceled', 'crew', 'date', 'hours', 'notice', 'start']);
  const msg = bookingMessage({ shopName: '반짝입주청소', shopPhone: '010-5555-6666', customerName: '김고객', templateName: '입주청소', booking: b, url: 'https://x/view.html?id=abc' });
  assert.match(msg, /^\[반짝입주청소\] 김고객님 입주청소 예약이 확정되었습니다\./);
  assert.match(msg, /11월 4일 \(수\) 09:00 도착/);
  assert.match(msg, /작업 약 4\.5시간/);
  assert.match(msg, /3명 방문/);
  assert.match(msg, /- 주차 안내/);
  assert.match(msg, /예약 내용 보기: https:\/\/x\/view\.html\?id=abc/);
  assert.doesNotMatch(msg, /1234|숨고|soomgo/);
  assert.match(msg, /문의·일정 변경: 010-5555-6666/);
});

test('견적서 링크가 없으면 문구만 (링크 줄 없음)', () => {
  const msg = bookingMessage({ shopName: 'A', templateName: '입주청소', booking: bookingFrom(job, []) });
  assert.doesNotMatch(msg, /예약 내용 보기|undefined|null/);
});

test('날짜·시간 표기', () => {
  assert.equal(dateKo('2026-11-04'), '11월 4일 (수)');
  assert.equal(timeKo(bookingFrom(job, [])), '09:00 도착 · 약 4.5시간 (13:30 무렵 끝)');
  assert.equal(dateKo('x'), '');
});

test('일정 탭에서 시간을 고치면 "안내와 다름"으로 잡힘', () => {
  const b = bookingFrom(job, []);
  assert.equal(bookingChanged(b, job), false);
  assert.equal(bookingChanged(b, { ...job, start: '10:00' }), true);
  assert.equal(bookingChanged(b, { ...job, staffIds: [] }), false, '직원 바뀐 건 고객과 무관');
  assert.equal(bookingChanged(null, job), false);
});
