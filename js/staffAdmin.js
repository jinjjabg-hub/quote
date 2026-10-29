// 사장님 화면 "일정" 탭 — ①단계: 직원·근무 설정 (설계도 10-1장). 일정(②단계)은 jobsAdmin.js
// 날짜별 출근 명단, 7일 근무표(칸을 누르면 개인 휴무/프리랜서 가능일 전환), 직원 등록·수정, 초대 링크.
import { db, doc, collection, setDoc, updateDoc, onSnapshot, serverTimestamp } from './firebase.js';
import { h, icon, toast, copyText, pageUrl, setChildren } from './util.js';
import { toDateStr } from './calc.js';
import { renderJobs } from './jobsAdmin.js';
import { WEEKDAYS, dayOfWeek, shiftDate, dateRange, workStatus, roster, toggleDay, pruneDates, newToken } from './schedule.js';

const today = () => toDateStr(new Date());
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const dayLabel = (d) => `${d.slice(0, 4)}.${md(d).replace('/', '.')} (${WEEKDAYS[dayOfWeek(d)]})`;

/** 직원 목록 실시간 구독. 정렬: 재직 → 정규 → 이름 */
export function subscribeStaff(shopId, onChange) {
  return onSnapshot(collection(db, 'shops', shopId, 'staff'), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.active === false) - (b.active === false) || (a.type === 'freelancer') - (b.type === 'freelancer') || String(a.name).localeCompare(b.name, 'ko'));
    onChange(list);
  }, (e) => toast(`직원 목록을 불러오지 못했습니다: ${e.message}`, 4000));
}

/**
 * @param ctx { shopId, shopName, staff: [] | null, jobs: [] | null, st: { date, view }, rerender }
 * view: 'jobs' 일정(②단계) | 'staff' 직원·근무(①단계)
 */
export function renderSchedule(ctx) {
  const { staff, st } = ctx;
  st.date = st.date || today();
  st.view = st.view || 'jobs';
  if (!staff) return h('p.muted.center', {}, '직원 목록을 불러오는 중…');
  const go = (n) => { st.date = n === 0 ? today() : shiftDate(st.date, n); ctx.rerender(); };
  const views = [['jobs', '일정', 'event'], ['staff', '직원·근무', 'group']];

  return h('section', {},
    h('div.choices.view-tabs', { role: 'tablist' }, views.map(([k, l, ic]) => h(`button.chip.small${st.view === k ? '.on' : ''}`, {
      type: 'button', role: 'tab', 'aria-selected': st.view === k, onclick: () => { st.view = k; ctx.rerender(); },
    }, icon(ic), l))),
    h('div.card', {},
      h('div.sched-nav', {},
        h('button.btn.soft.icon', { type: 'button', 'aria-label': '전날', onclick: () => go(-1) }, icon('chevron_left')),
        h('div.grow.center', {}, h('b', {}, dayLabel(st.date)), st.date === today() ? h('div.small.muted', {}, '오늘') : null),
        h('button.btn.soft.icon', { type: 'button', 'aria-label': '다음날', onclick: () => go(1) }, icon('chevron_right'))),
      h('div.sched-jump', {},
        st.date !== today() ? h('button.link', { type: 'button', onclick: () => go(0) }, '오늘로') : null,
        h('input.input.small', { type: 'date', value: st.date, 'aria-label': '날짜 바로 가기', onchange: (e) => { if (e.target.value) { st.date = e.target.value; ctx.rerender(); } } })),
      st.view === 'staff' ? renderRoster(staff, st.date) : null),
    st.view === 'jobs' ? renderJobs(ctx) : renderStaffView(ctx));
}

function renderRoster(staff, date) {
  const active = staff.filter((s) => s.active !== false);
  const r = roster(staff, date);
  return [
    h('div.sched-count', {}, h('span', {}, '출근'), h('b', {}, `${r.working.length}명`), h('span.muted', {}, ` / 재직 ${active.length}명`)),
    r.working.length
      ? h('div.staff-chips', {}, r.working.map((s) => h('span.staff-chip', {}, s.name, s.type === 'freelancer' ? h('span.mini-tag', {}, '프리') : null)))
      : h('p.muted.small', {}, active.length ? '이날 출근하는 사람이 없어요.' : '아래에서 직원을 먼저 등록하세요.'),
    r.off.length ? h('div.off-list', {}, h('div.small.muted', {}, '쉬는 사람'),
      r.off.map((o) => h('div.off-row', {}, h('span', {}, o.staff.name), h('span.muted.small', {}, o.reason)))) : null,
  ];
}

