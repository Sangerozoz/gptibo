# Plan Label and Table Refinement Implementation Plan

> **For agentic workers:** Use the test-driven-development workflow for behavior changes. Execute this plan inline in the current authorized task.

**Goal:** Make plan labels editable in the admin plan table and visible in the storefront while refining the table layout.

**Architecture:** Store labels in `catalog_plans`, update them through the existing versioned admin plan endpoint, and return them in both direct and partner catalog responses. The React admin keeps one row-level save action for price, availability, and label; the storefront reads the label from its catalog offer.

**Tech Stack:** React, TypeScript, Cloudflare Worker, D1/SQLite migrations, Node test runner, CSS.

## Global Constraints

- Preserve Plus's current “日常之选” label during migration.
- Empty label means no storefront label; length limit is 20 characters.
- Keep existing price, status, and version checks; no plan creation or checkout changes.
- Do not submit real purchases or change sale status during browser verification.

---

### Task 1: Persist and serve labels

**Files:** `migrations/0046_plan_display_label.sql`, `worker/commerce.ts`, `worker/partners.ts`, `src/lib/api.ts`, `tests/commerce.test.ts`.

- [x] Add an integration test: Plus defaults to “日常之选”; admin can update and clear it; unauthenticated, invalid, and stale updates fail; direct and partner catalogs reflect the result.
- [x] Run the focused test to confirm failure.
- [x] Add the migration, API validation/update, and partner catalog selection.
- [x] Run the focused test to confirm success.

### Task 2: Edit and display labels

**Files:** `src/admin/ProductPlans.tsx`, `src/admin/product-plans.ts`, `src/admin/direct-store.css`, `src/App.tsx`, `src/components/purchase-workspace.tsx`, `src/components/recharge-site-preview.tsx`, `src/lib/catalog-display.ts`, `tests/product-plans.test.ts`, `tests/catalog-display.test.ts`.

- [x] Extend the audit-note test to cover changing and clearing a label; confirm failure, then implement the helper.
- [x] Add a label input to each row and include it in the existing Save action. Remove “适用范围,” align the price unit on the input row, and use a pencil edit icon.
- [x] Pass the catalog label into both storefront and preview plan props. Preserve the original Plus label only for legacy catalog responses that omit the field; a saved empty value hides it.
- [x] Build, lint, and run the full test suite.

### Task 3: Verify and deliver

- [x] Apply the new migration to the local D1 instance used by port 8788 and verify admin/storefront UI without saving live catalog changes.
- [x] Inspect the diff and run `git diff --check`.
- [x] Commit the verified changes and push the configured branch as required by `AGENTS.md`.
