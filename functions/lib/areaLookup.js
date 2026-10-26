// HTTP 함수 areaLookup — Secret Manager 의 키 3개를 읽어 lib/area.js 의 handle() 에 넘긴다.
// 키는 이름만 여기 있다. 값은 실행할 때 Google 서버 안에서만 읽히고, 응답·로그에 남기지 않는다.
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { handle, LookupError, ALLOWED_ORIGINS } from './area.js';

const JUSO_SEARCH_KEY = defineSecret('JUSO_SEARCH_KEY');
const JUSO_DETAIL_KEY = defineSecret('JUSO_DETAIL_KEY');
const BLD_KEY = defineSecret('BLD_KEY'); // 읽기만 한다. 이 코드는 시크릿을 만들거나 바꾸지 않는다.

export const areaLookup = onRequest({
  region: 'asia-northeast3',
  secrets: [JUSO_SEARCH_KEY, JUSO_DETAIL_KEY, BLD_KEY],
  cors: ALLOWED_ORIGINS,
  maxInstances: 5,
  memory: '256MiB',
  timeoutSeconds: 30,
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, reason: 'method', message: 'POST 만 받습니다.' }); return; }
  const origin = req.get('origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) { res.status(403).json({ ok: false, reason: 'origin', message: '허용되지 않은 출처입니다.' }); return; }
  const action = String(req.body?.action || '');
  try {
    const data = await handle(req.body, {
      keys: { jusoSearch: JUSO_SEARCH_KEY.value(), jusoDetail: JUSO_DETAIL_KEY.value(), bld: BLD_KEY.value() },
      // 바깥 서버 오류 응답(키는 *** 로 가림). Cloud Shell: gcloud functions logs read areaLookup --region=asia-northeast3 --gen2
      log: (level, data) => logger[level === 'warn' ? 'warn' : 'info']('areaLookup 바깥 응답', data),
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    if (e instanceof LookupError) {
      // 사유 코드와 안내문만 기록 (주소·키 값은 기록하지 않음)
      logger.info('areaLookup 실패', { action, reason: e.reason, message: e.message });
      res.status(e.status).json({ ok: false, reason: e.reason, message: e.message });
      return;
    }
    logger.error('areaLookup 오류', { action, error: e?.name || 'Error' });
    res.status(500).json({ ok: false, reason: 'server', message: '일시적인 오류입니다. 평수를 직접 입력해주세요.' });
  }
});
