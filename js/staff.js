// 직원 화면 (staff.html) — 설계도 10-1장 ①단계
// 사장님이 보낸 초대 링크(staff.html?shop=…&s=…&k=…)로 열고 구글 로그인 → 내 계정 연결 →
// 정규 직원은 개인 휴무일, 프리랜서는 일할 수 있는 날을 달력에서 직접 고른다.
import {
  auth, db, isConfigured, signInWithGoogle, onAuthStateChanged, signOut, doc, getDoc, updateDoc, onSnapshot, serverTimestamp,
} from './firebase.js';
import { $, h, toast, registerSW, showFatal, setChildren, icon, footerNote } from './util.js';
import { toDateStr } from './calc.js';
import { pushReady, pushState, enablePush, thisDeviceToken } from './push.js';
import { WEEKDAYS, dayOfWeek, monthDates, workStatus, toggleDay, pruneDates, shiftDate } from './schedule.js';

registerSW();

const app = $('#app');
const LINK_KEY = 'staffLink';
const params = new URLSearchParams(location.search);
const S = { user: null, shopId: '', staffId: '', shopName: '', me: null, month: toDateStr(new Date()).slice(0, 7), unsub: null };

if (!isConfigured) showFatal('Firebase 설정이 아직 없습니다.');
else onAuthStateChanged(auth, (u) => onUser(u).catch((e) => showFatal(e.message)));

function savedLink() {
  try { return JSON.parse(localStorage.getItem(LINK_KEY) || 'null'); } catch { return null; }
}

async function onUser(user) {
  S.unsub?.(); S.unsub = null;
  S.user = user;
  const fromUrl = { shop: params.get('shop') || '', s: params.get('s') || '' };
  const link = fromUrl.shop && fromUrl.s ? fromUrl : savedLink();
  if (!link?.shop || !link?.s) {
    setChildren(app, h('section.card.center', { style: 'margin-top:40px' },
      h('h1', {}, '직원 화면'), h('p.muted', {}, '사장님께 받은 초대 링크로 열어주세요.')));
    return;
  }
  S.shopId = link.shop; S.staffId = link.s;
  const shop = await getDoc(doc(db, 'shops', S.shopId)).catch(() => null);
  S.shopName = shop?.exists() ? shop.data().name || '' : '';
  if (!user) { renderLogin(); return; }

  const ref = doc(db, 'shops', S.shopId, 'staff', S.staffId);
  const token = params.get('k');
  if (token) {
    // 초대 값이 맞을 때만 내 계정이 연결된다 (보안 규칙이 확인). 이미 내 계정이면 그냥 지나감
    await updateDoc(ref, { uid: user.uid, inviteProof: token, linkedAt: serverTimestamp() }).catch(() => {});
    history.replaceState(null, '', `staff.html?shop=${encodeURIComponent(S.shopId)}&s=${encodeURIComponent(S.staffId)}`);
  }
  try { localStorage.setItem(LINK_KEY, JSON.stringify({ shop: S.shopId, s: S.staffId })); } catch { /* 무시 */ }
  S.unsub = onSnapshot(ref, (snap) => {
    S.me = { id: snap.id, ...snap.data() };
    render();
  }, () => {
    setChildren(app, h('section.card', { style: 'margin-top:24px' },
      h('h2', {}, '연결할 수 없어요'),
      h('p', {}, '초대 링크가 맞지 않거나, 이미 다른 구글 계정에 연결된 직원이에요.'),
      h('p.muted.small', {}, `지금 로그인: ${user.email || ''}`),
      h('div.btn-col', {},
        h('button.btn.ghost', { type: 'button', onclick: () => signOut(auth) }, '다른 계정으로 로그인'),
        h('p.muted.small', {}, '계속 안 되면 사장님께 새 초대 링크를 요청하세요.'))));
  });
}

function renderLogin() {
  setChildren(app, h('section.card.center', { style: 'margin-top:40px;padding:32px 22px' },
    h('div.brand', { style: 'color:var(--primary);font-weight:700' }, S.shopName || '비즈마이 견적'),
    h('h1', {}, '근무 일정 등록'),
    h('p.muted', {}, '구글로 로그인하면 내 휴무일을 직접 정할 수 있어요.\n일정이 배정되면 이 화면으로 알려드려요.'),
    h('button.btn.primary.big.block', { onclick: () => signInWithGoogle().catch((e) => toast(`로그인 실패: ${e.message}`)) }, 'Google 계정으로 시작하기')),
  footerNote());
}

