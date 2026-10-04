// アプリ本体（このサイトのファイル）だけをキャッシュする。外部 CDN はブラウザーの通常キャッシュに任せる。
const VERSION = 'vitalroom-web-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/main.js', 'js/nav.js', 'js/ui.js', 'js/config.js', 'js/dsp.js', 'js/session.js', 'js/face.js', 'js/vitals.js',
  'js/camera.js', 'js/widgets.js', 'js/p2p.js', 'js/interview.js',
  'js/screens/home.js', 'js/screens/measure.js', 'js/screens/room.js', 'js/screens/ai.js', 'js/screens/history.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 同一オリジンはネットワーク優先（更新をすぐ反映）、オフライン時のみキャッシュを返す。
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))));
});
