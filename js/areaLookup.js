// 주소 → 평수 자동 조회 화면 (설계도 4-4장). 고객 화면(q.js)과 업종 시뮬레이터(dev.js)가 같이 쓴다.
// 서버 함수 areaLookup 만 부른다. 인증키는 서버(Secret Manager)에만 있고 이 파일·브라우저에는 없다.
//
// 흐름: [주소로 평수 찾기] → 단지 검색 → 동 → 호 → "공급 약 34평 맞나요?" → [맞아요] 평수 칸에 입력 / [직접 입력]
// 어느 단계든 실패하면 "직접 입력"으로 자연스럽게 넘어간다. 평수 칸은 언제나 직접 고칠 수 있다.
import { areaLookupConfig } from './config.js';
import { h, icon } from './util.js';

const TIMEOUT_MS = 10000;

/** 화면 표시용: "1203" → "1203호", "101" → "101동" (저장은 받은 그대로) */
export const unitLabel = (v, suffix) => (v && /\d$/.test(v) ? `${v}${suffix}` : v || '');
export const placeLabel = (x) => [x?.bdNm, unitLabel(x?.dongNm, '동'), unitLabel(x?.hoNm, '호')].filter(Boolean).join(' ');

/** 고객 화면에서 버튼을 보일지: 설정에서 켰거나, 사장님이 켜기 전에 q.html?...&lookup=1 로 시험할 때 */
export function lookupEnabled(params = new URLSearchParams(location.search)) {
  return !!areaLookupConfig.url && (areaLookupConfig.enabled || params.get('lookup') === '1');
}

export class AreaLookupFail extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

