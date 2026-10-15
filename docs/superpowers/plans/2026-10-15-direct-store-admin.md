# Direct Store Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner operate the public storefront and its brand, categories, and existing products from `/admin` while keeping the partner system dormant and intact.

**Architecture:** Worker/D1 owns a separate direct-store configuration keyed by the existing immutable product IDs. `/api/catalog` supplies public display metadata; `/api/admin/direct-store/*` handles versioned writes. The React storefront applies metadata over its current product components, and the checkout path enforces product visibility. The partner feature flag is off in the local Worker config.

**Tech Stack:** React 19, TypeScript, Cloudflare Worker, D1, SQLite-backed Node tests, Vite.

## Global Constraints

- Keep the partner tables, routes, and fulfillment logic; do not run direct orders through a partner record.
- Only existing product IDs may be edited in phase one; adding products or fulfillment types is outside this plan.
- Chinese defaults to `硅基生物`, English defaults to `MEGHAN`, and blank English falls back to Chinese.
- A disabled category disappears from filters but leaves its products in All Products.
- A hidden product rejects new direct checkout even when its plan remains enabled; historical orders remain accessible.
- Current acceptance targets Worker/D1 at port 8788. Go/PostgreSQL parity is required before selecting Go for production.
- The normal `tsx` CLI cannot create its IPC socket in this sandbox. Use `node --import tsx` for email generation and `node --test` for tests.

---

### Task 1: Direct-store data and public read contract

**Files:** Create `migrations/0044_direct_store.sql`, `shared/direct-store.ts`, `worker/direct-store.ts`, `tests/direct-store.test.ts`; modify `worker/commerce.ts`.

**Interfaces:** `directStore(env)` returns `{site,categories,products}`; `publicDirectStore(env)` removes versions and private fields. Products are keyed by the IDs in `shared/product-order.ts`.

- [ ] **Step 1: Write a failing test** in `tests/direct-store.test.ts` asserting `/api/catalog` returns default `site`, four active categories, and existing product metadata for a direct shop while a partner catalog keeps its own data.
- [ ] **Step 2: Verify red** with `node --test tests/direct-store.test.ts`; expect missing `site`.
- [ ] **Step 3: Add migration and read implementation**. Use default rows for all current product IDs and localized names, with immutable IDs and integer versions. `commerce.ts` adds direct metadata only to the platform catalog.
- [ ] **Step 4: Verify green** with `node --test tests/direct-store.test.ts` and `node --test tests/catalog.test.ts`.
- [ ] **Step 5: Commit** `git add migrations/0044_direct_store.sql shared/direct-store.ts worker/direct-store.ts worker/commerce.ts tests/direct-store.test.ts && git commit -m "feat: add direct storefront catalog settings"`.

### Task 2: Versioned administration and checkout guard

**Files:** Modify `worker/direct-store.ts`, `worker/commerce.ts`, `tests/direct-store.test.ts`.

**Interfaces:** `/api/admin/direct-store/site`, `/categories`, `/categories/:id`, `/products`, `/products/:id`, `/product-order` use existing administrator authentication. `POST` bodies include `version`; version mismatch returns HTTP 409. `isDirectProductListed(env,id)` guards new direct orders.

- [ ] **Step 1: Add failing tests** for missing admin session, cross-origin write, invalid category references, editing localized site/product copy, ordering, category deactivation, product hide/relist, stale version, and direct checkout blocked for hidden products.
- [ ] **Step 2: Verify red** with `node --test tests/direct-store.test.ts`; expect absent routes or unblocked checkout.
- [ ] **Step 3: Add focused route handlers** with bounded fields, transactional version checks, audit entries, and a checkout guard before the order insert. Existing partner checkout remains subject to partner visibility only.
- [ ] **Step 4: Verify green** with `node --test tests/direct-store.test.ts tests/commerce.test.ts tests/product-order.test.ts`.
- [ ] **Step 5: Commit** `git add worker/direct-store.ts worker/commerce.ts tests/direct-store.test.ts && git commit -m "feat: manage direct store and enforce listings"`.

### Task 3: Image upload and delivery

**Files:** Modify `migrations/0044_direct_store.sql`, `worker/direct-store.ts`, `worker/index.ts`, `worker/platform.ts`, `tests/direct-store.test.ts`; create `src/lib/prepare-product-image.ts`.

**Interfaces:** `POST /api/admin/direct-store/media` accepts a bounded PNG/JPEG data URL and returns an immutable media ID and URL; `GET /api/direct-media/:id` serves validated bytes with content type and cache headers. Admin saves the returned media ID in site/product settings.

