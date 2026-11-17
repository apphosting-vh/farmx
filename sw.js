/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           FARM MANAGER — SERVICE WORKER                          ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  Version      : 6.0.1                                            ║
 * ║  Cache Key    : farm-manager-shell-v6.0.1                        ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  OFFLINE-FIRST GUARANTEE                                          ║
 * ║  ──────────────────────────────────────────────────────────────   ║
 * ║  Install precaches EVERYTHING the app needs to boot with no       ║
 * ║  network at all:                                                  ║
 * ║    • App shell        — index.html, app-core.js                   ║
 * ║    • PWA metadata     — manifest.json, icon-192, icon-512         ║
 * ║    • Libraries        — React 18, ReactDOM 18, Babel Standalone   ║
 * ║    • Fonts            — Google Fonts CSS *and every woff2 binary* ║
 * ║                         parsed out of that CSS (no lazy gaps)     ║
 * ║                                                                   ║
 * ║  Shell + libraries are treated as CRITICAL: if any of them cannot ║
 * ║  be fetched, the install FAILS and the browser retries later. An  ║
 * ║  incomplete worker is never activated, so "installed" always      ║
 * ║  means "works offline".                                           ║
 * ║                                                                   ║
 * ║  All URLs are derived from the worker's own scope, so the exact   ║
 * ║  same file works at https://apphosting-vh.github.io/farmx/ and at ║
 * ║  http://localhost:PORT/ during local testing.                     ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  UPDATE DELIVERY MECHANISM                                        ║
 * ║  1. On each deploy, update CACHE_VERSION below. The browser       ║
 * ║     detects the changed SW byte-for-byte and installs the new     ║
 * ║     worker alongside the running one.                            ║
 * ║  2. install  → precaches all assets under the new shell key.      ║
 * ║  3. New SW enters "waiting" — it does NOT disrupt the user.       ║
 * ║  4. The app's update banner fires (via updatefound event).        ║
 * ║  5. "Update Now" → app sends { type: SKIP_WAITING }.              ║
 * ║  6. activate → clients.claim() → controllerchange → reload.       ║
 * ║  7. activate deletes all old cache buckets.                       ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  CACHING STRATEGIES                                               ║
 * ║    Navigations   → Navigation-preload + network-first (3s) then   ║
 * ║                    cached shell → inline offline page             ║
 * ║    app-core.js   → Network-first with timeout, cache fallback     ║
 * ║    CDN libraries → Cache-first     (pinned semver, immutable)     ║
 * ║    Icons/manifest→ Cache-first                                    ║
 * ║    Google Fonts  → Stale-while-revalidate (dedicated FONT_CACHE)  ║
 * ║    Google APIs   → Network-only    (authenticated, never cached)  ║
 * ║    Everything else → Stale-while-revalidate                       ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  ⚠️  HOW TO RELEASE A NEW VERSION                                ║
 * ║     1. Change CACHE_VERSION string below (e.g. v6.0.2)            ║
 * ║     2. Change APP_VERSION in app-core.js to match                 ║
 * ║     3. Update the "Version" comment at the top of index.html      ║
 * ║     4. Push — Pages redeploys automatically. The browser sees the ║
 * ║        byte-change and starts the update flow.                    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

// ─── VERSION — BUMP THIS ON EVERY RELEASE ────────────────────────────────────
// Must match APP_VERSION constant in app-core.js.
const CACHE_VERSION = 'v6.0.1';

// ─── App location — derived from this worker's scope ─────────────────────────
// On GitHub Pages  : origin=https://apphosting-vh.github.io  path=/farmx
// On localhost     : origin=http://localhost:8084            path=''
// Deriving these means the app is offline-capable wherever it is served,
// instead of only at one hard-coded GitHub Pages URL.
const SCOPE_URL  = new URL(self.registration.scope);
const APP_ORIGIN = SCOPE_URL.origin;
const APP_PATH   = SCOPE_URL.pathname.replace(/\/+$/, ''); // '' or '/farmx'
const APP_BASE   = `${APP_ORIGIN}${APP_PATH}/`;

