// 서비스워커: 앱 껍데기(HTML/CSS/JS/템플릿)만 캐시. 네트워크 우선 → 오프라인일 때만 캐시 사용.
// Firebase·구글 요청은 건드리지 않는다.
const CACHE = 'quote-v9';
const SHELL = [
  './', './owner.html', './q.html', './view.html', './staff.html', './css/style.css',
  './js/config.js', './js/firebase.js', './js/calc.js', './js/templates.js', './js/util.js',
  './js/owner.js', './js/q.js', './js/view.js', './js/areaLookup.js', './js/schedule.js', './js/staffAdmin.js', './js/jobsAdmin.js', './js/booking.js', './js/bookingAdmin.js', './js/staff.js', './templates/move-in-cleaning.json', './icons/icon.svg',
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