export async function callArea(action, payload = {}) {
  if (!areaLookupConfig.url) throw new AreaLookupFail('off', '평수 조회 주소가 설정되지 않았습니다 (js/config.js).');
  let res;
  try {
    res = await fetch(areaLookupConfig.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...payload }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AreaLookupFail('network', '조회 서버에 연결하지 못했습니다.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 아래에서 처리 */ }
  if (!data?.ok) throw new AreaLookupFail(data?.reason || 'server', data?.message || `조회에 실패했습니다 (${res.status}).`);
  return data;
}

export function newLookupState() {
  return { open: false, stage: 'search', keyword: '', items: [], sel: null, dongs: [], dong: '', hos: [], ho: '', house: null, part: null, units: 1, result: null, busy: false, error: '' };
}

/**
 * 조회 패널. ls: newLookupState() 로 만든 상태(호출하는 쪽이 보관), applied: 이미 적용한 조회 결과(있으면 요약 표시)
 * opts.rerender(): 다시 그리기, opts.onApply(info): 평수 적용, opts.onManual(): 직접 입력, opts.debug: 항목별 면적 표(dev.html)
 */
export function renderLookupPanel(ls, applied, opts) {
  const { rerender, onApply, onManual, debug = false } = opts;
  const redraw = () => rerender();
  const run = async (fn) => {
    ls.busy = true; ls.error = ''; redraw();
    try { await fn(); } catch (e) {
      ls.stage = 'fail';
      ls.error = e?.message || '조회에 실패했습니다.';
      if (debug) ls.errorReason = e?.reason;
    }
    ls.busy = false; redraw();
  };
  const reset = () => Object.assign(ls, newLookupState(), { open: true, keyword: ls.keyword });
  const manual = () => { Object.assign(ls, newLookupState()); onManual?.(); redraw(); };

  const search = () => run(async () => {
    const { items } = await callArea('search', { keyword: ls.keyword });
    ls.items = items; ls.stage = 'pick';
  });
  const loadHos = (dong) => run(async () => {
    ls.dong = dong;
    const { hos } = await callArea('hos', { ref: ls.sel.ref, dongNm: dong });
    ls.hos = hos; ls.stage = 'ho';
  });
  // 일반주택(단독·다가구): 호별 면적이 없어 표제부(연면적)·층별개요(층 면적)로 "집 전체" 또는 "○층 ÷ 집 수"
  const loadHouse = async () => {
    const r = await callArea('house', { ref: ls.sel.ref });
    ls.house = r;
    if (!r.floors.length || (r.groundFloors <= 1 && r.households <= 1)) { houseResult(null, 1); return; }
    ls.stage = 'house';
  };
  const houseResult = (floor, units) => {
    const r = ls.house;
    const m2 = floor ? Math.round((floor.m2 / units) * 100) / 100 : r.totalM2;
    ls.part = floor ? floor.label : '집 전체';
    ls.units = units;
    ls.result = { kind: 'house', m2, pyeong: Math.round((m2 / 3.305785) * 10) / 10, floorM2: floor?.m2, purpose: r.purpose };
    ls.stage = 'result';
  };
  const pickFloor = (floor) => {
    ls.floor = floor;
    const r = ls.house;
    ls.units = r.households && r.groundFloors ? Math.min(4, Math.max(1, Math.round(r.households / r.groundFloors))) : 1;
    ls.stage = 'houseUnits'; redraw();
  };
  const pickBuilding = (item) => run(async () => {
    ls.sel = item;
    if (!item.apt) { await loadHouse(); return; } // 공동주택이 아님 (단독·다가구)
    const { dongs } = await callArea('dongs', { ref: item.ref });
    ls.dongs = dongs;
    if (dongs.length) { ls.stage = 'dong'; return; }
    ls.dong = '';
    try {
      const { hos } = await callArea('hos', { ref: item.ref, dongNm: '' }); // 동이 없는 건물 (오피스텔·나홀로 아파트)
      ls.hos = hos; ls.stage = 'ho';
    } catch (e) {
      if (e?.reason !== 'no_units') throw e;
      await loadHouse(); // 호 정보가 없는 건물 → 일반주택 방식으로
    }
  });
  const pickHo = (ho) => run(async () => {
    ls.ho = ho;
    const r = await callArea('area', { ref: ls.sel.ref, dongNm: ls.dong, hoNm: ho });
    ls.result = r; ls.stage = 'result';
  });

  // 닫힌 상태: 버튼 (+ 적용한 결과 요약)
  if (!ls.open) {
    return h('div.area-lookup', {},
      applied ? h('div.lookup-applied', {}, icon('verified', true),
        h('div', {}, h('b', {}, '건축물대장으로 확인했어요'),
          h('div.small', {}, appliedText(applied)))) : null,
      h('button.btn-lookup', { type: 'button', onclick: () => { ls.open = true; ls.stage = 'search'; redraw(); setTimeout(() => document.querySelector('.lookup-input')?.focus(), 0); } },
        icon('search'), applied ? '다른 주소로 다시 찾기' : '주소로 평수 찾기'),
      applied ? null : h('p.lookup-note', {}, '아파트·빌라·주택 모두 주소만 고르면 건축물대장으로 평수를 찾아드려요.'));
  }

  const crumbs = [ls.sel?.bdNm || ls.sel?.roadAddr, unitLabel(ls.dong, '동'), unitLabel(ls.ho, '호'),
    ls.stage === 'houseUnits' ? ls.floor?.label : ls.stage === 'result' && ls.result?.kind === 'house' ? ls.part : ''].filter(Boolean);
  const body = [];
  if (ls.busy) body.push(h('p.lookup-busy', { role: 'status' }, h('span.spinner', { 'aria-hidden': 'true' }), '찾는 중…'));
  else if (ls.stage === 'search' || ls.stage === 'pick') {
    body.push(h('div.lookup-search', {},
      h('input.input.lookup-input', {
        type: 'search', value: ls.keyword, placeholder: '예) 가야대로 팍스타운', maxLength: 60, enterKeyHint: 'search', 'aria-label': '단지명 또는 도로명',
        oninput: (e) => { ls.keyword = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); search(); } },
      }),
      h('button.btn.primary.small', { type: 'button', onclick: search }, '검색')));
    if (ls.stage === 'pick') {
      body.push(h('div.lookup-list', {}, ls.items.map((it) => h('button.lookup-item', { type: 'button', onclick: () => pickBuilding(it) },
        icon(it.apt ? 'apartment' : 'home'), h('span', {}, h('b', {}, it.bdNm || it.roadAddr), h('span.small', {}, it.bdNm ? it.roadAddr : it.jibunAddr || ''))))));
    } else body.push(h('p.lookup-note', {}, '단지명이나 도로명 주소를 입력하세요.'));
  } else if (ls.stage === 'dong') {
    body.push(h('p.lookup-q', {}, '몇 동인가요?'),
      h('div.lookup-grid', {}, ls.dongs.map((d) => h('button.lookup-chip', { type: 'button', onclick: () => loadHos(d) }, unitLabel(d, '동')))));
  } else if (ls.stage === 'ho') {
    body.push(h('p.lookup-q', {}, '몇 호인가요?'));
    if (ls.hos.length > 24) {
      body.push(h('select.input', { 'aria-label': '호수', onchange: (e) => e.target.value && pickHo(e.target.value) },
        h('option', { value: '' }, '호수를 고르세요'),
        ls.hos.map((x) => h('option', { value: x.hoNm }, unitLabel(x.hoNm, '호')))));
    } else {
      body.push(h('div.lookup-grid', {}, ls.hos.map((x) => h('button.lookup-chip', { type: 'button', onclick: () => pickHo(x.hoNm) }, unitLabel(x.hoNm, '호')))));
    }
  } else if (ls.stage === 'house') {
    const r = ls.house;
    body.push(h('p.lookup-q', {}, '어디를 청소하나요?'),
      h('div.lookup-list', {},
        h('button.lookup-item', { type: 'button', onclick: () => { houseResult(null, 1); redraw(); } },
          icon('home'), h('span', {}, h('b', {}, '집 전체'), h('span.small', {}, `연면적 ${r.totalM2}㎡ · 약 ${Math.round(r.totalPyeong)}평${r.purpose ? ` · ${r.purpose}` : ''}`))),
        r.floors.map((f) => h('button.lookup-item', { type: 'button', onclick: () => pickFloor(f) },
          icon('stairs'), h('span', {}, h('b', {}, `${f.label}만`), h('span.small', {}, `층 면적 ${f.m2}㎡ · 약 ${Math.round(f.pyeong)}평`))))),
      h('p.lookup-note', {}, `건축물대장: ${r.groundFloors}층 건물${r.households ? ` · ${r.households}가구` : ''}`));
  } else if (ls.stage === 'houseUnits') {
    body.push(h('p.lookup-q', {}, `${ls.floor.label}에 몇 집이 사나요?`),
      h('div.lookup-grid', {}, [1, 2, 3, 4].map((n) => h(`button.lookup-chip${ls.units === n ? '.on' : ''}`, { type: 'button', onclick: () => { houseResult(ls.floor, n); redraw(); } }, n === 4 ? '4집 이상' : `${n}집`))),
      h('p.lookup-note', {}, '한 층을 여러 집이 나눠 쓰면 층 면적을 집 수로 나눠 계산해요.'));
  } else if (ls.stage === 'result' && ls.result?.kind === 'house') {
    const r = ls.result;
    body.push(h('div.lookup-result', {},
      h('div.small', {}, '건축물대장 기준 · 일반주택'),
      h('div.lookup-big', {}, `약 ${Math.round(r.pyeong)}평`),
      h('div.small', {}, ls.part === '집 전체'
        ? `연면적 ${r.m2}㎡${r.purpose ? ` · ${r.purpose}` : ''}`
        : `${ls.part} ${r.floorM2}㎡${ls.units > 1 ? ` ÷ ${ls.units}집` : ''} = ${r.m2}㎡`),
      h('div.small', {}, '계단 등 공용 부분이 섞인 대략값이에요.'),
      h('p.lookup-q', {}, '이 평수가 맞나요?')),
    h('div.lookup-actions', {},
      h('button.btn.primary', {
        type: 'button',
        onclick: () => {
          onApply?.({ kind: 'house', pyeong: r.pyeong, areaM2: r.m2, bdNm: ls.sel.bdNm, roadAddr: ls.sel.roadAddr, part: ls.part, units: ls.units });
          Object.assign(ls, newLookupState()); redraw();
        },
      }, icon('check_circle', true), '맞아요, 이 평수로'),
      h('button.btn.soft', { type: 'button', onclick: manual }, '아니요, 직접 입력')));
    if (debug) body.push(h('pre.json', {}, JSON.stringify(ls.house, null, 2)));
  } else if (ls.stage === 'result') {
    const r = ls.result;
    body.push(h('div.lookup-result', {},
      h('div.small', {}, '건축물대장 기준'),
      h('div.lookup-big', {}, `공급 약 ${Math.round(r.pyeong)}평`),
      h('div.small', {}, `공급면적 ${r.supplyM2}㎡ · 전용면적 ${r.exclusiveM2}㎡ (약 ${r.exclusivePyeong}평)`),
      h('p.lookup-q', {}, '이 평수가 맞나요?')),
    h('div.lookup-actions', {},
      h('button.btn.primary', {
        type: 'button',
        onclick: () => {
          onApply?.({
            pyeong: r.pyeong, exclusiveM2: r.exclusiveM2, supplyM2: r.supplyM2,
            bdNm: ls.sel.bdNm, roadAddr: ls.sel.roadAddr, dongNm: ls.dong, hoNm: ls.ho,
          });
          Object.assign(ls, newLookupState()); redraw();
        },
      }, icon('check_circle', true), '맞아요, 이 평수로'),
      h('button.btn.soft', { type: 'button', onclick: manual }, '아니요, 직접 입력')));
    if (debug) body.push(breakdownTable(r));
  } else if (ls.stage === 'fail') {
    body.push(h('div.lookup-fail', { role: 'alert' },
      h('b', {}, '이 주소는 자동 조회가 안 돼요.'),
      h('div', {}, '평수를 아래 칸에 직접 입력해 주세요.'),
      debug ? h('div.small', {}, `사유: ${ls.errorReason || '-'} · ${ls.error}`) : null),
    h('div.lookup-actions', {},
      h('button.btn.primary', { type: 'button', onclick: manual }, icon('edit'), '직접 입력하기'),
      h('button.btn.soft', { type: 'button', onclick: () => { reset(); redraw(); } }, '다시 찾기')));
  }

  return h('div.area-lookup.open', {},
    h('div.lookup-head', {},
      h('b', {}, icon('search'), ' 주소로 평수 찾기'),
      h('button.lookup-close', { type: 'button', onclick: manual }, '직접 입력할게요')),
    crumbs.length && ls.stage !== 'fail' ? h('div.lookup-crumbs', {}, crumbs.join(' › '),
      ls.busy ? null : h('button.link', { type: 'button', onclick: () => { reset(); redraw(); } }, '처음부터')) : null,
    body);
}

