// 사장님 화면: 고객에게 "예약 확정 안내" 보내기 (설계도 10-2장)
// 견적서(quotes) 문서에 booking 을 넣으면 고객이 같은 견적서 링크에서 확정 내용을 본다. 일정(jobs)과 날짜·시간을 맞춘다.
import { db, doc, getDoc, setDoc, updateDoc, serverTimestamp } from './firebase.js';
import { h, icon, toast, copyText, pageUrl, setChildren } from './util.js';
import { jobFromRequest } from './schedule.js';
import { ensureQuoteJob } from './jobsAdmin.js';
import { defaultNotice, parseNotice, bookingFrom, bookingMessage, bookingChanged, dateKo } from './booking.js';

const settingsRef = (shopId) => doc(db, 'shops', shopId, 'private', 'settings');

/**
 * @param o { shopId, shop, tpl, req, labor, sizeText }
 */
export async function openBookingSheet(o) {
  const { shopId, shop, tpl, req } = o;
  const jobRef = doc(db, 'shops', shopId, 'jobs', `q_${req.id}`);
  const [jobSnap, quoteSnap, setSnap] = await Promise.all([
    getDoc(jobRef),
    req.quoteId ? getDoc(doc(db, 'quotes', req.quoteId)) : null,
    getDoc(settingsRef(shopId)).catch(() => null),
  ]);
  const job = jobSnap.exists() ? jobSnap.data() : null;
  const sent = quoteSnap?.exists() ? quoteSnap.data().booking || null : null;
  const draft = job || jobFromRequest(req, { templateName: tpl.name, labor: o.labor, sizeText: o.sizeText })
    || { date: '', start: '09:00', hours: Number(o.labor?.hours) || 4, crew: Number(o.labor?.crew) || 2 };
  const f = {
    date: draft.date, start: draft.start, hours: draft.hours, crew: draft.crew,
    notice: (sent?.notice?.length ? sent.notice : defaultNotice(tpl, setSnap?.exists() ? setSnap.data().bookingNotice : null)).join('\n'),
    keep: false,
  };
  const url = req.quoteId ? pageUrl('view.html', { id: req.quoteId }) : '';

  const dlg = h('dialog.sheet.booking-form', {});
  const close = () => { dlg.close(); dlg.remove(); };
  const num = (label, key, attrs) => h('label.field', {}, h('span.label', {}, label),
    h('input.input', { type: 'number', value: f[key], oninput: (e) => { f[key] = Number(e.target.value); }, ...attrs }));

  const drawForm = () => setChildren(dlg,
    h('h2', {}, '고객에게 예약 확정 안내'),
    h('p.muted.small', {}, '고객에게는 날짜·도착 시간·작업 시간·방문 인원·준비사항만 보여요. 직원 이름·내부 메모는 보내지 않아요.'),
    sent && job && bookingChanged(sent, job) ? h('div.warn-box', {}, `보낸 안내(${dateKo(sent.date)} ${sent.start})와 지금 일정이 달라요. 다시 보내주세요.`) : null,
    h('label.field', {}, h('span.label', {}, '방문 날짜', h('span.req', {}, ' *')),
      h('input.input', { type: 'date', value: f.date, onchange: (e) => { f.date = e.target.value; } })),
    h('div.two-col', {},
      h('label.field', {}, h('span.label', {}, '도착 시간'),
        h('input.input', { type: 'time', step: 1800, value: f.start, onchange: (e) => { f.start = e.target.value; } })),
      num('작업 시간(시간)', 'hours', { min: 0.5, max: 24, step: 0.5 })),
    num('방문 인원(명)', 'crew', { min: 1, max: 30, step: 1 }),
    h('label.field', {}, h('span.label', {}, '준비해주실 것', h('span.muted', {}, ' (한 줄에 하나)')),
      h('textarea.input', { rows: 4, maxLength: 1200, oninput: (e) => { f.notice = e.target.value; } }, f.notice)),
    h('label.toggle', {}, h('input', { type: 'checkbox', checked: f.keep, onchange: (e) => { f.keep = e.target.checked; drawForm(); } }),
      f.keep ? icon('check') : null, '이 준비사항을 다음에도 기본으로 쓰기'),
    req.quoteId ? null : h('p.notice.small', {}, '보낸 견적서가 없어 링크 없이 안내 문구만 만들어요.'),
    job ? null : h('p.small.muted', {}, '저장하면 일정 탭에도 이 날짜로 등록돼요.'),
    h('div.btn-row', {},
      h('button.btn.ghost', { type: 'button', onclick: close }, '닫기'),
      h('button.btn.primary', { type: 'button', onclick: (e) => save(e.currentTarget) }, icon('send'), '안내 만들기')));

  const drawDone = (booking) => {
    const msg = bookingMessage({ shopName: shop.name, shopPhone: shop.phone, customerName: req.customer?.name, templateName: tpl.name, booking, url });
    setChildren(dlg,
      h('h2', {}, '확정 안내가 준비됐어요'),
      h('p.muted', {}, req.quoteId ? '고객이 받은 견적서 링크에도 확정 내용이 표시돼요. 아래 문구를 카톡·문자로 보내세요.' : '아래 문구를 카톡·문자로 보내세요.'),
      h('pre.msg', {}, msg),
      h('div.btn-col', {},
        h('button.btn.primary.big', { type: 'button', onclick: () => copyText(msg) }, '안내 문구 복사'),
        navigator.share ? h('button.btn.ghost', { type: 'button', onclick: () => navigator.share({ text: msg }).catch(() => {}) }, '공유하기') : null,
        url ? h('a.btn.ghost', { href: url, target: '_blank', rel: 'noopener' }, '고객 화면 미리보기') : null,
        h('button.btn.ghost', { type: 'button', onclick: close }, '닫기')));
  };

  const save = async (btn) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || '')) { toast('방문 날짜를 골라주세요.'); return; }
    if (!/^\d{2}:\d{2}$/.test(f.start || '')) { toast('도착 시간을 입력해주세요.'); return; }
    if (!(f.hours > 0 && f.hours <= 24) || !(Number.isInteger(f.crew) && f.crew >= 1 && f.crew <= 30)) { toast('작업 시간·인원을 확인해주세요.'); return; }
    btn.disabled = true;
    const notice = parseNotice(f.notice);
    const booking = bookingFrom(f, notice);
    try {
      // 일정과 맞춘다: 없으면 만들고, 있으면 날짜·시간·인원만 고친다 (배정 직원은 그대로)
      const slot = { date: f.date, start: f.start, hours: f.hours, crew: f.crew };
      if (!job) {
        const base = jobFromRequest({ ...req, answers: { ...req.answers, date: f.date } }, { templateName: tpl.name, labor: o.labor, sizeText: o.sizeText });
        await ensureQuoteJob(shopId, { ...base, ...slot });
      } else if (bookingChanged(slot, job)) {
        await updateDoc(jobRef, { ...slot, updatedAt: serverTimestamp() });
      }
      if (req.quoteId) await updateDoc(doc(db, 'quotes', req.quoteId), { booking: { ...booking, sentAt: serverTimestamp() }, updatedAt: serverTimestamp() });
      if (f.keep) await setDoc(settingsRef(shopId), { bookingNotice: notice }, { merge: true });
      drawDone(booking);
    } catch (e) { toast(`저장 실패: ${e.message}`, 4000); btn.disabled = false; }
  };

  drawForm();
  document.body.append(dlg);
  dlg.showModal();
}

/**
 * 일정 탭에서 견적앱 일정을 고치거나 취소했을 때 고객 견적서의 확정 안내도 맞춘다.
 * @returns true 면 고객 안내가 바뀜 (다시 알려야 함)
 */
export async function syncBooking(job, { canceled = false } = {}) {
  if (!job.requestId) return false;
  const r = await getDoc(doc(db, 'requests', job.requestId));
  const quoteId = r.exists() ? r.data().quoteId : null;
  if (!quoteId) return false;
  const qRef = doc(db, 'quotes', quoteId);
  const q = await getDoc(qRef);
  const b = q.exists() ? q.data().booking : null;
  if (!b) return false;
  if (canceled) {
    if (b.canceled) return false;
    await updateDoc(qRef, { 'booking.canceled': true, updatedAt: serverTimestamp() });
    return true;
  }
  if (!bookingChanged(b, job)) return false;
  await updateDoc(qRef, {
    booking: { ...b, date: job.date, start: job.start, hours: Number(job.hours), crew: Number(job.crew), canceled: false }, updatedAt: serverTimestamp(),
  });
  return true;
}
