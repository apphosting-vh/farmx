/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           FARM MANAGER — SERVICE WORKER                          ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  Version      : 2.5.0                                            ║
 * ║  Cache Key    : farm-manager-v2.5.0                              ║
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
 * ║    index.html   → Network-first   (always pick up new deploys)   ║
 * ║    CDN scripts  → Cache-first     (pinned semver URLs, immutable)║
 * ║    Icons/assets → Cache-first     (static, versioned by SW key)  ║
 * ║    Google APIs  → Network-only    (authenticated, never cache)   ║
 * ║    Everything else → Stale-while-revalidate                      ║
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
// This single string change is all that's needed to trigger the update flow.
const CACHE_VERSION = 'v4.0.6';

// ─── Cache bucket names ───────────────────────────────────────────────────────
// Shell cache holds the app itself (HTML + same-origin static assets).
// Asset cache holds CDN libraries (React, Babel, etc.) — shared across versions
// so CDN scripts don't have to be re-downloaded on every update.
const SHELL_CACHE  = `farm-manager-shell-${CACHE_VERSION}`;
const ASSET_CACHE  = `farm-manager-assets-${CACHE_VERSION}`;

// ─── Resources to pre-cache during install ────────────────────────────────────
// These are fetched and stored before the SW becomes "installed".
// Keep this list lean — only what's needed for a full offline first load.
const SHELL_URLS = [
  'https://apphosting-vh.github.io/farmx/',
  'https://apphosting-vh.github.io/farmx/index.html',
  'https://apphosting-vh.github.io/farmx/manifest.json',
];

// CDN scripts: pinned semver URLs — content never changes for a given URL.
// Cache aggressively; evicted only when ASSET_CACHE key changes.
const CDN_URLS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

// ─── URL classifiers ──────────────────────────────────────────────────────────
const APP_ORIGIN = 'apphosting-vh.github.io';
const APP_PATH   = '/farmx';

