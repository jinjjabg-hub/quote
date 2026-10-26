// 주소 → 평수 자동 조회 (설계도 4-4장) — 순수 로직. Firebase·네트워크에 의존하지 않아 단위 테스트로 검증한다.
//
//   ① search  도로명주소 검색 API (JUSO_SEARCH_KEY)   "가야대로 팍스타운" → 단지 목록
//   ② dongs   상세주소 API, 동 목록 (JUSO_DETAIL_KEY)
//   ③ hos     상세주소 API, 층·호 목록 (JUSO_DETAIL_KEY)
//   ④ area    건축HUB 전유공용면적 (BLD_KEY)          → 전용·공용 → 공급면적 → 평
//
// 키 값은 이 파일에 들어오지 않는다. handle() 이 keys 객체로 받아 URL 을 만들 때만 쓰고, 응답·오류 메시지에는 절대 넣지 않는다.

export const JUSO_SEARCH_URL = 'https://business.juso.go.kr/addrlink/addrLinkApi.do';
export const JUSO_DETAIL_URL = 'https://business.juso.go.kr/addrlink/addrDetailApi.do';
export const BLD_AREA_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo';

export const PYEONG_M2 = 3.305785;

// 공급면적 = 전용 + 주거공용 (주택공급에 관한 규칙 제21조).
//   주거공용: 공동주택 지상층의 계단·복도·현관·벽체 등 → 포함
//   기타공용: 지하층, 부대시설·복리시설(관리사무소·경로당·주차장 등) → 제외
// 판정: 공용 항목은 ① 주용도가 주거이고 ② 지상층이고 ③ 아래 기타공용 단어가 없을 때만 포함.
// 검증: 더샵 남천프레스티지 전용 92.05㎡ → 공급 125.83㎡(38평형) (2026-10-26, dev.html ⑥ 항목별 표)
export const RESIDENTIAL_RE = /아파트|공동주택|연립|다세대|다가구|주택|기숙사|오피스텔/;
export const UNDERGROUND_RE = /^\s*지(?!상)|지하/;
export const EXCLUDED_COMMON_RE = /주차|기계|전기|발전|변전|펌프|저수|정화|관리사무|관리실|경비|노인|경로|어린이|보육|주민|커뮤니티|근린|창고|기타공용|피트니스|휴게|방재|중앙감시|쓰레기|분리수거/;

export class LookupError extends Error {
  constructor(reason, message, status = 200) { super(message); this.reason = reason; this.status = status; }
}

// ---------- 입력 검증 ----------

const DIGITS = (n) => (v) => typeof v === 'string' && new RegExp(`^\\d{1,${n}}$`).test(v);
const REF_RULES = {
  admCd: (v) => typeof v === 'string' && /^\d{10}$/.test(v),
  rnMgtSn: (v) => typeof v === 'string' && /^\d{12}$/.test(v),
  udrtYn: (v) => v === '0' || v === '1',
  buldMnnm: DIGITS(5),
  buldSlno: DIGITS(5),
  mtYn: (v) => v === '0' || v === '1',
  lnbrMnnm: DIGITS(4),
  lnbrSlno: DIGITS(4),
};

/** 단지 식별값(검색 결과의 ref)이 형식에 맞는지. 외부 입력이라 그대로 믿지 않는다. */
export function cleanRef(ref) {
  if (!ref || typeof ref !== 'object') throw new LookupError('bad_input', '주소 정보가 올바르지 않습니다.', 400);
  const out = {};
  for (const [k, ok] of Object.entries(REF_RULES)) {
    const v = ref[k] == null ? '' : String(ref[k]);
    if (!ok(v)) throw new LookupError('bad_input', '주소 정보가 올바르지 않습니다.', 400);
    out[k] = v;
  }
  return out;
}

/** 동·호 이름: 숫자·한글·영문·-·공백만, 20자 이하 */
export function cleanUnit(v, { allowEmpty = true } = {}) {
  const s = String(v ?? '').trim();
  if (!s && allowEmpty) return '';
  if (!/^[0-9A-Za-z가-힣\- ]{1,20}$/.test(s)) throw new LookupError('bad_input', '동·호 정보가 올바르지 않습니다.', 400);
  return s;
}

