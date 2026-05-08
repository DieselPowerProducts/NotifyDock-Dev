import prisma from "./db.server";
import {
  EMAIL_DELIVERY_METRIC_NAMES,
  METRIC_NAMES,
  listEmailDeliveryEventsForProfile,
  listNotifyDockEventsForOrder,
} from "./klaviyo.server";

const EMAIL_TYPE_BY_METRIC_NAME = Object.fromEntries(
  Object.entries(METRIC_NAMES).map(([emailType, metricName]) => [metricName, emailType]),
);
const EMAIL_HISTORY_SETUP_ERROR =
  "Notify Dock email history is not ready yet. Run prisma generate and apply the latest migration.";
const MAX_VISIBLE_HISTORY_ITEMS = 8;
const DELIVERY_STATUS_BY_METRIC_NAME = {
  [EMAIL_DELIVERY_METRIC_NAMES.bounced]: "bounced",
  [EMAIL_DELIVERY_METRIC_NAMES.delivered]: "delivered",
  [EMAIL_DELIVERY_METRIC_NAMES.dropped]: "dropped",
  [EMAIL_DELIVERY_METRIC_NAMES.marked_spam]: "marked_spam",
  [EMAIL_DELIVERY_METRIC_NAMES.opened]: "opened",
};
const DELIVERY_STATUS_PRIORITY = {
  pending: 0,
  delivered: 1,
  opened: 2,
  dropped: 3,
  bounced: 4,
  marked_spam: 5,
};

export async function listEmailHistory({orderId, shop}) {
  const historyModel = getHistoryModel();
  const history = await historyModel.findMany({
    where: {
      orderId,
      shop,
    },
    orderBy: {
      sentAt: "desc",
    },
    take: MAX_VISIBLE_HISTORY_ITEMS + 1,
  });

  return {
    hasMore: history.length > MAX_VISIBLE_HISTORY_ITEMS,
    history: history.slice(0, MAX_VISIBLE_HISTORY_ITEMS),
  };
}

export async function getEmailHistoryById({id, shop}) {
  const historyModel = getHistoryModel();

  return historyModel.findFirst({
    where: {
      id,
      shop,
    },
  });
}

export async function updateEmailHistoryCustomerEmail({
  customerEmail,
  id,
  shop,
}) {
  const historyModel = getHistoryModel();

  return historyModel.updateMany({
    where: {
      id,
      shop,
    },
    data: {
      customerEmail,
      deliveryCheckedAt: null,
      deliveryEventId: null,
      deliveryStatus: "pending",
      deliveryStatusAt: null,
      deliveryStatusReason: null,
    },
  });
}

export async function recordEmailHistory({
  customerEmail,
  emailType,
  firstName,
  fromAddress,
  message,
  metricName,
  orderId,
  orderNumber,
  sentAt,
  sentByEmail,
  shop,
  sku,
  source = "app",
  sourceEventId,
  requestEventUniqueId,
  subject,
}) {
  const historyModel = getHistoryModel();

  return historyModel.create({
    data: {
      customerEmail,
      emailType,
      firstName,
      fromAddress,
      message,
      metricName,
      orderId,
      orderNumber,
      sentAt,
      sentByEmail,
      shop,
      sku,
      source,
      sourceEventId,
      requestEventUniqueId,
      subject,
    },
  });
}

export async function refreshEmailHistoryDeliveryStatuses(history) {
  if (!Array.isArray(history) || !history.length) {
    return history;
  }

  const historyModel = getHistoryModel();
  const checkedAt = new Date();
  const entriesByEmail = groupHistoryByEmail(history);
  const updates = [];

  for (const [customerEmail, entries] of entriesByEmail.entries()) {
    let deliveryEvents = [];

    try {
      deliveryEvents = await listEmailDeliveryEventsForProfile({customerEmail});
    } catch (_error) {
      continue;
    }

    const matchedStatuses = matchDeliveryEventsToHistory({
      deliveryEvents,
      historyEntries: entries,
    });

    for (const entry of entries) {
      const matchedStatus = matchedStatuses.get(entry.id);

      if (!matchedStatus) {
        if (entry.deliveryCheckedAt) {
          continue;
        }

        updates.push(
          historyModel.update({
            where: {id: entry.id},
            data: {deliveryCheckedAt: checkedAt},
          }),
        );
        continue;
      }

      updates.push(
        historyModel.update({
          where: {id: entry.id},
          data: {
            deliveryCheckedAt: checkedAt,
            deliveryEventId: matchedStatus.deliveryEventId,
            deliveryStatus: matchedStatus.deliveryStatus,
            deliveryStatusAt: matchedStatus.deliveryStatusAt,
            deliveryStatusReason: matchedStatus.deliveryStatusReason,
          },
        }),
      );
    }
  }

  if (updates.length) {
    await Promise.all(updates);
  }

  const refreshedEntries = await historyModel.findMany({
    where: {
      id: {
        in: history.map((entry) => entry.id),
      },
    },
  });
  const refreshedById = new Map(
    refreshedEntries.map((entry) => [entry.id, entry]),
  );

  return history.map((entry) => refreshedById.get(entry.id) || entry);
}

