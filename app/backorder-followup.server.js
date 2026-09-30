import {createHash, randomUUID, timingSafeEqual} from "node:crypto";
import prisma from "./db.server";
import {unauthenticated} from "./shopify.server";
import {METRIC_NAMES} from "./klaviyo.server";
import {sendAutomaticBackorderEvent} from "./backorder-automatic-send.server";
import {requireBackorderPolicy, followupEnabled} from "./backorder-policy.server";
import {buildDynamicShippingDelayDetailsHtml} from "./notify-dock-email-template.server";
import {loadBackorderOrder} from "./backorder-automation-shopify.js";
import {genericFollowupCandidates, nextFollowupCheck, resolveFollowupItem} from "./backorder-followup.js";
import {hasBackorderTag, isOrderAfterBackorderCutoff} from "./backorder-automation.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function authorizeFollowupCron(request) {
  const secret = process.env.NOTIFY_DOCK_FOLLOWUP_SECRET;
  if (!secret) return false;
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function prepareFollowupTracking({admin, shop, orderId, products, emailType, globalShipDate}) {
  if (!followupEnabled(shop) || emailType !== "dynamic_shipping_delay" || globalShipDate ||
    !products.some((p) => ["", "no_confirmed_date"].includes(p.delayState || ""))) return [];
  let config;
  try { config = await requireBackorderPolicy(shop); }
  catch (_error) { return []; } // Manual sending remains available; no automatic enrollment.
  const {order} = await loadBackorderOrder(admin, orderId);
  if (!isOrderAfterBackorderCutoff(order, config.startAt) || !hasBackorderTag(order.tags)) return [];
  return genericFollowupCandidates({order, products, emailType, globalShipDate});
}

export async function saveFollowupTracking(history, candidates, now = new Date(), db = prisma) {
  if (!candidates.length || !followupEnabled(history.shop) || !history.requestEventUniqueId || !["app", "backorder_automation"].includes(history.source)) return;
  await requireBackorderPolicy(history.shop, db);
  // Called only AFTER Klaviyo accepts the initial email and its history row is saved.
  // No backfill and no order/catalog scan can create these records.
  await db.notifyDockFollowupItem.createMany({data: candidates.map((item) => ({
    ...item, id: hash(`${history.shop}:${history.orderId}:${item.lineItemId}`),
    shop: history.shop, orderId: history.orderId, initialHistoryId: history.id,
    nextCheckAt: nextFollowupCheck(now, process.env.NOTIFY_DOCK_FOLLOWUP_TEST_AT),
  })), skipDuplicates: true});
}

