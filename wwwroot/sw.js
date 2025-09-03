const CACHE_NAME = "pwa-cache-v1";

const urlsToCache = [
    "/manifest.json",
    "/offline.html",
    "/css/site.css",
    "/js/site.js",
];


self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async cache => {
            for (const url of urlsToCache) {
                try {
                    const response = await fetch(url, { redirect: "follow" });
                    if (response.ok) {
                        await cache.put(url, response);
                    }
                } catch (e) {
                    console.log("cache add failed for", url, e);
                }
            }
        })
    )
});

//Aktivasi Service Worker hapus cache lama jika versi berubah
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        })
    )
});


//fetch handler
self.addEventListener("fetch", event => {
    if (event.request.mode === "navigate") {
        // bikin request baru dengan redirect: follow
        const newRequest = new Request(event.request.url, {
            method: event.request.method,
            headers: event.request.headers,
            mode: event.request.mode,
            credentials: event.request.credentials,
            cache: event.request.cache,
        });

        event.respondWith(
            fetch(newRequest)
                .then(response => {
                    // kalau server redirect ke login, biarkan browser yang tangani
                    if (response && response.type === "opaqueredirect") {
                        return response;
                    }
                    return response;
                })
                .catch(() => caches.match("/offline.html"))
        );
        return;
    }

    // asset statis → cache first
    event.respondWith(
        caches.match(event.request).then(cacheResponse => {
            return cacheResponse || fetch(event.request);
        })
    );
});
