# Final webhook and creation-cutoff audit — September 24, 2026

Audited application commit: `456170e`, compared with the previously hardened
cutoff implementation at `714ecd2`. The audit added regression tests and this
report; no application behavior was changed. Nothing was pushed or deployed.

## Result

No automatic-send path was found that bypasses the creation cutoff. The core
timestamp parser, selector, locked-policy validator, final send guard, initial
worker, and immutable-policy migration are unchanged from the hardened version.

The boundary is **2026-09-24T21:40:39Z**, or **September 24, 2026 at 2:40:39 p.m.
Pacific**. Eligibility is inclusive: the exact boundary is allowed; one millisecond
before it is rejected. An order's original Shopify `createdAt` is authoritative.
`updated_at`, tag additions, product additions, and `processedAt` are not substitutes.

A read-only production database transaction confirmed that exact policy value,
the applied cutoff migration, and the enabled `notify_dock_immutable_cutoff`
BEFORE UPDATE OR DELETE trigger. The production app also has an offline session.
No production order was changed and no real email was sent for this audit.

## Both tag timings

`shopify.app.toml:16` subscribes to `orders/create` and `orders/updated`.
`app/routes/webhooks.orders.updated.jsx:6` authenticates both topics.

1. Created with Backorder: the creation event processes that order immediately.
2. Created without Backorder: no job is created. A later tagged update processes
   that order without requiring someone to open or refresh Notify Dock.

Processing is conditional on the cutoff, exact Red Head vendor, outstanding
eligible items, valid customer email, and the existing availability rules.
Repeated and reordered events do not reopen accepted jobs. Concurrent deliveries
are serialized by the per-order lease; uncertain provider retries reuse the saved
Klaviyo event ID and payload. Other queued orders are not scanned or drained.

## Cutoff enforcement

| Stage | Enforcement |
| --- | --- |
| Policy loading | `app/backorder-policy.server.js:6` requires a valid configured cutoff, allowed shop, persisted policy, and exact environment/database agreement. Missing/invalid/mismatched settings and database errors stop processing. |
| Webhook intake | `app/backorder-automation.server.js:19` checks original `created_at` before creating or reopening a job. |
| Initial selection | `app/backorder-automation-worker.js:9` reloads Shopify; `app/backorder-automation.js:85` rejects old/unverifiable creation timestamps before checking tags, products, status, or recipient. |
| Manual-email enrollment | `app/backorder-followup.server.js:21` rejects old orders before recording generic items for automatic follow-up. Manually sending an old-order email does not opt it into automation. |
| Follow-up records and batches | `app/backorder-followup.server.js:77` and `:110` check the actual order age for tracked items and prepared/retrying batches. |
| Final provider request | `app/backorder-automatic-send.server.js:9` reloads the policy, validates payload/order identity and enable flags, fetches Shopify again, and checks the actual creation timestamp immediately before Klaviyo. Both initial and follow-up senders use it. |

The other provider call sites are the authenticated, explicitly invoked manual
Send and Resend actions. Preview, autofill, and history refresh do not send email.

## Verification

All 23 offline test groups passed. The webhook regression test was expanded to
cover both tag timings, a missing customer followed by a customer update,
duplicate/reordered events, and an additional 18 combinations of older timestamps
with tag/product/availability/date/message/customer/processed-time edits. These
older events created no jobs, performed no order lookups, and sent no emails.

Another regression test lets initial selection succeed, then returns an older
order from the final Shopify lookup. The already saved send payload is blocked
before any provider call.

An independent read-only audit also exercised 96 old-order worker cases (12
mutations × four queue states × saved/unsaved payload), seven old/invalid manual
enrollment cases, and 2,001 millisecond boundary cases. Excluded cases produced
zero provider calls. The installed Shopify SDK was separately exercised with
locally signed creation/update requests; both topics normalized correctly and an
invalid signature was rejected.

Run the retained checks with:

```powershell
node --test scripts/verify-followup-schedule.mjs scripts/verify-backorder-webhooks.mjs scripts/verify-backorder-followups.mjs scripts/verify-backorder-policy.mjs scripts/verify-initial-rollout.mjs scripts/verify-backorder-prefill.mjs
```

## Delivery limits

The normal tag-triggered flow is supported, but webhook delivery is not an
unconditional guarantee. Shopify retries failed deliveries up to eight times over
four hours. Missing or exhausted deliveries have no automatic recovery scan in
this version. A prolonged outage can leave an eligible email unsent; it cannot
relax the creation cutoff. See [Shopify's delivery guidance](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

An initial validation hold, such as missing customer email or an invalid nonblank
date, is recorded as `waiting`. A later order update resumes it. Changing only a
product metafield does not emit an order event and does not itself resume a held
initial notice. Blank dates/messages are supported generic notices, and their
successfully recorded items remain eligible for the separate daily follow-up.

The follow-up scheduler is set to 4 p.m. America/Los_Angeles. Scheduler delays are
possible; the endpoint accepts the 4 p.m. hour only. It checks recorded generic
items, never discovers historical orders. `waitUntil` keeps initial processing
alive within the Vercel function lifetime; it does not guarantee unlimited runtime.

No audit can protect against future code changes or deliberate administrative
replacement of database/schema protections. The findings concern the reviewed
application paths and the verified policy. A real create/tag/email test of the
new webhook deployment remains pending the user's deployment authorization.
