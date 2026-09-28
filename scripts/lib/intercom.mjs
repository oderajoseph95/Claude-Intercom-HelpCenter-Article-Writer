/**
 * intercom.mjs: the one Intercom API client every script shares.
 *
 * Zero dependencies. Node 18+ (global fetch).
 *
 * Safety is built into the client, not left to each caller:
 *   - `allowWrites: false` (the default) makes every POST/PUT/DELETE throw before it leaves the
 *     machine. The audit creates its client this way, so it is read-only by construction.
 *   - Pagination follows every page. A one-page read silently drops later collections and
 *     articles, which then show up as "not found" or "orphan" for no real reason.
 *   - 429 rate limits are retried with backoff, honouring Retry-After / X-RateLimit-Reset.
 *     GETs are also retried on network errors and 5xx. WRITES ARE NOT retried on a network
 *     error or 5xx, because the write may have landed; the publisher's re-run is idempotent
 *     instead (it adopts an article it already created rather than creating a second one).
 */

import { fail } from "./messages.mjs";

export const REGIONS = {
  us: "https://api.intercom.io",
  eu: "https://api.eu.intercom.io",
  au: "https://api.au.intercom.io",
};

export function baseUrl(region = "us") {
  const base = REGIONS[String(region || "us").toLowerCase()];
  if (!base) throw fail("IHC007", { region });
  return base;
}

export class IntercomError extends Error {
  constructor(message, { region = "", status = 0, method = "GET", path = "", body = "", maybeApplied = false } = {}) {
    super(message);
    this.status = status;
    this.region = region;
    this.method = method;
    this.path = path;
    this.body = body;
    this.maybeApplied = maybeApplied;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.token          INTERCOM_API_TOKEN
 * @param {string} [o.region]       us | eu | au
 * @param {string} [o.version]      Intercom-Version header, default 2.11
 * @param {boolean} [o.allowWrites] false = GET only
 * @param {number} [o.maxRetries]   default 6
 * @param {(ms:number)=>Promise} [o.sleep] injectable for tests
 */
export function createClient({ token, region = "us", version = "2.11", allowWrites = false, maxRetries = 6, sleep = defaultSleep, onRetry } = {}) {
  const BASE = baseUrl(region);
  const stats = { get: 0, write: 0, retries: 0 };

  async function request(path, { method = "GET", body } = {}) {
    if (!token) throw new IntercomError("INTERCOM_API_TOKEN is not set. Export only that key.", { method, path });
    if (method !== "GET" && !allowWrites) throw new IntercomError(`refusing ${method} ${path}: this run is read-only (dry run)`, { method, path });
    const url = path.startsWith("http") ? path : BASE + path;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Intercom-Version": version,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (method === "GET" && attempt < maxRetries) { await backoff(attempt, null); continue; }
        throw new IntercomError(`${method} ${path} failed: ${e.message}`, { method, path, maybeApplied: method !== "GET" });
      }
      if (method === "GET") stats.get++; else stats.write++;
      if (res.status === 429 && attempt < maxRetries) { await backoff(attempt, res); continue; }
      if (res.status >= 500 && method === "GET" && attempt < maxRetries) { await backoff(attempt, res); continue; }
      const text = await res.text();
      if (!res.ok) {
        throw new IntercomError(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`, {
          region, status: res.status, method, path, body: text, maybeApplied: method !== "GET" && res.status >= 500,
        });
      }
      return text ? JSON.parse(text) : {};
    }
  }

  async function backoff(attempt, res) {
    stats.retries++;
    let ms = Math.min(60000, 1000 * 2 ** attempt);
    const retryAfter = res?.headers?.get?.("retry-after");
    const reset = res?.headers?.get?.("x-ratelimit-reset");
    if (retryAfter && !Number.isNaN(Number(retryAfter))) ms = Number(retryAfter) * 1000;
    else if (reset && !Number.isNaN(Number(reset))) ms = Math.max(0, Number(reset) * 1000 - Date.now()) + 250;
    ms = Math.min(ms, 120000);
    onRetry?.({ attempt, status: res?.status ?? "network", ms });
    await sleep(ms);
  }

  /** Follow `pages.next` (URL, path or cursor object) or `total_pages` to the end. */
  async function paginate(firstPath, perPage) {
    const all = [];
    const sep = firstPath.includes("?") ? "&" : "?";
    let page = 1;
    let path = `${firstPath}${sep}page=1&per_page=${perPage}`;
    const seen = new Set();
    while (path && !seen.has(path)) {
      seen.add(path);
      const res = await request(path);
      const data = res.data ?? [];
      all.push(...data);
      if (!data.length) break;
      const pages = res.pages ?? {};
      const next = pages.next;
      page++;
      if (typeof next === "string" && next) { path = next; continue; }
      if (next && typeof next === "object" && next.starting_after) {
        path = `${firstPath}${sep}per_page=${perPage}&starting_after=${encodeURIComponent(next.starting_after)}`;
        continue;
      }
      const total = Number(pages.total_pages);
      path = total && page <= total ? `${firstPath}${sep}page=${page}&per_page=${perPage}` : null;
    }
    return all;
  }

  const fetchAllCollections = () => paginate("/help_center/collections", 100);

  /**
   * Every article, with its body. The list endpoint normally includes `body`; if a workspace
   * returns list items without it, each article is fetched on its own, so the audit never
   * judges an article by a body it was simply not sent.
   */
  async function fetchAllArticles({ withBodies = true } = {}) {
    const list = await paginate("/articles", 50);
    if (!withBodies) return list;
    const out = [];
    for (const a of list) {
      if (typeof a.body === "string") { out.push(a); continue; }
      out.push({ ...a, ...(await request(`/articles/${a.id}`)) });
    }
    return out;
  }

  return {
    request,
    get: (p) => request(p),
    post: (p, body) => request(p, { method: "POST", body }),
    put: (p, body) => request(p, { method: "PUT", body }),
    fetchAllCollections,
    fetchAllArticles,
    stats,
    base: BASE,
  };
}

/** Name comparison used everywhere: case, spacing and & vs "and" do not matter. */
export const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");

/** Build id -> "Top › Section › Sub" for any depth, guarding against parent cycles. */
export function collectionPaths(collections) {
  const byId = new Map(collections.map((c) => [String(c.id), c]));
  const cache = new Map();
  const pathOf = (id) => {
    id = String(id);
    if (cache.has(id)) return cache.get(id);
    const names = [];
    const seen = new Set();
    let cur = byId.get(id);
    while (cur && !seen.has(String(cur.id))) {
      seen.add(String(cur.id));
      names.unshift(cur.name);
      cur = cur.parent_id != null ? byId.get(String(cur.parent_id)) : null;
    }
    const p = names.join(" › ");
    cache.set(id, p);
    return p;
  };
  return { byId, pathOf };
}

/** "A › B / C" -> ["A","B","C"]. Accepts ›, >, and " / " as separators. */
export function splitPath(s) {
  return String(s ?? "").split(/\s*(?:›|>|\s\/\s)\s*/).map((x) => x.trim()).filter(Boolean);
}
