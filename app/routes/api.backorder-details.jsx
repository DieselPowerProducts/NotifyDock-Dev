import {json} from "@remix-run/node";
import {authenticate} from "../shopify.server";
import {loadBackorderOrder} from "../backorder-automation-shopify.js";
import {selectBackorderNotice} from "../backorder-automation.js";
import {requireBackorderPolicy} from "../backorder-policy.server";

// Read-only prefilling for the existing order composer. Never queues or sends email.
export async function loader({request}) {
  const {admin, cors, session} = await authenticate.admin(request);
  const orderId = new URL(request.url).searchParams.get("order_id") || "";
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId)) {
    return cors(json({error: "A valid order ID is required."}, {status: 400}));
  }
  try {
    let config;
    try { config = await requireBackorderPolicy(session.shop); }
    catch (_error) {
      return cors(json({status: "skipped", reason: "Backorder autofill requires a configured order creation cutoff."},
        {headers: {"Cache-Control": "no-store"}}));
    }
    const loaded = await loadBackorderOrder(admin, orderId);
    // The recipient can be entered in the composer's To field after previewing.
    // Keep recipient validation enabled for background sending (the selector default).
    const selection = selectBackorderNotice({...loaded, requireCustomerEmail: false, config: {
      ...config, allowTestOrders: true,
    }});
    return cors(json(selection, {headers: {"Cache-Control": "no-store"}}));
  } catch (error) {
    return cors(json({error: error instanceof Error ? error.message : "Unable to read backorder details."}, {status: 500}));
  }
}
