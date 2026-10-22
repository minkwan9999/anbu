// 안부버튼 서비스 워커: 앱이 닫혀 있어도 알림을 띄운다
//  - 어르신 폰: 약 드실 시간 (alarm: 길게 진동, 누를 때까지 남음)
//  - 보호자 폰: 약 미응답
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '안부버튼', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag,
    renotify: !!d.tag,
    requireInteraction: !!d.alarm,
    vibrate: d.alarm ? [600, 300, 600, 300, 600, 300, 1200] : [200, 100, 200],
    data: { url: d.url || './#/guardian' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data.url, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.navigate(url).then(w => (w || c).focus());
    }
    return self.clients.openWindow(url);
  }));
});
