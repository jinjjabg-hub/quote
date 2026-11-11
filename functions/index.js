// Cloud Functions 진입점. 함수마다 lib/ 에 파일을 두고 여기서 내보내기만 한다.
//   areaLookup  주소 → 평수 자동 조회 (설계도 4-4장). 키: Secret Manager JUSO_SEARCH_KEY · JUSO_DETAIL_KEY · BLD_KEY
//   notifyJob   일정 배정·변경·취소 → 직원 휴대폰 알림 (설계도 10-1장 ③단계). 키 없음
// 배포: main 에 머지하면 GitHub Actions 가 자동 배포 (.github/workflows/deploy-functions.yml)
export { areaLookup } from './lib/areaLookup.js';
export { notifyJob } from './lib/notifyJob.js';
//   notifyRequest  새 견적 요청 → 사장님 휴대폰 알림 (1순위: 문의를 놓치지 않기). 키 없음
export { notifyRequest } from './lib/notifyRequest.js';
//   billingStatus  무료 견적 10건 세기 · 요금제 상태 · 해지 (설계도 12장). 키 없음
export { billingStatus } from './lib/billingStatus.js';
//   billingPay · billingRenew  카드 자동결제 (토스페이먼츠). Secret Manager 에 TOSS_SECRET_KEY 를 넣은 뒤 아래 줄의 주석을 풀고
//   배포 목록(.github/workflows/deploy-functions.yml FUNCTIONS)에 functions:billingPay,functions:billingRenew 를 추가한다 (배포.md ⑦)
// export { billingPay, billingRenew } from './lib/billingPay.js';
