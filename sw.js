// Service worker: แคชหน้าแอปไว้เปิดได้เร็ว/ออฟไลน์ ส่วนข้อมูล (POST ไป Apps Script) ไม่แคช
const CACHE = 'mm-v18';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'images/family-boy.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// network-first สำหรับไฟล์ของแอป (ได้เวอร์ชันใหม่เสมอเมื่อออนไลน์) ตกไปใช้แคชเมื่อออฟไลน์
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
