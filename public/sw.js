// ClaudeCraft service worker (B11). Registered from src/pwa.js (PROD only).
//
// Strategy: cache-first for every same-origin GET, with a background refresh so
// a redeploy lands on the NEXT visit while the current one keeps playing
// offline (the acceptance bar: "plays offline after first load"). The precache
// list is NOT hardcoded — sw.js fetches sw-manifest.json (generated from dist/
// by scripts/gen-pwa-manifest.mjs after a build) and falls back to runtime-only
// caching when that file is missing (e.g. dev, or the script was never run).
//
// Version bump = stale cleanup: bump CACHE below, activate deletes every older
// ccw-static-* cache.
const CACHE = 'ccw-static-v1';
// Never trust the network path for the shell itself.
const SHELL = ['./', './manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let files = [];
    try {
      const res = await fetch('./sw-manifest.json', { cache: 'no-store' });
      if (res.ok) files = (await res.json()).files ?? [];
    } catch { /* no manifest → runtime caching still covers everything */ }
    await cache.addAll([...new Set([...SHELL, ...files])]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // only OUR caches: version-bumped stale cleanup leaves foreign caches alone
    await Promise.all(
      names.filter(n => n !== CACHE && n.startsWith('ccw-static-'))
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // cross-origin (fonts/CDN if ever added) and Range requests (media) are out
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      // Navigations: serve the cached shell, refresh the cache in the
      // background so the next visit gets the new build. Without a cache hit
      // (first visit never reaches here) go straight to the network.
      const hit = await cache.match(req, { ignoreSearch: true }) ?? await cache.match('./');
      const refresh = fetch(req)
        .then(res => { if (res && res.ok) cache.put(req, res.clone()); })
        .catch(() => {});
      if (hit) { event.waitUntil(refresh); return hit; }
      try { return await fetch(req); }
      catch { return new Response('ClaudeCraft is offline', { status: 503 }); }
    }
    // Everything else: strict cache-first (hashed assets never change meaning).
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // 'basic' = same-origin success; opaque/errored responses are not worth caching
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch {
      return new Response('ClaudeCraft is offline', { status: 503 });
    }
  })());
});