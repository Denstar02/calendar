/* Календарь: работа без интернета.
   Сохраняет на устройстве страницу, темы, значок, шрифты и библиотеку синхронизации,
   чтобы календарь открывался и без сети. Сами записи браузер и так хранит у себя.

   Свои файлы (index.html, themes/*.css) — сначала из сети, чтобы обновления с GitHub
   появлялись сразу; если сети нет или она очень медленная — из сохранённого.
   Шрифты и библиотека Firebase не меняются (у них версия в адресе) — из сохранённого.
   Запросы самой синхронизации (Firestore) не трогаются. */

var APP = 'kalendar-app-v1';
var EXT = 'kalendar-ext-v1';
var CORE = ['./', './index.html', './themes/paper.css', './themes/vhs.css', './themes/term.css', './apple-touch-icon.png'];
var WAIT = 2500; // сколько ждать сеть, прежде чем открыть сохранённое
var slowUntil = 0; // сеть только что не успела ответить — остальные файлы страницы почти не ждём

self.addEventListener('install', function (e) {
  // по одному файлу: если какого-то нет на сайте, остальные всё равно сохранятся
  e.waitUntil(caches.open(APP).then(function (c) {
    return Promise.all(CORE.map(function (u) { return c.add(u).catch(function () { return null; }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== APP && k !== EXT; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isFixed(url) { return url.hostname === 'fonts.gstatic.com' || (url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0); }
function isFontCss(url) { return url.hostname === 'fonts.googleapis.com'; }

// чужие файлы просим с CORS, чтобы сохранить их целиком; если сервер не разрешает — как есть
function fetchExt(url) {
  return fetch(new Request(url, { mode: 'cors', credentials: 'omit' })).catch(function () { return fetch(url, { mode: 'no-cors' }); });
}
function usable(res) { return !!res && (res.ok || res.type === 'opaque'); }
function keep(cacheName, key, res) {
  if (usable(res)) return caches.open(cacheName).then(function (c) { return c.put(key, res); }).catch(function () { return null; });
  return Promise.resolve(null);
}

// В CSS Google Fonts у каждого набора букв свой файл. Сохраняем кириллицу и латиницу всех шрифтов сразу,
// чтобы любая тема выглядела как надо и без сети, даже если на этом устройстве её ещё не включали.
function fontFiles(css) {
  var out = [], re = /\/\*\s*(?:cyrillic|latin)\s*\*\/\s*@font-face\s*\{[^}]*?url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/g, m;
  while ((m = re.exec(css))) out.push(m[1]);
  return out;
}
function keepFontFiles(cssRes) {
  return cssRes.text().then(function (css) {
    var urls = fontFiles(css);
    if (!urls.length) return null;
    return caches.open(EXT).then(function (c) {
      return Promise.all(urls.map(function (u) {
        return c.match(u).then(function (hit) {
          if (hit) return null;
          return fetchExt(u).then(function (r) { if (r && r.ok) return c.put(u, r); return null; }).catch(function () { return null; });
        });
      }));
    });
  }).catch(function () { return null; });
}
// CSS шрифтов: сохранить сам файл и файлы шрифтов из него
function keepFontCss(url, res) {
  if (!res || !res.ok) return res ? keep(EXT, url, res.clone()) : Promise.resolve(null);
  var a = res.clone(), b = res.clone();
  return keep(EXT, url, a).then(function () { return keepFontFiles(b); });
}

function networkFirst(req) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(r) { if (!done && r) { done = true; resolve(r); } }
    function fromCache() {
      return caches.match(req, { ignoreSearch: true }).then(function (r) {
        return r || (req.mode === 'navigate' ? caches.match('./index.html') : null);
      });
    }
    var timer = setTimeout(function () {
      slowUntil = Date.now() + 15000;
      fromCache().then(finish);
    }, Date.now() < slowUntil ? 300 : WAIT);
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) { keep(APP, req, res.clone()); finish(res); return; }
      // сбой на стороне сайта (5xx) — лучше показать сохранённое
      if (res && res.status >= 500) { fromCache().then(function (r) { finish(r || res); }); return; }
      finish(res);
    }).catch(function () {
      clearTimeout(timer);
      fromCache().then(function (r) { if (!done) { done = true; resolve(r || Response.error()); } });
    });
  });
}

function cacheFirst(req) {
  return caches.match(req.url).then(function (hit) {
    if (hit) return hit;
    return fetchExt(req.url).then(function (res) { keep(EXT, req.url, res.clone()); return res; });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req)); return; }
  if (isFixed(url)) { e.respondWith(cacheFirst(req)); return; }
  if (isFontCss(url)) {
    // сохранённый CSS отдаём сразу, а в фоне обновляем
    var saving = null;
    var net = fetchExt(req.url).then(function (res) { saving = keepFontCss(req.url, res); return res; });
    e.waitUntil(net.then(function () { return saving; }).catch(function () { return null; }));
    e.respondWith(caches.match(req.url).then(function (hit) {
      return hit || net.catch(function () { return Response.error(); });
    }));
    return;
  }
  // остальное (Firestore и прочее) — как обычно, мимо
});

// страница сообщает, какие шрифты и библиотеки она уже загрузила, — сохраняем их сразу,
// чтобы календарь открывался без сети уже со следующего запуска
self.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'cache' || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(EXT).then(function (c) {
    return Promise.all(d.urls.slice(0, 200).map(function (u) {
      var url;
      try { url = new URL(u); } catch (err) { return null; }
      if (isFontCss(url)) {
        // CSS проверяем всегда: из него берутся все файлы шрифтов
        return fetchExt(u).then(function (res) { return keepFontCss(u, res); }).catch(function () { return null; });
      }
      if (!isFixed(url)) return null;
      return c.match(u).then(function (hit) {
        if (hit) return null;
        return fetchExt(u).then(function (res) { if (usable(res)) return c.put(u, res); return null; }).catch(function () { return null; });
      });
    }));
  }));
});
