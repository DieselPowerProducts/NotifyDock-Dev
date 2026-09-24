import {selectBackorderNotice} from "./backorder-automation.js";

// Dependencies are injected so failure/retry behavior can be tested without sending email.
export async function processBackorderJob({job, config, repository, loadOrder, send, buildMessage, now = new Date()}) {
  const update = (data) => repository.update(job.id, data);
  const retryAt = new Date(now.getTime() + 15 * 60 * 1000);
  try {
    const {order, shopName, today} = await loadOrder(job.orderId);
    const selection = selectBackorderNotice({order, config, today});
    if (selection.status !== "ready") {
      await update({status: selection.status, reason: selection.reason, nextAttemptAt: retryAt});
      return selection.status;
    }
    if (job.sendPayload && (
      job.sendPayload.customerEmail !== selection.payload.customerEmail ||
      productSignature(job.sendPayload.products) !== productSignature(selection.payload.products)
    )) {
      await update({
        status: "waiting",
        reason: "Recipient, eligible items, or dates changed after a send attempt. Review Klaviyo activity before sending manually; the earlier request may already have been accepted.",
        nextAttemptAt: retryAt,
      });
      return "waiting";
    }
    // Once a send has been attempted, preserve its recipient, metric, payload and ID.
    // Klaviyo deduplicates retries using (profile, metric, unique_id).
    if (!job.sendPayload && await repository.hasPreviousNotice(job)) {
      await update({status: "previously_notified", reason: "A backorder or shipping-delay email is already recorded for this order."});
      return "previously_notified";
    }
    const payload = job.sendPayload || {
      ...selection.payload,
      shop: shopName || job.shop,
      message: buildMessage(selection.payload),
      requestEventUniqueId: job.id,
      metricName: config.metricName,
      requestTimeoutMs: 15000,
    };
    if (config.mode !== "live") {
      await update({status: "ready", reason: "Dry run: ready to send; no email was requested.", previewPayload: payload, nextAttemptAt: retryAt});
      return "ready";
    }
    // This durable write MUST succeed before contacting Klaviyo.
    const attemptedAt = job.attemptedAt || now;
    await update({sendPayload: payload, previewPayload: payload, attemptedAt, attempts: {increment: 1}});
    const result = await send(payload);
    await repository.complete(job, payload, result, attemptedAt);
    return "accepted";
  } catch (error) {
    await update({
      status: "retry",
      reason: `Processing failed; will retry. ${error instanceof Error ? error.message : "Unknown error"}`.slice(0, 1500),
      nextAttemptAt: retryAt,
    });
    return "retry";
  }
}

function productSignature(products) {
  return JSON.stringify(products.map(({sku, delayDate}) => [sku, delayDate]).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  ));
}
