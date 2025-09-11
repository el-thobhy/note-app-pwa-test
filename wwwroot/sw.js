const CACHE_NAME = 'note-app-static-v1';
const STATIC_ASSETS = [
    '/frest/assets/vendor/fonts/boxicons.css',
    '/frest/assets/vendor/fonts/fontawesome.css',
    '/frest/assets/vendor/fonts/flag-icons.css',
    '/frest/assets/vendor/css/rtl/core.css',
    '/frest/assets/vendor/css/rtl/theme-default.css',
    '/frest/assets/css/demo.css',
    '/frest/assets/vendor/libs/perfect-scrollbar/perfect-scrollbar.css',
    '/frest/assets/vendor/libs/typeahead-js/typeahead.css',
    '/frest/assets/vendor/libs/apex-charts/apex-charts.css',
    '/frest/assets/vendor/libs/datatables-bs5/datatables.bootstrap5.css',
    '/frest/assets/vendor/libs/datatables-responsive-bs5/responsive.bootstrap5.css',
    '/frest/assets/vendor/libs/flatpickr/flatpickr.css',
    '/frest/assets/vendor/css/pages/app-logistics-dashboard.css',
    '/css/site.css',
    '/frest/assets/vendor/js/helpers.js',
    '/frest/assets/vendor/js/template-customizer.js',
    '/frest/assets/js/config.js',
    '/frest/assets/vendor/libs/jquery/jquery.js',
    '/frest/assets/vendor/libs/popper/popper.js',
    '/frest/assets/vendor/js/bootstrap.js',
    '/frest/assets/vendor/libs/perfect-scrollbar/perfect-scrollbar.js',
    '/frest/assets/vendor/libs/hammer/hammer.js',
    '/frest/assets/vendor/libs/i18n/i18n.js',
    '/frest/assets/vendor/libs/typeahead-js/typeahead.js',
    '/frest/assets/vendor/js/menu.js',
    '/frest/assets/vendor/libs/apex-charts/apexcharts.js',
    '/frest/assets/vendor/libs/flatpickr/flatpickr.js',
    '/frest/assets/vendor/libs/moment/moment.js',
    '/frest/assets/js/main.js',
    '/frest/assets/js/app-logistics-dashboard.js',
    '/tinymce/tinymce.min.js',
    '/js/site.js',
    '/frest/assets/vendor/libs/datatables-bs5/datatables-bootstrap5.js',
    '/sw.js',
    '/manifest.json'
];

// Cache static files on install
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
    );
    console.log("Service Worker: Installed & Static Assets Cached");
});

// Activate and clean up old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        )
    );
    console.log("Service Worker: Activated");
});

// Serve cached static files
self.addEventListener('fetch', event => {
    if (STATIC_ASSETS.includes(new URL(event.request.url).pathname)) {
        event.respondWith(
            caches.match(event.request)
                .then(response => response || fetch(event.request))
        );
    }
    // Otherwise, let the request go to the network
});