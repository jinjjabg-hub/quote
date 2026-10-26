// 네트워크 진단 테스트 (실제 접속 없이 가짜 연결·fetch 로)
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { diagnose, egressIp, tcpConnect, DIAG_TARGETS } from '../lib/netDiag.js';

test('diagnose: 나가는 IP + 대상별 연결 결과', async () => {
  const fetchFn = async () => ({ json: async () => ({ ip: '34.64.1.2' }) });
  const connect = async (host) => ({ host, ok: host.includes('data'), ms: 12, ...(host.includes('juso') ? { error: 'timeout' } : {}) });
  const d = await diagnose({ fetchFn, connect, region: 'asia-northeast3' });
  assert.equal(d.egressIp, '34.64.1.2');
  assert.equal(d.region, 'asia-northeast3');
  assert.deepEqual(d.targets.map((t) => t.host), DIAG_TARGETS);
  assert.equal(d.targets.find((t) => t.host.includes('juso')).error, 'timeout');
});

test('egressIp: 이상한 응답·실패는 값 대신 표시만', async () => {
  assert.equal(await egressIp(async () => ({ json: async () => ({ ip: '<script>' }) })), 'unknown');
  assert.match(await egressIp(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }), /^error:TimeoutError$/);
});

test('tcpConnect: 실제 로컬 소켓으로 연결 성공·거부 측정', async () => {
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const ok = await tcpConnect('127.0.0.1', port, 2000);
  assert.equal(ok.ok, true);
  server.close();
  await new Promise((r) => server.once('close', r));
  const refused = await tcpConnect('127.0.0.1', port, 2000);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'ECONNREFUSED');
});
