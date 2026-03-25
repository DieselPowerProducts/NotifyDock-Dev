## Project Notes

- Notify Dock currently uses the Klaviyo event flow for email delivery. The `shopify-send` branch is only an experiment with Shopify `orderInvoiceSend`, and it failed on normal paid orders that had no outstanding balance.
- Do not chase Shopify's native order timeline email entry for app-sent Klaviyo emails. If tracking is still needed, build persistent send history inside Notify Dock instead.
