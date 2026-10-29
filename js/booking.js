// 예약 확정 안내 (고객용) — 순수 함수. 설계도 10-2장
// 고객에게는 날짜·도착 시간·작업 시간·방문 인원·준비사항만 보낸다. 직원 이름·내부 메모·출처는 넣지 않는다.
import { WEEKDAYS, dayOfWeek, jobEnd } from './schedule.js';

const GENERIC_NOTICE = ['주차 가능 여부와 현관 비밀번호를 알려주세요.', '일정 변경은 작업 전날까지 전화로 말씀해주세요.'];

/** 준비사항 기본값: 사장님이 저장한 문구 → 업종 템플릿 → 공통 문구 */
export function defaultNotice(template, saved) {
  if (Array.isArray(saved) && saved.length) return saved;
  if (Array.isArray(template?.bookingNotice) && template.bookingNotice.length) return template.bookingNotice;
  return GENERIC_NOTICE;
}

/** 여러 줄 글 → 준비사항 목록 (빈 줄·앞 기호 제거, 최대 10줄 × 120자) */
export function parseNotice(text) {
  return String(text || '').split('\n').map((l) => l.replace(/^\s*[-•·*\d.)]+\s*/, '').trim()).filter(Boolean).slice(0, 10).map((l) => l.slice(0, 120));
}

/** 일정(또는 요청에서 만든 일정 초안) → 견적서에 넣을 booking */
export function bookingFrom(job, notice) {
  return {
    date: job.date, start: job.start, hours: Number(job.hours) || 0, crew: Number(job.crew) || 0,
    notice: [...(notice || [])], canceled: false,
  };
}

/** "11월 4일 (수)" */
export function dateKo(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return '';
  return `${Number(dateStr.slice(5, 7))}월 ${Number(dateStr.slice(8, 10))}일 (${WEEKDAYS[dayOfWeek(dateStr)]})`;
}

/** "09:00 도착 · 약 4시간 (13:00 무렵 끝)" */
export function timeKo(b) {
  if (!b.start) return '';
  return b.hours ? `${b.start} 도착 · 약 ${b.hours}시간 (${jobEnd(b)} 무렵 끝)` : `${b.start} 도착`;
}

/** 카톡·문자로 보낼 확정 안내 문구 */
export function bookingMessage({ shopName, shopPhone, customerName, templateName, booking, url }) {
  const b = booking;
  return [
    `[${shopName || '업체'}] ${customerName ? `${customerName}님 ` : ''}${templateName || ''} 예약이 확정되었습니다.`.replace(/\s+예약/, ' 예약'),
    '',
    `📅 ${dateKo(b.date)} ${b.start} 도착`,
    b.hours ? `⏱ 작업 약 ${b.hours}시간` : null,
    b.crew ? `👷 ${b.crew}명 방문` : null,
    b.notice?.length ? ['', '준비해주실 것', ...b.notice.map((n) => `- ${n}`)].join('\n') : null,
    url ? `\n예약 내용 보기: ${url}` : null,
    shopPhone ? `문의·일정 변경: ${shopPhone}` : null,
  ].filter((l) => l !== null).join('\n');
}

/** 고객에게 보낸 안내와 지금 일정이 다른지 (일정 탭에서 고친 경우) */
export function bookingChanged(booking, job) {
  if (!booking || !job) return false;
  return booking.date !== job.date || booking.start !== job.start || Number(booking.hours) !== Number(job.hours) || Number(booking.crew) !== Number(job.crew);
}
