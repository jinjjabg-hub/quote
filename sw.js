// 서비스워커: 앱 껍데기(HTML/CSS/JS/템플릿)만 캐시. 네트워크 우선 → 오프라인일 때만 캐시 사용.
// Firebase·구글 요청은 건드리지 않는다.
const CACHE = 'quote-v13';
const SHELL = [
  './', './owner.html', './q.html', './view.html', './staff.html', './manifest-staff.webmanifest', './css/style.css', './css/legal.css', './pricing.html', './terms.html', './refund.html', './privacy.html',
  './js/config.js', './js/firebase.js', './js/calc.js', './js/templates.js', './js/util.js',
  './js/owner.js', './js/q.js', './js/view.js', './js/areaLookup.js', './js/schedule.js', './js/staffAdmin.js', './js/jobsAdmin.js', './js/booking.js', './js/bookingAdmin.js', './js/push.js', './js/staff.js', './templates/move-in-cleaning.json', './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

// 일정 배정 알림 (설계도 10-1장 ③단계). 서버 함수 notifyJob 이 FCM 으로 data 만 보내고, 알림 모양은 여기서 만든다.
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { data: { title: '일정 알림', body: e.data?.text() || '' } }; }
  const d = p.data || {};
  const n = p.notification || {};
  const title = d.title || n.title || '알림';
  const tag = d.jobId ? `job-${d.jobId}` : d.requestId ? `req-${d.requestId}` : undefined; // 같은 건의 알림은 최신 것 하나만
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || n.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag,
    renotify: !!tag,
    data: { link: d.link || './staff.html' },
  }));
});

// 알림을 누르면: 직원 일정 알림 → 직원 화면, 새 견적 요청 알림 → 사장님 화면의 그 요청. 우리 사이트 주소로만 연다.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = new URL(e.notification.data?.link || './staff.html', self.location.href);
  const page = link.pathname.endsWith('/owner.html') ? 'owner.html' : 'staff.html';
  const target = new URL(`./${page}`, self.location.href);
  if (page === 'owner.html') target.hash = link.hash;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).pathname.endsWith(`/${page}`));
    if (open) return (target.hash && open.navigate ? open.navigate(target.href).catch(() => open) : Promise.resolve(open)).then((c) => (c || open).focus());
    return self.clients.openWindow(target.href);
  }));
});