function renderStaffView(ctx) {
  const { staff } = ctx;
  const active = staff.filter((s) => s.active !== false);
  return h('div', {},
    active.length ? renderWeek(ctx, active) : null,
    h('div.section-head', {}, h('h2', {}, icon('group'), ' 직원 ', h('span.pill-count', {}, active.length)),
      h('button.btn.primary.small', { type: 'button', onclick: () => openStaffForm(ctx, null) }, icon('person_add'), '직원 추가')),
    staff.length ? h('ul.staff-list', {}, staff.map((s) => renderStaffRow(ctx, s)))
      : h('div.card.empty', {}, h('p', {}, h('b', {}, '등록된 직원이 없어요.')),
        h('p.muted', {}, '정규 직원은 정기 휴무 요일을, 프리랜서는 일할 수 있는 날을 기준으로 출근을 계산해요.')),
    h('p.footer-note', {}, '직원에게 초대 링크를 보내면 본인이 휴무일(프리랜서는 가능일)을 직접 설정할 수 있어요.\n배정된 직원에게 알림 보내기는 다음 단계에서 붙습니다.'));
}

// 7일 근무표: 칸을 누르면 정규는 개인 휴무, 프리랜서는 가능일을 켜고 끈다 (정기 휴무 요일은 직원 정보에서)
function renderWeek(ctx, active) {
  const days = dateRange(ctx.st.date, 7);
  const cell = (s, d) => {
    const w = workStatus(s, d);
    const fixed = w.reason === '정기 휴무';
    const text = w.working ? '근무' : w.reason === '정기 휴무' ? '정휴' : w.reason === '개인 휴무' ? '휴무' : '—';
    return h('td', {}, h(`button.wk-cell.${w.working ? 'on' : fixed ? 'fixed' : 'off'}`, {
      type: 'button', disabled: fixed, title: `${s.name} ${d} ${w.working ? '근무' : w.reason}`,
      'aria-label': `${s.name} ${md(d)} ${w.working ? '근무' : w.reason}`,
      onclick: () => saveToggle(ctx.shopId, s, d),
    }, text));
  };
  return h('div.card.week-card', {},
    h('div.card-title', {}, icon('calendar_month'), h('span.grow', {}, '7일 근무표'), h('span.aside', {}, '칸을 누르면 휴무·가능일 전환')),
    h('div.week-scroll', {}, h('table.week', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), days.map((d) => h(`th${[0, 6].includes(dayOfWeek(d)) ? '.we' : ''}`, {}, md(d), h('div', {}, WEEKDAYS[dayOfWeek(d)]))))),
      h('tbody', {},
        active.map((s) => h('tr', {}, h('th.nm', {}, s.name, s.type === 'freelancer' ? h('span.mini-tag', {}, '프리') : null), days.map((d) => cell(s, d)))),
        h('tr.total', {}, h('th.nm', {}, '출근'), days.map((d) => h('td', {}, h('b', {}, roster(active, d).working.length))))))),
    h('p.small.muted', {}, '정휴 = 정기 휴무 요일 · 휴무 = 개인 휴무 · — = 프리랜서 가능일 아님'));
}

async function saveToggle(shopId, s, d) {
  const t = toggleDay(s, d);
  if (!t) return;
  try {
    await updateDoc(doc(db, 'shops', shopId, 'staff', s.id), { [t.field]: pruneDates(t.value, today()), updatedAt: serverTimestamp() });
  } catch (e) { toast(`저장 실패: ${e.message}`); }
}

function renderStaffRow(ctx, s) {
  const off = s.type === 'freelancer' ? '프리랜서 · 가능일 기준' : `정기 휴무 ${(s.weeklyOff || []).length ? [...s.weeklyOff].sort().map((i) => WEEKDAYS[i]).join('·') : '없음'}`;
  return h(`li.staff-row${s.active === false ? '.inactive' : ''}`, {},
    h('div.grow', {},
      h('div', {}, h('b', {}, s.name), s.active === false ? h('span.badge', {}, '퇴사·비활성') : null,
        s.uid ? h('span.badge.st-ok', {}, '연결됨') : h('span.badge', {}, '미연결')),
      h('div.small.muted', {}, [off, s.phone].filter(Boolean).join(' · '))),
    s.uid || s.active === false ? null : h('button.btn.soft.small', { type: 'button', onclick: () => copyInvite(ctx, s) }, icon('link'), '초대 링크'),
    h('button.btn.ghost.small', { type: 'button', onclick: () => openStaffForm(ctx, s) }, '수정'));
}

export function inviteUrl(shopId, s) {
  return pageUrl('staff.html', { shop: shopId, s: s.id, k: s.inviteToken });
}

