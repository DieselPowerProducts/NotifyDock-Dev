import {authenticate} from "../shopify.server";
import {enqueueBackorderWebhook} from "../backorder-automation.server";

export async function action({request}) {
  const {shop, payload, topic} = await authenticate.webhook(request);
  if (!["ORDERS_CREATE", "ORDERS_UPDATED"].includes(topic)) return new Response(null, {status: 400});
  // Persist the job and acknowledge promptly. The scheduled worker performs API calls and sends.
  await enqueueBackorderWebhook({shop, payload});
  return new Response(null, {status: 200});
}
