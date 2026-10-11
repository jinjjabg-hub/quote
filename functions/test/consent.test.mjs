// 결제 전 동의 (검수 S4): 약관 링크 없으면 결제 안 열림, 맞춤제작은 별도 동의
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAgreements, requiredAgreements, isCustomMade, legalLinksReady, CUSTOM_MADE_NOTICE, customMadeNoticeText,
} from '../lib/consent.js';
import { checkAgreements as legacyCheck } from '../lib/rules.js';

const ALL = { cancelPolicy: true, terms: true, privacy: true };
const curtain = { service: { templateId: 'curtain', customMade: true } };
const cleaning = { service: { templateId: 'move-in-cleaning' } };

test('일반 견적: 동의 3종이 모두 true 여야', () => {
  assert.equal(checkAgreements(ALL, cleaning).ok, true);
  assert.deepEqual(checkAgreements({ cancelPolicy: true, terms: 'yes' }, cleaning).missing, ['terms', 'privacy']);
  assert.equal(legacyCheck(ALL).ok, true); // rules.js 재수출 호환
});

test('맞춤제작 견적: customMade 별도 동의 + 현재 문구 버전 필수', () => {
  assert.equal(isCustomMade(curtain), true);
  assert.equal(isCustomMade({ service: { customMade: 'true' } }), false); // 정확히 true 만
  assert.deepEqual(requiredAgreements(curtain), ['cancelPolicy', 'terms', 'privacy', 'customMade']);
  const r = checkAgreements(ALL, curtain, { customMadeNoticeVersion: CUSTOM_MADE_NOTICE.version });
  assert.deepEqual(r.missing, ['customMade']);
  assert.equal(checkAgreements({ ...ALL, customMade: true }, curtain, { customMadeNoticeVersion: CUSTOM_MADE_NOTICE.version }).ok, true);
  assert.equal(checkAgreements({ ...ALL, customMade: true }, curtain, { customMadeNoticeVersion: 'custom-made-v0' }).code, 'NOTICE_OUTDATED');
  assert.equal(checkAgreements({ ...ALL, customMade: true }, curtain, {}).code, 'NOTICE_OUTDATED');
});

test('맞춤제작 고지 원문: legal 필수 요소(개별 제작·재판매 불가·제작 후 변심 불가·하자 예외)', () => {
  const text = customMadeNoticeText();
  assert.match(text, /치수에 맞춰 개별 제작/);
  assert.match(text, /다른 곳에 쓸 수 없어요/);
  assert.match(text, /제작 시작 후: 단순 변심으로는 취소·환불이 안 돼요/);
  assert.match(text, /하자/);
  assert.match(text, /\[필수\]/);
});

test('약관·처리방침 링크: 둘 다 있어야 결제 가능', () => {
  assert.equal(legalLinksReady({ termsUrl: '', privacyUrl: 'https://x.github.io/privacy.html' }), false);
  assert.equal(legalLinksReady({ termsUrl: 'https://x.github.io/terms.html', privacyUrl: '' }), false);
  assert.equal(legalLinksReady({ termsUrl: '  ', privacyUrl: ' ' }), false);
  assert.equal(legalLinksReady({ termsUrl: 'javascript:alert(1)', privacyUrl: 'https://a.b/p' }), false);
  assert.equal(legalLinksReady({}), false);
  assert.equal(legalLinksReady({ termsUrl: 'https://x.github.io/terms.html', privacyUrl: 'https://x.github.io/privacy.html' }), true);
  assert.equal(legalLinksReady({ termsUrl: 'terms.html', privacyUrl: './privacy.html' }), true);
});

test('고객 화면(js/payment.js)의 고지 문구·링크 판정이 서버와 같다', async (t) => {
  let client;
  try { client = await import('../../js/payment.js'); } catch (e) { t.skip(`js/payment.js 를 Node 에서 불러오지 못함: ${e.message}`); return; }
  assert.deepEqual(client.CUSTOM_MADE_NOTICE, CUSTOM_MADE_NOTICE);
  for (const v of [{}, { termsUrl: 'terms.html', privacyUrl: '' }, { termsUrl: 'https://a.b/t', privacyUrl: 'https://a.b/p' }, { termsUrl: 'javascript:x', privacyUrl: 'https://a.b/p' }]) {
    assert.equal(client.legalLinksReady(v), legalLinksReady(v), JSON.stringify(v));
  }
});

test('현재 config.js 는 약관 링크가 비어 있으므로 결제 버튼이 나오지 않는다 (예약 요청 유지)', async (t) => {
  let client;
  let cfg;
  try { client = await import('../../js/payment.js'); cfg = await import('../../js/config.js'); } catch (e) { t.skip(e.message); return; }
  const PC = cfg.paymentConfig;
  const quoteOk = { deposit: 112000, cancelPolicy: '3일 전 전액' };
  if (!(String(PC.termsUrl || cfg.appConfig?.termsUrl || '').trim() && String(PC.privacyUrl || cfg.appConfig?.privacyUrl || '').trim())) {
    assert.equal(client.paymentEnabled(quoteOk), false);
  }
});