const CDN_ORIGINS = [
  'unpkg.com',
  'cdnjs.cloudflare.com',
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

function isGoogleAPI(url) {
  return GOOGLE_ORIGINS.some(origin => url.hostname.endsWith(origin));
}

// ─────────────────────────────────────────────────────────────────────────────
//  INSTALL — Pre-cache app shell and CDN assets
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SW] Installing Farm Manager ${CACHE_VERSION}`);

  event.waitUntil(
    Promise.all([
      // Cache app shell (HTML, manifest)
      caches.open(SHELL_CACHE).then(async cache => {
        // addAll() is atomic — if one URL fails, nothing is cached.
        // We use individual put() calls with try/catch so a single 404
        // (e.g. manifest not yet deployed) doesn't abort the whole install.
        for (const url of SHELL_URLS) {
          try {
            const res = await fetch(url, { cache: 'reload' }); // bypass HTTP cache
            if (res.ok) await cache.put(url, res);
          } catch (e) {
            console.warn(`[SW] Shell precache skipped: ${url}`, e.message);
          }
        }
      }),

      // Cache CDN scripts
      caches.open(ASSET_CACHE).then(async cache => {
        for (const url of CDN_URLS) {
          try {
            // Only fetch if not already in cache (saves bandwidth on minor version bumps)
            const existing = await cache.match(url);
            if (!existing) {
              const res = await fetch(url);
              if (res.ok) await cache.put(url, res);
            }
          } catch (e) {
            console.warn(`[SW] CDN precache skipped: ${url}`, e.message);
          }
        }
      }),
    ]).then(() => {
      console.log(`[SW] Precache complete for ${CACHE_VERSION}`);
      // ⚠️  Do NOT call self.skipWaiting() here.
      // We wait for an explicit { type: 'SKIP_WAITING' } message from the app
      // so we never interrupt a user who is mid-session when a new version lands.
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
//  ACTIVATE — Delete stale caches, claim all open clients
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
            key !== ASSET_CACHE
          )
          .map(stale => {
            console.log(`[SW] Deleting stale cache: ${stale}`);
            return caches.delete(stale);
          })
      ))

      // 2. Take control of ALL open tabs immediately — without waiting for reload
      .then(() => self.clients.claim())

      // 3. Notify every open window that the new version is now live
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => {
        console.log(`[SW] ${CACHE_VERSION} active — notifying ${clients.length} client(s)`);
        clients.forEach(client => {
          client.postMessage({
            type: 'SW_ACTIVATED',
            version: CACHE_VERSION,
            message: `Farm Manager ${CACHE_VERSION} is now active.`
          });
        });
      })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
//  MESSAGE — Handle SKIP_WAITING from the React update banner
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (!event.data) return;

  switch (event.data.type) {

    // Sent by the React app when the user clicks "Update Now".
    // skipWaiting() makes this SW active immediately.
    // Once active, clients.claim() fires → 'controllerchange' event fires
    // on every tab → the app's controllerchange listener calls location.reload().
    case 'SKIP_WAITING':
      console.log('[SW] SKIP_WAITING received — activating new version now');
      self.skipWaiting();
      break;

    // Optional: app can ask the SW what version it is (useful for debugging)
    case 'GET_VERSION':
      if (event.source) {
        event.source.postMessage({
          type: 'SW_VERSION',
          version: CACHE_VERSION
        });
      }
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

/** Open (or create) the background-sync IndexedDB. */
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

/**
 * Core background sync routine.
 * Reads the queued payload from IndexedDB, refreshes the OAuth token,
 * uploads the data to Google Drive, then clears the queue.
 *
 * If the upload fails the browser will automatically retry the sync tag
 * (with exponential back-off) until it succeeds or the retry limit expires.
 */
async function performBackgroundSync() {
  let db;
  try {
    db = await openBgSyncDB();

    // ── 1. Read the pending payload ────────────────────────────────────────
    const pending = await idbGet(db, 'syncPayload');
    if (!pending) {
      console.log('[SW] No pending sync payload found — nothing to do.');
      return;
    }

    const { creds, fileId, data, version } = pending;

    // Bail if credentials are incomplete — nothing we can do
    if (!creds || !creds.refreshToken || !creds.clientId || !creds.clientSecret) {
      console.warn('[SW] Background sync: missing OAuth credentials — skipping.');
      return;
    }

    // ── 2. Obtain a fresh access token via refresh token ──────────────────
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

    // ── 3. Resolve the Drive file ID ───────────────────────────────────────
    let syncFileId = fileId || '';

    // Verify the stored ID still resolves
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

    // Search Drive for the well-known file name
    if (!syncFileId) {
      const q           = encodeURIComponent("name='farm-manager-sync.json' and trashed=false");
      const searchResp  = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const searchData  = await searchResp.json();
      if (searchData.error) {
        throw new Error(searchData.error.message || `Drive search failed (HTTP ${searchResp.status})`);
      }
      if (searchData.files && searchData.files.length > 0) {
        syncFileId = searchData.files[0].id;
        console.log('[SW] Background sync: found existing Drive file:', syncFileId);
      }
    }

    // ── 4. Build the JSON payload ─────────────────────────────────────────
    const payload = JSON.stringify({
      ...data,
      exportDate: new Date().toISOString(),
      version:    version || CACHE_VERSION,
    }, null, 2);

    // ── 5. Upload — PATCH existing file, or create new one ────────────────
    let upResp;
    if (syncFileId) {
      // Update existing file content
      upResp = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${syncFileId}?uploadType=media`,
        {
          method:  'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    payload,
        }
      );
    } else {
      // Create the sync file for the first time
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
          // Store the new file ID so the page can pick it up on next open
          await idbPut(db, 'lastBgSyncFileId', syncFileId);
        }
      }
    }

    if (!upResp.ok) {
      const errBody = await upResp.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `HTTP ${upResp.status}`);
    }

    // ── 6. Persist metadata & clear the pending payload ───────────────────
    const syncTime = new Date().toISOString();
    await idbPut(db, 'lastBgSyncTime',   syncTime);
    await idbPut(db, 'lastBgSyncFileId', syncFileId);
    await idbDelete(db, 'syncPayload');           // payload consumed — remove it

    console.log('[SW] Background sync succeeded at', syncTime);

    // ── 7. Notify any open clients so they can update their UI ────────────
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => {
      client.postMessage({
        type:     'BG_SYNC_COMPLETE',
        syncTime: syncTime,
        fileId:   syncFileId,
      });
    });

  } catch (err) {
    console.error('[SW] Background sync FAILED:', err.message);

    // Notify any open clients about the failure
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(client => {
        client.postMessage({ type: 'BG_SYNC_ERROR', error: err.message });
      });
    } catch (_) {}

    // Re-throwing causes the browser to schedule a retry (Back-off: ~5 min, ~10 min, …)
    throw err;
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

  // ── Google APIs → Network-only (never cache authenticated requests) ──────
  if (isGoogleAPI(url)) return;

  // ── App shell (index.html, root URL) → Network-first ─────────────────────
  // Network-first ensures that a newly deployed index.html is ALWAYS served
  // to online users. This is what the version-string polling detects.
  // When offline, the cached shell is served so the app still opens.
  if (isAppShell(url)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // ── Same-origin static assets (icons, manifest) → Cache-first ────────────
  if (isSameOriginStatic(url)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // ── CDN libraries → Cache-first ───────────────────────────────────────────
  // Pinned semver URLs are immutable — serve from cache instantly,
  // fetch from network only if not yet cached.
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
 * Network-First
 * Try the network; on success update the cache and return the fresh response.
 * On network failure (offline / server down), fall back to the cached version.
 * Last resort: return an offline fallback page.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetch(request);
    // Only cache valid, non-opaque responses
    if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'error') {
      cache.put(request, networkResponse.clone()); // fire-and-forget
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      console.log(`[SW] Offline → serving cached: ${request.url}`);
      return cached;
    }
    return offlinePage();
  }
}