// ─── Cache bucket names ───────────────────────────────────────────────────────
// Shell cache  — HTML, app-core.js, manifest & icons. Versioned, so a new
//                release starts from a clean slate and never serves stale HTML.
// Asset cache  — CDN libraries (React, Babel, …). Pinned URLs are immutable,
//                so this bucket is intentionally NOT versioned: upgrading the
//                app never re-downloads 3 MB of libraries. Activate purges any
//                legacy versioned buckets.
// Font cache   — Google Fonts CSS + woff2 binaries. Immutable, not versioned.
const SHELL_CACHE = `farm-manager-shell-${CACHE_VERSION}`;
const ASSET_CACHE = 'farm-manager-assets';
const FONT_CACHE  = 'farm-manager-fonts';

// ─── Cache size limits (max entries per bucket) ───────────────────────────────
// Oldest entries are evicted when a bucket exceeds its limit, preventing the
// browser from hitting its storage quota and silently dropping whole caches.
const SHELL_CACHE_MAX_ENTRIES = 30;
const ASSET_CACHE_MAX_ENTRIES = 60;
const FONT_CACHE_MAX_ENTRIES  = 60;

// ─── Network timeout for app-shell fetches (ms) ──────────────────────────────
// If the network has not responded within this window we serve the cached
// shell immediately so the app never stalls on a slow or lossy connection.
const SHELL_NETWORK_TIMEOUT_MS = 3000;

// ─── Resources to pre-cache during install ────────────────────────────────────

// CRITICAL shell files — install FAILS if any of these cannot be fetched.
// This is what makes "installed" equal "works with no network".
const CRITICAL_SHELL_URLS = [
  APP_BASE,
  `${APP_BASE}index.html`,
  `${APP_BASE}app-core.js`,
];

// Optional shell files — nice for a complete PWA install, but the app still
// boots offline without them, so a missing file must not block installation.
const OPTIONAL_SHELL_URLS = [
  `${APP_BASE}manifest.json`,
  `${APP_BASE}icon-192.png`,
  `${APP_BASE}icon-512.png`,
  `${APP_BASE}offline.html`,
];

// CDN scripts: pinned semver URLs — content never changes for a given URL.
// CRITICAL: without Babel/React the app cannot render at all, so a failed
// fetch aborts the install instead of activating a half-usable worker.
const CDN_URLS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.26.0/babel.min.js',
];

// Google Fonts stylesheet. Its woff2 binaries are discovered by parsing this
// CSS at install time and are precached too, so typography is identical
// offline on the very first offline boot (not just after a warm-up visit).
const FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap';

