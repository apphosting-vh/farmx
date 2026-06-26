/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           FARM MANAGER — SERVICE WORKER                          ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  Version      : 5.0.0                                            ║
 * ║  Cache Key    : farm-manager-v5.0.0                              ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  UPDATE DELIVERY MECHANISM                                        ║
 * ║  ─────────────────────────────────────────────────────────────   ║
 * ║  1. On each new GitHub Pages deploy, update CACHE_VERSION below. ║
 * ║     The browser detects the changed SW byte-for-byte and begins  ║
 * ║     installing the new SW alongside the running one.             ║
 * ║  2. install  → precaches all app shell assets under new key.     ║
 * ║  3. New SW enters "waiting" state — does NOT disrupt the user.   ║
 * ║  4. The app's React update banner fires (via updatefound event). ║
 * ║  5. User clicks "Update Now" → app sends { type: SKIP_WAITING }. ║
 * ║  6. skipWaiting() → activate fires → clients.claim() takes       ║
 * ║     control → controllerchange fires on every tab → auto-reload. ║
 * ║  7. activate deletes ALL old cache keys, installs fresh cache.   ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  CACHING STRATEGIES                                               ║
 * ║    index.html   → Navigation-preload + network-first (3s timeout)║
 * ║    CDN scripts  → Cache-first     (pinned semver URLs, immutable)║
 * ║    Icons/assets → Cache-first     (static, versioned by SW key)  ║
 * ║    Google Fonts → Stale-while-revalidate (dedicated FONT_CACHE)  ║
 * ║    Google APIs  → Network-only    (authenticated, never cache)   ║
 * ║    Everything else → Stale-while-revalidate                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  OPTIMISATIONS IN THIS VERSION                                    ║
 * ║    • Parallel precaching — Promise.all replaces serial for-loops ║
 * ║    • Google Fonts CSS precached at install time (FONT_URLS)      ║
 * ║    • Dedicated FONT_CACHE bucket (separate from ASSET_CACHE)     ║
 * ║    • Smart network-first with 3 s timeout for app shell          ║
 * ║    • PREFETCH_FONTS message → idle-time warm-cache of woff2 URLs ║
 * ║    • trimCache() — per-bucket entry limits, runs at install +    ║
 * ║      activate + after every cache write (async, non-blocking)    ║
 * ║    • SW_READY_FOR_WARM_CACHE notification sent after install so  ║
 * ║      the page can schedule idle prefetch via requestIdleCallback  ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  ⚠️  HOW TO RELEASE A NEW VERSION                                ║
 * ║     1. Change CACHE_VERSION string below (e.g. v2.6.0)           ║
 * ║     2. Change APP_VERSION in index.html to match                 ║
 * ║     3. Push both files to GitHub — Pages redeploys automatically ║
 * ║     Browser detects SW byte-change → update flow begins          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

// ─── VERSION — BUMP THIS ON EVERY RELEASE ────────────────────────────────────
// Must match APP_VERSION constant in index.html.
const CACHE_VERSION = 'v5.0.0'; // bumped: Total Project Cost = Item + Labor auto-sum; v5.0.0

