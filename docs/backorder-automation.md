# Red Head backorder automation

Automation defaults to disabled. Development deployment settings can enable sending for the isolated `dieseldev.myshopify.com` store, including test-payment orders. Production activation is a separate step.

## Development purchase test

Use **NotifyDock-Dev** on `dieseldev.myshopify.com`, backed by `https://notify-dock-dev.vercel.app`. The dev deployment can run in `live` mode so a test purchase exercises the real Klaviyo handoff. Its shop allowlist must contain only `dieseldev.myshopify.com`, and test orders must be explicitly allowed.

Before buying, choose a dev variant whose product vendor is exactly `Red-Head Steering Gears Inc.`. Set its variant metafields `custom.product_availability` to `Backorder` (or `Build to Order`) and `custom.availability_date_confirmed` to a future `YYYY-MM-DD` date. Make a new dev purchase with your own test email, leave the item unfulfilled, and add the `Backorder` order tag. Within the next scheduled run, check **NotifyDock-Dev → Backorder automation**, the order's Notify Dock email history, and the test inbox. Further order updates should not send another initial notice.

No test purchase is created by deployment. Existing orders are excluded by the configured activation cutoff.

## Behavior

- Only orders created on or after the explicit activation timestamp qualify. Existing orders are excluded even if they receive the tag later. The first worker run persists the cutoff; a later environment change cannot silently move it backward.
- The order must have the exact `Backorder` tag (case/whitespace insensitive).
- Only unfulfilled, non-removed items belonging to vendor **`Red-Head Steering Gears Inc.`** are included. The vendor match is exact and intentionally fixed for this pilot. A mixed-vendor order's email contains only matching Red Head items.
- Read the variant attached to each order line; do not search the catalog by SKU. Read `custom.product_availability` and include values `Backorder` or `Build to Order` (case/whitespace insensitive).
- Read that variant's `custom.availability_date_confirmed`. It must contain a real `YYYY-MM-DD` date on or after today in the store's timezone. Missing/invalid/past dates hold the entire Red Head notice for review. Confirm the actual metafield definitions and representative values in a dry run.
- Send one initial `dynamic_shipping_delay` event using the existing Notify Dock Klaviyo flow, with a separate specific date for each selected SKU. No automatic date-change follow-up emails are sent in this pilot.
- Cancelled orders, test orders (unless explicitly allowed), and fully fulfilled orders are skipped. Missing/deleted variants or unknown vendors hold the order because the app cannot safely determine eligibility.
- A previously recorded backorder/shipping-delay notice suppresses a new initial automation notice. This checks Notify Dock's local history. Staff should use manual sends only for exceptions during the pilot; a manual send racing an in-progress automatic send is not serialized by this worker.
- Variant availability is current catalog data shared by all orders; it is not an order-specific promise or an inventory allocation record.

The vendor name was checked against the public Shopify product JSON on September 23, 2026:
<https://dieselpowerproducts.com/products/p-7082-red-head-steering-gear-box-03-08-dodge-ram-2500-3500-2879-aspx.js>

## How it runs

`orders/create` and `orders/updated` webhooks authenticate with Shopify, persist a job, and return without calling Klaviyo. A cron invokes `/api/cron/backorders` every five minutes. The worker also scans tagged orders from the activation date, with a persisted pagination cursor, to recover missed webhooks. Waiting orders are checked approximately every 15 minutes, including when a variant date is supplied later without another order update. These intervals can increase when a backlog exists.

Each invocation scans one page of 100 orders per configured shop, handles at most 20 jobs per shop, and stops starting new work after 40 seconds. API calls have bounded timeouts; allow at least 120 seconds of server execution time. Large orders are paginated completely; a partial order never generates a notice. A database lease prevents overlapping workers for a shop. A worker interrupted by a host timeout releases its lease automatically after 10 minutes.

The database has one durable job per shop/order. Before the first network send, the worker saves the exact recipient, metric, event ID, products, and dates. Retries reuse them, including after an ambiguous timeout or a failure to save history after acceptance. Klaviyo deduplicates the same `(profile, metric, unique_id)`. Once accepted, the job cannot be reactivated by duplicate webhooks or unrelated order updates. Do not delete job rows to resend an email; use the existing manual resend workflow.

After the first send attempt, corrections to an order do not rewrite that attempted email. Its frozen payload is retried only while the order is still eligible and the recipient, eligible SKUs, and dates are unchanged. Changes hold the job for manual review rather than sending stale information or turning an uncertain send into a second message. Check Klaviyo activity before sending manually.

History records the event as pending delivery, with source `backorder_automation`. `Accepted by Klaviyo` is not a delivery receipt. The existing order history checks delivery outcomes.

