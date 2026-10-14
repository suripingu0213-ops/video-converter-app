// オフライン用 Service Worker。一度開けば以降は通信なしで起動できる（動画本体は IndexedDB に保存）。
// 通信できる時は最新のファイルを取りに行き、圏外ならキャッシュで動く。
// アプリを更新したら VERSION を上げる（app.js の APP_VERSION も合わせる）。
// 同じ github.io にポケット将棋もあるので、消すキャッシュは自分の接頭辞のものだけにする。
const PREFIX = 'video-converter-';
const VERSION = PREFIX + 'v1';
const APP_FILES = ['./', './index.html', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];
const NET_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(APP_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req) {
  return new Promise((resolve) => {
    let settled = false;
    const fromCache = () => caches.match(req, { ignoreSearch: true, cacheName: VERSION }).then((hit) => hit || fetch(req));
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fromCache()); } }, NET_TIMEOUT_MS);
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      if (!settled) { settled = true; clearTimeout(timer); resolve(res); }
    }).catch(() => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(fromCache()); }
    });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // GitHub API などは触らない。自分のフォルダ内のファイルだけ扱う
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(networkFirst(req));
});
