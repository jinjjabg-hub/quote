// 개발자 모드 오류 패널 — 모든 화면에 포함되지만, 켜져 있을 때만 동작한다.
// 켜기: 주소 뒤에 ?dev=1 (한 번만 붙이면 이 브라우저에 기억됨) · 끄기: ?dev=0 또는 패널의 "끄기"
// dev.html(업종 시뮬레이터)에서는 항상 켜진다.
// 화면에서 일어난 오류·경고를 시간순으로 모아 보여주고, "전체 복사"로 그대로 전달할 수 있게 한다.
import { firebaseConfig } from './config.js';

const KEY = 'devMode';
const params = new URLSearchParams(location.search);
try {
  if (params.get('dev') === '1') localStorage.setItem(KEY, '1');
  if (params.get('dev') === '0') localStorage.removeItem(KEY);
} catch { /* 저장소 사용 불가 */ }

let stored = null;
try { stored = localStorage.getItem(KEY); } catch { /* 무시 */ }
export const devEnabled = stored === '1' || location.pathname.endsWith('/dev.html');

const logs = [];
let panel = null;
let badge = null;

function fmt(v) {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.code ? ` (${v.code})` : ''}`;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

/** 앱 코드에서 직접 기록할 때: devlog('info', '견적 발송', {id}) */
export function devlog(level, ...args) {
  if (!devEnabled) return;
  const stack = args.find((a) => a instanceof Error)?.stack || '';
  logs.push({ t: new Date(), level, msg: args.map(fmt).join(' '), stack });
  if (logs.length > 300) logs.shift();
  render();
}

function envText() {
  const emu = (() => { try { return localStorage.getItem('emulator') === '1'; } catch { return false; } })();
  return [
    `페이지: ${location.pathname.split('/').pop() || 'index.html'}`,
    `시각: ${new Date().toLocaleString('ko-KR')}`,
    `Firebase 프로젝트: ${emu ? 'demo-quote (에뮬레이터)' : firebaseConfig.projectId}`,
    `브라우저: ${navigator.userAgent}`,
    `화면: ${innerWidth}×${innerHeight}`,
  ].join('\n');
}

function allText() {
  return `[환경]\n${envText()}\n\n[기록 ${logs.length}건]\n${logs.map((l) => `${l.t.toLocaleTimeString('ko-KR')} [${l.level}] ${l.msg}${l.stack ? `\n${l.stack}` : ''}`).join('\n')}`;
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (k === 'class') n.className = v; else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

function render() {
  if (!badge) return;
  const errors = logs.filter((l) => l.level === 'error').length;
  badge.textContent = errors ? `🛠 오류 ${errors}` : `🛠 ${logs.length}`;
  badge.classList.toggle('has-error', errors > 0);
  if (panel && !panel.hidden) fillPanel();
}

function fillPanel() {
  const list = panel.querySelector('.dv-list');
  list.replaceChildren(...(logs.length ? logs.slice().reverse().map((l) => el('div', { class: `dv-row dv-${l.level}` },
    el('span', { class: 'dv-time' }, l.t.toLocaleTimeString('ko-KR')),
    el('span', { class: 'dv-level' }, { error: '오류', warn: '경고', info: '정보' }[l.level] || l.level),
    el('span', { class: 'dv-msg' }, l.msg),
    l.stack ? el('details', {}, el('summary', {}, '자세히'), el('pre', {}, l.stack)) : null)) : [el('p', { class: 'dv-empty' }, '아직 기록이 없습니다. 오류가 생기면 여기에 바로 나타납니다.')]));
  panel.querySelector('.dv-env').textContent = envText();
}

function mount() {
  const style = el('style', {}, `
.dv-badge{position:fixed;left:12px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:9999;border:0;border-radius:20px;padding:8px 12px;font:600 13px system-ui,sans-serif;background:#1e293b;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer}
.dv-badge.has-error{background:#dc2626}
.dv-panel{position:fixed;inset:auto 8px calc(8px + env(safe-area-inset-bottom,0px)) 8px;max-height:70vh;z-index:10000;background:#0f172a;color:#e2e8f0;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.4);display:flex;flex-direction:column;font:13px/1.5 system-ui,sans-serif;max-width:720px;margin:0 auto}
.dv-head{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid #334155;flex-wrap:wrap}
.dv-head b{flex:1;min-width:120px}
.dv-head button{border:1px solid #475569;background:#1e293b;color:#e2e8f0;border-radius:8px;padding:5px 10px;font:inherit;cursor:pointer}
.dv-list{overflow:auto;padding:6px 12px;flex:1}
.dv-row{display:grid;grid-template-columns:auto auto 1fr;gap:8px;padding:6px 0;border-bottom:1px solid #1e293b;word-break:break-all}
.dv-row details{grid-column:1/-1}.dv-row pre{white-space:pre-wrap;font-size:11px;color:#94a3b8;margin:4px 0}
.dv-time{color:#64748b}.dv-level{font-weight:700}.dv-error .dv-level{color:#f87171}.dv-warn .dv-level{color:#fbbf24}.dv-info .dv-level{color:#60a5fa}
.dv-env{white-space:pre-wrap;font-size:11px;color:#94a3b8;padding:8px 12px;border-top:1px solid #334155;margin:0;max-height:80px;overflow:auto}
.dv-empty{color:#94a3b8}`);
  badge = el('button', { class: 'dv-badge', type: 'button', 'aria-label': '개발자 오류 패널 열기', onclick: () => { panel.hidden = !panel.hidden; fillPanel(); } }, '🛠');
  panel = el('div', { class: 'dv-panel', role: 'dialog', 'aria-label': '개발자 모드 기록' },
    el('div', { class: 'dv-head' },
      el('b', {}, '🛠 개발자 모드 · 오류·경고 기록'),
      el('button', { type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(allText()); devlog('info', '기록을 복사했습니다'); } catch { prompt('아래 내용을 복사하세요', allText()); }
      } }, '전체 복사'),
      el('button', { type: 'button', onclick: () => { logs.length = 0; render(); fillPanel(); } }, '비우기'),
      location.pathname.endsWith('/dev.html') ? null : el('button', { type: 'button', onclick: () => { try { localStorage.removeItem(KEY); } catch { /* 무시 */ } location.reload(); } }, '개발자 모드 끄기'),
      el('button', { type: 'button', onclick: () => { panel.hidden = true; } }, '닫기')),
    el('div', { class: 'dv-list' }),
    el('pre', { class: 'dv-env' }));
  panel.hidden = true;
  document.head.append(style);
  document.body.append(badge, panel);
  render();
}

if (devEnabled) {
  addEventListener('error', (e) => devlog('error', e.error || e.message, e.filename ? `@ ${e.filename.split('/').pop()}:${e.lineno}` : ''));
  addEventListener('unhandledrejection', (e) => devlog('error', e.reason || '처리되지 않은 Promise 오류'));
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); devlog(level, ...args); };
  }
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
  devlog('info', '개발자 모드 켜짐');
}
