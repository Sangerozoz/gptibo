# Admin Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat owner admin menu with task-based groups while preserving all routes and partner-mode visibility.

**Architecture:** Keep navigation data and the partner-mode filter in a small pure module. Render groups in the existing sidebar; adjust desktop and mobile CSS without changing page components or APIs.

**Tech Stack:** React 19, TypeScript, CSS, Node test runner.

## Global Constraints

- Preserve all 17 existing views and the overview default.
- Hide the entire proxy-business group when partner mode is disabled.
- Use the approved Chinese labels and the name “套餐与定价”.
- Product creation is outside this change.

---

### Task 1: Navigation data and behavior

**Files:**
- Create: `src/admin/navigation.ts`
- Create: `tests/admin-navigation.test.ts`
- Modify: `src/admin/Admin.tsx`

**Interfaces:**
- Produces: `getAdminNavigation(partnerModeEnabled: boolean)` returning ordered sections with `id`, `label`, and `items` (`id`, `label`).
- Consumes: Existing `selectedView`, `setView`, and `session.partnerModeEnabled` state in `Admin.tsx`.

- [ ] Write tests asserting ordered menu groups, unique view IDs, overview first, and 14 visible views with no empty agent section when partner mode is off.
- [ ] Run `node --test tests/admin-navigation.test.ts` and confirm it fails because the module is absent.
- [ ] Add the pure menu model and render the grouped items in the existing sidebar, keeping `aria-current` and page labels.
- [ ] Run the targeted test and confirm it passes.

### Task 2: Presentation and copy

**Files:**
- Modify: `src/admin/admin.css`
- Modify: `src/admin/DirectStorePages.tsx`
- Modify: `src/admin/XGiftPanel.tsx`

**Interfaces:**
- Consumes: `.admin-nav-group`, `.admin-nav-group-label`, `.admin-nav-group-items` emitted by `Admin.tsx`.

- [ ] Style section headings and spacing on desktop; preserve mobile horizontal scrolling with each group labeled.
- [ ] Change existing “商品与套餐” references to “套餐与定价” and clarify that new products require a checkout and fulfillment path.
- [ ] Run `npm run build`, `npm run lint`, the targeted test, and `git diff --check`.
- [ ] Review the diff, commit with an accurate summary, and push the completed branch to `origin` per `AGENTS.md`.

## Self-review

The two tasks cover menu membership, partner visibility, naming, desktop and mobile presentation, and product limitation copy. No placeholders or new product-creation behavior are included.
