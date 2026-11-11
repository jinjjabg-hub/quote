// 운영자 화면 (admin.html) — 설계도 12장 ①단계: 입금 확인 후 업체 요금제를 수동으로 켠다.
// 운영자 = admins/{내 uid} 문서가 있는 계정 (Firebase 콘솔에서만 만든다). 권한 확인은 보안 규칙이 한다.
import {
  auth, db, isConfigured, signInWithGoogle, onAuthStateChanged, signOut, doc, collection, getDoc, getDocs, setDoc, serverTimestamp, Timestamp,
} from './firebase.js';
import { $, h, toast, registerSW, showFatal, setChildren, icon, copyText, tsToDate, fmtDateTime } from './util.js';
import { PLANS, PLAN_ORDER, effectivePlan, monthKey, won, untilText, extendUntil } from './plan.js';

registerSW();
const app = $('#app');
const S = { user: null, shops: [], q: '' };

if (!isConfigured) showFatal('Firebase 설정이 아직 없습니다.');
else onAuthStateChanged(auth, (u) => onUser(u).catch((e) => showFatal(e.message)));

async function onUser(user) {
  S.user = user;
  if (!user) {
    setChildren(app, h('section.card.center', { style: 'margin-top:40px;padding:32px 22px' },
      h('h1', {}, '운영자 화면'), h('p.muted', {}, '업체 요금제를 관리합니다.'),
      h('button.btn.primary.big.block', { onclick: () => signInWithGoogle().catch((e) => toast(`로그인 실패: ${e.message}`)) }, 'Google 계정으로 로그인')));
    return;
  }
  const me = await getDoc(doc(db, 'admins', user.uid)).catch(() => null);
  if (!me?.exists()) { renderNotAdmin(); return; }
  await load();
}

function renderNotAdmin() {
  const uid = S.user.uid;
  setChildren(app, h('section.card', { style: 'margin-top:24px' },
    h('h2', {}, '운영자 권한이 없어요'),
    h('p', {}, '처음 한 번만 Firebase 콘솔에서 이 계정을 운영자로 등록해주세요.'),
    h('ol.steps', {},
      h('li', {}, 'Firebase 콘솔 → Firestore Database → 데이터'),
      h('li', {}, '"컬렉션 시작" → 컬렉션 ID: admins'),
      h('li', {}, '문서 ID에 아래 계정 번호를 붙여넣기'),
      h('li', {}, '필드: name (문자열) = 운영자 → 저장 → 이 화면 새로고침')),
    h('div.box', {}, h('div.small.muted', {}, `내 계정 번호 (${S.user.email || ''})`), h('b.mono', {}, uid)),
    h('div.btn-col', {},
      h('button.btn.primary', { type: 'button', onclick: () => copyText(uid, '계정 번호를 복사했어요.') }, icon('content_copy'), '계정 번호 복사'),
      h('button.btn.ghost', { type: 'button', onclick: () => signOut(auth) }, '다른 계정으로 로그인'))));
}

async function load() {
  setChildren(app, h('p.muted.center', {}, '업체 목록을 불러오는 중…'));
  const month = monthKey();
  const snap = await getDocs(collection(db, 'shops'));
  S.shops = await Promise.all(snap.docs.map(async (d) => {
    const [p, u] = await Promise.all([
      getDoc(doc(db, 'shops', d.id, 'billing', 'plan')).catch(() => null),
      getDoc(doc(db, 'shops', d.id, 'usage', month)).catch(() => null),
    ]);
    const planDoc = p?.exists() ? p.data() : null;
    return { id: d.id, ...d.data(), planDoc, plan: effectivePlan(planDoc), used: u?.exists() ? Number(u.data().sent) || 0 : 0 };
  }));
  S.shops.sort((a, b) => (tsToDate(b.createdAt)?.getTime() || 0) - (tsToDate(a.createdAt)?.getTime() || 0));
  render();
}

function render() {
  const paid = S.shops.filter((s) => s.plan !== 'free');
  const revenue = paid.reduce((n, s) => n + PLANS[s.plan].price, 0);
  const q = S.q.trim().toLowerCase();
  const list = q ? S.shops.filter((s) => [s.name, s.ownerName, s.phone, s.id].some((v) => String(v || '').toLowerCase().includes(q))) : S.shops;
  setChildren(app,
    h('header.appbar', {},
      h('div.grow', {}, h('div.brand', {}, '비즈마이 견적'), h('div.title', {}, '운영자 · 요금제 관리')),
      h('button.avatar', { type: 'button', 'aria-label': '로그아웃', onclick: () => { if (confirm('로그아웃할까요?')) signOut(auth); } }, icon('logout'))),
    h('div.stats', {},
      h('div.stat', {}, h('div.stat-head', {}, '업체'), h('div.stat-num', {}, S.shops.length, h('small', {}, '곳'))),
      h('div.stat', {}, h('div.stat-head', {}, '유료'), h('div.stat-num.green', {}, paid.length, h('small', {}, '곳'))),
      h('div.stat', {}, h('div.stat-head', {}, '이번 달 견적 발송'), h('div.stat-num', {}, S.shops.reduce((n, s) => n + s.used, 0), h('small', {}, '건'))),
      h('div.stat', {}, h('div.stat-head', {}, '월 요금 합계'), h('div.stat-num.blue', {}, Math.round(revenue / 1000).toLocaleString('ko-KR'), h('small', {}, '천원')))),
    h('label.field', {}, h('input.input', { type: 'search', value: S.q, placeholder: '업체명·대표·연락처·계정 번호로 찾기', 'aria-label': '업체 찾기', oninput: (e) => { S.q = e.target.value; render(); $('input[type=search]')?.focus(); } })),
    list.length ? h('ul.admin-list', {}, list.map(renderShop)) : h('p.muted.center', {}, '업체가 없어요.'));
}

