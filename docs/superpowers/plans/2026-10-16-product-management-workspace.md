# Product Management Workspace Implementation Plan

> **For agentic workers:** Execute tasks in order with a red-green test cycle. Keep product and plan persistence separate while joining their administration workflow.

**Goal:** Manage each product's information and plans under one 商品管理 menu entry.

**Architecture:** Keep the existing APIs. Add a product-scoped plan section beside the product editor, move plan editing into a focused component, and place supplier connectivity in 服务接入.

**Tech Stack:** React, TypeScript, Node test runner, CSS, Cloudflare Worker APIs already present.

## Global Constraints

- Keep existing plan version checks, validation, and audit endpoint behavior.
- Do not create new products or plans through this interface; the plan Add action explains the missing checkout and fulfillment wiring.
- Preserve Gmail supplier status access through 服务接入.

---

### Task 1: Navigation and product-scoped plan selection

**Files:** `tests/admin-navigation.test.ts`, `tests/product-plans.test.ts`, `src/admin/navigation.ts`, `src/admin/product-plans.ts`

- [x] Change the navigation expectation to omit `plans`, then run `node --test tests/admin-navigation.test.ts` and confirm the expected failure.
- [x] Add tests for selecting only plans whose `product_id` matches a product and only audit rows whose `target_id` matches those plans; run and confirm failure.
- [x] Remove the extra menu item and implement pure selectors with the tested signatures.
- [x] Run both focused tests and confirm they pass.

### Task 2: Product detail and plan editing

**Files:** `src/admin/ProductPlans.tsx`, `src/admin/DirectStorePages.tsx`, `src/admin/direct-store.css`, `src/admin/Admin.tsx`, `src/admin/XGiftPanel.tsx`

- [x] Move the existing plan editor unchanged in behavior to `ProductPlans.tsx`; scope its plan table and audit rows to the expanded product.
- [x] Initially add 商品信息 and 套餐与售价 views within each expanded product. Show an empty state if no plans exist and clarify that checkout needs both an active product and active plan.
- [x] Remove `PlansPage`, its navigation route, and the cross-page edit button. Put `GmailSupplierPanel` in 服务接入 and update the X gift guidance.
- [x] Run `npm run build`, `npm run lint`, focused tests, then `npm test`; inspect results and fix any concrete failure.
- [x] Review `git diff --check`, commit the verified change, and push the task branch as required by `AGENTS.md`.

### Task 3: Refine product and plan editing interaction

**Files:** `src/admin/DirectStorePages.tsx`, `src/admin/ProductPlans.tsx`, `src/admin/direct-store.css`, `src/admin/product-plans.ts`, `tests/product-plans.test.ts`

- [x] Move product information editing into a dialog opened by a separate “编辑” button; use an icon button to expand or collapse plans directly.
- [x] Add per-plan price input and sale status checkbox with a row-level Save action, retaining version checks and an audit note. Keep advanced plan settings in a separate settings dialog.
- [x] Place “新增” next to the 套餐与售价 heading and explain why a new saleable plan needs front-end, payment, and fulfillment integration.
- [x] Add focused tests for price validation and audit notes; run red and green phases.
- [x] Run final build, lint, and full tests; verify the browser interaction and review `git diff --check`.
- [ ] Commit and push the verified change.