export async function backfillEmailHistoryFromKlaviyo({
  customerEmail,
  orderId,
  orderNumber,
  shop,
}) {
  if (!customerEmail || !orderNumber) {
    return {importedCount: 0};
  }

  const events = await listNotifyDockEventsForOrder({
    customerEmail,
    orderNumber,
  });

  if (!events.length) {
    return {importedCount: 0};
  }

  const historyModel = getHistoryModel();

  await Promise.all(
    events.map((event) =>
      historyModel.upsert({
        where: {
          sourceEventId: event.id,
        },
        update: buildHistoryUpsertData({
          customerEmail,
          event,
          orderId,
          orderNumber,
          shop,
        }),
        create: buildHistoryUpsertData({
          customerEmail,
          event,
          orderId,
          orderNumber,
          shop,
        }),
      }),
    ),
  );

  return {importedCount: events.length};
}

export function serializeEmailHistory(historyEntry) {
  return {
    customerEmail: historyEntry.customerEmail,
    deliveryCheckedAt: historyEntry.deliveryCheckedAt?.toISOString() || null,
    deliveryEventId: historyEntry.deliveryEventId,
    deliveryStatus: historyEntry.deliveryStatus || "pending",
    deliveryStatusAt: historyEntry.deliveryStatusAt?.toISOString() || null,
    deliveryStatusReason: historyEntry.deliveryStatusReason,
    emailType: historyEntry.emailType,
    firstName: historyEntry.firstName,
    fromAddress: historyEntry.fromAddress,
    id: historyEntry.id,
    message: historyEntry.message,
    orderId: historyEntry.orderId,
    orderNumber: historyEntry.orderNumber,
    sentAt: historyEntry.sentAt.toISOString(),
    sentByEmail: historyEntry.sentByEmail,
    source: historyEntry.source,
    subject: historyEntry.subject,
  };
}

function buildHistoryUpsertData({
  customerEmail,
  event,
  orderId,
  orderNumber,
  shop,
}) {
  const eventProperties = event.eventProperties || {};
  const emailType =
    `${eventProperties.email_type || ""}`.trim() ||
    EMAIL_TYPE_BY_METRIC_NAME[event.metricName] ||
    "backorder_notice";

  return {
    customerEmail:
      `${event.profileEmail || ""}`.trim() || customerEmail,
    emailType,
    firstName: `${event.profileFirstName || ""}`.trim() || null,
    fromAddress: `${eventProperties.from_address || ""}`.trim() || null,
    message: `${eventProperties.message_html || ""}`.trim(),
    metricName: event.metricName || null,
    orderId,
    orderNumber:
      `${eventProperties.order_number || ""}`.trim() || orderNumber,
    sentAt: new Date(event.datetime),
    sentByEmail: `${eventProperties.sent_by_email || ""}`.trim() || null,
    shop,
    sku: `${eventProperties.sku || ""}`.trim() || null,
    source: "klaviyo_backfill",
    sourceEventId: event.id,
    requestEventUniqueId:
      `${eventProperties.notify_dock_send_id || ""}`.trim() || null,
    subject:
      `${eventProperties.subject || ""}`.trim() ||
      buildFallbackSubject({
        emailType,
        orderNumber:
          `${eventProperties.order_number || ""}`.trim() || orderNumber,
      }),
  };
}

