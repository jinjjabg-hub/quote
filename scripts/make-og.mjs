// 공유 미리보기(OG) 이미지 3종을 scripts/og.html 에서 만든다. 실행: node scripts/make-og.mjs  (playwright + 인터넷(글꼴) 필요)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // 전역 설치본도 찾도록 (NODE_PATH)

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
for (const [v, file] of [['owner', 'og.png'], ['quote', 'og-quote.png'], ['view', 'og-view.png']]) {
  await page.goto(`${pathToFileURL(path.join(here, 'og.html'))}?v=${v}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(here, '../icons', file) });
  console.log('만듦:', file);
}
await browser.close();
