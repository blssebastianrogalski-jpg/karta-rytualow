// Pamięć podręczna: aplikacja otwiera się szybko i działa przy słabym zasięgu.
const VERSION = 'v41';
const ASSETS = [
  './', 'index.html', 'panel.html', 'config.js', 'css/style.css',
  'js/data.js', 'js/ui.js', 'js/client.js', 'js/panel.js', 'js/integracje.js',
  'vendor/supabase.js', 'vendor/qrcode.js',
  'img/mark.png', 'img/mark-96.png', 'img/logo.png', 'img/favicon.png', 'img/icon-192.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== LOG_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // baza danych zawsze na żywo
  // najpierw sieć (świeże zmiany), a bez internetu wersja zapisana
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// Powiadomienia push: pokazanie wiadomości i otwarcie aplikacji po kliknięciu.
// Każde powiadomienie zapisujemy też w dzienniku (ostatnie 30), żeby panel mógł pokazać,
// czego dotyczyła kropka na ikonie, nawet gdy powiadomienie zniknęło z paska.
const LOG_CACHE = 'powiadomienia';
const LOG_KEY = 'dziennik.json';
async function logPush(d) {
  try {
    const c = await caches.open(LOG_CACHE);
    const old = await c.match(LOG_KEY);
    const list = old ? await old.json() : [];
    list.unshift({ title: d.title || '', body: d.body || '', url: d.url || '', at: new Date().toISOString() });
    await c.put(LOG_KEY, new Response(JSON.stringify(list.slice(0, 30)), { headers: { 'Content-Type': 'application/json' } }));
  } catch (err) { /* dziennik nie może zablokować powiadomienia */ }
}
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'Karta rytuałów', { body: d.body || '', icon: 'img/icon-192.png', data: { url: d.url || './' } }),
    logPush(d)
  ]));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url));
});
