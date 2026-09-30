# All-vendor backorder automation

Automatic initial notices now include every vendor. Orders still need the Backorder tag, eligible unfulfilled variants, a usable recipient and valid availability data. Existing recorded backorder/shipping-delay emails suppress another initial notice. Shopify order-created/updated webhooks process only that order; there is no historical scan or queue-wide drain.

New initial notices require orders created on or after September 30, 2026 at 3:30 p.m. Pacific (`2026-09-30T22:30:00Z`). The new database `initialStartAt` and production `NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT` setting must match. The existing `startAt`/`NOTIFY_DOCK_AUTOMATION_START_AT` remains unchanged for already-enrolled follow-ups and manual prefill. Missing or mismatched policy fails closed before a new automatic initial send, including retries.

The initial email includes eligible Backorder and Built to Order items with known and unknown estimates. Only included generic items without an estimate are enrolled. At the existing daily 4 p.m. Pacific check, newly dated Backorder items or Built to Order items with a new message are emailed together when they belong to the same initial email. Each item completes after one accepted follow-up. Other undated items keep waiting and can receive their own update on later days. Cancelled, fulfilled, removed or reclassified items stop tracking without an email. There is no order-wide stop while other eligible items remain pending.

Follow-ups retain their original recipient, frozen payload and stable event ID across uncertain provider retries. Immediately before sending, Shopify is read again and the tracked items/estimates must still match. A changed queued batch is held for manual review; it is never silently rewritten into a new provider event.

The additive migration preserves the original immutable cutoff and restores its database trigger in the same transaction. It changes no email history or tracking records. It was exercised in the isolated notifydock_dev schema before production rollout.

Validation covers five vendors receiving dates on five different days, grouping same-day updates, excluding previously dated items, changes to In Stock, no restart after completion, retries, the exact UTC/Pacific cutoff boundary, and preservation of pre-rollout Red Head follow-ups. All provider calls in automated tests are mocked.
