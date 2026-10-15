# 5SIM API Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-only 5SIM adapter and a read-only admin connection check without enabling the Codex SMS product.

**Architecture:** Keep upstream protocol and validation in `worker/fivesim/client.ts`. Use existing admin authentication in `worker/commerce.ts` for a status route; surface configuration and the manual check in the service integrations page.

**Tech Stack:** TypeScript, Cloudflare Worker, React, Node test runner.

## Global Constraints

- Never expose `FIVESIM_API_TOKEN` to the browser, logs, or API responses.
- Never call a purchase endpoint from an HTTP route in this phase.
- Do not retry a purchase automatically after a network failure.
- Do not enable `codex-sms-once` or change its demo order behavior.

---

### Task 1: Protocol adapter

**Files:** Create `worker/fivesim/client.ts`, `tests/fivesim.test.ts`; modify `worker/platform.ts`, `.dev.vars.example`.

**Interfaces:** Export `fivesimConfigured(env)`, `fivesimProfile(env)`, `fivesimPrices(env,country,product)`, `fivesimBuyActivation(env,request)`, `fivesimCheck(env,id)`, `fivesimFinish(env,id)`, and `fivesimCancel(env,id)`.

- [x] Write mock-fetch tests for authorization, exact official paths, parsed profile/order data, parameter validation, upstream failure, and lost purchase response.
- [x] Run `node --test tests/fivesim.test.ts`; verify expected failure before implementing.
- [x] Implement the smallest adapter satisfying those tests, with fixed HTTPS host, response size limit, timeout, and no retry.
- [x] Run focused tests and review error messages for secret leakage.

### Task 2: Admin status and presentation

**Files:** Modify `worker/commerce.ts`, `worker/rate-limit.ts`, `src/admin/Admin.tsx`, `tests/commerce.test.ts`, `README.md`.

**Interfaces:** `GET /api/admin/fivesim/status` returns `{configured:false,connected:false}` without a token or `{configured:true,connected:true,balance:number}` after a successful profile read. Admin overview reports `integrations.fivesim` as a boolean.

- [x] Write tests that reject unauthenticated requests, avoid upstream calls without a token, and return only balance with a configured mock token.
- [x] Run focused tests and verify expected failure.
- [x] Add the authenticated route, rate limit it, add the configuration flag, and display a manual detection button in “服务接入”.
- [x] Document private token setup and the deferred product/Go backend scope.
- [x] Run focused tests, all tests, build, lint, `git diff --check`, inspect diff, commit, and push.

## Self-review

The plan covers the approved server adapter, admin-only read, UI state, configuration, no purchase route, and validation. The product/order integration stays outside this phase.
