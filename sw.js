/* Service Worker: アプリシェルをプリキャッシュし完全オフライン起動を保証する。
   デプロイ時は VERSION を上げること（古いキャッシュは activate で破棄）。 */

const VERSION = "v6";
const CACHE = `ic-exam-${VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./logic.js",
  "./db.js",
  "./app.js",
  "./manifest.json",
  "./sample_questions.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* cache-first。オンライン時はバックグラウンドで再取得しキャッシュ更新（次回起動に反映） */
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetched = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