function groupHistoryByEmail(history) {
  return history.reduce((groups, entry) => {
    const customerEmail = `${entry.customerEmail || ""}`.trim().toLowerCase();

    if (!customerEmail) {
      return groups;
    }

    if (!groups.has(customerEmail)) {
      groups.set(customerEmail, []);
    }

    groups.get(customerEmail).push(entry);
    return groups;
  }, new Map());
}

function matchDeliveryEventsToHistory({deliveryEvents, historyEntries}) {
  const sortedEntries = [...historyEntries].sort(
    (firstEntry, secondEntry) =>
      new Date(firstEntry.sentAt).getTime() - new Date(secondEntry.sentAt).getTime(),
  );
  const sortedEvents = [...deliveryEvents].sort(
    (firstEvent, secondEvent) =>
      new Date(firstEvent.datetime).getTime() - new Date(secondEvent.datetime).getTime(),
  );
  const matchedStatuses = new Map();

  sortedEntries.forEach((entry, index) => {
    const sentAtTime = new Date(entry.sentAt).getTime();
    const nextSentAtTime =
      index < sortedEntries.length - 1
        ? new Date(sortedEntries[index + 1].sentAt).getTime()
        : Number.POSITIVE_INFINITY;

    if (!Number.isFinite(sentAtTime)) {
      return;
    }

    const matchingEvents = sortedEvents.filter((event) => {
      const eventTime = new Date(event.datetime).getTime();

      return (
        Number.isFinite(eventTime) &&
        eventTime >= sentAtTime - 60_000 &&
        eventTime < nextSentAtTime
      );
    });
    const bestEvent = matchingEvents.reduce((bestMatch, event) => {
      const status = DELIVERY_STATUS_BY_METRIC_NAME[event.metricName];

      if (!status) {
        return bestMatch;
      }

      if (!bestMatch) {
        return event;
      }

      const bestStatus = DELIVERY_STATUS_BY_METRIC_NAME[bestMatch.metricName];
      const bestPriority = DELIVERY_STATUS_PRIORITY[bestStatus] || 0;
      const currentPriority = DELIVERY_STATUS_PRIORITY[status] || 0;

      if (currentPriority !== bestPriority) {
        return currentPriority > bestPriority ? event : bestMatch;
      }

      return new Date(event.datetime).getTime() >
        new Date(bestMatch.datetime).getTime()
        ? event
        : bestMatch;
    }, null);

    if (!bestEvent) {
      return;
    }

    matchedStatuses.set(entry.id, {
      deliveryEventId: bestEvent.id,
      deliveryStatus: DELIVERY_STATUS_BY_METRIC_NAME[bestEvent.metricName],
      deliveryStatusAt: new Date(bestEvent.datetime),
      deliveryStatusReason: buildDeliveryStatusReason(bestEvent),
    });
  });

  return matchedStatuses;
}

function buildDeliveryStatusReason(event) {
  const eventProperties = event?.eventProperties || {};

  return (
    `${eventProperties.bounce_type || ""}`.trim() ||
    `${eventProperties.bounce_reason || ""}`.trim() ||
    `${eventProperties.reason || ""}`.trim() ||
    `${eventProperties.failure_reason || ""}`.trim() ||
    `${eventProperties.error || ""}`.trim() ||
    null
  );
}

function buildFallbackSubject({emailType, orderNumber}) {
  if (emailType === "will_call_partially_ready") {
    return "Partial Will Call Order is Ready";
  }

  if (emailType === "will_call_ready") {
    return `Pick Up on Location Order ${orderNumber}`.trim();
  }

  if (emailType === "will_call_in_progress") {
    return "Hang Tight - Your Will Call Order Is In Progress";
  }

  if (emailType === "shipping_delay") {
    return `Shipping delay for order ${orderNumber}`.trim();
  }

  if (emailType === "dynamic_shipping_delay") {
    return `Shipping delay for order ${orderNumber}`.trim();
  }

  return `Backorder status for order ${orderNumber}`.trim();
}

function getHistoryModel() {
  const historyModel = prisma.notifyDockEmailHistory;

  if (historyModel) {
    return historyModel;
  }

  const error = new Error(EMAIL_HISTORY_SETUP_ERROR);
  error.status = 503;
  throw error;
}
