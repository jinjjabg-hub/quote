// 주소 → 평수 조회 로직 테스트. 실제 API 를 부르지 않고, 공식 문서의 응답 형식으로 만든 예시 응답을 쓴다.
// 예시 숫자는 테스트용이며 실제 단지 값이 아니다. 실제 값 검증은 배포 후 dev.html "평수 조회 시험"에서 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handle, parseSearch, parseDongs, parseHos, computeArea, bldItems, bldParams, bldAreaUrl, encodeServiceKey,
  cleanKeyword, cleanRef, unitVariants, sameUnit, bldTextError, LookupError, jusoSearchUrl,
} from '../lib/area.js';

const KEYS = { jusoSearch: 'TEST-SEARCH-KEY', jusoDetail: 'TEST-DETAIL-KEY', bld: 'abc+def/ghi==' };

const jusoOk = (juso) => ({ results: { common: { errorCode: '0', errorMessage: '정상', totalCount: String(juso.length) }, juso } });
const SEARCH = jusoOk([
  {
    roadAddr: '부산광역시 부산진구 가야대로 000 (가야동, 예시타운)', roadAddrPart1: '부산광역시 부산진구 가야대로 000',
    jibunAddr: '부산광역시 부산진구 가야동 000-1 예시타운', bdNm: '예시타운', bdKdcd: '1',
    admCd: '2623010500', rnMgtSn: '262303000001', udrtYn: '0', buldMnnm: '000', buldSlno: '0',
    mtYn: '0', lnbrMnnm: '0', lnbrSlno: '1',
  },
  { // 같은 건물 중복 (동마다 다른 행으로 오는 경우)
    roadAddr: '부산광역시 부산진구 가야대로 000 (가야동, 예시타운)', roadAddrPart1: '부산광역시 부산진구 가야대로 000',
    jibunAddr: '부산광역시 부산진구 가야동 000-1', bdNm: '예시타운', bdKdcd: '1',
    admCd: '2623010500', rnMgtSn: '262303000001', udrtYn: '0', buldMnnm: '000', buldSlno: '0',
    mtYn: '0', lnbrMnnm: '0', lnbrSlno: '1',
  },
]);
// lnbrMnnm '0' 은 형식상 허용되지만 실제로는 번지가 있다 → 예시 ref 는 아래처럼 정상 번지로 쓴다
const REF = { admCd: '2623010500', rnMgtSn: '262303000001', udrtYn: '0', buldMnnm: '123', buldSlno: '0', mtYn: '0', lnbrMnnm: '456', lnbrSlno: '1' };

const bldOk = (item) => ({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items: item === undefined ? '' : { item }, totalCount: Array.isArray(item) ? item.length : item ? 1 : 0 } } });
const UNIT_ITEMS = [
  { exposPubuseGbCd: '1', exposPubuseGbCdNm: '전유', mainPurpsCdNm: '공동주택', etcPurps: '아파트', area: 84.97, dongNm: '101동', hoNm: '1203호', flrNoNm: '12층' },
  { exposPubuseGbCd: '2', exposPubuseGbCdNm: '공용', mainPurpsCdNm: '공동주택', etcPurps: '계단실,복도', area: 20.5, dongNm: '101동', hoNm: '1203호', flrNoNm: '각층' },
  { exposPubuseGbCd: '2', exposPubuseGbCdNm: '공용', mainPurpsCdNm: '공동주택', etcPurps: '주거공용', area: 6.88, dongNm: '101동', hoNm: '1203호', flrNoNm: '각층' },
  { exposPubuseGbCd: '2', exposPubuseGbCdNm: '공용', mainPurpsCdNm: '주차장', etcPurps: '지하주차장', area: 40.1, dongNm: '101동', hoNm: '1203호', flrNoNm: '지하1층' },
  { exposPubuseGbCd: '2', exposPubuseGbCdNm: '공용', mainPurpsCdNm: '공동주택', etcPurps: '기타공용(관리사무소)', area: 3.2, dongNm: '101동', hoNm: '1203호', flrNoNm: '1층' },
];