// ─── Cache bucket names ───────────────────────────────────────────────────────
// Shell cache  — HTML + same-origin static assets.
// Asset cache  — CDN libraries (React, Babel, etc.) shared across versions.
// Font cache   — Google Fonts CSS + woff2 binaries, shared across versions.
const SHELL_CACHE = `farm-manager-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `farm-manager-assets-${CACHE_VERSION}`;
const FONT_CACHE  = `farm-manager-fonts-${CACHE_VERSION}`;

// ─── Cache size limits (max entries per bucket) ───────────────────────────────
// Oldest entries are evicted when a bucket exceeds its limit, preventing the
// browser from hitting its storage quota and silently dropping whole caches.
const SHELL_CACHE_MAX_ENTRIES = 20;
const ASSET_CACHE_MAX_ENTRIES = 60;
const FONT_CACHE_MAX_ENTRIES  = 40;

// ─── Network timeout for app-shell fetches (ms) ──────────────────────────────
// If the network has not responded within this window we serve the cached
// shell immediately so the app never stalls on a slow or lossy connection.
const SHELL_NETWORK_TIMEOUT_MS = 3000;

// ─── Resources to pre-cache during install ────────────────────────────────────
const SHELL_URLS = [
  'https://apphosting-vh.github.io/farmx/',
  'https://apphosting-vh.github.io/farmx/index.html',
  'https://apphosting-vh.github.io/farmx/app-core.js',
  'https://apphosting-vh.github.io/farmx/manifest.json',
];

// CDN scripts: pinned semver URLs — content never changes for a given URL.
// Served from ASSET_CACHE indefinitely; evicted only when ASSET_CACHE key changes.
const CDN_URLS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.26.0/babel.min.js',
];

// Google Fonts CSS stylesheet(s) — precached at install so font metrics are
// available for the very first paint, even on a slow connection.
// The woff2 binary files themselves are warm-cached on idle after app load
// via the PREFETCH_FONTS message (sent from index.html's requestIdleCallback).
const FONT_URLS = [
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap',
];

// ─── URL classifiers ──────────────────────────────────────────────────────────
const APP_ORIGIN = 'apphosting-vh.github.io';
const APP_PATH   = '/farmx';

const CDN_ORIGINS = [
  'unpkg.com',
  'cdnjs.cloudflare.com',
];

// Google Fonts — cached separately. Matched BEFORE GOOGLE_ORIGINS so that
// fonts.googleapis.com is not accidentally treated as a pass-through API call.
const FONT_ORIGINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const GOOGLE_ORIGINS = [
  'googleapis.com',
  'accounts.google.com',
  'drive.google.com',
];

function isAppShell(url) {
  return (
    url.hostname === APP_ORIGIN &&
    (url.pathname === `${APP_PATH}/` ||
     url.pathname === `${APP_PATH}/index.html` ||
     url.pathname.endsWith('/'))
  );
}

function isSameOriginStatic(url) {
  return (
    url.hostname === APP_ORIGIN &&
    /\.(png|jpg|jpeg|svg|ico|json|webp|woff2?|txt|xml)$/i.test(url.pathname)
  );
}

function isCDNAsset(url) {
  return CDN_ORIGINS.some(origin => url.hostname.endsWith(origin));
}

function isGoogleFont(url) {
  return FONT_ORIGINS.some(origin => url.hostname === origin);
}

function isGoogleAPI(url) {
  // Explicitly exclude font origins: fonts.googleapis.com ends with
  // "googleapis.com" and must never be treated as a pass-through API call.
  if (isGoogleFont(url)) return false;
  return GOOGLE_ORIGINS.some(origin => url.hostname.endsWith(origin));
}

// ─────────────────────────────────────────────────────────────────────────────
//  QUOTA MANAGEMENT — trim a cache bucket to at most maxEntries entries
//
//  Cache API preserves insertion order, so keys()[0] is always the oldest.
//  We slice off the front of the list when the bucket is over budget.
//  Called: after install precaching, in activate, and after each cache write.
// ─────────────────────────────────────────────────────────────────────────────
async function trimCache(cacheName, maxEntries) {
  try {
    const cache  = await caches.open(cacheName);
    const keys   = await cache.keys();
    if (keys.length <= maxEntries) return;
    const excess = keys.slice(0, keys.length - maxEntries);
    await Promise.all(excess.map(key => cache.delete(key)));
    console.log(`[SW] Trimmed ${excess.length} excess entries from ${cacheName}`);
  } catch (e) {
    console.warn(`[SW] trimCache failed for ${cacheName}:`, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  INSTALL — Precache app shell, CDN assets, and font stylesheets in PARALLEL
//
//  All three cache buckets are opened and filled concurrently (outer Promise.all).
//  Within each bucket, every URL is also fetched in parallel (inner Promise.all),
//  cutting install time from O(N sequential round-trips) to ~O(1 round-trip).
//
//  After precaching, SW_READY_FOR_WARM_CACHE is broadcast so any open window
//  can schedule idle-time warm-caching of font binaries (woff2 URLs).
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SW] Installing Farm Manager ${CACHE_VERSION}`);

  event.waitUntil((async () => {

    // ── Parallel bucket fill ──────────────────────────────────────────────────
    await Promise.all([

      // 1. App shell (HTML + manifest) — always re-fetch to pick up new deploys
      caches.open(SHELL_CACHE).then(cache =>
        Promise.all(SHELL_URLS.map(async url => {
          try {
            const res = await fetch(url, { cache: 'reload' }); // bypass HTTP cache
            if (res.ok) await cache.put(url, res);
          } catch (e) {
            console.warn(`[SW] Shell precache skipped: ${url}`, e.message);
          }
        }))
      ),

      // 2. CDN scripts — skip URLs already cached to save bandwidth on minor bumps
      caches.open(ASSET_CACHE).then(cache =>
        Promise.all(CDN_URLS.map(async url => {
          try {
            const existing = await cache.match(url);
            if (!existing) {
              const res = await fetch(url);
              if (res.ok) await cache.put(url, res);
            }
          } catch (e) {
            console.warn(`[SW] CDN precache skipped: ${url}`, e.message);
          }
        }))
      ),

      // 3. Google Fonts CSS — CORS mode required; skip if already cached
      caches.open(FONT_CACHE).then(cache =>
        Promise.all(FONT_URLS.map(async url => {
          try {
            const existing = await cache.match(url);
            if (!existing) {
              const res = await fetch(url, { mode: 'cors' });
              if (res.ok) await cache.put(url, res);
            }
          } catch (e) {
            console.warn(`[SW] Font precache skipped: ${url}`, e.message);
          }
        }))
      ),

    ]);

    // ── Post-install quota guard ──────────────────────────────────────────────
    await Promise.all([
      trimCache(SHELL_CACHE, SHELL_CACHE_MAX_ENTRIES),
      trimCache(ASSET_CACHE, ASSET_CACHE_MAX_ENTRIES),
      trimCache(FONT_CACHE,  FONT_CACHE_MAX_ENTRIES),
    ]);

    console.log(`[SW] Precache complete for ${CACHE_VERSION}`);

    // ── Notify open windows so they can idle-prefetch font binaries ───────────
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client =>
      client.postMessage({ type: 'SW_READY_FOR_WARM_CACHE', version: CACHE_VERSION })
    );

    // ⚠️  Do NOT call self.skipWaiting() here.
    // We wait for an explicit { type: 'SKIP_WAITING' } message from the app
    // so we never interrupt a user who is mid-session when a new version lands.
  })());
});

