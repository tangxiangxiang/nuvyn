// REQ-PWA-001: cache *only* Vite's content-hashed, public build assets.
// Never intercept HTML navigations, API calls, draft/attachment URLs or
// unversioned public files. Data remains authoritative on the NAS.
const ASSET_CACHE = 'nuvyn-pwa-assets-v1'
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|woff|ttf|otf|png|jpe?g|webp|avif|svg)$/

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith('nuvyn-pwa-assets-') && name !== ASSET_CACHE)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || request.mode === 'navigate') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || !HASHED_ASSET.test(url.pathname)) return

  event.respondWith((async () => {
    const cache = await caches.open(ASSET_CACHE)
    const cached = await cache.match(request)
    if (cached) return cached

    const response = await fetch(request)
    if (response.ok && response.type === 'basic') {
      try {
        await cache.put(request, response.clone())
      } catch {
        // Storage quotas/private modes must never break a successful fetch.
      }
    }
    return response
  })())
})

// Deliberately no skipWaiting(): an open Diary editor must not be replaced
// mid-session. New pages load current HTML over the network on refresh.
