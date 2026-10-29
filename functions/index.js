// Cloud Functions 진입점. 함수마다 lib/ 에 파일을 두고 여기서 내보내기만 한다.
//   areaLookup  주소 → 평수 자동 조회 (설계도 4-4장). 키: Secret Manager JUSO_SEARCH_KEY · JUSO_DETAIL_KEY · BLD_KEY
//   notifyJob   일정 배정·변경·취소 → 직원 휴대폰 알림 (설계도 10-1장 ③단계). 키 없음
// 배포: main 에 머지하면 GitHub Actions 가 자동 배포 (.github/workflows/deploy-functions.yml)
export { areaLookup } from './lib/areaLookup.js';
export { notifyJob } from './lib/notifyJob.js';
