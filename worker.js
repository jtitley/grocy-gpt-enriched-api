export default {
  async fetch(req, env) {
    // -----------------------------
    // Auth (static bearer gate)
    // -----------------------------
    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${env.OPENAI_BEARER_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const ALLOWED_METHODS = ["GET", "POST", "HEAD"];
    if (!ALLOWED_METHODS.includes(req.method)) {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!env.UPSTREAM_BASE) {
      return new Response("Server misconfigured (missing UPSTREAM_BASE)", { status: 500 });
    }

    if (!env.GROCY_API_KEY) {
      return new Response("Server misconfigured (missing GROCY_API_KEY)", { status: 500 });
    }
    
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      return new Response("Server misconfigured (missing CF Access credentials)", { status: 500 });
    }

    const url = new URL(req.url);
    const upstreamBase = env.UPSTREAM_BASE.replace(/\/+$/, ""); // no trailing slash
    const upstreamHost = new URL(upstreamBase).host;

    const CACHE_VERSION = env.CACHE_VERSION || "v1.1";
    const CACHE_DURATION = Number(env.CACHE_DURATION || 21600);

    const DEFAULT_LOCATION_NAME = env.DEFAULT_LOCATION_NAME || "Fridge";

    const DEFAULT_UNITS = {
      stock: env.DEFAULT_STOCK_UNIT || "Piece",
      purchase: env.DEFAULT_PURCHASE_UNIT || "Piece",
      consume: env.DEFAULT_CONSUME_UNIT || "Piece",
      price: env.DEFAULT_PRICE_UNIT || "Piece"
    };

    const BASE_JSON_HEADERS = { "Content-Type": "application/json" };

    const upstreamJsonHeaders = {
      Host: upstreamHost,
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
      "GROCY-API-KEY": env.GROCY_API_KEY,
      "Content-Type": "application/json"
    };

    const upstreamFileHeaders = {
      Host: upstreamHost,
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
      "GROCY-API-KEY": env.GROCY_API_KEY
      // NOTE: do NOT set Content-Type here; FormData will set it with boundary.
    };

    // -----------------------------
    // Small helpers
    // -----------------------------
    const json = (obj, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...BASE_JSON_HEADERS, ...extraHeaders }
      });

    const jsonError = (status, obj) => json(obj, status);

    async function safeJson(req) {
      try {
        return await req.json();
      } catch {
        return null;
      }
    }

    function normalize(str) {
      return String(str || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s]/g, "");
    }

    function scoreProduct(name, query) {
      if (name === query) return 100;
      if (name.startsWith(query)) return 60;
      if (name.includes(query)) return 30;
      return 0;
    }

    async function cacheGetJson(cache, cacheKeyUrl, fetcher, ttlSeconds) {
      const cacheKey = new Request(cacheKeyUrl);
      let cached = await cache.match(cacheKey);
      if (cached) return cached.json();

      const resp = await fetcher();
      if (!resp.ok) return null;

      const text = await resp.text();
      const stored = new Response(text, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${ttlSeconds}`
        }
      });

      await cache.put(cacheKey, stored.clone());
      return stored.json();
    }

    async function getCachedProducts(cache) {
      const keyUrl = `https://cache.local/${CACHE_VERSION}/grocy/products`;
      const data = await cacheGetJson(
        cache,
        keyUrl,
        () => fetch(`${upstreamBase}/api/objects/products`, { headers: upstreamJsonHeaders }),
        CACHE_DURATION
      );
      if (!data) throw new Error("Failed to fetch products");
      return data;
    }

    async function getCachedShoppingLists(cache) {
      const keyUrl = `https://cache.local/${CACHE_VERSION}/grocy/shopping_lists`;
      const data = await cacheGetJson(
        cache,
        keyUrl,
        () => fetch(`${upstreamBase}/api/objects/shopping_lists`, { headers: upstreamJsonHeaders }),
        CACHE_DURATION
      );
      if (!data) throw new Error("Failed to fetch shopping lists");
      return data;
    }

    async function getCachedStores(cache) {
      const keyUrl = `https://cache.local/${CACHE_VERSION}/grocy/stores`;
      const data = await cacheGetJson(
        cache,
        keyUrl,
        () => fetch(`${upstreamBase}/api/objects/shopping_locations`, { headers: upstreamJsonHeaders }),
        CACHE_DURATION
      );
      if (!data) throw new Error("Failed to fetch stores");
      return data;
    }

    function resolveProductFuzzy(products, productName) {
      const query = normalize(productName);
      const matches = products
        .map(p => ({
          id: p.id,
          name: p.name,
          score: p.name ? scoreProduct(normalize(p.name), query) : 0
        }))
        .filter(p => p.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (matches.length === 0) {
        return { error: { error: "product_not_found", product: productName } };
      }
      if (matches.length > 1 && matches[0].score < 100) {
        return {
          error: {
            error: "multiple_products",
            products: matches.map(m => ({ id: m.id, name: m.name }))
          }
        };
      }
      return { product: matches[0] };
    }

    // ============================================================
    // ENRICHED: Add item to shopping list
    // ============================================================
    if (url.pathname === "/api/enriched/shopping_list/add" && req.method === "POST") {
      const body = await safeJson(req);
      if (!body) return jsonError(400, { error: "invalid_json" });

      const { product, amount, note, shopping_list_id } = body;
      if (!product || typeof amount !== "number") {
        return jsonError(400, { error: "invalid_request" });
      }

      const cache = caches.default;

      // Resolve list
      let lists;
      try {
        lists = await getCachedShoppingLists(cache);
      } catch {
        return new Response("Failed to fetch shopping lists", { status: 502 });
      }

      let selectedList;
      if (shopping_list_id) {
        selectedList = lists.find(l => l.id === shopping_list_id);
        if (!selectedList) return jsonError(400, { error: "invalid_shopping_list_id" });
      } else if (lists.length === 1) {
        selectedList = lists[0];
      } else if (lists.length > 1) {
        return json({
          error: "multiple_lists",
          lists: lists.map(l => ({ id: l.id, name: l.name }))
        }, 400);
      } else {
        return jsonError(400, { error: "no_shopping_list_found" });
      }

      // Resolve product
      let products;
      try {
        products = await getCachedProducts(cache);
      } catch {
        return new Response("Failed to fetch products", { status: 502 });
      }

      const resolved = resolveProductFuzzy(products, product);
      if (resolved.error) return json(resolved.error, 400);

      const productId = resolved.product.id;

      // Add item
      const addResp = await fetch(`${upstreamBase}/api/stock/shoppinglist/add-product`, {
        method: "POST",
        headers: upstreamJsonHeaders,
        body: JSON.stringify({
          product_id: productId,
          product_amount: amount,
          note,
          list_id: selectedList.id
        })
      });

      if (!addResp.ok) return new Response("Failed to add item", { status: 502 });

      return json({
        status: "added",
        list: { id: selectedList.id, name: selectedList.name },
        item: {
          product_id: productId,
          product_name: resolved.product.name,
          amount,
          note: note ?? null
        }
      });
    }

    // ============================================================
    // ENRICHED: Get shopping list (with pricing context)
    // ============================================================
    if (url.pathname === "/api/enriched/shopping_list" && req.method === "GET") {
      const cache = caches.default;
      const requestedListId = url.searchParams.get("list_id");

      let lists;
      try {
        lists = await getCachedShoppingLists(cache);
      } catch {
        return new Response("Failed to fetch shopping lists", { status: 502 });
      }

      let selectedList;
      if (requestedListId) {
        selectedList = lists.find(l => String(l.id) === String(requestedListId));
        if (!selectedList) return jsonError(400, { error: "invalid_shopping_list_id" });
      } else if (lists.length === 1) {
        selectedList = lists[0];
      } else if (lists.length > 1) {
        return json({
          error: "multiple_lists",
          lists: lists.map(l => ({ id: l.id, name: l.name }))
        }, 400);
      } else {
        return json({ list: null, items: [] });
      }

      const itemsResp = await fetch(
        `${upstreamBase}/api/objects/shopping_list?list_id=${selectedList.id}`,
        { headers: upstreamJsonHeaders }
      );
      if (!itemsResp.ok) return new Response("Failed to fetch shopping list items", { status: 502 });

      let items = await itemsResp.json();
      items = items.slice(0, 50);

      const productIds = [...new Set(items.map(i => i.product_id).filter(id => typeof id === "number"))];

      let products;
      try {
        products = await getCachedProducts(cache);
      } catch {
        return new Response("Failed to fetch products", { status: 502 });
      }
      const productMap = Object.fromEntries(products.map(p => [p.id, p.name]));

      let stores;
      try {
        stores = await getCachedStores(cache);
      } catch {
        return new Response("Failed to fetch stores", { status: 502 });
      }
      const storeMap = Object.fromEntries(stores.map(s => [s.id, s.name]));

      // Last-purchase details per product (cached, parallel)
      const lastPurchaseMap = {};
      await Promise.all(productIds.map(async (productId) => {
        const cacheKeyUrl = `https://cache.local/${CACHE_VERSION}/grocy/stock-product/${productId}`;
        const details = await cacheGetJson(
          cache,
          cacheKeyUrl,
          () => fetch(`${upstreamBase}/api/stock/products/${productId}`, { headers: upstreamJsonHeaders }),
          3600
        );
        if (!details) return;

        lastPurchaseMap[productId] = {
          last_price: details.last_price ?? null,
          store_id: details.last_shopping_location_id ?? null,
          price_qu_id: details.product?.qu_id_price ?? details.qu_id_price ?? null,
          price_qu_name: details.quantity_unit_price?.name ?? null,
          price_to_stock_factor: details.qu_conversion_factor_price_to_stock ?? null,
          purchase_to_stock_factor: details.qu_conversion_factor_purchase_to_stock ?? null
        };
      }));

      const enrichedItems = items.map(i => {
        const last = lastPurchaseMap[i.product_id] ?? {};
        return {
          product_id: i.product_id,
          product_name: productMap[i.product_id] ?? "Unknown",
          amount: i.amount,
          note: i.note ?? null,
          last_store: last.store_id ? (storeMap[last.store_id] ?? null) : null,
          pricing: {
            last_price_per_price_unit: last.last_price,
            price_unit: last.price_qu_name,
            price_qu_id: last.price_qu_id,
            amount: i.amount,
            shopping_list_qu_id: i.qu_id ?? null,
            purchase_to_stock_factor: last.purchase_to_stock_factor,
            price_to_stock_factor: last.price_to_stock_factor
          }
        };
      });

      return json({
        list: { id: selectedList.id, name: selectedList.name },
        items: enrichedItems
      });
    }

    // ============================================================
    // ENRICHED: Get stock (enriched)
    // ============================================================
    if (url.pathname === "/api/enriched/stock" && req.method === "GET") {
      const stockResp = await fetch(`${upstreamBase}/api/objects/stock`, { headers: upstreamJsonHeaders });
      if (!stockResp.ok) return new Response("Failed to fetch stock", { status: 502 });

      let stock = await stockResp.json();
      stock = stock.slice(0, 25);

      const productIds = [...new Set(stock.map(s => s.product_id).filter(id => typeof id === "number"))];
      if (productIds.length === 0) return json([]);

      // Use cached products
      const cache = caches.default;
      let products;
      try {
        products = await getCachedProducts(cache);
      } catch {
        return new Response("Failed to fetch products", { status: 502 });
      }

      const productMap = Object.fromEntries(products.map(p => [p.id, p.name]));

      const enriched = stock.map(s => ({
        stock_id: s.id,
        product_id: s.product_id,
        product_name: productMap[s.product_id] ?? "Unknown",
        amount: s.amount,
        best_before_date: s.best_before_date ?? null
      }));

      return json(enriched);
    }

    // ============================================================
    // ENRICHED: Product search
    // ============================================================
    if (url.pathname === "/api/enriched/products/search" && req.method === "GET") {
      const q = url.searchParams.get("q");
      const limitParam = url.searchParams.get("limit");

      if (!q || !q.trim()) return jsonError(400, { error: "missing_query" });

      const limit = Math.min(Number(limitParam) || 5, 10);
      const cache = caches.default;

      let products;
      try {
        products = await getCachedProducts(cache);
      } catch {
        return new Response("Failed to fetch products", { status: 502 });
      }

      const query = normalize(q);
      const matches = products
        .map(p => ({
          id: p.id,
          name: p.name,
          score: p.name ? scoreProduct(normalize(p.name), query) : 0
        }))
        .filter(p => p.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return json({
        query: q,
        matches: matches.map(m => ({
          id: m.id,
          name: m.name,
          confidence: Math.min(1, m.score / 100)
        }))
      });
    }

    // ============================================================
    // ENRICHED: Product create
    // ============================================================
    if (url.pathname === "/api/enriched/products/create" && req.method === "POST") {
      const body = await safeJson(req);
      if (!body) return jsonError(400, { error: "invalid_json" });

      const {
        name,
        description,
        default_location,
        quantity_units = {},
        product_group,
        image_url
      } = body;

      if (!name || typeof name !== "string") return jsonError(400, { error: "invalid_request" });

      const cache = caches.default;

      // De-dupe check
      let products;
      try {
        products = await getCachedProducts(cache);
      } catch {
        return new Response("Failed to fetch products", { status: 502 });
      }

      const normalizedName = normalize(name);
      if (products.some(p => normalize(p.name) === normalizedName)) {
        return jsonError(400, { error: "product_exists", product: name });
      }

      // Resolve location
      const locationName = default_location || DEFAULT_LOCATION_NAME;
      const locations = await cacheGetJson(
        cache,
        `https://cache.local/${CACHE_VERSION}/grocy/locations`,
        () => fetch(`${upstreamBase}/api/objects/locations`, { headers: upstreamJsonHeaders }),
        CACHE_DURATION
      );
      if (!locations) return new Response("Failed to fetch locations", { status: 502 });

      const location = locations.find(l => normalize(l.name) === normalize(locationName));
      if (!location) return jsonError(400, { error: "invalid_location", location: locationName });

      // Resolve quantity units
      const units = await cacheGetJson(
        cache,
        `https://cache.local/${CACHE_VERSION}/grocy/quantity-units`,
        () => fetch(`${upstreamBase}/api/objects/quantity_units`, { headers: upstreamJsonHeaders }),
        CACHE_DURATION
      );
      if (!units) return new Response("Failed to fetch quantity units", { status: 502 });

      const resolveUnit = (unitName) => units.find(u => normalize(u.name) === normalize(unitName));

      const resolvedUnits = {
        stock: resolveUnit(quantity_units.stock || DEFAULT_UNITS.stock),
        purchase: resolveUnit(quantity_units.purchase || DEFAULT_UNITS.purchase),
        consume: resolveUnit(quantity_units.consume || DEFAULT_UNITS.consume),
        price: resolveUnit(quantity_units.price || DEFAULT_UNITS.price)
      };

      for (const [key, unit] of Object.entries(resolvedUnits)) {
        if (!unit) return jsonError(400, { error: "invalid_quantity_unit", unit: key });
      }

      // Resolve product group (optional)
      let product_group_id = null;
      if (product_group) {
        const pgResp = await fetch(`${upstreamBase}/api/objects/product_groups`, { headers: upstreamJsonHeaders });
        if (!pgResp.ok) return new Response("Failed to fetch product groups", { status: 502 });

        const groups = await pgResp.json();
        const match = groups.find(g => normalize(g.name) === normalize(product_group));
        if (!match) return jsonError(400, { error: "invalid_product_group", product_group });
        product_group_id = match.id;
      }

      // Create product
      const createResp = await fetch(`${upstreamBase}/api/objects/products`, {
        method: "POST",
        headers: upstreamJsonHeaders,
        body: JSON.stringify({
          name,
          description,
          location_id: location.id,
          qu_id_stock: resolvedUnits.stock.id,
          qu_id_purchase: resolvedUnits.purchase.id,
          qu_id_consume: resolvedUnits.consume.id,
          qu_id_price: resolvedUnits.price.id,
          product_group_id
        })
      });
      if (!createResp.ok) return new Response("Failed to create product", { status: 502 });

      const created = await createResp.json();
      const productId = created.id;

      // Optional image upload (best effort)
      let imageAttached = false;
      let imageError = null;

      if (image_url) {
        try {
          const imgResp = await fetch(image_url);
          if (!imgResp.ok) throw new Error(`image fetch failed (${imgResp.status})`);

          const size = Number(imgResp.headers.get("content-length") || 0);
          if (size > 5_000_000) throw new Error("image too large");

          const ct = imgResp.headers.get("content-type") || "";
          if (!ct.startsWith("image/")) throw new Error(`invalid content-type (${ct})`);

          const blob = await imgResp.blob();
          const form = new FormData();
          form.append("file", blob, "product.jpg");

          const uploadResp = await fetch(`${upstreamBase}/api/files/productpictures/${productId}`, {
            method: "POST",
            headers: upstreamFileHeaders,
            body: form
          });

          if (!uploadResp.ok) {
            const text = await uploadResp.text();
            throw new Error(`upload failed (${uploadResp.status}): ${text}`);
          }

          imageAttached = true;
        } catch (err) {
          imageError = err.message;
          console.log("Image upload failed:", imageError);
        }
      }

      // Invalidate product cache
      await caches.default.delete(new Request(`https://cache.local/${CACHE_VERSION}/grocy/products`));

      return json({
        status: "created",
        product: { id: productId, name },
        location: location.name,
        quantity_units: {
          stock: resolvedUnits.stock.name,
          purchase: resolvedUnits.purchase.name,
          consume: resolvedUnits.consume.name,
          price: resolvedUnits.price.name
        },
        image: { attached: imageAttached, error: imageError }
      });
    }

    // ============================================================
    // ENRICHED: Stock add (single)
    // ============================================================
    if (url.pathname === "/api/enriched/stock/add" && req.method === "POST") {
      const body = await safeJson(req);
      if (!body) return jsonError(400, { error: "invalid_json" });

      const { product, amount, price, best_before_date } = body;
      if (!product || typeof amount !== "number") return jsonError(400, { error: "invalid_request" });

      const cache = caches.default;

      let products;
      try {
        products = await getCachedProducts(cache);
      } catch {
        return new Response("Failed to fetch products", { status: 502 });
      }

      const resolved = resolveProductFuzzy(products, product);
      if (resolved.error) return json(resolved.error, 400);

      const productId = resolved.product.id;

      const detailsResp = await fetch(`${upstreamBase}/api/stock/products/${productId}`, { headers: upstreamJsonHeaders });
      if (!detailsResp.ok) return new Response("Failed to fetch product details", { status: 502 });

      const details = await detailsResp.json();
      const quId = details.product?.qu_id_stock ?? details.qu_id_stock;

      const addResp = await fetch(`${upstreamBase}/api/objects/products/${productId}/add`, {
        method: "POST",
        headers: upstreamJsonHeaders,
        body: JSON.stringify({ amount, best_before_date, qu_id: quId })
      });
      if (!addResp.ok) return new Response("Failed to add stock", { status: 502 });

      if (typeof price === "number") {
        // best-effort
        fetch(`${upstreamBase}/api/objects/product_prices`, {
          method: "POST",
          headers: upstreamJsonHeaders,
          body: JSON.stringify({
            product_id: productId,
            price,
            store_id: details.last_shopping_location_id ?? null
          })
        }).catch(() => {});
      }

      return json({
        status: "added",
        product: { id: productId, name: resolved.product.name },
        interpreted_as: {
          amount,
          unit: details.quantity_unit_stock?.name ?? "stock unit",
          price: typeof price === "number" ? price : null
        }
      });
    }

    // ============================================================
    // ENRICHED: Stock add bulk
    // ============================================================
    if (url.pathname === "/api/enriched/stock/add/bulk" && req.method === "POST") {
      const body = await safeJson(req);
      if (!body) return jsonError(400, { error: "invalid_json" });

      const { items } = body;
      if (!Array.isArray(items) || items.length === 0) return jsonError(400, { error: "invalid_request" });

      const MAX_ITEMS = 25;
      const safeItems = items.slice(0, MAX_ITEMS);

      const cache = caches.default;

      let products;
      try {
        products = await getCachedProducts(cache);
      } catch {
        return new Response("Failed to fetch products", { status: 502 });
      }

      const results = [];

      for (const item of safeItems) {
        const { line, product, amount, best_before_date, price } = item;

        if (!product || typeof amount !== "number") {
          results.push({ line, status: "error", error: "invalid_line" });
          continue;
        }

        const resolved = resolveProductFuzzy(products, product);
        if (resolved.error) {
          results.push({ line, status: "error", ...resolved.error });
          continue;
        }

        const productId = resolved.product.id;

        let details;
        try {
          const detailsResp = await fetch(`${upstreamBase}/api/stock/products/${productId}`, { headers: upstreamJsonHeaders });
          if (!detailsResp.ok) throw new Error();
          details = await detailsResp.json();
        } catch {
          results.push({ line, status: "error", error: "product_details_unavailable" });
          continue;
        }

        const quId = details.product?.qu_id_stock ?? details.qu_id_stock;

        const addResp = await fetch(`${upstreamBase}/api/objects/products/${productId}/add`, {
          method: "POST",
          headers: upstreamJsonHeaders,
          body: JSON.stringify({ amount, best_before_date, qu_id: quId })
        });

        if (!addResp.ok) {
          results.push({ line, status: "error", error: "add_failed" });
          continue;
        }

        if (typeof price === "number") {
          fetch(`${upstreamBase}/api/objects/product_prices`, {
            method: "POST",
            headers: upstreamJsonHeaders,
            body: JSON.stringify({
              product_id: productId,
              price,
              store_id: details.last_shopping_location_id ?? null
            })
          }).catch(() => {});
        }

        results.push({
          line,
          status: "added",
          product: { id: productId, name: resolved.product.name },
          interpreted_as: {
            amount,
            unit: details.quantity_unit_stock?.name ?? "stock unit",
            price: typeof price === "number" ? price : null
          }
        });
      }

      return json({
        status: "completed",
        summary: {
          total: safeItems.length,
          added: results.filter(r => r.status === "added").length,
          errors: results.filter(r => r.status === "error").length
        },
        results
      });
    }

    // ============================================================
    // Pass-through for other /api/* routes
    // ============================================================
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

    // IMPORTANT: preserve query string
    const upstreamUrl = upstreamBase + url.pathname + url.search;

    const upstreamReq = new Request(upstreamUrl, {
      method: req.method,
      body,
      headers: upstreamJsonHeaders,
      redirect: "manual"
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let resp;
    try {
      resp = await fetch(upstreamReq, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    const ct = resp.headers.get("content-type") || "";
    if (resp.status === 302 || (ct.includes("text/html") && !ct.includes("application/json"))) {
      return new Response("Access Authentication failed", { status: 502 });
    }

    return resp;
  }
};
