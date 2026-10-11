// 배포 단위 확인: index.js 가 문법·import 오류 없이 로드되고 약속한 함수 6개를 내보낸다
import test from 'node:test';
import assert from 'node:assert/strict';

test('index.js 함수 목록 (contract.md: verifyBusiness, updateIdentity 포함)', async () => {
  process.env.GCLOUD_PROJECT ||= 'demo-quote';
  const m = await import('../index.js');
  assert.deepEqual(Object.keys(m).sort(),
    ['cancelPayment', 'confirmPayment', 'preparePayment', 'tossWebhook', 'updateIdentity', 'verifyBusiness']);
});