/** 적용한 조회 결과 한 줄 요약 (고객 화면 패널·사장님 상세 공용) */
export function appliedText(a) {
  if (a?.kind === 'house') return `${a.bdNm || a.roadAddr} · ${a.part}${a.units > 1 ? ` ÷ ${a.units}집` : ''} · ${a.areaM2}㎡ (일반주택, 대략값)`;
  return `${placeLabel(a)} · 전용 ${a.exclusiveM2}㎡ · 공급 ${a.supplyM2}㎡`;
}

function breakdownTable(r) {
  return h('div.lookup-debug', {},
    h('b', {}, '항목별 면적 (공급면적 계산 검증용)'),
    h('table.lines-table', {}, h('tbody', {},
      r.breakdown.map((b) => h('tr', {},
        h('td', {}, b.gb === 'exclusive' ? '전유' : '공용', ' · ', b.purpose || '-', b.floor ? ` (${b.floor})` : ''),
        h('td.num', {}, `${b.area}㎡`),
        h('td.num', {}, b.included ? '포함' : `제외${b.note ? ` · ${b.note}` : ''}`))))),
    h('p.small', {}, `전용 ${r.exclusiveM2} + 주거공용 ${r.commonIncludedM2} = 공급 ${r.supplyM2}㎡ (제외한 기타공용 ${r.commonExcludedM2}㎡) → ${r.pyeong}평. 주거공용 = 주용도가 주거인 지상층 공용면적. 분양 평수와 다르면 functions/lib/area.js 규칙을 조정합니다.`));
}