// ─────────────────────────────────────────────────────────────────────────────
//  ACTIVATE — Delete stale caches, enforce quota, claim all open clients
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log(`[SW] Activating Farm Manager ${CACHE_VERSION}`);

  event.waitUntil(
    // 1. Purge every cache that belongs to this app but is NOT the current version
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key =>
            key.startsWith('farm-manager-') &&
            key !== SHELL_CACHE &&
            key !== ASSET_CACHE &&
            key !== FONT_CACHE
          )
          .map(stale => {
            console.log(`[SW] Deleting stale cache: ${stale}`);
            return caches.delete(stale);
          })
      ))

      // 2. Enforce per-bucket entry limits on the current version's caches
      .then(() => Promise.all([
        trimCache(SHELL_CACHE, SHELL_CACHE_MAX_ENTRIES),
        trimCache(ASSET_CACHE, ASSET_CACHE_MAX_ENTRIES),
        trimCache(FONT_CACHE,  FONT_CACHE_MAX_ENTRIES),
      ]))

      // 3. Take control of ALL open tabs immediately — without waiting for reload
      .then(() => self.clients.claim())

      // 4. Enable Navigation Preload (where supported) — the browser can fetch
      //    the HTML in parallel with SW boot, eliminating startup-latency penalty.
      .then(() => {
        if (self.registration.navigationPreload) {
          return self.registration.navigationPreload.enable();
        }
      })

      // 5. Notify every open window that the new version is now live
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => {
        console.log(`[SW] ${CACHE_VERSION} active — notifying ${clients.length} client(s)`);
        clients.forEach(client =>
          client.postMessage({
            type:    'SW_ACTIVATED',
            version: CACHE_VERSION,
            message: `Farm Manager ${CACHE_VERSION} is now active.`
          })
        );
      })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
