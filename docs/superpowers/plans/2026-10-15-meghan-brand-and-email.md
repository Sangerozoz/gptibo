# MEGHAN Brand and Email Implementation Plan

Implementation record for the local brand and email update.

**Goal:** Apply the supplied logo with 硅基生物 in Chinese and MEGHAN in English, and make outgoing email assets and links resolve to the configured site origin.

**Architecture:** Preserve partner-specific branding. The platform uses one supplied SVG mark for the web and a rasterized copy for email. Generated Worker email templates retain a site-origin token, resolved just before messages are sent or persisted. The Go mailer continues to use its existing origin-based brand function.

**Tech Stack:** React, TypeScript, React Email, Cloudflare Worker, Go, Sharp (existing dependency), Node test runner.

## Global Constraints

- Platform English name: `MEGHAN`.
- Platform Chinese name: `硅基生物`.
- Show only the name for the active language; the current email templates and administration UI are Chinese.
- Use `/Users/sanger/Desktop/logo.svg` as the source mark.
- Keep partner store names and logos independent from the platform brand.
- The local mail link origin is `http://127.0.0.1:8788`; production needs a configured HTTPS origin.
- Leave the 5sim supplier integration to a separate plan.

---

### Task 1: Email origin and identity

**Files:** `emails/brand.ts`, `scripts/build-emails.tsx`, `worker/email.ts`, `worker/platform.ts`, `worker/email-delivery.ts`, `worker/account_supplier/service.ts`, `worker/delivery_supplier/service.ts`, `.dev.vars.example`, `tests/email.test.ts`

**Interfaces:** `siteEmail(env, message)` accepts `{subject,html,text}` and returns the same fields with the generated site-origin token replaced by the validated `PUBLIC_SITE_ORIGIN`. Existing message builders retain their signatures.

- [x] Update `tests/email.test.ts` to assert 硅基生物 is rendered, the generated template has an origin token, and a configured `https://meghan.example.test` yields the correct image and `/admin` link in the Resend payload.
- [x] Run `node --test tests/email.test.ts` and observe the expected branding/origin assertion failure.
- [x] Change generated Worker templates to keep `__RECHARGE_SITE_ORIGIN__` and use `硅基生物` as the Chinese email sender name. Replace this token at the send or persistence boundary, with HTTPS required except loopback HTTP.
- [x] Configure local `PUBLIC_SITE_ORIGIN=http://127.0.0.1:8788` in the ignored `.dev.vars`; document the setting in `.dev.vars.example`.
- [x] Build templates with `tsc -p tsconfig.emails.json` and `node --import tsx scripts/build-emails.tsx`, then pass `node --test tests/email.test.ts`. The `tsx` CLI wrapper could not create its IPC socket in this sandbox.

### Task 2: Web and mail logo

**Files:** `public/logo.svg`, `public/favicon.svg`, `public/email-logo.png`, `src/components/brand.tsx`, `src/components/shop-brand.tsx`, `src/components/shop-brand.css`

**Interfaces:** `BrandMark` keeps its current React props and renders the supplied shape in the inherited text color; `ShopBrand` receives the platform name for the active locale and still uses partner identity when one exists.

- [x] Copy the supplied SVG to `public/logo.svg` and use its path in `BrandMark`.
- [x] Create a high contrast favicon and a 256 px PNG email mark from the SVG using the installed Sharp renderer.
- [x] Show 硅基生物 in the Chinese header and MEGHAN in the English header; keep partner branding unchanged.
- [x] Build and inspect the logo in the running site's dark view and as a standalone PNG.

### Task 3: Remaining platform copy

**Files:** `src/App.tsx`, `src/main.tsx`, `src/admin/Admin.tsx`, `src/partner/Partner.tsx`, related platform-only UI copy, `worker/payments/service.ts`, `worker/payments/alipay.ts`, `worker/invoices.ts`, `services/storefront/internal/mailer/brand.go`, related Go payment and invoice copy.

**Interfaces:** Chinese titles, payment subjects, exports and email subjects say 硅基生物; English storefront titles say MEGHAN. Stored partner-specific names remain untouched.

- [x] Replace platform-only GPTibo and Recharge AI copy without renaming module paths, database identifiers or upstream product names.
- [x] Update assertions that pin the former platform name and validate Worker mail branding. The Go mail branding test was updated but could not run because Go is not installed on this host.
- [x] Search tracked source for old platform strings and review every remaining match.

### Task 4: Verification and delivery

**Files:** changed files above.

- [x] Pass 394 Node tests, TypeScript checks, Vite build, and `git diff --check`; verify the admin login email payload contains the configured logo and link. Go tests remain unavailable because the Go toolchain is absent.
- [x] Check the running local site at `http://127.0.0.1:8788/` in both languages and `/admin` for the supplied mark and the language-appropriate title.
Repository delivery: commit the verified change on the current task branch and push it to the configured remote, per `AGENTS.md`.
