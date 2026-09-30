# NotifyDock-Dev Polaris migration

Production baseline: `DieselPowerProducts/NotifyDock` commit `4a170ecb9deb37dd70b21f8f36e6d70627d17d56`.
Development destination: `DieselPowerProducts/NotifyDock-Dev`, branch `main`.

## Scope

Both Admin UI extensions (`backorder-email` and `notify-dock-action`) now use API `2026-07`, Preact, and Polaris web components. Existing extension handles and UIDs are preserved. `extensions/shared/polaris.tsx` translates the existing composer callbacks and layout into web component properties/events, including action slots, input values, date ranges, image alt text, and numeric dimensions.

The composer business logic, server endpoints, Klaviyo payloads, webhook gates, and production automation cutoff match the latest production baseline. The embedded Remix app still uses its existing React/Polaris implementation; this is separate from Shopify's UI-extension runtime migration.

## Checks

- `npm run typecheck:extensions`: both extension source trees and shared adapters.
- `npm run test:regression`: 23 backend tests covering creation cutoffs, vendor/tag eligibility, webhook retries and leases, missing-date prefilling, deduplication, and daily follow-ups.
- `npm run test:composer`: Preact/DOM interaction checks using Shopify's extension API test harness. Covers all five email types, global and item dates, built-to-order ranges, stale/out-of-order preview responses, missing recipients, current input values, send failure recovery, history recipient edits/resends, correct reopened order, and the order-page launcher. All network requests and sends are mocked; no customer emails are sent.
- `npm run build`: backend production build without database credentials locally.
- `shopify app build --client-id 9d017066e4bef3c21a4b679c73f35cac`: both extension bundles.
- `docs/workflow-templates/polaris-checks.yml` is a prepared CI template for these checks. It is not installed: the current GitHub OAuth token permits code pushes but lacks the `workflow` scope. The production follow-up workflow is also retained only as a template in dev.

DOM tests do not reproduce Shopify's native calendar rendering or prove actual Klaviyo delivery. Those need the dev-store acceptance checks below.

## Dev deployment isolation

The existing dev Vercel project pointed at the production database's default schema. For this rollout, an isolated `notifydock_dev` schema was created in the same database, and only dieseldev's six session records and 54 history records (plus its existing scan record) were copied. Production tables were not modified. This is table/schema isolation, not a separate database server or database credential.

NotifyDock-Dev's Vercel production-target `POSTGRES_PRISMA_URL` and `POSTGRES_URL_NON_POOLING` now specify `schema=notifydock_dev`. The Shopify client ID remains `9d017066e4bef3c21a4b679c73f35cac`, and its application URL remains `https://notify-dock-dev.vercel.app`.

Dev automation is explicitly off and daily follow-ups are disabled. Manual send/resend still use the configured Klaviyo account: use internal test recipients. Dev backorder autofill is allowed for `dieseldev.myshopify.com`, with its own locked cutoff at `2026-09-24T21:40:39Z`; use test orders created after that time. No automatic follow-up workflow is installed in this dev repository.

## Acceptance before production promotion

1. Open NotifyDock-Dev on dieseldev and open the composer from two different test orders. Confirm recipient, order number, saved history, and correct order after reopening.
2. Preview all five email types. Send each to an internal recipient and confirm actual delivery and the saved history entry.
3. Test one global shipping date, different item dates, a built-to-order range, and clearing/changing those values. Check both preview and received email.
4. For newer tagged backorders from the supported vendor, test known dates, missing dates/messages, mixed items, and recipient-less orders.
5. Edit a history recipient and resend; confirm the new recipient and no unintended duplicate send. Check Close, loading/disabled states, calendar rendering, image labels, and the narrow order-page block layout in Shopify.
6. If testing automatic sends, deliberately enable only the dieseldev allowlist and use internal recipients. Automatic sends and follow-ups are not enabled by this UI migration.

Do not deploy the dev app config to production. Promote the extension migration into the production repository while retaining production's Shopify client ID, URL, database settings, scheduler, and locked cutoff. Keep the prior Shopify app version available for rollback; reverting extensions does not require a data rollback.