## Deployment setup

1. **Target the correct projects.** This checkout's `shopify.app.toml` identifies `NotifyDock-Dev`, and `.vercel/project.json` currently links `notify-dock-dev`. Production is the separate **NotifyDock** app. Do not use the current defaults to deploy production. Obtain/link the production Shopify configuration and confirm its client ID and application URL; link the production Vercel project separately. Keep development and production databases, credentials, and shop allowlists separate.
2. **Apply the database migration** `20260923120000_add_backorder_automation` and generate Prisma. The existing `npm run build` does this when `POSTGRES_PRISMA_URL` is present, using `POSTGRES_URL_NON_POOLING` for migrations. On another build path run `npx prisma migrate deploy` and `npx prisma generate` against the intended database before running the worker or status page.
3. **Configure environment variables** on the intended deployment:

   | Variable | Value |
   | --- | --- |
   | `NOTIFY_DOCK_AUTOMATION_MODE` | `off` by default; `dry-run` to inspect selections; `live` to send |
   | `NOTIFY_DOCK_AUTOMATION_SHOPS` | Exact production `*.myshopify.com` domain; comma-separated only if needed |
   | `NOTIFY_DOCK_AUTOMATION_START_AT` | Planned activation timestamp with timezone, e.g. `2026-09-28T00:00:00-07:00`; choose once and keep it fixed |
   | `CRON_SECRET` | Random secret of at least 32 characters; never a public/client variable |
   | `NOTIFY_DOCK_AUTOMATION_FROM_ADDRESS` | Optional; defaults to `orders@dieselpowerproducts.com` |
   | `NOTIFY_DOCK_AUTOMATION_ALLOW_TEST_ORDERS` | Optional `true` for controlled testing; defaults to false |

   Existing database, Shopify and Klaviyo variables are still required. The existing Dynamic Shipping Delay metric/flow must be live and use its working sender and template settings. Keep its metric configuration stable during retries.

4. **Configure the scheduler.** The included `vercel.json` runs every five minutes. Vercel Pro/Enterprise support this interval; Hobby only permits daily jobs and will reject this schedule. An existing external scheduler can instead call the same route with `Authorization: Bearer <CRON_SECRET>` (remove the Vercel `crons` entry in that case). Cron schedules run on Vercel production deployments, not branch previews. Verify the project's function duration supports at least 120 seconds.
5. **Register the webhooks on the production Shopify app.** The local development TOML already contains this block. Copy it into the verified production configuration, then deploy that configuration:

   ```toml
   [[webhooks.subscriptions]]
   topics = [ "orders/create", "orders/updated" ]
   uri = "/webhooks/orders/updated"
   ```

   Shopify CLI configuration deployment and Vercel server deployment are separate steps. Ship the backend before enabling the subscriptions. Existing order/product read permissions cover the reads (`read_orders`, `read_products`); verify the production installation has granted them. Older orders beyond Shopify's ordinary order window also require the existing `read_all_orders` scope.
6. **Establish offline access.** Open the production app once as an authorized admin after deployment/reauthorization. The installed Shopify Remix library stores an offline session alongside the current online session, and `unauthenticated.admin(shop)` loads/refreshes that offline session for background work. Check the status page for missing-session or permission errors.
7. **Dry-run verification.** Start with `dry-run` and inspect **Apps → NotifyDock → Backorder automation** (`/app/backorder-automation`). Verify the activation cutoff, exact vendor, both metafields, multiple SKUs/dates, a mixed-vendor order, missing-date holds, and a recent worker timestamp. Dry runs do not contact Klaviyo or create send history. The test fixture may be on a separate development store with its own cutoff. Do not move the production cutoff backward for testing.
8. **Activate.** Set `live` for the intended production deployment and redeploy, keeping the chosen cutoff. Eligible orders created since that cutoff, including those observed in dry run, can now send. Confirm the first pilot notice in Klaviyo and Notify Dock history before expanding beyond Red Head.

To pause, set mode to `off` and redeploy or disable the scheduler. Already accepted Klaviyo events cannot be recalled by pausing. Keep the database records and the activation cutoff when resuming.

## Local verification

```text
npm run test:backorder-automation
node scripts/verify-composer-dates.mjs
npm run build
```

The automation tests use mocked services; they do not send customer email or change a database. `npm run build` applies database migrations if database environment variables are loaded, so use an isolated database or leave them unset for a compilation-only check.

References: [Shopify background Admin access](https://shopify.dev/docs/api/shopify-app-remix/latest/unauthenticated/unauthenticated-admin), [Klaviyo event deduplication](https://developers.klaviyo.com/en/reference/events_api_overview), [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