- [ ] **Step 1: Add failing tests** for valid media, unauthenticated upload, malformed MIME/data, oversized payload, unknown media, and catalog returning a URL rather than image bytes.
- [ ] **Step 2: Verify red** with `node --test tests/direct-store.test.ts`.
- [ ] **Step 3: Implement bounded media persistence and serving** with byte-signature checks, dimension and content limits, client resizing, and no mutation of saved settings on upload failure.
- [ ] **Step 4: Verify green** with `node --test tests/direct-store.test.ts` and TypeScript checks.
- [ ] **Step 5: Commit** `git add migrations/0044_direct_store.sql worker/direct-store.ts worker/index.ts worker/platform.ts src/lib/prepare-product-image.ts tests/direct-store.test.ts && git commit -m "feat: upload direct storefront images"`.

### Task 4: Public storefront metadata

**Files:** Modify `src/lib/use-store.ts`, `src/App.tsx`, `src/components/product-catalog.tsx`, `src/components/shop-brand.tsx`, `src/styles/storefront-home.css`; create `src/lib/direct-store-display.ts`, `tests/direct-store-display.test.ts`.

**Interfaces:** `displayName(site,locale)`, `displayProduct(product,locale)` resolve locale fallback. The catalog uses server-provided categories, order, visibility, copy and optional image for the direct shop; partner storefront retains its current behavior.

- [ ] **Step 1: Add failing display tests** for Chinese/English fallback, hidden products, disabled category behavior, and metadata overlays without changing immutable product IDs.
- [ ] **Step 2: Verify red** with `node --test tests/direct-store-display.test.ts`.
- [ ] **Step 3: Wire metadata into `useStore`, `App`, and `ProductCatalog`**; retain existing art without an image override, keep detail and mobile purchase copy in sync, and keep partner storefront isolated.
- [ ] **Step 4: Verify green** with focused tests, `tsc -b`, and Vite build.
- [ ] **Step 5: Commit** `git add src/lib/use-store.ts src/lib/direct-store-display.ts src/App.tsx src/components/product-catalog.tsx src/components/shop-brand.tsx src/styles/storefront-home.css tests/direct-store-display.test.ts && git commit -m "feat: render owner-managed storefront"`.

### Task 5: Owner administration UI and dormant partner mode

**Files:** Create `src/admin/DirectStorePages.tsx`, `src/admin/direct-store.css`; modify `src/admin/Admin.tsx`, `src/Root.tsx`, `worker/commerce.ts`, `worker/platform.ts`, `wrangler.jsonc`, `.dev.vars.example`, `tests/direct-store.test.ts`.

**Interfaces:** Admin navigation gains `店铺设置`, `分类管理`, `商品管理`; existing `商品与套餐` remains the price editor. `PARTNER_MODE_ENABLED=false` in Worker config hides partner-only UI and rejects partner login/store and new provisioning; setting it to `true` restores current behavior.

- [ ] **Step 1: Add failing tests** for partner-disabled catalog/login/provision behavior, preserved historical direct orders, and re-enabled partner behavior.
- [ ] **Step 2: Verify red** with `node --test tests/direct-store.test.ts`.
- [ ] **Step 3: Implement forms and feature switch**. Forms show validation, save state and conflict errors; sorting and visibility require explicit save. Keep partner code and schema.
- [ ] **Step 4: Verify green** with focused tests, lint and build. Preview `/` and `/admin` at desktop and narrow widths.
- [ ] **Step 5: Commit** `git add src/admin/DirectStorePages.tsx src/admin/direct-store.css src/admin/Admin.tsx src/Root.tsx worker/commerce.ts worker/platform.ts wrangler.jsonc .dev.vars.example tests/direct-store.test.ts && git commit -m "feat: operate direct store from admin"`.

### Task 6: Email identity and final verification

**Files:** Modify `worker/email.ts`, `emails/brand.ts`, `scripts/build-emails.tsx`, `tests/email.test.ts`, `README.md`; adjust generated email file via the repository generator.

**Interfaces:** Sending platform email resolves current direct-site name and logo URL; sender mailbox remains `RESEND_FROM`. Partner email brand stays partner-scoped when partner mode is enabled.

- [ ] **Step 1: Add failing email tests** for edited brand name/logo and unchanged delivery links and sender address.
- [ ] **Step 2: Verify red** with `node --test tests/email.test.ts`.
- [ ] **Step 3: Resolve platform email markers at send time** from direct-site settings, escaping text and leaving historical already-sent messages untouched.
- [ ] **Step 4: Verify green** with all Node tests via `tsc -p tsconfig.emails.json && node --import tsx scripts/build-emails.tsx && node --test tests/*.test.ts`, `npm run lint`, `npm run build` with the equivalent IPC-safe generator path if necessary, `git diff --check`, and a local browser pass.
- [ ] **Step 5: Commit and push** the verified changes, then report the commit IDs, tests, live local URL, and the Go backend limitation.
