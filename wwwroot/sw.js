// service-worker.js

// Trigger saat pertama kali SW diinstall
self.addEventListener("install", event => {
    console.log("Service Worker: Installed");
});

// Trigger saat SW diaktifkan (setelah install atau update)
self.addEventListener("activate", event => {
    console.log("Service Worker: Activated");
});

// Trigger setiap ada request dari browser
self.addEventListener("fetch", event => {
    console.log("Service Worker: Fetch ->", event.request.url);
    // Tidak ada caching, request diteruskan langsung ke network
});