/**
 * Cache-First
 * Return the cached response instantly if available.
 * On cache miss, fetch from network, cache the result, and return it.
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'error') {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // Totally offline and not cached — nothing we can do for this resource
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * Stale-While-Revalidate
 * Return the cached response immediately (fast), then fetch a fresh copy in
 * the background and update the cache for the next request.
 * If there is no cached version, wait for the network response.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Kick off a background network fetch regardless
  const networkFetch = fetch(request)
    .then(response => {
      if (response && response.status === 200 && response.type !== 'error') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Return cached immediately; if no cache, await the network
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
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      padding-top: calc(24px + env(safe-area-inset-top));
      padding-bottom: calc(24px + env(safe-area-inset-bottom));
    }
    .card {
      background: white;
      border-radius: 28px;
      padding: 48px 32px 40px;
      max-width: 360px;
      width: 100%;
      text-align: center;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.14);
    }
    .icon {
      font-size: 72px;
      margin-bottom: 24px;
      display: block;
      line-height: 1;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #03045e;
      margin-bottom: 12px;
      letter-spacing: -0.4px;
    }
    p {
      font-size: 15px;
      color: #5d6d7e;
      line-height: 1.65;
      margin-bottom: 32px;
    }
    .badge {
      display: inline-block;
      background: #e8f4fd;
      color: #0077b6;
      font-size: 12px;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 20px;
      margin-bottom: 32px;
      letter-spacing: 0.3px;
    }
    button {
      background: linear-gradient(135deg, #0077b6 0%, #005f8e 100%);
      color: white;
      border: none;
      padding: 16px 36px;
      border-radius: 16px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0, 119, 182, 0.38);
      width: 100%;
      transition: opacity 0.2s;
      letter-spacing: -0.2px;
    }
    button:hover { opacity: 0.9; }
    .hint {
      margin-top: 16px;
      font-size: 13px;
      color: #aab7c4;
    }
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
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    }
  });
}
