// Pamięć podręczna: aplikacja otwiera się szybko i działa przy słabym zasięgu.
const VERSION = 'v2';
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
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Karta rytuałów', { body: d.body || '', icon: 'img/icon-192.png', data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url));
});