/** 검색어: 도로명주소 API 가 거부하는 특수문자·SQL 예약어를 지운다 (API 안내 사항) */
export function cleanKeyword(v) {
  let s = String(v ?? '').replace(/[%=><\[\]{}()'"`;\\]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\b(OR|SELECT|INSERT|DELETE|UPDATE|CREATE|DROP|EXEC|UNION|FETCH|DECLARE|TRUNCATE)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 2) throw new LookupError('bad_input', '검색어를 2글자 이상 입력해주세요.', 400);
  if (s.length > 60) throw new LookupError('bad_input', '검색어가 너무 깁니다.', 400);
  return s;
}

// ---------- URL ----------

/**
 * 공공데이터포털 인증키는 "인코딩"·"디코딩" 두 가지가 있다. 어느 쪽이 저장돼 있어도 동작하게,
 * 이미 % 인코딩된 키는 그대로, 아니면 한 번만 인코딩한다. (두 번 인코딩하면 SERVICE_KEY_IS_NOT_REGISTERED_ERROR)
 */
export function encodeServiceKey(key) {
  const k = String(key || '').trim();
  return /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k);
}

export function jusoSearchUrl(key, keyword) {
  const p = new URLSearchParams({ confmKey: String(key).trim(), currentPage: '1', countPerPage: '10', keyword, resultType: 'json' });
  return `${JUSO_SEARCH_URL}?${p}`;
}

export function jusoDetailUrl(key, ref, searchType, dongNm = '') {
  const p = new URLSearchParams({
    confmKey: String(key).trim(), admCd: ref.admCd, rnMgtSn: ref.rnMgtSn, udrtYn: ref.udrtYn,
    buldMnnm: ref.buldMnnm, buldSlno: ref.buldSlno, searchType, resultType: 'json',
  });
  if (dongNm) p.set('dongNm', dongNm);
  return `${JUSO_DETAIL_URL}?${p}`;
}

/** 건축물대장 조회 조건: 행정구역코드 10자리 = 시군구 5 + 법정동 5, 지번 본번·부번 4자리 */
export function bldParams(ref, dongNm, hoNm) {
  return {
    sigunguCd: ref.admCd.slice(0, 5),
    bjdongCd: ref.admCd.slice(5, 10),
    platGbCd: ref.mtYn === '1' ? '1' : '0', // 0 대지, 1 산
    bun: ref.lnbrMnnm.padStart(4, '0'),
    ji: ref.lnbrSlno.padStart(4, '0'),
    ...(dongNm ? { dongNm } : {}),
    ...(hoNm ? { hoNm } : {}),
  };
}

const BLD_BASE = 'https://apis.data.go.kr/1613000/BldRgstHubService';

/** 건축HUB 다른 상세기능 (표제부 getBrTitleInfo · 층별개요 getBrFlrOulnInfo) */
export function bldUrl(op, key, params) {
  const p = new URLSearchParams({ ...params, numOfRows: '100', pageNo: '1', _type: 'json' });
  return `${BLD_BASE}/${op}?serviceKey=${encodeServiceKey(key)}&${p}`;
}

export function bldAreaUrl(key, params) {
  const p = new URLSearchParams({ ...params, numOfRows: '100', pageNo: '1', _type: 'json' });
  return `${BLD_AREA_URL}?serviceKey=${encodeServiceKey(key)}&${p}`;
}

// ---------- 응답 해석 ----------

function jusoList(json) {
  const common = json?.results?.common;
  if (!common) throw new LookupError('upstream', '주소 검색 응답을 읽을 수 없습니다.', 502);
  if (String(common.errorCode) !== '0') {
    // E0001 승인되지 않은 키, E0005 검색어 없음, E0006 주소를 상세히 입력 등 — 메시지는 API 안내문(키 값 없음)
    const msg = String(common.errorMessage || '주소 검색에 실패했습니다.');
    const userFault = ['E0005', 'E0006', 'E0008', 'E0009', 'E0010', 'E0011', 'E0012', 'E0013', 'E0014', 'E0015'].includes(String(common.errorCode));
    throw new LookupError(userFault ? 'bad_input' : 'upstream', msg, userFault ? 400 : 502);
  }
  return Array.isArray(json.results.juso) ? json.results.juso : [];
}

/** 도로명주소 검색 결과 → 화면용 목록 (같은 건물 중복 제거) */
export function parseSearch(json) {
  const seen = new Set();
  const out = [];
  for (const j of jusoList(json)) {
    const ref = {
      admCd: String(j.admCd || ''), rnMgtSn: String(j.rnMgtSn || ''), udrtYn: String(j.udrtYn ?? '0'),
      buldMnnm: String(j.buldMnnm ?? ''), buldSlno: String(j.buldSlno ?? '0'),
      mtYn: String(j.mtYn ?? '0'), lnbrMnnm: String(j.lnbrMnnm ?? ''), lnbrSlno: String(j.lnbrSlno ?? '0'),
    };
    try { cleanRef(ref); } catch { continue; }
    const id = `${ref.admCd}-${ref.rnMgtSn}-${ref.buldMnnm}-${ref.buldSlno}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      roadAddr: String(j.roadAddrPart1 || j.roadAddr || ''),
      jibunAddr: String(j.jibunAddr || ''),
      bdNm: String(j.bdNm || ''),
      apt: String(j.bdKdcd) === '1', // 1 공동주택
      ref,
    });
  }
  return out;
}

const naturalSort = (a, b) => a.localeCompare(b, 'ko', { numeric: true });

export function parseDongs(json) {
  const names = new Set(jusoList(json).map((j) => String(j.dongNm || '').trim()).filter(Boolean));
  return [...names].sort(naturalSort);
}

export function parseHos(json) {
  const seen = new Set();
  const out = [];
  for (const j of jusoList(json)) {
    const hoNm = String(j.hoNm || '').trim();
    if (!hoNm || seen.has(hoNm)) continue;
    seen.add(hoNm);
    out.push({ hoNm, floorNm: String(j.floorNm || '').trim() });
  }
  return out.sort((a, b) => naturalSort(a.hoNm, b.hoNm));
}

/** 건축물대장 응답의 item 목록. item 이 1개면 객체, 없으면 "" 로 오는 경우까지 처리 */
export function bldItems(json) {
  const header = json?.response?.header;
  if (!header) throw new LookupError('upstream', '건축물대장 응답을 읽을 수 없습니다.', 502);
  if (String(header.resultCode) !== '00') throw new LookupError('upstream', String(header.resultMsg || '건축물대장 조회에 실패했습니다.'), 502);
  const item = json.response.body?.items?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

/** JSON 대신 XML 오류(인증키 오류 등)가 오면 사유만 꺼낸다. 키 값은 응답에 없다. */
export function bldTextError(text) {
  const m = /<returnAuthMsg>([^<]+)<\/returnAuthMsg>|<resultMsg>([^<]+)<\/resultMsg>/.exec(String(text || ''));
  return m ? (m[1] || m[2]).trim() : '건축물대장 응답 형식이 올바르지 않습니다.';
}

const unitKey = (s) => String(s || '').replace(/\s/g, '').replace(/(동|호)$/, '').replace(/^0+(?=\d)/, '');

/** 대장의 동·호 표기("101동"/"101", "1203호"/"1203")가 달라도 같은 집인지 */
export function sameUnit(a, b) {
  return unitKey(a) === unitKey(b);
}

/** 동·호 이름 변형: 대장 조회는 정확히 일치해야 해서 흔한 표기를 순서대로 시도한다 */
export function unitVariants(dongNm, hoNm) {
  const d = String(dongNm || '').trim();
  const h = String(hoNm || '').trim();
  const dongs = d ? [...new Set([d, d.endsWith('동') ? d.slice(0, -1) : `${d}동`])] : [''];
  const hos = [...new Set([h.endsWith('호') ? h : `${h}호`, h.endsWith('호') ? h.slice(0, -1) : h])];
  const out = [];
  for (const dd of dongs) for (const hh of hos) out.push([dd, hh]);
  return out;
}

/** 전유·공용 항목 → 전용면적·공급면적·평 */
export function computeArea(items, { dongNm = '', hoNm = '' } = {}) {
  const mine = items.filter((it) => (!hoNm || !it.hoNm || sameUnit(it.hoNm, hoNm)) && (!dongNm || !it.dongNm || sameUnit(it.dongNm, dongNm)));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  let exclusive = 0; let commonIn = 0; let commonOut = 0;
  const breakdown = [];
  for (const it of mine) {
    const area = num(it.area);
    const purpose = [it.mainPurpsCdNm, it.etcPurps].filter(Boolean).join(' / ');
    const gb = String(it.exposPubuseGbCd) === '1' ? 'exclusive' : 'common';
    const floor = String(it.flrNoNm || '');
    let note = '';
    if (gb === 'common') {
      const main = String(it.mainPurpsCdNm || '').trim();
      if (UNDERGROUND_RE.test(floor) || String(it.flrGbCdNm || '').includes('지하')) note = '지하층';
      else if (main && !RESIDENTIAL_RE.test(main)) note = `${main}(기타공용)`;
      else if (EXCLUDED_COMMON_RE.test(purpose)) note = '기타공용';
    }
    const included = !note;
    if (gb === 'exclusive') exclusive += area;
    else if (included) commonIn += area;
    else commonOut += area;
    breakdown.push({ gb, purpose, area: round2(area), included, floor, ...(note ? { note } : {}) });
  }
  if (!exclusive) throw new LookupError('no_area', '건축물대장에서 이 집의 전용면적을 찾지 못했습니다.');
  const supply = exclusive + commonIn;
  return {
    exclusiveM2: round2(exclusive),
    supplyM2: round2(supply),
    commonIncludedM2: round2(commonIn),
    commonExcludedM2: round2(commonOut),
    exclusivePyeong: round1(exclusive / PYEONG_M2),
    pyeong: round1(supply / PYEONG_M2),
    breakdown,
  };
}

// ---------- 일반주택 (단독·다가구: 호별 면적이 없는 일반건축물) ----------
// 표제부(집 전체 연면적·주용도·가구 수)와 층별개요(층마다 면적)로 고객이 "집 전체" 또는 "○층 ÷ 가구 수"를 고르게 한다.
// 층 면적에는 계단 등 공용 부분이 섞여 있어 아파트 공급면적보다 대략값이다 (화면에 표시).

const FLOOR_GB = { 10: '지하', 20: '지상', 30: '옥탑' };

/** 같은 대지에 건물이 여럿이면 주건축물(mainAtchGbCd 0) 중 연면적이 가장 큰 것 */
export function pickMainBuilding(titles) {
  const mains = titles.filter((t) => String(t.mainAtchGbCd ?? '0') === '0');
  const list = mains.length ? mains : titles;
  return [...list].sort((a, b) => (Number(b.totArea) || 0) - (Number(a.totArea) || 0))[0] || null;
}

/** 층별개요 → 층마다 면적 합 (한 층이 용도별로 여러 행으로 오는 경우 합산) */
export function houseFloors(rows, main) {
  const sameBuilding = (r) => String(r.mainAtchGbCd ?? '0') === String(main?.mainAtchGbCd ?? '0')
    && (!main?.dongNm || !r.dongNm || String(r.dongNm).trim() === String(main.dongNm).trim());
  const byFloor = new Map();
  for (const r of rows.filter(sameBuilding)) {
    const gb = Number(r.flrGbCd) || 20;
    const no = Number(r.flrNo) || 0;
    const key = `${gb}-${no}`;
    const area = Number(r.area) > 0 ? Number(r.area) : 0;
    const cur = byFloor.get(key) || {
      key, gb, no, label: String(r.flrNoNm || `${FLOOR_GB[gb] || ''}${no}층`).trim(), m2: 0, purposes: new Set(),
    };
    cur.m2 += area;
    if (r.etcPurps || r.mainPurpsCdNm) cur.purposes.add(String(r.etcPurps || r.mainPurpsCdNm).trim());
    byFloor.set(key, cur);
  }
  const order = (f) => (f.gb === 10 ? -f.no : f.gb === 30 ? 1000 + f.no : f.no);
  return [...byFloor.values()].filter((f) => f.m2 > 0).sort((a, b) => order(a) - order(b))
    .map((f) => ({ key: f.key, label: f.label, underground: f.gb === 10, m2: round2(f.m2), pyeong: round1(f.m2 / PYEONG_M2), purpose: [...f.purposes].join(', ') }));
}

export function computeHouse(titles, floorRows) {
  const main = pickMainBuilding(titles);
  if (!main) throw new LookupError('not_found', '건축물대장에서 이 건물을 찾지 못했습니다.');
  const totalM2 = Number(main.totArea) > 0 ? Number(main.totArea) : 0;
  const floors = houseFloors(floorRows, main);
  if (!totalM2 && !floors.length) throw new LookupError('no_area', '건축물대장에 면적 정보가 없습니다.');
  const households = Number(main.fmlyCnt) || Number(main.hhldCnt) || Number(main.hoCnt) || 0;
  return {
    kind: 'house',
    purpose: [main.mainPurpsCdNm, main.etcPurps].filter(Boolean).join(' / '),
    bldNm: String(main.bldNm || '').trim(),
    totalM2: round2(totalM2),
    totalPyeong: round1(totalM2 / PYEONG_M2),
    households,
    groundFloors: Number(main.grndFlrCnt) || floors.filter((f) => !f.underground).length,
    floors,
    buildings: titles.filter((t) => String(t.mainAtchGbCd ?? '0') === '0').length || titles.length,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- 요청 처리 ----------

/**
 * 바깥 서버 접속 실패의 원인 코드 (예: timeout, UNABLE_TO_VERIFY_LEAF_SIGNATURE, ECONNRESET).
 * 영문·숫자·_ 만 남겨 URL·키가 섞여 나갈 수 없게 한다.
 */
export function failCode(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const raw = e?.cause?.code || e?.code || e?.cause?.name || e?.name || 'unknown';
  return String(raw).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'unknown';
}

/**
 * 오류 응답 본문에서 사유만 꺼낸다 (예: Forbidden, SERVICE_KEY_IS_NOT_REGISTERED_ERROR, Unauthorized).
 * 알려진 XML 태그 값이나 본문 첫 부분의 영문·숫자·_·공백만 남겨 키·URL 이 섞여 나갈 수 없게 한다.
 */
export function upstreamReason(text) {
  // 응답이 &lt;…&gt; 로 이스케이프돼 오는 경우도 있어 먼저 되돌린다
  const t = String(text || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const tag = (name) => (new RegExp(`<${name}>\\s*([^<]{1,120}?)\\s*</${name}>`).exec(t) || [])[1];
  // 공공데이터포털 표준 오류: 사유 번호(returnReasonCode) + 사유(returnAuthMsg)가 핵심
  const picked = [tag('returnReasonCode'), tag('returnAuthMsg')].filter(Boolean).join(' ')
    || tag('resultMsg') || tag('errMsg') || t.replace(/<[^>]*>/g, ' ');
  return picked.replace(/[^A-Za-z0-9_ ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// 요청 헤더 후보. 403 이면 다음 후보로 한 번 더 보낸다 (공공데이터포털 게이트웨이가 헤더에 따라 거부하는지 진단·우회)
export const HEADER_TRIES = [
  { accept: 'application/json' },
  { accept: '*/*', 'user-agent': 'Mozilla/5.0 (compatible; bizmy-quote/1.0; +https://quote.bizmy.net)' },
];

/** 로그에 남길 본문에서 키 값(원문·인코딩)을 *** 로 가린다 */
export function redact(text, secrets = []) {
  let out = String(text || '');
  for (const s of secrets.filter((x) => x && String(x).trim().length >= 8)) {
    const k = String(s).trim();
    for (const v of new Set([k, encodeURIComponent(k), encodeServiceKey(k), decodeURIComponentSafe(k)])) out = out.split(v).join('***');
  }
  return out;
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

async function getJson(fetchFn, url, what, { log = () => {}, secrets = [] } = {}) {
  for (let i = 0; i < HEADER_TRIES.length; i += 1) {
    let res;
    try {
      res = await fetchFn(url, { signal: AbortSignal.timeout(7000), headers: HEADER_TRIES[i] });
    } catch (e) {
      throw new LookupError('upstream', `${what} 서버에 연결하지 못했습니다 (${failCode(e)}).`, 504);
    }
    const text = await res.text();
    if (res.ok) {
      if (i > 0) log('info', { what, note: `헤더 후보 ${i + 1}번으로 성공`, attempt: i + 1 });
      try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
    }
    // 실제 응답을 그대로(키만 가려서) 남긴다: 상태·형식·서버·본문 앞부분. 요청 URL 은 남기지 않는다(키 포함)
    log('warn', {
      what, attempt: i + 1, status: res.status,
      contentType: res.headers?.get?.('content-type') || '',
      server: res.headers?.get?.('server') || '',
      body: redact(text, secrets).slice(0, 500),
    });
    if (res.status === 403 && i < HEADER_TRIES.length - 1) continue;
    const why = upstreamReason(redact(text, secrets));
    throw new LookupError('upstream', `${what} 서버 오류 (${res.status}${why ? ` ${why}` : ''})`, 502);
  }
  throw new LookupError('upstream', `${what} 서버 오류`, 502);
}

/**
 * 요청 1건 처리. body: { action: 'search'|'dongs'|'hos'|'area', ... }
 * keys: { jusoSearch, jusoDetail, bld } — 실행 시 Secret Manager 에서 읽은 값. 응답·오류에 넣지 않는다.
 */
export async function handle(body, { keys, fetchFn = fetch, log } = {}) {
  const action = body?.action;
  const ctx = { log, secrets: Object.values(keys || {}) };
  if (action === 'search') {
    const keyword = cleanKeyword(body.keyword);
    const { json } = await getJson(fetchFn, jusoSearchUrl(keys.jusoSearch, keyword), '주소 검색', ctx);
    const items = parseSearch(json);
    if (!items.length) throw new LookupError('not_found', '검색 결과가 없습니다. 단지명이나 도로명을 다시 확인해주세요.');
    return { items };
  }
  if (action === 'dongs') {
    const ref = cleanRef(body.ref);
    const { json } = await getJson(fetchFn, jusoDetailUrl(keys.jusoDetail, ref, 'dong'), '상세주소', ctx);
    return { dongs: parseDongs(json) };
  }
  if (action === 'hos') {
    const ref = cleanRef(body.ref);
    const dongNm = cleanUnit(body.dongNm);
    const { json } = await getJson(fetchFn, jusoDetailUrl(keys.jusoDetail, ref, 'floorho', dongNm), '상세주소', ctx);
    const hos = parseHos(json);
    if (!hos.length) throw new LookupError('no_units', '이 건물은 호수 정보가 없습니다.');
    return { hos };
  }
  if (action === 'area') {
    const ref = cleanRef(body.ref);
    const dongNm = cleanUnit(body.dongNm);
    const hoNm = cleanUnit(body.hoNm, { allowEmpty: false });
    for (const [d, h] of unitVariants(dongNm, hoNm)) {
      const { json, text } = await getJson(fetchFn, bldAreaUrl(keys.bld, bldParams(ref, d, h)), '건축물대장', ctx);
      if (!json) throw new LookupError('upstream', bldTextError(text), 502);
      const items = bldItems(json);
      if (items.length) return computeArea(items, { dongNm, hoNm });
    }
    throw new LookupError('not_found', '건축물대장에서 이 집을 찾지 못했습니다.');
  }
  if (action === 'house') {
    const ref = cleanRef(body.ref);
    const params = bldParams(ref, '', '');
    const readItems = async (op) => {
      const { json, text } = await getJson(fetchFn, bldUrl(op, keys.bld, params), '건축물대장', ctx);
      if (!json) throw new LookupError('upstream', bldTextError(text), 502);
      return bldItems(json);
    };
    const titles = await readItems('getBrTitleInfo');
    if (!titles.length) throw new LookupError('not_found', '건축물대장에서 이 건물을 찾지 못했습니다.');
    const floors = await readItems('getBrFlrOulnInfo');
    return computeHouse(titles, floors);
  }
  throw new LookupError('bad_input', '알 수 없는 요청입니다.', 400);
}

// 우리 화면에서 온 요청만 받는다 (공개 정보지만 남이 우리 할당량을 쓰지 못하게)
export const ALLOWED_ORIGINS = [
  'https://quote.bizmy.net',
  'https://jinjjabg-hub.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8765',
];
