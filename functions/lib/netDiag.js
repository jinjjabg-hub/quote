// 네트워크 진단 (action: "diag"). 키를 쓰지 않는다.
// 함수가 바깥으로 나가는 IP 와, 바깥 서버 443 포트 연결 시간을 잰다.
// juso.go.kr 만 연결 시간 초과가 나는 문제(2026-10-26)처럼, 리전·IP 에 따른 차단을 데이터로 확인하기 위함.
import net from 'node:net';

export const DIAG_TARGETS = ['business.juso.go.kr', 'apis.data.go.kr'];

/** TCP 연결만 해보고 걸린 시간(ms)을 잰다. 데이터는 보내지 않는다. */
export function tcpConnect(host, port = 443, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, error) => { socket.destroy(); resolve({ host, ok, ms: Date.now() - started, ...(error ? { error } : {}) }); };
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'));
    socket.once('connect', () => done(true));
    socket.once('error', (e) => done(false, String(e?.code || e?.name || 'error').replace(/[^A-Za-z0-9_]/g, '')));
  });
}

/** 나가는 IP (공개 IP 확인 서비스). 실패하면 오류 코드만 */
export async function egressIp(fetchFn = fetch) {
  try {
    const res = await fetchFn('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    return /^[0-9a-fA-F.:]{3,45}$/.test(j?.ip || '') ? j.ip : 'unknown';
  } catch (e) {
    return `error:${String(e?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '')}`;
  }
}

export async function diagnose({ fetchFn = fetch, connect = tcpConnect, region = '' } = {}) {
  const [ip, ...targets] = await Promise.all([egressIp(fetchFn), ...DIAG_TARGETS.map((h) => connect(h, 443))]);
  return { region, egressIp: ip, targets, at: new Date().toISOString() };
}
