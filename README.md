# Grocy Butler – Enriched Grocy API via Cloudflare Worker

Grocy Butler is a Cloudflare Worker that exposes a **GPT-friendly, enriched API** in front of a private Grocy instance.

It acts as a secure façade that:

* keeps Grocy completely private
* enforces strict access controls
* adds fuzzy product resolution
* supports partial success for bulk operations
* provides predictable, human-readable responses for GPT usage

Grocy itself is not modified.

---

## High-Level Architecture

```
GPT / Client
|
|  Authorization: Bearer <TOKEN>
v
grocy-butler.example.com        (Cloudflare Worker – public)
|
|  CF Access Service Token + Grocy API Key
v
grocy-butler-internal.example.com   (Grocy – private)
```

Key points:

* The Grocy backend is **never publicly accessible**
* Only the Cloudflare Worker can reach Grocy
* GPT or other clients only talk to the Worker
* Secrets for Grocy and Cloudflare Access are never exposed to GPT

---

## Repository Contents

This repository intentionally contains only two files:

* `worker.js` – the Cloudflare Worker implementation
* `schema.yaml` – OpenAPI 3.1 schema used by GPT

There is no backend code here. Grocy remains a separate, private service.

---

## Security Model

### Grocy Backend

* Hosted on a **private Cloudflare Access–protected hostname**, for example:
  `grocy-butler-internal.example.com`
* Access is restricted to a **Cloudflare Access Service Token**
* Requires a valid Grocy API key
* No browser access
* No public network access

### Cloudflare Worker (Grocy Butler)

* Publicly reachable
* Protected by a **static Bearer token**
* All requests must include:
  `Authorization: Bearer <OPENAI_BEARER_TOKEN>`
* Injects Cloudflare Access headers and Grocy API key when proxying requests
* Enforces method allow-lists, limits, and validation

### GPT / Client

* Only knows:

  * Worker URL
  * Bearer token
  * OpenAPI schema
* Never sees:

  * Grocy API key
  * Cloudflare Access credentials
  * Internal Grocy hostname

---

## Cloudflare Setup

### 1. Grocy Backend

1. Create a private hostname for Grocy, for example:
   `grocy-butler-internal.example.com`
2. Protect it using **Cloudflare Access**
3. Create a **Service Token**
4. Configure the Access policy to allow **only that Service Token**

### 2. Cloudflare Worker

1. Deploy `worker.js` as a Cloudflare Worker
2. Bind it to a public hostname, for example:
   `grocy-butler.example.com`
3. Configure the required environment variables

---

## Worker Environment Variables

### Required

```
UPSTREAM_BASE=https://grocy-butler-internal.example.com
GROCY_API_KEY=<Grocy API key>

CF_ACCESS_CLIENT_ID=<Cloudflare service token ID>
CF_ACCESS_CLIENT_SECRET=<Cloudflare service token secret>

OPENAI_BEARER_TOKEN=<Bearer token for GPT or client>
```

### Optional / Behavioural

```
CACHE_VERSION=v1
CACHE_DURATION=21600

DEFAULT_LOCATION_NAME=Fridge

DEFAULT_STOCK_UNIT=Piece
DEFAULT_PURCHASE_UNIT=Piece
DEFAULT_CONSUME_UNIT=Piece
DEFAULT_PRICE_UNIT=Piece
```

---

## OpenAPI Schema (GPT Setup)

The file `schema.yaml` is designed specifically for GPT usage.

It documents:

* fuzzy product resolution
* ambiguity handling
* partial success semantics
* silent truncation limits
* enrichment behaviour

When importing the schema into GPT:

* Update the `servers:` URL to match your Worker hostname
* Do not expose the internal Grocy hostname

---

## Testing with curl

### Test Grocy Backend Directly (Internal)

This verifies Cloudflare Access and Grocy itself:

```
curl https://grocy-butler-internal.example.com/api/system/info \
  -H "CF-Access-Client-Id: <ID>" \
  -H "CF-Access-Client-Secret: <SECRET>" \
  -H "GROCY-API-KEY: <GROCY_KEY>"
```

This request should succeed.
If it fails, fix this before testing the Worker.

### Test the Worker (Public)

```
curl https://grocy-butler.example.com/api/enriched/stock \
  -H "Authorization: Bearer <OPENAI_BEARER_TOKEN>"
```

This confirms:

* Worker deployment
* Bearer authentication
* End-to-end proxying
* Enrichment and caching

---

## Behavioural Guarantees

The Worker enforces the following rules:

* **Fuzzy product resolution**

  * Exact matches are preferred
  * Ambiguity returns a structured error
  * The client must request clarification

* **Partial success for bulk operations**

  * Each line is processed independently
  * Failures do not abort the entire request

* **Hard limits**

  * Bulk add capped at 25 items
  * Stock and list results may be silently truncated

* **Best-effort enrichment**

  * Pricing and unit data is informational only
  * Do not assume arithmetic correctness

* **Predictable JSON responses**

  * Errors are structured
  * No HTML, redirects, or Grocy internals leak through

---

## Design Philosophy

This project is intentionally conservative and defensive.

The goal is not to expose Grocy directly, but to make it **safe, predictable, and usable by GPT**.

If something is ambiguous:

* the Worker stops
* the client must ask the user
* no guessing, no retries

---

## Notes

If something breaks:

1. Check Cloudflare Access first
2. Verify Worker environment variables
3. Confirm Grocy API health

The Worker is designed to be boring in production.

That is intentional.
