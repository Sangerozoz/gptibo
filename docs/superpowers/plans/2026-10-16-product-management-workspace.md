# Product Management Workspace Implementation Plan

> **For agentic workers:** Execute tasks in order with a red-green test cycle. Keep product and plan persistence separate while joining their administration workflow.

**Goal:** Manage each product's information and plans under one 商品管理 menu entry.

**Architecture:** Keep the existing APIs. Add a product-scoped plan section beside the product editor, move plan editing into a focused component, and place supplier connectivity in 服务接入.

**Tech Stack:** React, TypeScript, Node test runner, CSS, Cloudflare Worker APIs already present.

## Global Constraints

- Keep existing plan version checks, validation, and audit endpoint behavior.
- Do not create new products or plans through this interface.
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
- [x] Add 商品信息 and 套餐与售价 views within each expanded product. Show an empty state if no plans exist and clarify that checkout needs both an active product and active plan.
- [x] Remove `PlansPage`, its navigation route, and the cross-page edit button. Put `GmailSupplierPanel` in 服务接入 and update the X gift guidance.
- [x] Run `npm run build`, `npm run lint`, focused tests, then `npm test`; inspect results and fix any concrete failure.
- [x] Review `git diff --check`, commit the verified change, and push the task branch as required by `AGENTS.md`.
