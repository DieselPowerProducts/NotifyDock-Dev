import {waitUntil} from "@vercel/functions";
import {authenticate} from "../shopify.server";
import {processBackorderWebhook} from "../backorder-automation.server";

export async function action({request}) {
  const {shop, payload, topic} = await authenticate.webhook(request);
  if (!["ORDERS_CREATE", "ORDERS_UPDATED"].includes(topic)) return new Response(null, {status: 400});
  // Keep processing alive if Shopify disconnects at its five-second deadline.
  // Never acknowledge an unfinished send: Shopify retries 503s, and the job lease
  // plus the persisted Klaviyo event ID protect against concurrent/duplicate sends.
  const processing = processBackorderWebhook({shop, payload}).catch(() => "retry");
  waitUntil(processing);
  let timer;
  try {
    const result = await Promise.race([
      processing,
      new Promise((resolve) => { timer = setTimeout(() => resolve("retry"), 3500); }),
    ]);
    return new Response(null, {status: ["retry", "busy"].includes(result) ? 503 : 200});
  } finally {
    clearTimeout(timer);
  }
}
