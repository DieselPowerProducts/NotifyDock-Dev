# Red Head backorder rollout

Production initial automation is **live**, authorized by Mike on September 24, 2026.

Production configuration saved September 24, 2026:

- `NOTIFY_DOCK_AUTOMATION_MODE=live`
- `NOTIFY_DOCK_AUTOMATION_SHOPS=fbgure-nn.myshopify.com`
- `NOTIFY_DOCK_AUTOMATION_START_AT=2026-09-24T21:40:39Z` (2:40:39 p.m. Pacific)
- Follow-up checks: 4 p.m. America/Los_Angeles, including daylight saving changes.
- `NOTIFY_DOCK_FOLLOWUP_ENABLED=true`; the temporary test-time override has been removed.

The explicit cutoff applies to manual composer autofill and follow-ups even while initial automation is off.
Older orders open with no automatic SKU selection; staff can still enter SKUs and dates manually.
Missing or invalid cutoff configuration cannot autofill historical orders.
An older order cannot enroll through a manual email, and old pending items and
queued follow-up batches cannot send. Manual email sending remains available.

Initial automation uses authenticated Shopify `orders/create` and `orders/updated`
webhooks. Adding the Backorder tag triggers processing of that one order; there is
no scheduled order search or queue-wide scan. The former scan endpoint returns 410.
Off mode stops webhook processing. The original locked cutoff is retained.
Initial selection and enqueue both verify Shopify's order creation timestamp;
adding a Backorder tag or Red Head item to an older order does not make it eligible.

The job is saved before sending. A per-order database lease prevents concurrent
webhook deliveries from sending together; accepted jobs do not reopen. Slow or
failed processing returns HTTP 503 for Shopify to retry, while Vercel `waitUntil`
keeps the in-flight work alive within the function lifetime. Retries retain the
same saved Klaviyo payload and event ID. There is no background five-minute retry
timer. Shopify retries are finite; exhausted failures remain recorded for review.

One GitHub Actions schedule runs daily at `0 16 * * *`, timezone
`America/Los_Angeles`, calling the authenticated follow-up endpoint. There are no
Vercel cron entries. GitHub may delay starting scheduled jobs; the endpoint allows
the 4 p.m. hour and refuses to check products outside it. See backorder-followups.md.

Migration `20260924222000_lock_backorder_cutoff` provisions the production cutoff
in `NotifyDockAutomationPolicy`. The app has no creation or update path for this
policy, and a database trigger rejects updates/deletes. Missing configuration,
missing policy, an environment/database mismatch or a database read failure stops
automatic processing. Both initial processing and follow-ups require this policy,
even when initial automation is off. Restoring a deleted policy requires an explicit
migration, not a runtime setting.

All automatic provider calls go through `sendAutomaticBackorderEvent`, which checks
the policy again, verifies the appropriate enable flag and payload order ID, reloads
the actual order from Shopify, and rejects old, missing, invalid-date or cancelled
orders. Queued and retry payloads cannot bypass this gate. Manual Send/Resend retain
their existing authenticated routes. If the policy is unavailable, manual sending
does not enroll follow-ups and composer autofill stays blank.

Only exact-vendor `Red-Head Steering Gears Inc.` items with Backorder or Built to
Order availability qualify. Initial sends save email history and enroll only items
that actually received generic messaging. Confirmed items are excluded from that
follow-up. In Stock/fulfilled/cancelled items stop without a follow-up email.
