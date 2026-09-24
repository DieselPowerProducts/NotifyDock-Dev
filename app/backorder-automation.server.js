import {createHash, randomUUID, timingSafeEqual} from "node:crypto";
import prisma from "./db.server";
import {unauthenticated} from "./shopify.server";
import {METRIC_NAMES, sendNotifyDockEvent} from "./klaviyo.server";
import {buildNotifyDockMessage} from "./notify-dock-email-template.server";
import {
  BACKORDER_EMAIL_TYPE, BACKORDER_HISTORY_TYPES, getBackorderAutomationConfig, hasBackorderTag,
} from "./backorder-automation.js";
import {BACKORDER_SCAN_QUERY, loadBackorderOrder, queryBackorderShopify} from "./backorder-automation-shopify.js";
import {processBackorderJob} from "./backorder-automation-worker.js";

export function isBackorderCronAuthorized(request, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const received = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function jobId(shop, orderId) {
  return `nd-backorder-${createHash("sha256").update(`${shop}:${orderId}:initial`).digest("hex")}`;
}

async function enqueueOrders(shop, orders, config) {
  const eligible = orders.filter((order) => {
    const createdAt = new Date(order.createdAt);
    return /^gid:\/\/shopify\/Order\/\d+$/.test(order.id || "") &&
      !Number.isNaN(createdAt.getTime()) && createdAt >= config.startAt && hasBackorderTag(order.tags);
  });
  if (!eligible.length) return;
  await prisma.notifyDockBackorderJob.createMany({
    data: eligible.map((order) => ({id: jobId(shop, order.id), shop, orderId: order.id, orderNumber: order.name || order.id})),
    skipDuplicates: true,
  });
  // A cancelled/untagged order may later become eligible again. Accepted jobs never reopen.
  await prisma.notifyDockBackorderJob.updateMany({
    where: {shop, orderId: {in: eligible.map((order) => order.id)}, status: "skipped"},
    data: {status: "queued", nextAttemptAt: new Date()},
  });
}

export async function enqueueBackorderWebhook({shop, payload}) {
  const config = getBackorderAutomationConfig();
  if (config.mode === "off" || !config.shops.includes(shop)) return;
  await enqueueOrders(shop, [{
    id: payload.admin_graphql_api_id || `gid://shopify/Order/${payload.id}`,
    name: payload.name,
    createdAt: payload.created_at,
    tags: payload.tags,
  }], config);
}

const repository = {
  update: (id, data) => prisma.notifyDockBackorderJob.update({where: {id}, data}),
  hasPreviousNotice: async (job) => Boolean(await prisma.notifyDockEmailHistory.findFirst({
    where: {shop: job.shop, orderId: job.orderId, emailType: {in: BACKORDER_HISTORY_TYPES}},
    select: {id: true},
  })),
  complete: async (job, payload, result, sentAt) => {
    await prisma.$transaction([
      prisma.notifyDockEmailHistory.upsert({
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
      }),
      prisma.notifyDockBackorderJob.update({
        where: {id: job.id},
        data: {status: "accepted", acceptedAt: new Date(), reason: "Klaviyo accepted the event. Delivery is tracked in email history."},
      }),
    ]);
  },
};

export async function runBackorderAutomation() {
  const config = {...getBackorderAutomationConfig(), metricName: METRIC_NAMES[BACKORDER_EMAIL_TYPE]};
  if (config.mode === "off") return {mode: "off", shops: []};
  const deadline = Date.now() + 40000;
  const results = [];
  for (const shop of config.shops) {
    if (Date.now() >= deadline) break;
    const now = new Date();
    await prisma.notifyDockBackorderScan.upsert({
      where: {shop}, create: {shop, startAt: config.startAt}, update: {},
    });
    const leaseToken = randomUUID();
    const claimed = await prisma.notifyDockBackorderScan.updateMany({
      where: {shop, OR: [{leaseUntil: null}, {leaseUntil: {lt: now}}]},
      data: {leaseToken, leaseUntil: new Date(now.getTime() + 10 * 60 * 1000)},
    });
    if (!claimed.count) {
      results.push({shop, status: "busy"});
      continue;
    }
    try {
      const scan = await prisma.notifyDockBackorderScan.findUnique({where: {shop}});
      // Prevent an environment change from silently including an older backlog.
      if (scan.startAt.getTime() !== config.startAt.getTime()) {
        throw new Error("START_AT differs from the saved activation time. Keep the original cutoff; changing it requires a deliberate database migration.");
      }
      const {admin} = await unauthenticated.admin(shop);
      const data = await queryBackorderShopify(admin, BACKORDER_SCAN_QUERY, {
        after: scan.cursor,
        query: `tag:Backorder created_at:>='${config.startAt.toISOString()}'`,
      });
      await enqueueOrders(shop, data.orders.nodes, config);
      await prisma.notifyDockBackorderScan.update({
        where: {shop},
        data: {cursor: data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null},
      });
      const jobs = await prisma.notifyDockBackorderJob.findMany({
        where: {shop, status: {in: ["queued", "waiting", "ready", "retry"]}, nextAttemptAt: {lte: now}},
        orderBy: [{nextAttemptAt: "asc"}, {createdAt: "asc"}], take: 20,
      });
      const counts = {};
      for (const job of jobs) {
        if (Date.now() >= deadline) break;
        const status = await processBackorderJob({
          job, config, repository,
          loadOrder: (orderId) => loadBackorderOrder(admin, orderId),
          send: sendNotifyDockEvent,
          buildMessage: buildNotifyDockMessage,
        });
        counts[status] = (counts[status] || 0) + 1;
      }
      await prisma.notifyDockBackorderScan.update({
        where: {shop}, data: {lastRunAt: new Date(), lastError: null},
      });
      results.push({shop, status: "ok", counts});
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Automation failed.";
      await prisma.notifyDockBackorderScan.update({where: {shop}, data: {lastRunAt: new Date(), lastError: message}});
      results.push({shop, status: "error", error: message});
    } finally {
      await prisma.notifyDockBackorderScan.updateMany({
        where: {shop, leaseToken}, data: {leaseToken: null, leaseUntil: null},
      });
    }
  }
  return {mode: config.mode, shops: results};
}
