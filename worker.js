export default {
  async fetch(req, env) {
    // 1. Your existing static bearer check (unchanged)
    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${env.OPENAI_BEARER_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const ALLOWED_METHODS = ["GET", "POST"];
    if (!ALLOWED_METHODS.includes(req.method)) {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(req.url);
    const upstreamBase = env.UPSTREAM_BASE;
    const CACHE_VERSION = "v1.1";

    const headers = {
      "Host": upstreamBase,
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
      "GROCY-API-KEY": env.GROCY_API_KEY,
      "Content-Type": "application/json"
    };

    async function getCachedProducts(env, headers, cache, CACHE_VERSION) {
      const cacheKey = new Request(
        `https://cache.local/${CACHE_VERSION}/grocy/products`
      );
    
      let cached = await cache.match(cacheKey);
      if (cached) {
        return cached.json();
      }
    
      const resp = await fetch(
        `${env.UPSTREAM_BASE}/api/objects/products`,
        { headers }
      );
    
      if (!resp.ok) {
        throw new Error("Failed to fetch products");
      }
    
      cached = new Response(await resp.text(), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "max-age=21600"
        }
      });
    
      await cache.put(cacheKey, cached.clone());
      return cached.json();
    }
    
    /**
     * @param {string} str
     */
    function normalize(str) {
      return str
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s]/g, "");
    }
    
    /**
     * @param {string} name
     * @param {any} query
     */
    function scoreProduct(name, query) {
      if (name === query) return 100;
      if (name.startsWith(query)) return 60;
      if (name.includes(query)) return 30;
      return 0;
    }    

    // --- ENRICHED ADD TO SHOPPING LIST ---
    if (url.pathname === "/api/enriched/shopping_list/add" && req.method === "POST") {
      const body = await req.json();
      const { product, amount, note, shopping_list_id } = body;

      if (!product || typeof amount !== "number") {
        return new Response("Invalid request", { status: 400 });
      }

      // 1️⃣ Resolve shopping list (reuse your logic)
      const listsResp = await fetch(
        `${upstreamBase}/api/objects/shopping_lists`,
        { headers }
      );

      const lists = await listsResp.json();

      let selectedList;
      if (shopping_list_id) {
        selectedList = lists.find(l => l.id === shopping_list_id);
        if (!selectedList) {
          return new Response("Invalid shopping list ID", { status: 400 });
        }
      } else if (lists.length === 1) {
        selectedList = lists[0];
      } else if (lists.length > 1) {
        return new Response(JSON.stringify({
          error: "multiple_lists",
          lists: lists.map(l => ({ id: l.id, name: l.name }))
        }), { headers: { "Content-Type": "application/json" }});
      } else {
        return new Response("No shopping list found", { status: 400 });
      }

      // 2️⃣ Resolve product (fuzzy, cached, GPT-safe)
      const cache = caches.default;
      const products = await getCachedProducts(env, headers, cache, CACHE_VERSION);

      const query = normalize(product);

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
          return new Response(JSON.stringify({
            error: "product_not_found",
            product
          }), { headers: { "Content-Type": "application/json" }});
        }
        
        if (matches.length > 1 && matches[0].score < 100) {
          return new Response(JSON.stringify({
            error: "multiple_products",
            products: matches.map(p => ({
              id: p.id,
              name: p.name
            }))
          }), { headers: { "Content-Type": "application/json" }});
        }
        
      const productId = matches[0].id;

      // 3️⃣ Add to shopping list
      const addResp = await fetch(
        `${upstreamBase}/api/stock/shoppinglist/add-product`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            product_id: productId,
            product_amount: amount,
            note,
            list_id: selectedList.id
          })
        }
      );

      if (!addResp.ok) {
        //const text = await addResp.text();
        return new Response("Failed to add item" /*+ text*/, { status: 502 });
      }

      // 4️⃣ Enriched confirmation
      return new Response(JSON.stringify({
        status: "added",
        list: { id: selectedList.id, name: selectedList.name },
        item: {
          product_id: productId,
          product_name: matches[0].name,
          amount,
          note
        }
      }), { headers: { "Content-Type": "application/json" }});
    }

    // --- ENRICHED SHOPPING LIST ---
    if (url.pathname === "/api/enriched/shopping_list" && req.method === "GET") {

      const cache = caches.default; 
      const requestedListId = url.searchParams.get("list_id");

      // 1️⃣ Fetch shopping lists
      const listsResp = await fetch(
        `${upstreamBase}/api/objects/shopping_lists`,
        { headers }
      );

      if (!listsResp.ok) {
        return new Response("Failed to fetch shopping lists", { status: 502 });
      }

      const lists = await listsResp.json();

      // 2️⃣ Decide which list to use
      let selectedList;

      if (requestedListId) {
        selectedList = lists.find(l => String(l.id) === requestedListId);
        if (!selectedList) {
          return new Response("Invalid shopping list ID", { status: 400 });
        }
      } else if (lists.length === 1) {
        selectedList = lists[0];
      } else if (lists.length > 1) {
        return new Response(JSON.stringify({
          error: "multiple_lists",
          lists: lists.map(l => ({ id: l.id, name: l.name }))
        }), { headers: { "Content-Type": "application/json" }});
      } else {
        return new Response(JSON.stringify({
          list: null,
          items: []
        }), { headers: { "Content-Type": "application/json" }});
      }

      // 3️⃣ Fetch shopping list items
      const itemsResp = await fetch(
        `${upstreamBase}/api/objects/shopping_list?list_id=${selectedList.id}`,
        { headers }
      );

      if (!itemsResp.ok) {
        return new Response("Failed to fetch shopping list items", { status: 502 });
      }

      let items = await itemsResp.json();

      // Safety limit
      items = items.slice(0, 50);

      // 4️⃣ Collect unique product IDs
      const productIds = [...new Set(
        items.map(i => i.product_id).filter(id => typeof id === "number")
      )];

      // 5️⃣ Fetch all products (for names)
      const productsCacheKey = new Request("https://cache.local/${CACHE_VERSION}/grocy/products");
      let productsRespCached = await cache.match(productsCacheKey);

      if (!productsRespCached) {
        const resp = await fetch(`${upstreamBase}/api/objects/products`, { headers });
        if (!resp.ok) {
          return new Response("Failed to fetch products", { status: 502 });
        }

        productsRespCached = new Response(await resp.text(), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=21600" }
        });

        await cache.put(productsCacheKey, productsRespCached.clone());
      }

      const products = await productsRespCached.json();
      const productMap = Object.fromEntries(products.map(p => [p.id, p.name]));

      // 6️⃣ Fetch stores (cached)
      const storesCacheKey = new Request("https://cache.local/${CACHE_VERSION}/grocy/stores");
      let storesRespCached = await cache.match(storesCacheKey);

      if (!storesRespCached) {
        const resp = await fetch(
          `${upstreamBase}/api/objects/shopping_locations`,
          { headers }
        );

        if (!resp.ok) {
          return new Response("Failed to fetch stores", { status: 502 });
        }

        storesRespCached = new Response(await resp.text(), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=21600" }
        });

        await cache.put(storesCacheKey, storesRespCached.clone());
      }

      const stores = await storesRespCached.json();
      const storeMap = Object.fromEntries(stores.map(s => [s.id, s.name]));

      // 7️⃣ Fetch last-purchase info per product (cached and parallel)
      const lastPurchaseMap = {};

      await Promise.all(productIds.map(async (productId) => {
        const cacheKey = new Request(`https://cache.local/${CACHE_VERSION}/grocy/stock-product/${productId}`);
        let cached = await cache.match(cacheKey);

        if (!cached) {
          const resp = await fetch(
            `${upstreamBase}/api/stock/products/${productId}`,
            { headers }
          );
          if (!resp.ok) return;

          cached = new Response(await resp.text(), {
            headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" }
          });

          await cache.put(cacheKey, cached.clone());
        }

        const details = await cached.json();

        lastPurchaseMap[productId] = {
          last_price: details.last_price ?? null, // ✅ CORRECT
          store_id: details.last_shopping_location_id ?? null,
        
          // Price axis (NOT purchase axis)
          price_qu_id: details.product?.qu_id_price
            ?? details.qu_id_price
            ?? null,
        
          price_qu_name: details.quantity_unit_price?.name ?? null,
        
          // Conversion factors (critical)
          price_to_stock_factor: details.qu_conversion_factor_price_to_stock ?? null,
          purchase_to_stock_factor: details.qu_conversion_factor_purchase_to_stock ?? null
        };lastPurchaseMap[productId] = {
          last_price: details.last_price ?? null, // ✅ CORRECT
          store_id: details.last_shopping_location_id ?? null,
        
          // Price axis (NOT purchase axis)
          price_qu_id: details.product?.qu_id_price
            ?? details.qu_id_price
            ?? null,
        
          price_qu_name: details.quantity_unit_price?.name ?? null,
        
          // Conversion factors (critical)
          price_to_stock_factor: details.qu_conversion_factor_price_to_stock ?? null,
          purchase_to_stock_factor: details.qu_conversion_factor_purchase_to_stock ?? null
        };                
      }));

      // 8️⃣ Enrich shopping list items
      const enrichedItems = items.map(i => {
        const last = lastPurchaseMap[i.product_id] ?? {};
      
        return {
          product_id: i.product_id,
          product_name: productMap[i.product_id] ?? "Unknown",
          amount: i.amount,
          note: i.note,
      
          // Store info
          last_store: last.store_id
            ? storeMap[last.store_id] ?? null
            : null,
      
          // Pricing primitives (THIS is the important part)
          pricing: {
            last_price_per_price_unit: last.last_price,
            price_unit: last.price_qu_name,
            price_qu_id: last.price_qu_id,
          
            amount: i.amount,
            shopping_list_qu_id: i.qu_id ?? null,
          
            // Conversion context (THIS is the gold)
            purchase_to_stock_factor: last.purchase_to_stock_factor,
            price_to_stock_factor: last.price_to_stock_factor
          }          
        };
      });
      
      // 9️⃣ Final response
      return new Response(JSON.stringify({
        list: { id: selectedList.id, name: selectedList.name },
        items: enrichedItems
      }), { headers: { "Content-Type": "application/json" }});
    }

    //
    //
    // --- ENRICHED STOCK ENDPOINT ---
    //
    //
    if (url.pathname === "/api/enriched/stock" && req.method === "GET") {
      
      // 1️⃣ Fetch stock (Grocy object API)
      const stockResp = await fetch(
        `${upstreamBase}/api/objects/stock`,
        { headers }
      );

      if (!stockResp.ok) {
        return new Response("Failed to fetch stock", { status: 502 });
      }

      let stock = await stockResp.json();

      // 2️⃣ Enforce Worker-side limit
      const MAX_ITEMS = 25;
      stock = stock.slice(0, MAX_ITEMS);

      // 3️⃣ Extract unique product IDs
      const productIds = [...new Set(
        stock
          .map(s => s.product_id)
          .filter(id => typeof id === "number")
      )];

      if (productIds.length === 0) {
        return new Response("[]", {
          headers: { "Content-Type": "application/json" }
        });
      }

      // 4️⃣ Fetch ALL products once (Worker-only, safe)
      const productsResp = await fetch(
        `${upstreamBase}/api/objects/products`,
        { headers }
      );

      if (!productsResp.ok) {
        return new Response("Failed to fetch products", { status: 502 });
      }

      const products = await productsResp.json();

      // Build product map
      const productMap = Object.fromEntries(
        products.map(p => [p.id, p.name])
      );

      // 5️⃣ Enrich + minimize response
      const enriched = stock.map(s => ({
        stock_id: s.id,
        product_id: s.product_id,
        product_name: productMap[s.product_id] ?? "Unknown",
        amount: s.amount,
        best_before_date: s.best_before_date
      }));

      return new Response(JSON.stringify(enriched), {
        headers: { "Content-Type": "application/json" }
      });
    }

    //
    //
    // --- ENRICHED PRODUCT SEARCH ---
    //
    //
    if (url.pathname === "/api/enriched/products/search" && req.method === "GET") {
      const q = url.searchParams.get("q");
      const limitParam = url.searchParams.get("limit");

      if (!q || !q.trim()) {
        return new Response(JSON.stringify({
          error: "missing_query"
        }), { headers: { "Content-Type": "application/json" }});
      }

      const limit = Math.min(
        Number(limitParam) || 5,
        10 // hard safety cap
      );

      const cache = caches.default;

      let products;
      try {
        products = await getCachedProducts(env, headers, cache, CACHE_VERSION);
      } catch (err) {
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

      return new Response(JSON.stringify({
        query: q,
        matches: matches.map(m => ({
          id: m.id,
          name: m.name,
          confidence: Math.min(1, m.score / 100)
        }))
      }), { headers: { "Content-Type": "application/json" }});
    }
    
    //
    //
    // Pass through API
    //
    //
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    const body = req.method === "GET" || req.method === "HEAD"
    ? undefined
    : await req.text();

    // 2. Build upstream request
    const upstreamUrl = upstreamBase + new URL(req.url).pathname;

    const upstreamReq = new Request(upstreamUrl, {
      method: req.method,
      body: body,
      headers: headers,
      redirect: "manual" // IMPORTANT: do not follow Access redirects
    });

    // 3. Fetch
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(upstreamReq, {
      signal: controller.signal
    });    

    // 4. Optional safety: block HTML redirects
    const ct = resp.headers.get("content-type") || "";
    if (resp.status === 302 ||
      (ct.includes("text/html") && !ct.includes("application/json"))
      ) {
      return new Response("Access Authentication failed", { status: 502 });
      /*return new Response(await resp.text(), {
        status: resp.status,
        headers: resp.headers
      });*/
    }

    return resp;
  }
};