/** 가짜 fetch: URL 규칙별 응답. 호출된 URL 은 calls 에 남는다 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [match, reply] of routes) {
      if (match(url)) {
        const r = typeof reply === 'function' ? reply(url) : reply;
        if (r instanceof Error) throw r;
        const body = typeof r === 'string' ? r : JSON.stringify(r);
        return { ok: true, status: 200, text: async () => body };
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  fn.calls = calls;
  return fn;
}
const isSearch = (u) => u.includes('addrLinkApi');
const isDetail = (u) => u.includes('addrDetailApi');
const isBld = (u) => u.includes('getBrExposPubuseAreaInfo');

test('검색: 단지 목록 + 같은 건물 중복 제거, 공동주택 표시', () => {
  const items = parseSearch(SEARCH);
  assert.equal(items.length, 1);
  assert.equal(items[0].bdNm, '예시타운');
  assert.equal(items[0].apt, true);
  assert.equal(items[0].roadAddr, '부산광역시 부산진구 가야대로 000');
  assert.deepEqual(Object.keys(items[0].ref).sort(), ['admCd', 'buldMnnm', 'buldSlno', 'lnbrMnnm', 'lnbrSlno', 'mtYn', 'rnMgtSn', 'udrtYn']);
});

test('검색: API 오류 코드 → 사용자 입력 문제(400)와 서버 문제(502) 구분', () => {
  const err = (code) => ({ results: { common: { errorCode: code, errorMessage: '안내 문구' }, juso: null } });
  assert.throws(() => parseSearch(err('E0006')), (e) => e instanceof LookupError && e.status === 400);
  assert.throws(() => parseSearch(err('E0001')), (e) => e instanceof LookupError && e.status === 502 && e.reason === 'upstream');
  assert.throws(() => parseSearch({}), (e) => e.reason === 'upstream');
});

test('동·호 목록: 중복 제거 + 자연 정렬 (2동 < 10동)', () => {
  assert.deepEqual(parseDongs(jusoOk([{ dongNm: '102동' }, { dongNm: '101동' }, { dongNm: '101동' }, { dongNm: '1010동' }, { dongNm: '' }])), ['101동', '102동', '1010동']);
  assert.deepEqual(parseHos(jusoOk([{ hoNm: '1203', floorNm: '12' }, { hoNm: '203', floorNm: '2' }, { hoNm: '203', floorNm: '2' }])).map((x) => x.hoNm), ['203', '1203']);
});

test('면적: 공급 = 전용 + 주거공용, 주차장·관리사무소 같은 기타공용은 제외', () => {
  const r = computeArea(UNIT_ITEMS, { dongNm: '101', hoNm: '1203' });
  assert.equal(r.exclusiveM2, 84.97);
  assert.equal(r.commonIncludedM2, 27.38);
  assert.equal(r.commonExcludedM2, 43.3);
  assert.equal(r.supplyM2, 112.35);
  assert.equal(r.pyeong, 34); // 112.35 / 3.3058 = 33.99
  assert.equal(r.exclusivePyeong, 25.7);
  assert.equal(r.breakdown.filter((b) => !b.included).length, 2, '항목별 포함 여부를 돌려줘 dev.html 에서 검증 가능');
});

test('면적: 다른 호의 항목이 섞여 와도 내 호만 합산, 전용이 없으면 실패', () => {
  const mixed = [...UNIT_ITEMS, { exposPubuseGbCd: '1', mainPurpsCdNm: '공동주택', area: 59.9, dongNm: '101동', hoNm: '1204호' }];
  assert.equal(computeArea(mixed, { dongNm: '101동', hoNm: '1203호' }).exclusiveM2, 84.97);
  assert.throws(() => computeArea(UNIT_ITEMS.slice(1), { hoNm: '1203' }), (e) => e.reason === 'no_area');
});

test('건축물대장: item 이 1개(객체)·없음("")·여러 개(배열) 모두 처리, 오류 코드는 실패', () => {
  assert.equal(bldItems(bldOk(UNIT_ITEMS[0])).length, 1);
  assert.equal(bldItems(bldOk()).length, 0);
  assert.equal(bldItems(bldOk(UNIT_ITEMS)).length, 5);
  assert.throws(() => bldItems({ response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED ERROR.' } } }), (e) => e.reason === 'upstream');
  assert.equal(bldTextError('<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>'), 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR');
});

test('대장 조회 조건: 행정구역코드 → 시군구 5 + 법정동 5, 번지 4자리, 산 여부', () => {
  assert.deepEqual(bldParams(REF, '101동', '1203호'), { sigunguCd: '26230', bjdongCd: '10500', platGbCd: '0', bun: '0456', ji: '0001', dongNm: '101동', hoNm: '1203호' });
  assert.equal(bldParams({ ...REF, mtYn: '1' }, '', '1').platGbCd, '1');
});

test('인증키: 디코딩 키는 한 번 인코딩, 이미 인코딩된 키는 그대로 (이중 인코딩 방지)', () => {
  assert.equal(encodeServiceKey('abc+def/ghi=='), 'abc%2Bdef%2Fghi%3D%3D');
  assert.equal(encodeServiceKey('abc%2Bdef%2Fghi%3D%3D'), 'abc%2Bdef%2Fghi%3D%3D');
  assert.match(bldAreaUrl('abc%2Bdef', bldParams(REF, '', '101')), /serviceKey=abc%2Bdef&/);
});

test('동·호 표기 차이: "101동"/"101", "1203호"/"1203" 을 같은 집으로, 조회는 변형을 차례로 시도', () => {
  assert.ok(sameUnit('101동', '101'));
  assert.ok(sameUnit('1203호', '1203'));
  assert.ok(!sameUnit('1203', '203'));
  assert.deepEqual(unitVariants('101동', '1203'), [['101동', '1203호'], ['101동', '1203'], ['101', '1203호'], ['101', '1203']]);
  assert.deepEqual(unitVariants('', '1203호'), [['', '1203호'], ['', '1203']]);
});

test('입력 검증: 검색어 특수문자·SQL 예약어 제거, 형식이 틀린 주소 정보는 거부', () => {
  assert.equal(cleanKeyword(" 가야대로 '팍스타운' OR 1=1 "), '가야대로 팍스타운 1 1');
  assert.throws(() => cleanKeyword('가'), (e) => e.status === 400);
  assert.throws(() => cleanRef({ ...REF, admCd: '26230' }), (e) => e.reason === 'bad_input');
  assert.throws(() => cleanRef({ ...REF, admCd: '2623010500; drop' }), (e) => e.reason === 'bad_input');
});

test('handle: 검색 → 동 → 호 → 면적 전체 흐름', async () => {
  const fetchFn = fakeFetch([
    [isSearch, SEARCH],
    [(u) => isDetail(u) && u.includes('searchType=dong'), jusoOk([{ dongNm: '101동' }, { dongNm: '102동' }])],
    [(u) => isDetail(u) && u.includes('searchType=floorho'), jusoOk([{ hoNm: '1203', floorNm: '12' }])],
    [isBld, bldOk(UNIT_ITEMS)],
  ]);
  const s = await handle({ action: 'search', keyword: '가야대로 예시타운' }, { keys: KEYS, fetchFn });
  assert.equal(s.items.length, 1);
  const d = await handle({ action: 'dongs', ref: REF }, { keys: KEYS, fetchFn });
  assert.deepEqual(d.dongs, ['101동', '102동']);
  const h = await handle({ action: 'hos', ref: REF, dongNm: '101동' }, { keys: KEYS, fetchFn });
  assert.equal(h.hos[0].hoNm, '1203');
  const a = await handle({ action: 'area', ref: REF, dongNm: '101동', hoNm: '1203' }, { keys: KEYS, fetchFn });
  assert.equal(a.pyeong, 34);
  assert.ok(fetchFn.calls.find(isDetail).includes('dongNm=') === false, '동 목록 조회에는 dongNm 없음');
  assert.ok(fetchFn.calls.filter(isDetail)[1].includes(`dongNm=${encodeURIComponent('101동')}`));
});

test('handle: 대장에서 첫 표기로 못 찾으면 다음 표기로 다시 조회', async () => {
  const fetchFn = fakeFetch([[isBld, (u) => (u.includes(`hoNm=${encodeURIComponent('1203호')}`) ? bldOk() : bldOk(UNIT_ITEMS))]]);
  const a = await handle({ action: 'area', ref: REF, dongNm: '101동', hoNm: '1203' }, { keys: KEYS, fetchFn });
  assert.equal(a.exclusiveM2, 84.97);
  assert.equal(fetchFn.calls.length, 2);
});

test('handle: 실패 → 사유 코드로 구분 (화면은 모두 "직접 입력"으로 넘어감)', async () => {
  const empty = fakeFetch([[isSearch, jusoOk([])], [isBld, bldOk()], [isDetail, jusoOk([])]]);
  await assert.rejects(handle({ action: 'search', keyword: '없는주소' }, { keys: KEYS, fetchFn: empty }), (e) => e.reason === 'not_found');
  await assert.rejects(handle({ action: 'area', ref: REF, dongNm: '', hoNm: '101' }, { keys: KEYS, fetchFn: empty }), (e) => e.reason === 'not_found');
  await assert.rejects(handle({ action: 'hos', ref: REF, dongNm: '' }, { keys: KEYS, fetchFn: empty }), (e) => e.reason === 'no_units');
  const down = fakeFetch([[isSearch, new Error('timeout')]]);
  await assert.rejects(handle({ action: 'search', keyword: '가야대로' }, { keys: KEYS, fetchFn: down }), (e) => e.reason === 'upstream' && e.status === 504);
  const xml = fakeFetch([[isBld, '<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>']]);
  await assert.rejects(handle({ action: 'area', ref: REF, dongNm: '', hoNm: '101' }, { keys: KEYS, fetchFn: xml }), (e) => e.reason === 'upstream' && /NOT_REGISTERED/.test(e.message));
  await assert.rejects(handle({ action: 'hack' }, { keys: KEYS, fetchFn: empty }), (e) => e.status === 400);
});

test('키 값은 응답·오류 메시지에 절대 나오지 않는다', async () => {
  const fetchFn = fakeFetch([
    [isSearch, SEARCH], [isDetail, jusoOk([{ dongNm: '101동', hoNm: '1203' }])], [isBld, bldOk(UNIT_ITEMS)],
  ]);
  const outs = [
    await handle({ action: 'search', keyword: '가야대로' }, { keys: KEYS, fetchFn }),
    await handle({ action: 'area', ref: REF, dongNm: '101동', hoNm: '1203' }, { keys: KEYS, fetchFn }),
  ];
  const errFetch = fakeFetch([[isSearch, { results: { common: { errorCode: 'E0001', errorMessage: '승인되지 않은 KEY 입니다.' } } }]]);
  const err = await handle({ action: 'search', keyword: '가야대로' }, { keys: KEYS, fetchFn: errFetch }).catch((e) => e.message);
  const all = JSON.stringify(outs) + err;
  for (const k of Object.values(KEYS)) assert.ok(!all.includes(k) && !all.includes(encodeURIComponent(k)), `키(${k.slice(0, 4)}…)가 응답에 노출됨`);
  assert.ok(jusoSearchUrl(KEYS.jusoSearch, '가야').includes('confmKey='), '키는 바깥 API 호출 URL 에만 쓰인다');
});