function render() {
  const me = S.me;
  if (!me?.name) return;
  const today = toDateStr(new Date());
  const free = me.type === 'freelancer';
  const days = monthDates(S.month);
  const lead = dayOfWeek(days[0]);
  const worked = days.filter((d) => workStatus(me, d).working).length;
  const moveMonth = (n) => {
    const d = shiftDate(`${S.month}-15`, n * 30);
    S.month = d.slice(0, 7); render();
  };
  const cell = (d) => {
    const w = workStatus(me, d);
    const past = d < today;
    const fixed = w.reason === '정기 휴무';
    const cls = w.working ? 'on' : fixed ? 'fixed' : 'off';
    return h(`button.cal-day.${cls}${d === today ? '.today' : ''}`, {
      type: 'button', disabled: past || fixed,
      'aria-label': `${d} ${w.working ? '근무' : w.reason}`,
      onclick: () => toggle(d),
    }, h('span.n', {}, Number(d.slice(8))), h('span.t', {}, w.working ? '근무' : fixed ? '정휴' : free ? '' : '휴무'));
  };
  setChildren(app,
    h('header.appbar', {},
      h('div.grow', {}, h('div.brand', {}, S.shopName || '비즈마이 견적'), h('div.title', {}, `${me.name}님 근무 일정`)),
      h('button.avatar', { type: 'button', title: '로그아웃', 'aria-label': '로그아웃', onclick: () => { if (confirm('로그아웃할까요?')) signOut(auth); } }, icon('logout'))),
    renderPush(me),
    h('div.notice', {}, free
      ? h('p', {}, h('b', {}, '일할 수 있는 날을 눌러 주세요.'), '\n누른 날만 일정 배정 대상이 돼요. 다시 누르면 취소돼요.')
      : h('p', {}, h('b', {}, '쉬고 싶은 날을 눌러 주세요.'), `\n정기 휴무: ${(me.weeklyOff || []).length ? [...me.weeklyOff].sort().map((i) => WEEKDAYS[i]).join('·') : '없음'} (사장님 설정)`)),
    h('section.card', {},
      h('div.sched-nav', {},
        h('button.btn.soft.icon', { type: 'button', 'aria-label': '이전 달', onclick: () => moveMonth(-1) }, icon('chevron_left')),
        h('div.grow.center', {}, h('b', {}, `${S.month.slice(0, 4)}년 ${Number(S.month.slice(5))}월`), h('div.small.muted', {}, `근무 ${worked}일`)),
        h('button.btn.soft.icon', { type: 'button', 'aria-label': '다음 달', onclick: () => moveMonth(1) }, icon('chevron_right'))),
      h('div.cal', {},
        WEEKDAYS.map((w, i) => h(`div.cal-head${i === 0 || i === 6 ? '.we' : ''}`, {}, w)),
        Array.from({ length: lead }, () => h('div.cal-blank')),
        days.map(cell)),
      h('p.small.muted', {}, free ? '파란 칸 = 일할 수 있는 날' : '파란 칸 = 근무 · 회색 = 휴무 · 정휴 = 정기 휴무(사장님만 변경)')),
    h('p.footer-note', {}, '일정이 배정·변경·취소되면 휴대폰 알림으로 알려드려요.'));
}

// 일정 알림 받기 (설계도 10-1장 ③단계)
function renderPush(me) {
  if (!pushReady()) return null; // 사장님 쪽 알림 설정 전
  const st = pushState();
  const on = st === 'granted' && (me.pushTokens || []).includes(thisDeviceToken());
  const card = (cls, ic, title, ...rest) => h(`section.card.push-card.${cls}`, {}, h('div.push-head', {}, icon(ic, cls === 'on'), h('b', {}, title)), ...rest);
  if (on) return card('on', 'notifications_active', '이 휴대폰으로 일정 알림을 받고 있어요');
  if (st === 'ios-install') {
    return card('off', 'notifications_off', '아이폰은 홈 화면에 추가해야 알림을 받아요',
      h('p.small', {}, '사파리 아래 공유 버튼(□↑) → "홈 화면에 추가" → 홈 화면의 "근무" 앱을 열고 여기서 "알림 받기"를 눌러주세요. (iOS 16.4 이상)'));
  }
  if (st === 'unsupported') return card('off', 'notifications_off', '이 브라우저는 알림을 지원하지 않아요', h('p.small', {}, '크롬이나 삼성 인터넷으로 이 링크를 열어주세요.'));
  if (st === 'denied') return card('off', 'notifications_off', '알림이 차단돼 있어요', h('p.small', {}, '휴대폰 설정 → 알림 → 이 앱(또는 브라우저)의 알림을 켠 뒤 다시 열어주세요.'));
  return card('off', 'notifications', '일정이 배정되면 알림으로 받을까요?',
    h('p.small', {}, '새 일정·시간 변경·취소를 바로 알려드려요.'),
    h('button.btn.primary.block', {
      type: 'button',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await enablePush(S.shopId, S.staffId, me.pushTokens || []); toast('알림을 켰어요.'); render(); }
        catch (err) { toast(err.message, 4000); render(); }
      },
    }, icon('notifications'), '알림 받기'));
}

async function toggle(d) {
  const t = toggleDay(S.me, d);
  if (!t) return;
  try {
    await updateDoc(doc(db, 'shops', S.shopId, 'staff', S.staffId), { [t.field]: pruneDates(t.value, toDateStr(new Date())), updatedAt: serverTimestamp() });
  } catch (e) { toast(`저장 실패: ${e.message}`); }
}