//  MESSAGE — Handle messages from the React app
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (!event.data) return;

  switch (event.data.type) {

    // ── SKIP_WAITING ──────────────────────────────────────────────────────────
    // Sent by the React app when the user clicks "Update Now".
    case 'SKIP_WAITING':
      console.log('[SW] SKIP_WAITING received — activating new version now');
      self.skipWaiting();
      break;

    // ── GET_VERSION ───────────────────────────────────────────────────────────
    // Optional: lets the app query the active SW version (useful for debugging).
    case 'GET_VERSION':
      if (event.source) {
        event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
      }
      break;

    // ── PREFETCH_FONTS ────────────────────────────────────────────────────────
    // Sent from a requestIdleCallback in index.html after the app shell is
    // interactive. Warm-caches any woff2 font URLs that weren't in the initial
    // FONT_URLS precache list so future visits serve fonts from cache instantly.
    // event.data.urls  — string[] of woff2 (or other font) URLs to prefetch
    case 'PREFETCH_FONTS': {
      const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
      if (!urls.length) break;

      event.waitUntil((async () => {
        const cache = await caches.open(FONT_CACHE);
        await Promise.all(urls.map(async url => {
          try {
            if (await cache.match(url)) return; // already cached — skip
            const res = await fetch(url, { mode: 'cors' });
            if (res.ok) {
              await cache.put(url, res);
              console.log(`[SW] Warm-cached font: ${url}`);
            }
          } catch (e) {
            console.warn(`[SW] Font warm-cache failed: ${url}`, e.message);
          }
        }));
        // Trim after warm-caching in case woff2 blobs pushed us over the limit
        await trimCache(FONT_CACHE, FONT_CACHE_MAX_ENTRIES);
      })());
      break;
    }

    // ── TRIM_CACHES ───────────────────────────────────────────────────────────
    // Lets the page request a quota sweep on demand (e.g. from a settings UI).
    case 'TRIM_CACHES':
      event.waitUntil(Promise.all([
        trimCache(SHELL_CACHE, SHELL_CACHE_MAX_ENTRIES),
        trimCache(ASSET_CACHE, ASSET_CACHE_MAX_ENTRIES),
        trimCache(FONT_CACHE,  FONT_CACHE_MAX_ENTRIES),
      ]));
      break;

    default:
      break;
  }
});


// ─────────────────────────────────────────────────────────────────────────────
//  INDEXED DB HELPERS — shared key-value store for background sync payloads
//  The page writes the sync payload here before going offline; the SW reads
//  it when the 'sync' event fires (even with the app fully closed).
// ─────────────────────────────────────────────────────────────────────────────

const BG_SYNC_DB_NAME  = 'farm-manager-bg-sync';
const BG_SYNC_DB_VER   = 1;
const BG_SYNC_DB_STORE = 'pending-syncs';

function openBgSyncDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BG_SYNC_DB_NAME, BG_SYNC_DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(BG_SYNC_DB_STORE)) {
        db.createObjectStore(BG_SYNC_DB_STORE);
      }
    };
    req.onsuccess  = e  => resolve(e.target.result);
    req.onerror    = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(BG_SYNC_DB_STORE, 'readonly');
    const req = tx.objectStore(BG_SYNC_DB_STORE).get(key);
    req.onsuccess  = () => resolve(req.result);
    req.onerror    = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(BG_SYNC_DB_STORE, 'readwrite');
    const req = tx.objectStore(BG_SYNC_DB_STORE).put(value, key);
    req.onsuccess  = () => resolve();
    req.onerror    = () => reject(req.error);
  });
}

function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(BG_SYNC_DB_STORE, 'readwrite');
    const req = tx.objectStore(BG_SYNC_DB_STORE).delete(key);
    req.onsuccess  = () => resolve();
    req.onerror    = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  BACKGROUND SYNC — fires when connectivity is restored, even with no tab open
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('sync', event => {
  if (event.tag === 'gcp-data-sync') {
    console.log('[SW] Background sync event fired — attempting Drive upload');
    event.waitUntil(performBackgroundSync());
  }
});

async function performBackgroundSync() {
  let db;
  try {
    db = await openBgSyncDB();

    // ── 1. Read the pending payload ────────────────────────────────────────────
    const pending = await idbGet(db, 'syncPayload');
    if (!pending) {
      console.log('[SW] No pending sync payload found — nothing to do.');
      return;
    }

    const { creds, fileId, data, version } = pending;

    if (!creds || !creds.refreshToken || !creds.clientId || !creds.clientSecret) {
      console.warn('[SW] Background sync: missing OAuth credentials — skipping.');
      return;
    }

    // ── 2. Obtain a fresh access token via refresh token ───────────────────────
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: creds.refreshToken,
        client_id:     creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    });
    const tokenData = await tokenResp.json();
    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }
    const token = tokenData.access_token;
    console.log('[SW] Background sync: access token obtained.');

    // ── 3. Resolve the Drive file ID ───────────────────────────────────────────
    let syncFileId = fileId || '';

    if (syncFileId) {
      const check = await fetch(
        `https://www.googleapis.com/drive/v3/files/${syncFileId}?fields=id`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!check.ok) {
        console.log('[SW] Background sync: stored fileId is stale, will search Drive.');
        syncFileId = '';
      }
    }

    if (!syncFileId) {
      const q          = encodeURIComponent("name='farm-manager-sync.json' and trashed=false");
      const searchResp = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const searchData = await searchResp.json();
      if (searchData.error) {
        throw new Error(searchData.error.message || `Drive search failed (HTTP ${searchResp.status})`);
      }
      if (searchData.files && searchData.files.length > 0) {
        syncFileId = searchData.files[0].id;
        console.log('[SW] Background sync: found existing Drive file:', syncFileId);
      }
    }

    // ── 4. Build the JSON payload ──────────────────────────────────────────────
    const payload = JSON.stringify({
      ...data,
      exportDate: new Date().toISOString(),
      version:    version || CACHE_VERSION,
    }, null, 2);

    // ── 5. Upload — PATCH existing file, or create new one ────────────────────
    let upResp;
    if (syncFileId) {
      upResp = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${syncFileId}?uploadType=media`,
        {
          method:  'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    payload,
        }
      );
    } else {
      const form = new FormData();
      form.append('metadata', new Blob(
        [JSON.stringify({ name: 'farm-manager-sync.json', mimeType: 'application/json' })],
        { type: 'application/json' }
      ));
      form.append('file', new Blob([payload], { type: 'application/json' }));
      upResp = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
      );
      if (upResp.ok) {
        const created = await upResp.clone().json();
        if (created.id) {
          syncFileId = created.id;
          await idbPut(db, 'lastBgSyncFileId', syncFileId);
        }
      }
    }

    if (!upResp.ok) {
      const errBody = await upResp.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `HTTP ${upResp.status}`);
    }

    // ── 6. Persist metadata & clear the pending payload ───────────────────────
    const syncTime = new Date().toISOString();
    await idbPut(db, 'lastBgSyncTime',   syncTime);
    await idbPut(db, 'lastBgSyncFileId', syncFileId);
    await idbDelete(db, 'syncPayload');

    console.log('[SW] Background sync succeeded at', syncTime);

    // ── 7. Notify any open clients so they can update their UI ────────────────
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client =>
      client.postMessage({
        type:     'BG_SYNC_COMPLETE',
        syncTime: syncTime,
        fileId:   syncFileId,
      })
    );

  } catch (err) {
    console.error('[SW] Background sync FAILED:', err.message);
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(client =>
        client.postMessage({ type: 'BG_SYNC_ERROR', error: err.message })
      );
    } catch (_) {}
    throw err; // re-throw so browser schedules an automatic retry
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FETCH — Intercept all network requests and apply caching strategies
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests over HTTP(S)
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return; // Malformed URL — let the browser handle it
  }

  if (!url.protocol.startsWith('http')) return;

  // ── Google Fonts → Stale-while-revalidate (dedicated FONT_CACHE) ─────────
  // ⚠️  MUST be checked BEFORE isGoogleAPI.
  // fonts.googleapis.com hostname ends with "googleapis.com", so if isGoogleAPI
  // ran first it would match and pass font requests through as network-only,
  // bypassing the cache entirely and breaking offline font delivery.
  if (isGoogleFont(url)) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  // ── Google APIs → Network-only (never cache authenticated requests) ───────
  // Covers oauth2.googleapis.com (token refresh), www.googleapis.com (Drive
  // API), accounts.google.com, and drive.google.com.  All auth-bearing
  // requests must hit the network every time — no caching, no interception.
  if (isGoogleAPI(url)) return;

  // ── App shell → Navigation-preload-first + 3 s timeout ───────────────────
  // Navigation Preload lets the browser fetch HTML in parallel with SW boot.
  // If the network is slow (> SHELL_NETWORK_TIMEOUT_MS), we immediately fall
  // back to the cached shell so the app feels responsive on any connection.
  if (isAppShell(url)) {
    event.respondWith(navigationPreloadFirst(event, SHELL_CACHE));
    return;
  }

  // ── Same-origin static assets (icons, manifest) → Cache-first ────────────
  if (isSameOriginStatic(url)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // ── CDN libraries → Cache-first ──────────────────────────────────────────
  // Pinned semver URLs are immutable — serve from cache instantly, fetch
  // from network only if not yet cached.
  if (isCDNAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // ── Everything else → Stale-while-revalidate ─────────────────────────────
  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});

// ─────────────────────────────────────────────────────────────────────────────
//  CACHING STRATEGY IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigation-Preload-First (app-shell strategy)
 *
 * Uses the preloaded response the browser started fetching in parallel with
 * SW startup — eliminating SW boot latency on repeat navigations.
 * Falls back to networkFirstWithTimeout → cached shell → offline page.
 */
async function navigationPreloadFirst(event, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const preloadResponse = await event.preloadResponse;
    if (preloadResponse && preloadResponse.status === 200) {
      cache.put(event.request, preloadResponse.clone()); // update cache in background
      return preloadResponse;
    }
  } catch {
    // Navigation Preload unavailable or failed — fall through to timed network fetch
  }

  return networkFirstWithTimeout(event.request, cacheName, SHELL_NETWORK_TIMEOUT_MS);
}

/**
 * Network-First with Timeout (used for the app shell)
 *
 * Races the network fetch against a countdown timer. If the network wins and
 * delivers a valid response it is cached and returned. If the timer fires first
 * we serve the cached shell immediately — no blank screen, no indefinite spinner.
 */
async function networkFirstWithTimeout(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`[SW] Network timeout after ${timeoutMs} ms`)),
      timeoutMs
    )
  );

  try {
    const networkResponse = await Promise.race([fetch(request), timeout]);
    if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'error') {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    // Timeout or offline — serve the cached shell instantly
    console.log(`[SW] ${err.message} — serving cached shell: ${request.url}`);
    const cached = await cache.match(request);
    if (cached) return cached;
    return offlinePage();
  }
}

/**
 * Cache-First
 *
 * Return the cached response instantly if available.
 * On cache miss, fetch from network, store the result, and return it.
 * After storing, async-trim the bucket to stay within the entry limit.
 */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'error') {
      await cache.put(request, networkResponse.clone());
      // Non-blocking trim — keeps quota healthy without slowing the response
      const limit = cacheName === FONT_CACHE  ? FONT_CACHE_MAX_ENTRIES
                  : cacheName === SHELL_CACHE ? SHELL_CACHE_MAX_ENTRIES
                  : ASSET_CACHE_MAX_ENTRIES;
      trimCache(cacheName, limit).catch(() => {});
    }
    return networkResponse;
  } catch {
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * Stale-While-Revalidate
 *
 * Return the cached response immediately (fast), then fetch a fresh copy in
 * the background and update the cache for the next request.
 * If there is no cached version, wait for the network response.
 * Background writes trigger an async trim to prevent quota creep over time.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then(async response => {
      if (response && response.status === 200 && response.type !== 'error') {
        await cache.put(request, response.clone());
        const limit = cacheName === FONT_CACHE  ? FONT_CACHE_MAX_ENTRIES
                    : cacheName === SHELL_CACHE ? SHELL_CACHE_MAX_ENTRIES
                    : ASSET_CACHE_MAX_ENTRIES;
        trimCache(cacheName, limit).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  // Return stale immediately; fall back to awaiting the network on first visit
  return cached ?? networkFetch;
}

// ─────────────────────────────────────────────────────────────────────────────
//  OFFLINE FALLBACK PAGE
// ─────────────────────────────────────────────────────────────────────────────
function offlinePage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0077b6">
  <title>Farm Manager — Offline</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #caf0f8 0%, #90e0ef 100%);
      min-height: 100dvh;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      padding-top: calc(24px + env(safe-area-inset-top));
      padding-bottom: calc(24px + env(safe-area-inset-bottom));
    }
    .card {
      background: white; border-radius: 28px; padding: 48px 32px 40px;
      max-width: 360px; width: 100%; text-align: center;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.14);
    }
    .icon { font-size: 72px; margin-bottom: 24px; display: block; line-height: 1; }
    h1 { font-size: 24px; font-weight: 700; color: #03045e; margin-bottom: 12px; letter-spacing: -0.4px; }
    p { font-size: 15px; color: #5d6d7e; line-height: 1.65; margin-bottom: 32px; }
    .badge {
      display: inline-block; background: #e8f4fd; color: #0077b6;
      font-size: 12px; font-weight: 700; padding: 4px 12px;
      border-radius: 20px; margin-bottom: 32px; letter-spacing: 0.3px;
    }
    button {
      background: linear-gradient(135deg, #0077b6 0%, #005f8e 100%);
      color: white; border: none; padding: 16px 36px; border-radius: 16px;
      font-size: 16px; font-weight: 700; cursor: pointer;
      box-shadow: 0 6px 20px rgba(0, 119, 182, 0.38);
      width: 100%; transition: opacity 0.2s; letter-spacing: -0.2px;
    }
    button:hover { opacity: 0.9; }
    .hint { margin-top: 16px; font-size: 13px; color: #aab7c4; }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">🌾</span>
    <div class="badge">🔌 No Internet Connection</div>
    <h1>You're Offline</h1>
    <p>
      Farm Manager needs a connection to load for the first time.
      Once loaded online, it works fully offline — your data is always
      stored locally on this device.
    </p>
    <button onclick="window.location.reload()">🔄 Try Again</button>
    <p class="hint">Your farm data is safe and waiting for you.</p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status:  200,
    headers: {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    }
  });
}
