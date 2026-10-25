// Cloud Functions 진입점. 함수마다 lib/ 에 파일을 두고 여기서 내보내기만 한다.
//   areaLookup  주소 → 평수 자동 조회 (설계도 4-4장). 키: Secret Manager JUSO_SEARCH_KEY · JUSO_DETAIL_KEY · BLD_KEY
// 배포: npx firebase-tools deploy --only functions:areaLookup --project quote-640f4
export { areaLookup } from './lib/areaLookup.js';
