/**
 * A fake Intercom REST API, in memory, installed as globalThis.fetch.
 *
 * It paginates (small pages, so single-page reads fail tests), creates ids, echoes bodies, keeps
 * translated_content, and can inject 429s, 403s, 404s and network failures. It models the API
 * shapes this plugin uses (2.11); it does not prove Intercom accepts or renders a payload.
 */
export function createFakeIntercom(opts = {}) {
  const state = {
    region: opts.region ?? "us",
    me: opts.me ?? { type: "admin", id: 777, name: "Test Admin", app: { id_code: "ws1", name: "Acme Help" } },
    collections: structuredClone(opts.collections ?? []),
    articles: structuredClone(opts.articles ?? []),
    collectionsPerPage: opts.collectionsPerPage ?? 2,
    articlesPerPage: opts.articlesPerPage ?? 2,
    listWithoutBody: opts.listWithoutBody ?? false,
    nextStyle: opts.nextStyle ?? "total_pages", // or "url"
    nextId: 1000,
    calls: [],
    inject: [], // { method, prefix, status, headers, network, times, afterApply }
  };
  const hosts = { us: "api.intercom.io", eu: "api.eu.intercom.io", au: "api.au.intercom.io" };

  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
  const page = (list, url, perPage) => {
    const p = Number(url.searchParams.get("page") ?? 1);
    const data = list.slice((p - 1) * perPage, p * perPage);
    const total = Math.max(1, Math.ceil(list.length / perPage));
    const pages = { type: "pages", page: p, per_page: perPage, total_pages: total };
    if (state.nextStyle === "url" && p < total) pages.next = `https://${url.host}${url.pathname}?page=${p + 1}&per_page=${perPage}`;
    return json({ type: "list", data, pages, total_count: list.length });
  };

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method, path: url.pathname, search: url.search, body, host: url.host };
    state.calls.push(call);

    const inj = state.inject.find((i) => (!i.method || i.method === method) && url.pathname.startsWith(i.prefix) && i.times > 0);
    let applyThenFail = false;
    if (inj) {
      inj.times--;
      if (inj.network && !inj.afterApply) throw new TypeError("fetch failed");
      if (inj.network && inj.afterApply) applyThenFail = true;
      else return new Response(JSON.stringify({ errors: [{ code: String(inj.status) }] }), { status: inj.status, headers: inj.headers ?? {} });
    }
    if (url.host !== hosts[state.region]) return json({ type: "error.list", errors: [{ code: "unauthorized" }] }, 401);
    const auth = init.headers?.Authorization ?? "";
    if (!/^Bearer .+/.test(auth)) return json({ errors: [{ code: "unauthorized" }] }, 401);

    const res = route(method, url, body);
    if (applyThenFail) throw new TypeError("fetch failed after the write landed");
    return res;
  }

  function route(method, url, body) {
    const p = url.pathname;
    if (p === "/me" && method === "GET") return json(state.me);
    if (p === "/help_center/collections" && method === "GET") return page(state.collections, url, state.collectionsPerPage);
    if (p === "/help_center/collections" && method === "POST") {
      const c = { id: String(state.nextId++), name: body.name, parent_id: body.parent_id ?? null, description: body.description ?? "" };
      state.collections.push(c);
      return json(c);
    }
    if (p === "/articles" && method === "GET") {
      const list = state.listWithoutBody ? state.articles.map(({ body: _b, ...rest }) => rest) : state.articles;
      return page(list, url, state.articlesPerPage);
    }
    if (p === "/articles" && method === "POST") {
      const id = String(state.nextId++);
      const a = { id, workspace_id: state.me.app.id_code, url: `https://help.example.com/en/articles/${id}-${slug(body.title)}`, updated_at: Math.floor(Date.now() / 1000), ...body, parent_id: body.parent_id ?? null };
      state.articles.push(a);
      return json(a);
    }
    const m = /^\/articles\/(\w+)$/.exec(p);
    if (m) {
      const a = state.articles.find((x) => String(x.id) === m[1]);
      if (!a) return json({ type: "error.list", errors: [{ code: "not_found" }] }, 404);
      if (method === "GET") return json(a);
      if (method === "PUT") {
        const { translated_content, ...rest } = body;
        Object.assign(a, rest, { updated_at: Math.floor(Date.now() / 1000) });
        if (translated_content) a.translated_content = { ...(a.translated_content ?? { type: "article_translated_content" }), ...translated_content };
        return json(a);
      }
    }
    return new Response(`fake intercom: unexpected ${method} ${p}`, { status: 400 });
  }

  const api = {
    state,
    fetch,
    install() { this.prev = globalThis.fetch; globalThis.fetch = fetch; return this; },
    uninstall() { globalThis.fetch = this.prev; },
    writes: () => state.calls.filter((c) => c.method !== "GET"),
    reset() { state.calls.length = 0; },
    failOnce(method, prefix, status, headers) { state.inject.push({ method, prefix, status, headers, times: 1 }); },
    networkFailOnce(method, prefix, { afterApply = false } = {}) { state.inject.push({ method, prefix, network: true, afterApply, times: 1 }); },
    article: (id) => state.articles.find((a) => String(a.id) === String(id)),
  };
  return api;
}

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A realistic small help center for the audit tests: every finding type appears at least once. */
export function sampleHelpCenter() {
  // Distinct, deterministic prose per topic, so only the pairs meant to overlap do.
  const VOCAB = "account admin alert apply archive batch browser button calendar change check choose column confirm copy create date default delete detail device download edit email enable entry error export field file filter find folder form group guide history import invoice label language layout limit link list login menu message mobile month name note number option order owner page password pause period plan preview print profile quantity range record refund report reset result review role rule save schedule search section select send setting share sheet shop size sort status step store summary switch table team template time total type update upload user value view week window workflow".split(" ");
  const long = (topic) => {
    let seed = [...topic].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) % VOCAB.length;
    const sentences = Array.from({ length: 30 }, () => `${topic} ${Array.from({ length: 9 }, () => VOCAB[rnd()]).join(" ")}.`);
    return `<p class="no-margin">${sentences.join(" ")}</p>`;
  };
  const exportBody = `<h2>Export</h2><p class="no-margin"></p><p class="no-margin">Open <b>Export orders</b>, choose a <b>Date range</b> and click <b>Download CSV</b>. CSV opens in Excel, Numbers and Google Sheets.</p>${long("export")}`;
  return {
    collections: [
      { id: "10", name: "Getting started", parent_id: null },
      { id: "11", name: "Orders", parent_id: null },
      { id: "12", name: "Old stuff", parent_id: null },
      { id: "13", name: "Legacy", parent_id: "12" },
      { id: "14", name: "Deep", parent_id: "13" },
      { id: "15", name: "Nobody home", parent_id: null },
    ],
    articles: [
      { id: "1", title: "How do I export my orders to CSV?", state: "published", parent_id: 11, body: exportBody, updated_at: 1790000000, url: "https://help.example.com/en/articles/1-export", translated_content: { type: "article_translated_content", fr: { title: "Exporter", body: "<p>fr</p>" } } },
      { id: "2", title: "How do I export my orders to CSV", state: "published", parent_id: 12, body: exportBody.replace("Export</h2>", "Exporting</h2>"), updated_at: 1790000000, url: "https://help.example.com/en/articles/2-export" },
      { id: "3", title: "Welcome", state: "published", parent_id: 10, body: "", updated_at: 1790000000 },
      { id: "4", title: "Legacy fax integration", state: "published", parent_id: 14, body: `${long("fax machines")}<p><a href="https://help.example.com/en/articles/999-gone">old link</a></p>`, updated_at: 1500000000 },
      { id: "5", title: "Draft about billing", state: "draft", parent_id: null, body: "<p>Plans and invoices.</p>", updated_at: 1790000000 },
      { id: "6", title: "Why is my export empty?", state: "published", parent_id: 11, body: `<p>Only orders inside the <b>Date range</b> are exported, up to 10,000 per file. See <a href="https://help.example.com/en/articles/5-draft">billing</a>.</p>${long("empty exports")}`, updated_at: 1790000000 },
      { id: "7", title: "Getting around the dashboard", state: "published", parent_id: 10, body: long("dashboard navigation"), updated_at: 1790000000 },
      { id: "8", title: "Finding your way around", state: "published", parent_id: 10, body: long("dashboard navigation") + "<p>One extra line.</p>", updated_at: 1790000000 },
      { id: "9", title: "Welcome!", state: "published", parent_id: 10, body: long("welcome to the app"), updated_at: 1790000000 },
      { id: "10", title: "How do I cancel?", state: "published", parent_id: 10, body: long("cancel your subscription"), updated_at: 1790000000 },
      { id: "11", title: "How do I cancel?", state: "published", parent_id: 11, body: long("cancel a single order"), updated_at: 1790000000 },
    ],
  };
}