function copyInvite(ctx, s) {
  const msg = `[${ctx.shopName || '업체'}] ${s.name}님 근무 등록 링크입니다.\n열어서 구글로 로그인하면 ${s.type === 'freelancer' ? '일할 수 있는 날' : '휴무일'}을 직접 설정할 수 있어요.\n${inviteUrl(ctx.shopId, s)}`;
  copyText(msg, '초대 문구와 링크를 복사했어요. 카톡·문자로 보내세요.');
}

// 직원 등록·수정 (아래에서 올라오는 창)
function openStaffForm(ctx, s) {
  const f = { name: s?.name || '', phone: s?.phone || '', type: s?.type || 'employee', weeklyOff: [...(s?.weeklyOff || [])], memo: s?.memo || '', active: s?.active !== false };
  const dlg = h('dialog.sheet.staff-form', {});
  const draw = () => {
    setChildren(dlg, // replaceChildren 은 null 을 글자로 찍으므로 빈 값을 건너뛰는 setChildren
      h('h2', {}, s ? '직원 정보 수정' : '직원 추가'),
      h('label.field', {}, h('span.label', {}, '이름', h('span.req', {}, ' *')),
        h('input.input', { value: f.name, maxLength: 30, placeholder: '예) 김정규', oninput: (e) => { f.name = e.target.value; } })),
      h('label.field', {}, h('span.label', {}, '연락처'),
        h('input.input', { type: 'tel', value: f.phone, maxLength: 30, placeholder: '010-0000-0000', oninput: (e) => { f.phone = e.target.value; } })),
      h('div.field', {}, h('span.label', {}, '구분'),
        h('div.choices', {}, [['employee', '정규 직원'], ['freelancer', '프리랜서']].map(([v, l]) => h(`button.chip${f.type === v ? '.on' : ''}`, {
          type: 'button', onclick: () => { f.type = v; draw(); },
        }, l)))),
      f.type === 'employee'
        ? h('div.field', {}, h('span.label', {}, '정기 휴무 요일', h('span.muted', {}, ' (주 5일이면 2개)')),
          h('div.choices.days', {}, WEEKDAYS.map((w, i) => h(`button.chip${f.weeklyOff.includes(i) ? '.on' : ''}`, {
            type: 'button', 'aria-pressed': f.weeklyOff.includes(i),
            onclick: () => { f.weeklyOff = f.weeklyOff.includes(i) ? f.weeklyOff.filter((x) => x !== i) : [...f.weeklyOff, i]; draw(); },
          }, w))),
          h('span.hint', {}, '개인 휴무일은 직원 본인이 직원 화면에서 추가할 수 있어요.'))
        : h('p.notice.small', {}, '프리랜서는 본인이 직원 화면에서 "일할 수 있는 날"을 고른 날만 출근으로 계산해요.'),
      h('label.field', {}, h('span.label', {}, '메모'),
        h('input.input', { value: f.memo, maxLength: 200, placeholder: '예) 에어컨 분해 가능, 운전 가능', oninput: (e) => { f.memo = e.target.value; } })),
      s ? h('label.toggle', {}, h('input', { type: 'checkbox', checked: f.active, onchange: (e) => { f.active = e.target.checked; draw(); } }),
        f.active ? icon('check') : null, '재직 중 (끄면 출근 계산에서 빠짐)') : null,
      h('div.btn-row', {},
        h('button.btn.ghost', { type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, '취소'),
        h('button.btn.primary', { type: 'button', onclick: (e) => save(e.currentTarget) }, '저장')));
  };
  const save = async (btn) => {
    const name = f.name.trim();
    if (!name) { toast('이름을 입력해주세요.'); return; }
    btn.disabled = true;
    const data = {
      name, phone: f.phone.trim(), type: f.type, weeklyOff: f.type === 'employee' ? [...f.weeklyOff].sort() : [],
      memo: f.memo.trim(), active: f.active, updatedAt: serverTimestamp(),
    };
    try {
      if (s) await updateDoc(doc(db, 'shops', ctx.shopId, 'staff', s.id), data);
      else {
        await setDoc(doc(collection(db, 'shops', ctx.shopId, 'staff')), {
          ...data, offDates: [], availDates: [], inviteToken: newToken(), uid: null, createdAt: serverTimestamp(),
        });
      }
      toast(s ? '저장했어요.' : `${name}님을 등록했어요. "초대 링크"를 보내 연결하세요.`);
      dlg.close(); dlg.remove();
      ctx.rerender(); // 창이 열려 있는 동안 미뤄둔 목록 갱신
    } catch (e) { toast(`저장 실패: ${e.message}`); btn.disabled = false; }
  };
  draw();
  document.body.append(dlg);
  dlg.showModal();
}
