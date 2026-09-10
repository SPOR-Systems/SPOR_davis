"use client";

/**
 * ============================================================================
 *  A SMALL CLIENT-SIDE CACHE, WITH PREFETCH
 * ============================================================================
 *  Pages here fetch their data on mount. That is a waterfall the person waits
 *  through every single time: navigate, mount, request, query, render. Even
 *  when every one of those steps is fast, four of them in a row is a pause —
 *  and it happens again every time they come back to the page.
 *
 *  Two changes fix it:
 *
 *    PREFETCH — the dashboard asks for a page's data shortly after it loads,
 *    while the person is still reading whatever they are on. By the time they
 *    click, the answer is already in memory.
 *
 *    CACHE-THEN-REVALIDATE — a revisit renders what we already have
 *    immediately, then quietly replaces it if the server says something
 *    different. Nobody waits to see a list they were looking at a minute ago.
 *
 *  Deliberately not a data-fetching library. This is a Map with an age check;
 *  anything cleverer would need to earn its place.
 * ============================================================================
 */

interface Entry {
  promise: Promise<unknown>;
  at: number;
}

const cache = new Map<string, Entry>();

/* -------------------------------------------------------------------------- */
/* Surviving a refresh                                                        */
/* -------------------------------------------------------------------------- */

/**
 * An in-memory cache is empty again the moment someone presses F5 — which is
 * the case they complained about. So the last good answer is also kept in
 * sessionStorage, and a reload paints from it while the real request is still
 * in flight. The page is filled in before the network has replied.
 *
 * sessionStorage rather than localStorage: it belongs to one tab and is gone
 * when that tab closes, which is the right lifetime for a convenience copy of
 * somebody's data.
 */
const STORE_PREFIX = "davis:cache:";
const STORE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Never persisted. Connection rows carry hosts, ports and usernames — the shape
 * of the customer's infrastructure — and a speed-up is not a good enough reason
 * to leave that lying in browser storage after the page has gone.
 */
const NEVER_PERSIST = ["/api/connections", "/api/keys"];

function persistable(url: string): boolean {
  return !NEVER_PERSIST.some((p) => url.startsWith(p));
}

function remember(url: string, value: unknown): void {
  if (typeof window === "undefined" || !persistable(url)) return;
  try {
    window.sessionStorage.setItem(
      STORE_PREFIX + url,
      JSON.stringify({ at: Date.now(), value })
    );
  } catch {
    // Quota, private mode, storage disabled — all fine. This is a nicety.
  }
}

/** The last answer for this URL from a previous page load, if it is recent. */
export function remembered<T = unknown>(url: string): T | null {
  if (typeof window === "undefined" || !persistable(url)) return null;
  try {
    const raw = window.sessionStorage.getItem(STORE_PREFIX + url);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; value: T };
    if (Date.now() - parsed.at > STORE_MAX_AGE_MS) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

/** Forget every persisted copy — called on sign-out. */
export function forgetAll(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(STORE_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    /* nothing to do */
  }
  cache.clear();
}

/** How long a cached response may be handed out without a background refresh. */
export const DEFAULT_MAX_AGE_MS = 30_000;

/**
 * Fetch and remember. Concurrent callers share one request rather than each
 * firing their own — a page that mounts twice in React strict mode should not
 * hit the server twice.
 */
export function prefetchJson<T = unknown>(url: string): Promise<T> {
  const existing = cache.get(url);
  if (existing && Date.now() - existing.at < DEFAULT_MAX_AGE_MS) {
    return existing.promise as Promise<T>;
  }

  const promise = fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((value) => {
      remember(url, value);
      return value;
    })
    .catch((error) => {
      // A failed prefetch must not be cached, or one blip poisons the page
      // until the entry ages out.
      cache.delete(url);
      throw error;
    });

  cache.set(url, { promise, at: Date.now() });
  return promise as Promise<T>;
}

/** What we already have, if it is fresh enough to show. */
export function cachedJson<T = unknown>(
  url: string,
  maxAgeMs = DEFAULT_MAX_AGE_MS
): Promise<T> | null {
  const entry = cache.get(url);
  if (!entry) return null;
  return Date.now() - entry.at < maxAgeMs ? (entry.promise as Promise<T>) : null;
}

/**
 * Show what we have, then check. `onFresh` is called only when the server's
 * answer differs from what was already handed over, so a revisit that changed
 * nothing does not re-render or flicker.
 */
export async function staleWhileRevalidate<T = unknown>(
  url: string,
  onFresh: (value: T) => void
): Promise<T | null> {
  const cached = cachedJson<T>(url);
  if (!cached) {
    const fresh = await prefetchJson<T>(url);
    onFresh(fresh);
    return fresh;
  }

  let shown: T | null = null;
  try {
    shown = await cached;
    onFresh(shown);
  } catch {
    /* fall through to a fresh request */
  }

  invalidate(url);
  try {
    const fresh = await prefetchJson<T>(url);
    if (JSON.stringify(fresh) !== JSON.stringify(shown)) onFresh(fresh);
    return fresh;
  } catch {
    return shown;
  }
}

/** Drop an entry — call after anything that changes what it holds. */
export function invalidate(...urls: string[]): void {
  for (const url of urls) {
    cache.delete(url);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(STORE_PREFIX + url);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** Drop every entry whose key starts with this prefix. */
export function invalidatePrefix(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  if (typeof window === "undefined") return;
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(STORE_PREFIX + prefix)) window.sessionStorage.removeItem(key);
    }
  } catch {
    /* nothing to do */
  }
}

/**
 * Warm the endpoints behind the pages someone is most likely to open next.
 *
 * Run once the current page has settled, so it competes with nothing the
 * person is actually waiting for.
 */
export function prefetchDashboard(isAdmin = false): void {
  const urls = [
    "/api/knowledge",
    "/api/knowledge/documents",
    "/api/knowledge/articles",
    "/api/chat/sessions",
    // Members are refused this one, so asking would just be a wasted 403.
    ...(isAdmin ? ["/api/connections"] : []),
  ];

  const run = () => urls.forEach((u) => prefetchJson(u).catch(() => {}));

  if (typeof window === "undefined") return;
  const idle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  }).requestIdleCallback;

  if (idle) idle(run, { timeout: 3000 });
  else window.setTimeout(run, 800);
}