// Matches url(https://fonts.gstatic.com/…woff2) inside a Google Fonts stylesheet.
const FONT_BINARY_RE = /url\(\s*(['"]?)(https:\/\/fonts\.gstatic\.com\/[^'")]+)\1\s*\)/g;

// ─── URL classifiers ──────────────────────────────────────────────────────────
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
  'apis.google.com',
];

function isAppShellPath(pathname) {
  return (
    pathname === APP_PATH ||
    pathname === `${APP_PATH}/` ||
    pathname === `${APP_PATH}/index.html`
  );
}

function isAppCorePath(pathname) {
  return pathname === `${APP_PATH}/app-core.js`;
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
//  Entries listed in `protectedUrls` are never evicted (e.g. the fonts
//  stylesheet, which is written before the binaries it points at).
//  Called: after install precaching, in activate, and after each cache write.
// ─────────────────────────────────────────────────────────────────────────────
async function trimCache(cacheName, maxEntries, protectedUrls = []) {
  try {
    const cache = await caches.open(cacheName);
    const keys  = await cache.keys();
    if (keys.length <= maxEntries) return;

    const protectedSet = new Set(protectedUrls);
    const removable = keys.filter(req => !protectedSet.has(req.url));

    const excess = removable.slice(0, Math.max(0, keys.length - maxEntries));
    if (!excess.length) return;
    await Promise.all(excess.map(key => cache.delete(key)));
    console.log(`[SW] Trimmed ${excess.length} excess entries from ${cacheName}`);
  } catch (e) {
    console.warn(`[SW] trimCache failed for ${cacheName}:`, e.message);
  }
}

function trimAllCaches() {
  return Promise.all([
    trimCache(SHELL_CACHE, SHELL_CACHE_MAX_ENTRIES),
    trimCache(ASSET_CACHE, ASSET_CACHE_MAX_ENTRIES),
    trimCache(FONT_CACHE,  FONT_CACHE_MAX_ENTRIES, [FONT_CSS_URL]),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRECACHE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a URL with the HTTP cache bypassed, validate it, and store it.
 * Throws on network error or non-2xx so the caller can fail the install.
 */
async function putStrict(cache, url) {
  const response = await fetch(new Request(url, { cache: 'reload' }));
  if (!response || !response.ok) {
    throw new Error(`HTTP ${response ? response.status : 'network error'} for ${url}`);
  }
  await cache.put(url, response);
}

/**
 * Best-effort precache: log and continue when an individual URL fails.
 */
async function putOptional(cache, urls) {
  await Promise.all(urls.map(async url => {
    try {
      await putStrict(cache, url);
    } catch (e) {
      console.warn(`[SW] Optional precache skipped: ${url} — ${e.message}`);
    }
  }));
}

/**
 * CDN libraries. Pinned URLs never change, so anything already in the
 * (unversioned) asset bucket is reused — no re-download on every release.
 * Failures propagate: these libraries are required for the app to render.
 */
async function precacheCDN(cache) {
  await Promise.all(CDN_URLS.map(async url => {
    if (await cache.match(url)) return;
    await putStrict(cache, url);
  }));
}

/**
 * Google Fonts: cache the stylesheet, parse out every woff2 URL it references,
 * and cache those binaries too. This closes the "fonts only cached after they
 * happen to be used" gap that left the first offline boot with fallback fonts.
 * Font failures are non-fatal — the app still runs with system fonts.
 */
async function precacheFonts() {
  const cache = await caches.open(FONT_CACHE);
  try {
    const cssResponse = await fetch(FONT_CSS_URL, { mode: 'cors', cache: 'reload' });
    if (!cssResponse || !cssResponse.ok) {
      throw new Error(`HTTP ${cssResponse ? cssResponse.status : 'network error'}`);
    }

    const cssText = await cssResponse.clone().text();
    await cache.put(FONT_CSS_URL, cssResponse);

    const fontUrls = new Set();
    let match;
    FONT_BINARY_RE.lastIndex = 0;
    while ((match = FONT_BINARY_RE.exec(cssText)) !== null) {
      fontUrls.add(match[2]);
    }

    await Promise.all([...fontUrls].map(async url => {
      try {
        if (await cache.match(url, { ignoreVary: true })) return;
        const res = await fetch(url, { mode: 'cors', cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (e) {
        console.warn(`[SW] Font binary precache skipped: ${url} — ${e.message}`);
      }
    }));

    console.log(`[SW] Fonts precached: stylesheet + ${fontUrls.size} binaries`);
  } catch (e) {
    console.warn(`[SW] Font precache failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  INSTALL — Precache the complete offline bundle
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SW] Installing Farm Manager ${CACHE_VERSION}`);

  event.waitUntil((async () => {
    // ── 1. Critical assets — a failure here rejects install() on purpose ─────
    await Promise.all([
      caches.open(SHELL_CACHE).then(cache =>
        Promise.all(CRITICAL_SHELL_URLS.map(url => putStrict(cache, url)))
      ),
      caches.open(ASSET_CACHE).then(cache => precacheCDN(cache)),
    ]);

    // ── 2. Non-critical assets — never block a working install ──────────────
    await Promise.all([
      caches.open(SHELL_CACHE).then(cache => putOptional(cache, OPTIONAL_SHELL_URLS)),
      precacheFonts(),
    ]);

    // ── 3. Post-install quota guard ──────────────────────────────────────────
    await trimAllCaches();

    console.log(`[SW] Offline precache complete for ${CACHE_VERSION}`);

    // ── 4. Notify open windows so they can idle-prefetch any font binaries ───
    // (Belt and braces: the install already cached every woff2 it found.)
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

  const KEEP = new Set([SHELL_CACHE, ASSET_CACHE, FONT_CACHE]);

  event.waitUntil(
    // 1. Purge every cache that belongs to this app but is not current
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('farm-manager-') && !KEEP.has(key))
          .map(stale => {
            console.log(`[SW] Deleting stale cache: ${stale}`);
            return caches.delete(stale);
          })
      ))

      // 2. Enforce per-bucket entry limits on the current version's caches
      .then(() => trimAllCaches())

      // 3. Take control of ALL open tabs immediately — without waiting for reload
      .then(() => self.clients.claim())

      // 4. Enable Navigation Preload (where supported) — the browser can fetch
      //    the HTML in parallel with SW boot, eliminating startup-latency penalty.
      .then(() => {
        if (self.registration.navigationPreload) {
          return self.registration.navigationPreload.enable().catch(() => {});
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
    // interactive. Install already caches the stylesheet and every woff2 it
    // references; this catches any stylesheet URL the page adds later.
    // event.data.urls  — string[] of font stylesheet / binary URLs to prefetch
    case 'PREFETCH_FONTS': {
      const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
      if (!urls.length) break;

      event.waitUntil((async () => {
        const cache = await caches.open(FONT_CACHE);
        await Promise.all(urls.map(async url => {
          try {
            if (await cache.match(url, { ignoreVary: true })) return; // already cached
            const res = await fetch(url, { mode: 'cors' });

            if (res.ok) {
              await cache.put(url, res);

              // If this was a stylesheet, also pull in the binaries it references.
              if (/\.css(\?|$)/i.test(url) || url.includes('fonts.googleapis.com')) {
                const cssText = await res.clone().text();
                const binaries = new Set();
                let m;
                FONT_BINARY_RE.lastIndex = 0;
                while ((m = FONT_BINARY_RE.exec(cssText)) !== null) binaries.add(m[2]);
                await Promise.all([...binaries].map(async fontUrl => {
                  try {
                    if (await cache.match(fontUrl, { ignoreVary: true })) return;
                    const fontRes = await fetch(fontUrl, { mode: 'cors' });
                    if (fontRes.ok) await cache.put(fontUrl, fontRes);
                  } catch (_) {}
                }));
              }

              console.log(`[SW] Warm-cached font: ${url}`);
            }
          } catch (e) {
            console.warn(`[SW] Font warm-cache failed: ${url}`, e.message);
          }
        }));
        // Trim after warm-caching in case woff2 blobs pushed us over the limit
        await trimCache(FONT_CACHE, FONT_CACHE_MAX_ENTRIES, [FONT_CSS_URL]);
      })());
      break;
    }

    // ── TRIM_CACHES ───────────────────────────────────────────────────────────
    // Lets the page request a quota sweep on demand (e.g. from a settings UI).
    case 'TRIM_CACHES':
      event.waitUntil(trimAllCaches());
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
  } else if (event.tag === DAILY_BACKUP_PERIODIC_TAG) {
    console.log('[SW] Daily backup sync event fired');
    event.waitUntil(performDailyBackup());
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
//  AUTOMATIC DAILY BACKUP — periodic wake-up + timestamped Drive snapshots
// ─────────────────────────────────────────────────────────────────────────────

const DAILY_BACKUP_FOLDER_NAME   = 'Farm Manager Daily Backup';
const DAILY_BACKUP_INTERVAL_MS   = 24 * 60 * 60 * 1000;
const DAILY_BACKUP_PERIODIC_TAG  = 'farm-manager-daily-backup';

// Chromium (installed PWA) may wake the SW roughly once a day. The page also
// registers this tag and keeps a data snapshot in IndexedDB; when the browser
// has no Periodic Background Sync support the in-app scheduler covers it.
self.addEventListener('periodicsync', event => {
  if (event.tag === DAILY_BACKUP_PERIODIC_TAG) {
    console.log('[SW] Periodic daily backup event fired');
    event.waitUntil(performDailyBackup());
  }
});

const swPad = n => String(n).padStart(2, '0');

function swDailyBackupFileName(date = new Date()) {
  return `farm-wage-backup-${date.getFullYear()}-${swPad(date.getMonth() + 1)}-${swPad(date.getDate())}`
    + `_${swPad(date.getHours())}-${swPad(date.getMinutes())}-${swPad(date.getSeconds())}.json`;
}

async function swDriveJson(url, token, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    throw new Error(data.error?.message || `Drive request failed (HTTP ${resp.status})`);
  }
  return data;
}

async function resolveDailyBackupFolder(token, db) {
  const cachedId = await idbGet(db, 'dailyBackupFolderId');
  if (cachedId) {
    try {
      const check = await fetch(
        `https://www.googleapis.com/drive/v3/files/${cachedId}?fields=id,trashed,mimeType`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (check.ok) {
        const meta = await check.json();
        if (!meta.trashed && meta.mimeType === 'application/vnd.google-apps.folder') {
          return cachedId;
        }
      }
    } catch (_) { /* stale / deleted / different account — search again */ }
    await idbPut(db, 'dailyBackupFolderId', '');
  }

  const q = encodeURIComponent(
    `name='${DAILY_BACKUP_FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const found = await swDriveJson(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`,
    token
  );
  if (found.files && found.files.length > 0) {
    const id = found.files[0].id;
    await idbPut(db, 'dailyBackupFolderId', id);
    return id;
  }

  const created = await swDriveJson(
    'https://www.googleapis.com/drive/v3/files?fields=id',
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DAILY_BACKUP_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      }),
    }
  );
  await idbPut(db, 'dailyBackupFolderId', created.id);
  return created.id;
}

async function notifyDailyBackupClients(message) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => client.postMessage(message));
  } catch (_) { /* no clients — nothing to notify */ }
}

/**
 * Check the newest backup in the daily folder and upload a fresh timestamped
 * snapshot only when it is more than 24 hours old. Runs entirely inside the
 * service worker, so it needs no user interaction and no open app tab.
 */
async function performDailyBackup() {
  let db;
  try {
    db = await openBgSyncDB();
    const pending = await idbGet(db, 'dailyBackupPayload');
    if (!pending || !pending.creds) {
      console.log('[SW] Daily backup: no data snapshot available yet — skipping.');
      return;
    }

    const { creds, data, version } = pending;
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
      console.warn('[SW] Daily backup: missing OAuth credentials — skipping.');
      return;
    }

    // ── 1. Fresh access token from the stored refresh token ──
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
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

    // ── 2. Resolve the dedicated folder ──
    const folderId = await resolveDailyBackupFolder(token, db);

    // ── 3. Is the newest backup already less than 24 hours old? ──
    const q = encodeURIComponent(
      `'${folderId}' in parents and trashed=false and name contains 'farm-wage-backup-'`
    );
    const listResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=1&fields=files(id,name,createdTime,modifiedTime)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const list = await listResp.json().catch(() => ({}));
    if (!listResp.ok || list.error) {
      throw new Error(list.error?.message || `Drive search failed (HTTP ${listResp.status})`);
    }
    const latest = list.files && list.files[0];
    if (latest && latest.createdTime) {
      const latestMs = Date.parse(latest.createdTime);
      if (Number.isFinite(latestMs)) {
        await idbPut(db, 'lastDailyBackupTime', latest.createdTime);
        if (Date.now() - latestMs < DAILY_BACKUP_INTERVAL_MS) {
          console.log('[SW] Daily backup skipped — latest backup is under 24 hours old.');
          return;
        }
      }
    }

    // ── 4. Build and upload the timestamped snapshot ──
    const payload = JSON.stringify({
      ...data,
      exportDate: new Date().toISOString(),
      version: version || CACHE_VERSION,
      backupType: 'daily-auto',
    }, null, 2);

    const metadata = {
      name: swDailyBackupFileName(),
      mimeType: 'application/json',
      parents: [folderId],
      description: 'Automatic daily backup created by Farm Manager',
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([payload], { type: 'application/json' }));

    const upResp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
    );
    const created = await upResp.json().catch(() => ({}));
    if (!upResp.ok || created.error) {
      throw new Error(created.error?.message || `Backup upload failed (HTTP ${upResp.status})`);
    }

    const backupTime = created.createdTime || new Date().toISOString();
    await idbPut(db, 'lastDailyBackupTime', backupTime);
    await idbPut(db, 'dailyBackupFolderId', folderId);
    console.log('[SW] Daily backup uploaded:', created.name, backupTime);

    await notifyDailyBackupClients({
      type: 'DAILY_BACKUP_COMPLETE',
      backupTime,
      folderId,
      fileName: created.name,
    });

  } catch (err) {
    console.error('[SW] Daily backup FAILED:', err.message);
    await notifyDailyBackupClients({ type: 'DAILY_BACKUP_ERROR', error: err.message });
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

  // ── Navigations & app shell → preload-first, network-first, cache fallback ─
  // Any in-scope navigation is treated as the app shell, so deep links and
  // URLs with query strings still boot the cached SPA when offline.
  if (url.origin === APP_ORIGIN && (request.mode === 'navigate' || isAppShellPath(url.pathname))) {
    event.respondWith(appShellResponse(event, SHELL_CACHE));
    return;
  }

  // ── app-core.js → network-first with timeout, always cache fallback ───────
  if (url.origin === APP_ORIGIN && isAppCorePath(url.pathname)) {
    event.respondWith(networkFirstWithTimeout(request, SHELL_CACHE, SHELL_NETWORK_TIMEOUT_MS));
    return;
  }

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
  // API), accounts.google.com, apis.google.com and drive.google.com. All
  // auth-bearing requests must hit the network every time. Drive/GIS features
  // inherently require connectivity; the rest of the app does not.
  if (isGoogleAPI(url)) return;

  // ── CDN libraries → Cache-first ──────────────────────────────────────────
  // Pinned semver URLs are immutable — serve from cache instantly, fetch
  // from network only if not yet cached.
  if (isCDNAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // ── Same-origin static assets (icons, manifest, offline.html) ────────────
  if (url.origin === APP_ORIGIN) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // ── Everything else → Stale-while-revalidate ─────────────────────────────
  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});

// ─────────────────────────────────────────────────────────────────────────────
//  CACHING STRATEGY IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────────────

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[SW] Network timeout after ${timeoutMs} ms`)), timeoutMs)
    ),
  ]);
}

/**
 * App-shell (navigation) strategy.
 *
 * 1. Use the Navigation Preload response if the browser already fetched one.
 * 2. Otherwise race the network against SHELL_NETWORK_TIMEOUT_MS.
 * 3. If the network fails, is too slow, or we are offline, serve the cached
 *    shell (matching any in-scope URL to the cached index.html) and finally
 *    the built-in offline page.
 *
 * The successful HTML is stored under the canonical APP_BASE key so query
 * strings (?_v=…) and deep links never bloat the cache or evict the shell.
 */
async function appShellResponse(event, cacheName) {
  const cache = await caches.open(cacheName);

  // Only real document navigations may replace the cached shell. The app also
  // fetches its own URL with a `?_v=` cache-buster to poll for updates — that
  // request must be served fresh, and must never poison the offline HTML with
  // a non-HTML or proxy-generated body.
  const canUpdateShell = event.request.mode === 'navigate';

  const storeShell = async response => {
    if (!canUpdateShell || !response || !response.ok) return;
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return;
    await cache.put(APP_BASE, response.clone()).catch(() => {});
  };

  const fromCache = async () => {
    const exact = await cache.match(event.request, { ignoreSearch: true });
    if (exact) return exact;
    const root = (await cache.match(APP_BASE)) ||
                 (await cache.match(`${APP_BASE}index.html`));
    if (root) return root;
    return offlinePage();
  };

  try {
    const preloadResponse = await event.preloadResponse;
    if (preloadResponse && preloadResponse.ok) {
      await storeShell(preloadResponse);
      return preloadResponse;
    }
  } catch {
    // Navigation Preload unavailable or failed — fall through to timed fetch
  }

  // Known-offline: skip the pointless (and slow) network attempt entirely.
  if (self.navigator && self.navigator.onLine === false) {
    return fromCache();
  }

  try {
    const networkResponse = await withTimeout(fetch(event.request), SHELL_NETWORK_TIMEOUT_MS);
    if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'error') {
      await storeShell(networkResponse);
    }
    return networkResponse;
  } catch (err) {
    console.log(`[SW] ${err.message} — serving cached shell for ${event.request.url}`);
    return fromCache();
  }
}

/**
 * Network-First with Timeout (used for app-core.js)
 *
 * Races the network fetch against a countdown timer. If the network wins and
 * delivers a valid response it is cached and returned. If the timer fires first
 * (or we are offline) we serve the cached copy immediately — no blank screen,
 * no indefinite spinner, and the React app can still boot.
 */
async function networkFirstWithTimeout(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: true });

  if (self.navigator && self.navigator.onLine === false && cached) {
    return cached;
  }

  try {
    const networkResponse = await withTimeout(fetch(request), timeoutMs);
    if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'error') {
      await cache.put(request, networkResponse.clone()).catch(() => {});
    }
    return networkResponse;
  } catch (err) {
    // Timeout or offline — serve the cached copy instantly
    console.log(`[SW] ${err.message} — serving cached asset: ${request.url}`);
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
      trimAllCaches().catch(() => {});
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
  // Google Fonts responses carry `Vary: User-Agent`; ignoring it makes cached
  // stylesheets/fonts match regardless of the UA used to populate the cache.
  const matchOptions = cacheName === FONT_CACHE ? { ignoreVary: true } : undefined;
  const cached = await cache.match(request, matchOptions);

  const networkFetch = fetch(request)
    .then(async response => {
      if (response && response.status === 200 && response.type !== 'error') {
        await cache.put(request, response.clone());
        trimAllCaches().catch(() => {});
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
    .icon { display: block; margin: 0 auto 24px; width: 72px; height: 72px; color: #0077b6; }
    h1 { font-size: 24px; font-weight: 700; color: #03045e; margin-bottom: 12px; letter-spacing: -0.4px; }
    p { font-size: 15px; color: #5d6d7e; line-height: 1.65; margin-bottom: 32px; }
    .badge {
      display: inline-block; background: #e8f4fd; color: #0077b6;
      font-size: 12px; font-weight: 700; padding: 4px 12px;
      border-radius: 20px; margin-bottom: 32px; letter-spacing: 0.3px;
    }
    .badge svg { width: 14px; height: 14px; vertical-align: -2px; margin-right: 6px; }
    button {
      background: linear-gradient(135deg, #0077b6 0%, #005f8e 100%);
      color: white; border: none; padding: 16px 36px; border-radius: 16px;
      font-size: 16px; font-weight: 700; cursor: pointer;
      box-shadow: 0 6px 20px rgba(0, 119, 182, 0.38);
      width: 100%; transition: opacity 0.2s; letter-spacing: -0.2px;
    }
    button:hover { opacity: 0.9; }
    button svg { width: 18px; height: 18px; vertical-align: -4px; margin-right: 8px; }
    .hint { margin-top: 16px; font-size: 13px; color: #aab7c4; }
  </style>
</head>
<body>
  <div class="card">
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 22 16 8"/><path d="M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M15.47 8.53 17 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L17 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M19.47 12.53 21 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L21 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M2 22 20 4"/></svg>
    <div class="badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/></svg>No Internet Connection</div>
    <h1>You're Offline</h1>
    <p>
      This page could not be loaded from the offline cache. Open Farm
      Manager once with a connection so it can download and store
      everything it needs — after that it starts with no network at all.
    </p>
    <button onclick="window.location.reload()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>Try Again</button>
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