export async function runBackorderFollowups(now = new Date()) {
  const shops = (process.env.NOTIFY_DOCK_FOLLOWUP_SHOPS || "").split(",").map((s) => s.trim()).filter(followupEnabled);
  const summary = [];
  const deadline = Date.now() + 45000;
  for (const shop of shops) {
    const config = await requireBackorderPolicy(shop);
    const predatesActivation = (order) => !isOrderAfterBackorderCutoff(order, config.startAt);
    const token = randomUUID();
    await prisma.notifyDockFollowupLease.upsert({where: {shop}, create: {shop}, update: {}});
    const lock = await prisma.notifyDockFollowupLease.updateMany({where: {shop, OR: [{leaseUntil: null}, {leaseUntil: {lt: now}}]},
      data: {token, leaseUntil: new Date(now.getTime() + 10 * 60 * 1000)}});
    if (!lock.count) continue;
    try {
      const due = await prisma.notifyDockFollowupItem.findMany({where: {shop, status: "pending", nextCheckAt: {lte: now}},
        include: {initialHistory: true}, orderBy: {nextCheckAt: "asc"}, take: 100});
      const batches = await prisma.notifyDockFollowupBatch.findMany({where: {shop, status: "pending", nextAttemptAt: {lte: now}}, take: 20});
      if (!due.length && !batches.length) { summary.push({shop, checked: 0}); continue; }
      const {admin} = await unauthenticated.admin(shop);
      const orders = new Map();
      const load = async (id) => {
        if (!orders.has(id)) orders.set(id, await loadBackorderOrder(admin, id, now));
        return orders.get(id);
      };
      const groups = Map.groupBy(due, (row) => row.initialHistoryId);
      for (const records of groups.values()) {
        if (Date.now() >= deadline) break;
        const history = records[0].initialHistory;
        if (history.shop !== shop || !["app", "backorder_automation"].includes(history.source) || !history.requestEventUniqueId ||
          history.emailType !== "dynamic_shipping_delay" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(history.customerEmail)) {
          await prisma.notifyDockFollowupItem.updateMany({where: {id: {in: records.map((r) => r.id)}}, data: {status: "skipped", reason: "Initial send record is not eligible."}});
          continue;
        }
        const loaded = await load(history.orderId);
        if (predatesActivation(loaded.order)) {
          await prisma.notifyDockFollowupItem.updateMany({where: {id: {in: records.map((r) => r.id)}}, data: {status: "skipped", reason: "Order predates automatic rollout; no follow-up."}});
          continue;
        }
        const ready = [];
        for (const record of records) {
          const resolution = resolveFollowupItem(record, loaded);
          if (resolution.status === "ready") ready.push({record, product: resolution.product});
          else await prisma.notifyDockFollowupItem.update({where: {id: record.id}, data: {
            status: resolution.status, reason: resolution.reason, nextCheckAt: nextFollowupCheck(now),
          }});
        }
        if (!ready.length) continue;
        const id = `nd-followup-${hash(ready.map((r) => r.record.id).sort().join(":"))}`;
        const products = ready.map((r) => r.product);
        const payload = {customerEmail: history.customerEmail, firstName: history.firstName || "",
          emailType: "dynamic_shipping_delay", fromAddress: history.fromAddress || "orders@dieselpowerproducts.com",
          orderId: history.orderId, orderNumber: history.orderNumber, shop: loaded.shopName || shop,
          products, sku: products.map((p) => p.sku).join(", "), globalShipDate: "", shipDate: "", sentByEmail: "",
          subject: `Updated shipping estimate for order ${history.orderNumber}`,
          message: "<p>We have updated shipping information for the following item(s) in your order.</p>" + buildDynamicShippingDelayDetailsHtml({products}),
          requestEventUniqueId: id, metricName: METRIC_NAMES.dynamic_shipping_delay, requestTimeoutMs: 15000};
        const batch = await prisma.$transaction(async (tx) => {
          const created = await tx.notifyDockFollowupBatch.create({data: {id, shop, orderId: history.orderId, payload, nextAttemptAt: now}});
          await tx.notifyDockFollowupItem.updateMany({where: {id: {in: ready.map((r) => r.record.id)}}, data: {status: "batched", batchId: id}});
          return created;
        });
        batches.push(batch);
      }
      for (const batch of batches) {
        if (Date.now() >= deadline) break;
        const records = await prisma.notifyDockFollowupItem.findMany({where: {batchId: batch.id, shop}});
        const loaded = await load(batch.orderId);
        if (predatesActivation(loaded.order)) {
          await prisma.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {status: "held", reason: "Order predates automatic rollout; no follow-up."}});
          continue;
        }
        const current = records.map((r) => resolveFollowupItem(r, loaded));
        const expected = batch.payload.products;
        if (!records.length || current.some((r) => r.status !== "ready") || current.length !== expected.length ||
          current.some((r) => !expected.some((p) => p.sku === r.product.sku && p.delayDate === r.product.delayDate && p.delayMessage === r.product.delayMessage))) {
          await prisma.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {status: "held", reason: "Items or ETA changed after queuing; review before resending."}});
          continue;
        }
        try {
          const result = await sendAutomaticBackorderEvent({shop, orderId: batch.orderId, payload: batch.payload, kind: "followup"});
          const payload = batch.payload;
          await prisma.$transaction([
            prisma.notifyDockEmailHistory.upsert({where: {sourceEventId: batch.id}, update: {}, create: {
              shop, orderId: payload.orderId, orderNumber: payload.orderNumber, customerEmail: payload.customerEmail,
              firstName: payload.firstName, fromAddress: payload.fromAddress, emailType: payload.emailType,
              subject: payload.subject, message: payload.message, sku: payload.sku, metricName: result.metricName,
              source: "backorder_followup", sourceEventId: batch.id, requestEventUniqueId: batch.id, sentAt: now,
            }}),
            prisma.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {status: "accepted", acceptedAt: now, reason: null}}),
            prisma.notifyDockFollowupItem.updateMany({where: {batchId: batch.id}, data: {status: "accepted", reason: "One-time follow-up accepted by Klaviyo."}}),
          ]);
        } catch (error) {
          await prisma.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {
            nextAttemptAt: nextFollowupCheck(now), reason: `${error.message}`.slice(0, 1000),
          }});
        }
      }
      summary.push({shop, checked: due.length, batches: batches.length});
      await prisma.notifyDockFollowupLease.update({where: {shop}, data: {lastError: null}});
    } catch (error) {
      await prisma.notifyDockFollowupLease.update({where: {shop}, data: {lastError: `${error.message}`.slice(0, 1000)}});
      throw error;
    } finally {
      await prisma.notifyDockFollowupLease.updateMany({where: {shop, token}, data: {token: null, leaseUntil: null, lastRunAt: now}});
    }
  }
  // Drain additional pages during this one daily run, without another timer.
  let remaining = 0;
  for (const shop of shops) {
    remaining += await prisma.notifyDockFollowupItem.count({where: {shop, status: "pending", nextCheckAt: {lte: now}}});
    remaining += await prisma.notifyDockFollowupBatch.count({where: {shop, status: "pending", nextAttemptAt: {lte: now}}});
  }
  return {shops: summary, hasMore: remaining > 0};
}