function renderShop(s) {
  const p = PLANS[s.plan];
  const until = untilText(s.planDoc);
  const expired = s.planDoc?.plan && s.planDoc.plan !== 'free' && s.plan === 'free';
  return h('li.admin-row', {},
    h('div.grow', {},
      h('div', {}, h('b', {}, s.name || '(업체명 없음)'), h(`span.badge${s.plan === 'free' ? '' : '.st-ok'}`, {}, p.name), expired ? h('span.badge.st-req', {}, '만료') : null),
      h('div.small.muted', {}, [s.ownerName, s.phone, `가입 ${fmtDateTime(s.createdAt) || '-'}`].filter(Boolean).join(' · ')),
      h('div.small', {}, `이번 달 발송 ${s.used}건`, until ? ` · ${until}` : '', s.planDoc?.note ? ` · ${s.planDoc.note}` : ''),
      h('div.small.muted.mono', {}, s.id)),
    h('button.btn.soft.small', { type: 'button', onclick: () => openPlanForm(s) }, '요금제 변경'));
}

function openPlanForm(s) {
  const f = { plan: s.plan === 'free' ? 'solo' : s.plan, months: 1, note: s.planDoc?.note || '' };
  const dlg = h('dialog.sheet', {});
  const close = () => { dlg.close(); dlg.remove(); };
  const draw = () => {
    const until = f.plan === 'free' || f.months === 0 ? null : extendUntil(f.plan === s.planDoc?.plan ? s.planDoc.until : null, f.months); // 같은 요금제면 남은 기간 뒤로
    setChildren(dlg,
      h('h2', {}, s.name || '(업체명 없음)'),
      h('p.small.muted', {}, `지금: ${PLANS[s.plan].name}${untilText(s.planDoc) ? ` (${untilText(s.planDoc)})` : ''}`),
      h('div.field', {}, h('span.label', {}, '요금제'),
        h('div.choices', {}, PLAN_ORDER.map((k) => h(`button.chip.small${f.plan === k ? '.on' : ''}`, { type: 'button', onclick: () => { f.plan = k; draw(); } }, `${PLANS[k].name} ${PLANS[k].price ? won(PLANS[k].price).replace('월 ', '') : ''}`)))),
      f.plan === 'free' ? null : h('div.field', {}, h('span.label', {}, '기간 (남은 기간이 있으면 그 뒤로 이어짐)'),
        h('div.choices', {}, [[1, '1개월'], [3, '3개월'], [12, '12개월'], [0, '기한 없음']].map(([m, l]) => h(`button.chip.small${f.months === m ? '.on' : ''}`, { type: 'button', onclick: () => { f.months = m; draw(); } }, l)))),
      f.plan === 'free' ? null : h('p', {}, until ? `→ ${untilText({ until })}` : '→ 기한 없음 (직접 끌 때까지)'),
      h('label.field', {}, h('span.label', {}, '메모 (입금 내역 등)'),
        h('input.input', { value: f.note, maxLength: 200, placeholder: '예) 11/5 49,000원 입금 (홍길동)', oninput: (e) => { f.note = e.target.value; } })),
      h('div.btn-row', {},
        h('button.btn.ghost', { type: 'button', onclick: close }, '닫기'),
        h('button.btn.primary', { type: 'button', onclick: (e) => save(e.currentTarget, until) }, '저장')));
  };
  const save = async (btn, until) => {
    btn.disabled = true;
    try {
      await setDoc(doc(db, 'shops', s.id, 'billing', 'plan'), {
        plan: f.plan, until: until ? Timestamp.fromMillis(until) : null, note: f.note.trim(), updatedAt: serverTimestamp(), updatedBy: S.user.uid,
      });
      toast(`${s.name || '업체'}: ${PLANS[f.plan].name} 요금제로 바꿨어요.`);
      close();
      await load();
    } catch (e) { toast(`저장 실패: ${e.message}`, 4000); btn.disabled = false; }
  };
  draw();
  document.body.append(dlg);
  dlg.showModal();
}
