import {createHash, randomUUID} from "node:crypto";
import prisma from "./db.server";
import {unauthenticated} from "./shopify.server";
import {METRIC_NAMES} from "./klaviyo.server";
import {sendAutomaticBackorderEvent} from "./backorder-automatic-send.server";
import {requireBackorderPolicy} from "./backorder-policy.server";
import {buildNotifyDockMessage} from "./notify-dock-email-template.server";
import {
  BACKORDER_EMAIL_TYPE, BACKORDER_HISTORY_TYPES, getBackorderAutomationConfig, hasBackorderTag, isOrderAfterBackorderCutoff,
} from "./backorder-automation.js";
import {loadBackorderOrder} from "./backorder-automation-shopify.js";
import {processBackorderJob} from "./backorder-automation-worker.js";
import {saveFollowupTracking} from "./backorder-followup.server";

function jobId(shop, orderId) {
  return `nd-backorder-${createHash("sha256").update(`${shop}:${orderId}:initial`).digest("hex")}`;
}

async function enqueueOrders(shop, orders, config) {
  const eligible = orders.filter((order) => {
    return /^gid:\/\/shopify\/Order\/\d+$/.test(order.id || "") &&
      isOrderAfterBackorderCutoff(order, config.startAt) && hasBackorderTag(order.tags);
  });
  if (!eligible.length) return [];
  await prisma.notifyDockBackorderJob.createMany({
    data: eligible.map((order) => ({id: jobId(shop, order.id), shop, orderId: order.id, orderNumber: order.name || order.id})),
    skipDuplicates: true,
  });
  // A cancelled/untagged order may later become eligible again. Accepted jobs never reopen.
  await prisma.notifyDockBackorderJob.updateMany({
    where: {shop, orderId: {in: eligible.map((order) => order.id)}, status: "skipped"},
    data: {status: "queued", nextAttemptAt: new Date()},
  });
  return eligible.map((order) => jobId(shop, order.id));
}

export async function enqueueBackorderWebhook({shop, payload}) {
  let config = getBackorderAutomationConfig();
  if (config.mode === "off" || !config.shops.includes(shop)) return;
  config = await requireBackorderPolicy(shop);
  const ids = await enqueueOrders(shop, [{
    id: payload.admin_graphql_api_id || `gid://shopify/Order/${payload.id}`,
    name: payload.name,
    createdAt: payload.created_at,
    tags: payload.tags,
  }], config);
  return ids[0];
}

const repository = {
  update: (id, data) => prisma.notifyDockBackorderJob.update({where: {id}, data}),
  hasPreviousNotice: async (job) => Boolean(await prisma.notifyDockEmailHistory.findFirst({
    where: {shop: job.shop, orderId: job.orderId, emailType: {in: BACKORDER_HISTORY_TYPES}},
    select: {id: true},
  })),
  complete: async (job, payload, result, sentAt) => {
    await prisma.$transaction(async (tx) => {
      const history = await tx.notifyDockEmailHistory.upsert({
        where: {sourceEventId: job.id},
        update: {},
        create: {
          shop: job.shop, orderId: job.orderId, orderNumber: payload.orderNumber,
          customerEmail: payload.customerEmail, firstName: payload.firstName,
          emailType: payload.emailType, fromAddress: payload.fromAddress,
          subject: payload.subject, message: payload.message, sku: payload.sku,
          metricName: result.metricName, requestEventUniqueId: payload.requestEventUniqueId,
          source: "backorder_automation", sourceEventId: job.id, sentAt,
        },
      });
      await saveFollowupTracking(history, payload.followupCandidates || [], new Date(), tx);
      await tx.notifyDockBackorderJob.update({
        where: {id: job.id},
        data: {status: "accepted", acceptedAt: new Date(), reason: "Klaviyo accepted the event. Delivery is tracked in email history."},
      });
    });
  },
};

// Only the order identified by an authenticated Shopify webhook is processed.
// There is no scheduled discovery scan or queue-wide drain.
export async function processBackorderWebhook({shop, payload}) {
  const id = await enqueueBackorderWebhook({shop, payload});
  if (!id) return "ignored";
  const config = {...await requireBackorderPolicy(shop), metricName: METRIC_NAMES[BACKORDER_EMAIL_TYPE]};
  if (config.mode === "off") return "ignored";
  const token = randomUUID();
  const now = new Date();
  const claimed = await prisma.notifyDockBackorderJob.updateMany({
    where: {id, shop, status: {in: ["queued", "waiting", "ready", "retry"]},
      OR: [{leaseUntil: null}, {leaseUntil: {lt: now}}]},
    data: {leaseToken: token, leaseUntil: new Date(now.getTime() + 10 * 60 * 1000)},
  });
  if (!claimed.count) {
    const existing = await prisma.notifyDockBackorderJob.findUnique({where: {id}});
    return existing && ["accepted", "previously_notified"].includes(existing.status) ? "complete" : "busy";
  }
  try {
    const job = await prisma.notifyDockBackorderJob.findUnique({where: {id}});
    const {admin} = await unauthenticated.admin(shop);
    return await processBackorderJob({
      job, config, repository,
      loadOrder: (orderId) => loadBackorderOrder(admin, orderId),
      send: (email) => sendAutomaticBackorderEvent({shop, orderId: job.orderId, payload: email, kind: "initial"}),
      buildMessage: buildNotifyDockMessage,
    });
  } finally {
    await prisma.notifyDockBackorderJob.updateMany({
      where: {id, leaseToken: token}, data: {leaseToken: null, leaseUntil: null},
    });
  }
}
