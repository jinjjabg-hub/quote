// 사장님 화면 "일정" 탭 — ②단계: 일정표 · 빠른 등록 · 수동 배정 (설계도 10-1장)
// 일정은 견적앱 밖(전화·숨고·소개)에서도 들어오므로 직접 등록이 기본이고, 견적앱 계약확정은 자동 등록한다.
import { db, doc, collection, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp } from './firebase.js';
import { h, icon, toast, setChildren, telHref } from './util.js';
import {
  SOURCES, DAY_START, DAY_END, TRAVEL_MIN, toMin, jobEnd, jobsOn, crewStatus, candidatesFor, boardRows, blockPos,
} from './schedule.js';
import { syncBooking } from './bookingAdmin.js';

const START_CHIPS = ['08:00', '09:00', '10:00', '13:00', '14:00'];
const HOUR_CHIPS = [2, 3, 4, 5, 6, 8];
const CREW_CHIPS = [1, 2, 3, 4, 5];
const nameOf = (staff, id) => staff.find((s) => s.id === id)?.name || '(삭제된 직원)';

/** 날짜 구간(YYYY-MM-DD 문자열 비교)의 일정 실시간 구독 */
export function subscribeJobs(shopId, from, to, onChange) {
  const q = query(collection(db, 'shops', shopId, 'jobs'), where('date', '>=', from), where('date', '<=', to));
  return onSnapshot(q, (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => toast(`일정을 불러오지 못했습니다: ${e.message}`, 4000));
}

/**
 * 견적 요청이 계약확정되면 일정을 하나 만든다 (문서 ID q_요청ID → 두 번 눌러도 하나만).
 * @returns 'created' | 'exists' | 'nodate'
 */
export async function ensureQuoteJob(shopId, job) {
  if (!job) return 'nodate';
  const ref = doc(db, 'shops', shopId, 'jobs', `q_${job.requestId}`);
  if ((await getDoc(ref)).exists()) return 'exists';
  await setDoc(ref, { ...clip(job), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return 'created';
}

// 규칙의 글자 수 제한에 맞춘다
function clip(j) {
  return { ...j, title: (j.title || '').slice(0, 60), place: (j.place || '').slice(0, 120), customer: (j.customer || '').slice(0, 30), phone: (j.phone || '').slice(0, 30), memo: (j.memo || '').slice(0, 300) };
}

/** ctx: { shopId, staff, jobs (null=불러오는 중), st: { date } } */
export function renderJobs(ctx) {
  const { staff, st } = ctx;
  if (!ctx.jobs) return h('p.muted.center', {}, '일정을 불러오는 중…');
  const day = jobsOn(ctx.jobs, st.date);
  const board = boardRows(staff, ctx.jobs, st.date);
  const short = board.unassigned.length;
  return h('section', {},
    h('div.section-head', {},
      h('h2', {}, icon('event'), ' 이날 일정 ', h('span.pill-count', {}, day.length)),
      h('button.btn.primary.small', { type: 'button', onclick: () => openJobForm(ctx, null) }, icon('add'), '일정 등록')),
    short ? h('div.warn-box', {}, `인원이 모자란 일정 ${short}건 — 눌러서 직원을 배정하세요.`) : null,
    day.length ? renderBoard(ctx, board) : null,
    day.length
      ? h('ul.job-list', {}, day.map((j) => renderJobCard(ctx, j)))
      : h('div.card.empty', {}, h('p', {}, h('b', {}, '이날 일정이 없어요.')),
        h('p.muted', {}, '전화·숨고·소개로 들어온 일은 "일정 등록"으로 바로 넣고, 견적앱 요청은 계약확정하면 자동으로 들어와요.')));
}

// 직원 × 시간 일정표 (맨 위 "배정 필요" 줄)
function renderBoard(ctx, board) {
  const ticks = [];
  for (let t = DAY_START; t <= DAY_END; t += 2) ticks.push(t);
  const tickPos = (t) => `${((t - DAY_START) / (DAY_END - DAY_START)) * 100}%`;
  const block = (j, warn) => {
    const p = blockPos(j);
    return h(`button.job-block${warn ? '.short' : ''}`, {
      type: 'button', style: `left:${p.left}%;width:${p.width}%`, title: `${j.start}~${jobEnd(j)} ${j.title}`,
      onclick: () => openJobForm(ctx, j),
    }, `${j.start} ${j.title}`);
  };
  const row = (label, sub, jobs, warn, cls = '') => h(`div.board-row${cls}`, {},
    h('div.board-name', {}, label, sub ? h('span.small.muted', {}, sub) : null),
    h('div.board-track', {}, ticks.map((t) => h('span.board-line', { style: `left:${tickPos(t)}` })), jobs.map((j) => block(j, warn))));
  return h('div.card.board-card', {},
    h('div.card-title', {}, icon('calendar_month'), h('span.grow', {}, '일정표'), h('span.aside', {}, `이동 ${TRAVEL_MIN}분 포함해 겹침 확인`)),
    h('div.board-scroll', {}, h('div.board', {},
      h('div.board-row.head', {}, h('div.board-name', {}), h('div.board-track', {}, ticks.map((t) => h('span.board-tick', { style: `left:${tickPos(t)}` }, `${t}시`)))),
      board.unassigned.length ? row('배정 필요', null, board.unassigned, true, '.need') : null,
      board.rows.map((r) => row(r.staff.name, r.status.working ? null : r.status.reason, r.jobs, false, r.status.working ? '' : '.off')))),
    board.rows.length ? null : h('p.small.muted', {}, '이날 출근하는 직원이 없어요. "직원·근무"에서 확인하세요.'));
}

function crewText(c) {
  return c.short > 0 ? `${c.need}명 중 ${c.have}명 배정` : c.have > c.need ? `${c.have}명 배정 (필요 ${c.need}명)` : `${c.need}명 배정 완료`;
}

function renderJobCard(ctx, j) {
  const c = crewStatus(j);
  return h(`li.job-card${c.short > 0 ? '.short' : ''}`, { onclick: () => openJobForm(ctx, j) },
    h('div.job-top', {},
      h('b.job-time', {}, `${j.start}~${jobEnd(j)}`),
      h('span.badge.src', {}, SOURCES[j.source] || '기타'),
      j.status === 'done' ? h('span.badge.st-ok', {}, '완료') : null,
      h(`span.crew${c.short > 0 ? '.short' : ''}`, {}, icon('group'), crewText(c))),
    h('div.job-title', {}, j.title),
    j.place || j.customer ? h('div.small.muted', {}, [j.place, j.customer && `${j.customer} 고객`].filter(Boolean).join(' · ')) : null,
    (j.staffIds || []).length ? h('div.staff-chips.small', {}, j.staffIds.map((id) => h('span.staff-chip', {}, nameOf(ctx.staff, id)))) : null);
}

// 일정 등록·수정 + 직원 배정 (아래에서 올라오는 창)
export function openJobForm(ctx, job) {
  const f = {
    date: job?.date || ctx.st.date, start: job?.start || '09:00', hours: job?.hours || 4, crew: job?.crew || 2,
    staffIds: [...(job?.staffIds || [])], title: job?.title || '', place: job?.place || '', customer: job?.customer || '',
    phone: job?.phone || '', memo: job?.memo || '', source: job?.source || 'phone',
  };
  const dlg = h('dialog.sheet.job-form', {});
  const close = () => { dlg.close(); dlg.remove(); ctx.rerender(); };
  const chips = (list, cur, fmt, set) => h('div.choices', {}, list.map((v) => h(`button.chip.small${cur === v ? '.on' : ''}`, {
    type: 'button', 'aria-pressed': cur === v, onclick: () => { set(v); draw(); },
  }, fmt(v))));
  const text = (label, key, attrs = {}) => h('label.field', {}, h('span.label', {}, label),
    h('input.input', { value: f[key], oninput: (e) => { f[key] = e.target.value; }, ...attrs }));

  const draw = () => {
    const cands = candidatesFor({ ...f, id: job?.id }, ctx.staff, ctx.jobs || []);
    const c = crewStatus(f);
    const picked = cands.filter((x) => x.selected);
    const risky = picked.filter((x) => !x.ok);
    setChildren(dlg,
      h('h2', {}, job ? '일정 수정 · 배정' : '일정 등록'),
      job?.source === 'quote' ? h('p.notice.small', {}, '견적앱에서 계약확정되어 자동으로 등록된 일정이에요.') : null,
      h('label.field', {}, h('span.label', {}, '날짜', h('span.req', {}, ' *')),
        h('input.input', { type: 'date', value: f.date, onchange: (e) => { f.date = e.target.value; draw(); } })),
      h('div.field', {}, h('span.label', {}, '시작 시간'),
        chips(START_CHIPS, f.start, (v) => v, (v) => { f.start = v; }),
        h('input.input.time', { type: 'time', step: 1800, value: f.start, 'aria-label': '시작 시간 직접 입력', onchange: (e) => { if (e.target.value) { f.start = e.target.value; draw(); } } })),
      h('div.field', {}, h('span.label', {}, '걸리는 시간'),
        chips(HOUR_CHIPS, f.hours, (v) => `${v}시간`, (v) => { f.hours = v; }),
        h('input.input.num', { type: 'number', min: 0.5, max: 24, step: 0.5, value: f.hours, 'aria-label': '걸리는 시간 직접 입력', onchange: (e) => { const v = Number(e.target.value); if (v > 0 && v <= 24) { f.hours = v; draw(); } } })),
      h('div.field', {}, h('span.label', {}, '필요 인원'), chips(CREW_CHIPS, f.crew, (v) => `${v}명`, (v) => { f.crew = v; })),
      text('일 내용 *', 'title', { maxLength: 60, placeholder: '예) 입주청소 34평' }),
      text('장소', 'place', { maxLength: 120, placeholder: '예) 수영구 팍스타운 101동' }),
      h('div.two-col', {}, text('고객 이름', 'customer', { maxLength: 30 }), text('연락처', 'phone', { type: 'tel', maxLength: 30 })),
      f.phone && job ? h('a.link.small', { href: telHref(f.phone) }, icon('call'), ' 고객에게 전화') : null,
      job?.source === 'quote' ? null : h('div.field', {}, h('span.label', {}, '들어온 곳'),
        chips(['phone', 'soomgo', 'referral', 'other'], f.source, (v) => SOURCES[v], (v) => { f.source = v; })),
      text('메모', 'memo', { maxLength: 300, placeholder: '예) 현관 비번 1234, 주차 가능' }),

      h('div.field', {}, h('span.label', {}, '직원 배정 ', h(`span${c.short > 0 ? '.warn-text' : '.ok-text'}`, {}, crewText(c))),
        cands.length ? h('ul.cand-list', {}, cands.map((x) => h(`li.cand${x.ok ? '' : '.bad'}${x.selected ? '.on' : ''}`, {},
          h('label', {},
            h('input', { type: 'checkbox', checked: x.selected, onchange: (e) => {
              f.staffIds = e.target.checked ? [...f.staffIds, x.staff.id] : f.staffIds.filter((id) => id !== x.staff.id); draw();
            } }),
            h('span.grow', {}, x.staff.name, x.staff.type === 'freelancer' ? h('span.mini-tag', {}, '프리') : null),
            h('span.small', {}, x.ok ? '가능' : x.reason)))))
          : h('p.small.muted', {}, '등록된 직원이 없어요. "직원·근무"에서 먼저 등록하세요.')),
      risky.length ? h('div.warn-box', {}, `${risky.map((x) => `${x.staff.name}: ${x.reason}`).join('\n')}\n그래도 저장할 수 있지만 확인해주세요.`) : null,

      h('div.btn-row', {},
        h('button.btn.ghost', { type: 'button', onclick: close }, '닫기'),
        h('button.btn.primary', { type: 'button', onclick: (e) => save(e.currentTarget) }, '저장')),
      job ? h('div.btn-row.job-more', {},
        job.status === 'done'
          ? h('button.btn.ghost.small', { type: 'button', onclick: () => setStatus('scheduled') }, '완료 취소')
          : h('button.btn.soft.small', { type: 'button', onclick: () => setStatus('done') }, icon('task_alt'), '작업 완료'),
        h('button.btn.danger.small', { type: 'button', onclick: remove }, job.source === 'quote' ? '일정 취소' : '삭제')) : null);
  };

  const save = async (btn) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { toast('날짜를 골라주세요.'); return; }
    if (!f.title.trim()) { toast('일 내용을 입력해주세요. 예) 입주청소 34평'); return; }
    if (toMin(f.start) + f.hours * 60 > 24 * 60) { toast('끝나는 시간이 자정을 넘어요. 시간을 확인해주세요.'); return; }
    btn.disabled = true;
    const data = clip({
      date: f.date, start: f.start, hours: Number(f.hours), crew: Number(f.crew), staffIds: [...new Set(f.staffIds)],
      title: f.title.trim(), place: f.place.trim(), customer: f.customer.trim(), phone: f.phone.trim(), memo: f.memo.trim(),
      source: f.source, status: job?.status || 'scheduled', updatedAt: serverTimestamp(),
    });
    try {
      if (job) await updateDoc(doc(db, 'shops', ctx.shopId, 'jobs', job.id), data);
      else await setDoc(doc(collection(db, 'shops', ctx.shopId, 'jobs')), { ...data, createdAt: serverTimestamp() });
      // 견적앱 일정이면 고객 견적서의 확정 안내도 같은 날짜·시간으로 (설계도 10-2장)
      const changed = job?.requestId ? await syncBooking({ ...job, ...data }).catch(() => false) : false;
      toast(changed ? '저장했어요. 고객 확정 안내도 바뀐 시간으로 고쳤어요 — 고객에게 다시 알려주세요.' : job ? '저장했어요.' : '일정을 등록했어요.', changed ? 4500 : 2200);
      ctx.st.date = f.date; // 다른 날로 등록했으면 그날로 이동
      close();
    } catch (e) { toast(`저장 실패: ${e.message}`); btn.disabled = false; }
  };
  const setStatus = async (status) => {
    try { await updateDoc(doc(db, 'shops', ctx.shopId, 'jobs', job.id), { status, updatedAt: serverTimestamp() }); toast(status === 'done' ? '완료로 표시했어요.' : '완료를 취소했어요.'); close(); }
    catch (e) { toast(`저장 실패: ${e.message}`); }
  };
  const remove = async () => {
    // 견적앱 일정은 지우지 않고 '취소'로 남긴다 → 같은 요청을 다시 계약확정해도 되살아나지 않음
    if (!confirm(job.source === 'quote' ? '이 일정을 취소할까요?' : '이 일정을 삭제할까요?')) return;
    try {
      if (job.source === 'quote') await updateDoc(doc(db, 'shops', ctx.shopId, 'jobs', job.id), { status: 'canceled', updatedAt: serverTimestamp() });
      else await deleteDoc(doc(db, 'shops', ctx.shopId, 'jobs', job.id));
      const changed = job.requestId ? await syncBooking(job, { canceled: true }).catch(() => false) : false;
      toast(changed ? '일정을 취소했어요. 고객 견적서에도 "취소"로 표시돼요 — 고객에게 연락해주세요.' : job.source === 'quote' ? '일정을 취소했어요.' : '일정을 삭제했어요.', changed ? 4500 : 2200); close();
    } catch (e) { toast(`실패: ${e.message}`); }
  };
  draw();
  document.body.append(dlg);
  dlg.showModal();
}
