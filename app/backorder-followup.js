import {BACKORDER_PILOT_VENDOR, normalizeAvailabilityDate} from "./backorder-automation.js";

export function isFollowupRunHour(now = new Date()) {
  return Number.isFinite(now.getTime()) && new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23",
  }).format(now) === "16";
}

export function nextFollowupCheck(now, testAt = "") {
  const test = new Date(testAt);
  if (test > now) return test;
  // Find the next 16:00 in Pacific time, including daylight-saving transitions.
  const candidate = new Date(now);
  candidate.setUTCMinutes(0, 0, 0);
  for (let hour = 0; hour < 27; hour += 1) {
    if (candidate > now && new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23",
    }).format(candidate) === "16") return candidate;
    candidate.setUTCHours(candidate.getUTCHours() + 1);
  }
  throw new Error("Unable to calculate the next follow-up check.");
}

export function genericFollowupCandidates({order, products, emailType, globalShipDate}) {
  if (emailType !== "dynamic_shipping_delay" || globalShipDate || !order || order.cancelledAt) return [];
  const genericSkus = new Set(products.filter((p) =>
    ["", "no_confirmed_date"].includes(p.delayState || "") && !p.delayDate && !p.delayMessage &&
    !p.delayRangeStart && !p.delayRangeEnd).map((p) => p.sku));
  return order.lineItems.flatMap((item) => {
    const variant = item.variant;
    const availability = `${variant?.availability?.value || ""}`.trim().toLowerCase();
    if (!genericSkus.has(item.sku) || !item.id || !variant?.id || item.unfulfilledQuantity <= 0 ||
      item.currentQuantity <= 0 || variant.product?.vendor !== BACKORDER_PILOT_VENDOR ||
      !["backorder", "build to order", "built to order"].includes(availability)) return [];
    return [{lineItemId: item.id, variantId: variant.id, sku: item.sku,
      kind: availability === "backorder" ? "backorder" : "built_to_order"}];
  });
}

export function resolveFollowupItem(record, {order, today, timeZone}) {
  const item = order?.lineItems.find((line) => line.id === record.lineItemId && line.variant?.id === record.variantId);
  if (!order || order.cancelledAt || !item || item.unfulfilledQuantity <= 0 || item.currentQuantity <= 0 ||
    item.variant.product?.vendor !== BACKORDER_PILOT_VENDOR) return {status: "skipped", reason: "Item cancelled, removed, fulfilled, or no longer eligible."};
  const availability = `${item.variant.availability?.value || ""}`.trim().toLowerCase();
  if (!(record.kind === "backorder" ? availability === "backorder" : ["build to order", "built to order"].includes(availability))) {
    return {status: "skipped", reason: "Availability type changed; review manually."};
  }
  let date = "";
  let message = "";
  if (record.kind === "backorder") {
    date = normalizeAvailabilityDate(item.variant.availabilityDate, timeZone);
    if (!date || date < today) return {status: "pending", reason: "No current confirmed date."};
  } else {
    const field = item.variant.buildToOrderMessage;
    message = `${field?.value || ""}`.trim();
    if (!message || (field.type && !["single_line_text_field", "multi_line_text_field"].includes(field.type))) {
      return {status: "pending", reason: "No Built to Order message."};
    }
  }
  return {status: "ready", product: {sku: record.sku, productTitle: item.title,
    productVariantTitle: item.variantTitle || "", productImageUrl: item.variant.image?.url || item.image?.url || "",
    productImageAlt: item.variant.image?.altText || item.image?.altText || item.title,
    delayState: date ? "specific_date" : "build_to_order_message", delayDate: date, delayMessage: message,
    delayRangeStart: "", delayRangeEnd: ""}};
}
