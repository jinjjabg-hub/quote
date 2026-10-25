// 화면 공통 도우미 (DOM·이미지·클립보드)

export const $ = (sel, root = document) => root.querySelector(sel);

/** h('div.card', {onclick}, child1, 'text') 형태의 간단한 엘리먼트 생성기 */
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** root 의 내용을 바꾼다. replaceChildren 과 달리 null·false·중첩 배열을 h() 처럼 건너뛴다. */
export function setChildren(root, ...children) {
  root.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

export function toast(msg, ms = 2200) {
  let t = $('#toast');
  if (!t) { t = h('div.toast', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

export async function copyText(text, okMsg = '복사했어요. 카톡·문자에 붙여넣으세요.') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(okMsg);
}

/** 같은 폴더의 다른 페이지 절대 URL (GitHub Pages /quote/ 하위에서도 동작) */
export function pageUrl(page, params = {}) {
  const u = new URL(page, location.href);
  u.search = new URLSearchParams(params).toString();
  u.hash = '';
  return u.toString();
}

/** 사진 자동 압축: 긴 변 1600px, JPEG 0.8 → 보통 200~500KB */
export async function compressImage(file, maxSide = 1600, quality = 0.8) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const hgt = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = hgt;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, hgt);
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('이미지 변환 실패'))), 'image/jpeg', quality,
  ));
}

async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* 아래로 */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다'));
    img.src = URL.createObjectURL(file);
  });
}

export const STATUS = {
  new: { label: '신규', cls: 'st-new' },
  sent: { label: '발송완료', cls: 'st-sent' },
  booking_requested: { label: '계약요청', cls: 'st-req' },
  confirmed: { label: '계약확정', cls: 'st-ok' },
  hold: { label: '보류', cls: 'st-hold' },
};

export function statusBadge(status) {
  const s = STATUS[status] || { label: status, cls: '' };
  return h(`span.badge.${s.cls}`, {}, s.label);
}

/** Material Symbols 아이콘. 이름은 https://fonts.google.com/icons
 *  ★ 새 아이콘을 쓰면 HTML 4개(owner·q·view·dev)의 icon_names 목록에도 알파벳 순으로 추가 (쓰는 아이콘만 받아 가볍게) */
export function icon(name, fill = false) {
  return h(`span.ms${fill ? '.fill' : ''}`, { 'aria-hidden': 'true' }, name);
}

export function tsToDate(ts) {
  return ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
}

/** "15분 전" 같은 상대 시각 */
export function timeAgo(ts) {
  const d = tsToDate(ts);
  if (!d) return '';
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}시간 전`;
  if (m < 60 * 24 * 7) return `${Math.floor(m / 1440)}일 전`;
  return fmtDateTime(ts);
}

/** 목록에서 고객 이름 가리기 (김철수 → 김*수) */
export function maskName(name) {
  const s = String(name || '').trim();
  if (s.length <= 1) return s;
  if (s.length === 2) return `${s[0]}*`;
  return s[0] + '*'.repeat(s.length - 2) + s.at(-1);
}

/** 견적서 하단 표시 (설계도 12장 "견적서 하단 표시") */
export function footerNote(extra) {
  return h('p.footer-note', {}, h('b', {}, '견적by 비즈마이'), extra ? `\n${extra}` : null);
}

export function fmtDateTime(ts) {
  const d = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
  if (!d) return '';
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function optionLabel(field, value) {
  return field?.options?.find((o) => o.value === value)?.label ?? value;
}

export const MANDU_ID_RE = /^[a-z0-9_]{3,20}$/;

/** 만두 게스트 채팅 링크 (만두 ID 형식이 아니면 null) */
export function manduHref(base, manduId) {
  return MANDU_ID_RE.test(manduId || '') ? `${base}?u=${manduId}` : null;
}

export function telHref(phone) {
  return `tel:${String(phone || '').replace(/[^0-9+]/g, '')}`;
}

export function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

export function showFatal(msg) {
  const root = $('#app') || document.body;
  root.replaceChildren(h('div.card.error', {}, h('h2', {}, '문제가 생겼어요'), h('p', {}, msg)));
}
