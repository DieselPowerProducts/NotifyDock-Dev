import {requireBackorderPolicy, followupEnabled} from "./backorder-policy.server";
import {isOrderAfterBackorderCutoff} from "./backorder-automation.js";
import {loadBackorderOrder} from "./backorder-automation-shopify.js";
import {unauthenticated} from "./shopify.server";
import {sendNotifyDockEvent} from "./klaviyo.server";

// Every automatic provider request, including retries, must cross this gate.
// Manual Send/Resend deliberately use their existing authenticated routes.
export async function sendAutomaticBackorderEvent({shop, orderId, payload, kind}) {
  const config = await requireBackorderPolicy(shop);
  if (!(kind === "initial" ? config.mode === "live" : kind === "followup" && followupEnabled(shop))) {
    throw new Error("This automatic email path is disabled.");
  }
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId || "") || payload.orderId !== orderId) {
    throw new Error("Automatic email order identity does not match its job.");
  }
  const {admin} = await unauthenticated.admin(shop);
  const {order} = await loadBackorderOrder(admin, orderId);
  if (order?.id !== orderId || !isOrderAfterBackorderCutoff(order, config.startAt) || order.cancelledAt) {
    throw new Error("Automatic email blocked: order is missing, cancelled, or outside the locked creation cutoff.");
  }
  return sendNotifyDockEvent(payload);
}
