// Pure selection rules, shared by the worker and its offline tests.
export const BACKORDER_EMAIL_TYPE = "dynamic_shipping_delay";
export const BACKORDER_PILOT_VENDOR = "Red-Head Steering Gears Inc.";
export const BACKORDER_HISTORY_TYPES = [
  "backorder_notice", "shipping_delay", BACKORDER_EMAIL_TYPE,
];

export function getBackorderAutomationConfig(env = process.env) {
  const mode = env.NOTIFY_DOCK_AUTOMATION_MODE || "off";
  if (!["off", "dry-run", "live"].includes(mode)) {
    throw new Error("NOTIFY_DOCK_AUTOMATION_MODE must be off, dry-run, or live.");
  }
  const shops = (env.NOTIFY_DOCK_AUTOMATION_SHOPS || "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const startValue = env.NOTIFY_DOCK_AUTOMATION_START_AT || "";
  const startAt = new Date(startValue);
  if (mode !== "off" && (
    !shops.length || shops.some((shop) => !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(startValue) ||
    !isValidAvailabilityDate(startValue.slice(0, 10)) ||
    Number.isNaN(startAt.getTime())
  )) {
    throw new Error("Automation requires shop domains and an explicit START_AT timestamp with a timezone. Only orders created on or after START_AT are eligible.");
  }
  return {
    mode, shops, startAt,
    allowTestOrders: env.NOTIFY_DOCK_AUTOMATION_ALLOW_TEST_ORDERS === "true",
    fromAddress: env.NOTIFY_DOCK_AUTOMATION_FROM_ADDRESS || "orders@dieselpowerproducts.com",
  };
}

export function hasBackorderTag(tags) {
  const values = Array.isArray(tags) ? tags : `${tags || ""}`.split(",");
  return values.some((tag) => tag.trim().toLowerCase() === "backorder");
}

export function isValidAvailabilityDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function selectBackorderNotice({order, config, today}) {
  const skip = (reason) => ({status: "skipped", reason});
  const wait = (reason) => ({status: "waiting", reason});
  if (!order) return skip("Order no longer exists.");
  const createdAt = new Date(order.createdAt);
  if (Number.isNaN(createdAt.getTime())) return wait("Order creation time is missing.");
  if (createdAt < config.startAt) return skip("Order predates automation activation.");
  if (order.cancelledAt) return skip("Order was cancelled.");
  if (order.test && !config.allowTestOrders) return skip("Test orders are excluded.");
  if (!hasBackorderTag(order.tags)) return skip("Order does not have the Backorder tag.");

  const products = [];
  const problems = [];
  const items = order.lineItems || [];
  const outstanding = items.filter((item) => item.unfulfilledQuantity > 0 && item.currentQuantity > 0);
  if (!outstanding.length) return skip("No unfulfilled items remain.");

  for (const item of outstanding) {
    const variant = item.variant;
    if (!variant) {
      problems.push(`${item.sku || item.title}: variant is unavailable.`);
      continue;
    }
    if (!variant.product?.vendor) {
      problems.push(`${item.sku || item.title}: vendor is unavailable.`);
      continue;
    }
    // Deliberately an exact match: this rollout is limited to Red Head.
    if (variant.product.vendor !== BACKORDER_PILOT_VENDOR) continue;
    const availability = `${variant.availability?.value || ""}`.trim().toLowerCase();
    if (!["backorder", "build to order"].includes(availability)) continue;
    const sku = `${item.sku || variant.sku || ""}`.trim();
    const date = `${variant.availabilityDate?.value || ""}`.trim();
    if (!sku) problems.push(`${item.title}: SKU is missing.`);
    if (!isValidAvailabilityDate(date)) {
      problems.push(`${sku || item.title}: confirmed availability date is missing or invalid (expected YYYY-MM-DD).`);
    } else if (date < today) {
      problems.push(`${sku || item.title}: confirmed availability date is in the past.`);
    }
    products.push({
      sku,
      productTitle: item.title,
      productVariantTitle: item.variantTitle || "",
      productImageUrl: variant.image?.url || item.image?.url || "",
      productImageAlt: variant.image?.altText || item.image?.altText || item.title,
      delayState: "specific_date",
      delayDate: date,
      delayRangeStart: "",
      delayRangeEnd: "",
    });
  }
  if (problems.length) return wait(problems.join(" "));
  if (!products.length) return wait("No unfulfilled Red Head variants are marked Backorder or Build to Order.");
  const customerEmail = `${order.email || order.customer?.email || ""}`.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return wait("A valid customer email is missing.");
  if (!order.name) return wait("Order number is missing.");

  // The same variant can appear on multiple lines (for example, with different properties).
  const uniqueProducts = products.filter((product, index) =>
    products.findIndex((other) => other.sku === product.sku && other.delayDate === product.delayDate) === index,
  );
  return {
    status: "ready",
    reason: "All backordered items have confirmed dates.",
    payload: {
      customerEmail,
      emailType: BACKORDER_EMAIL_TYPE,
      firstName: order.customer?.firstName || order.shippingAddress?.firstName || "",
      fromAddress: config.fromAddress,
      orderId: order.id,
      orderNumber: order.name,
      products: uniqueProducts,
      sku: uniqueProducts.map((product) => product.sku).join(", "),
      subject: `Shipping delay for order ${order.name}`,
      globalShipDate: "",
      shipDate: "",
      sentByEmail: "",
      productImageUrl: uniqueProducts[0].productImageUrl,
      productTitle: uniqueProducts[0].productTitle,
      productVariantTitle: uniqueProducts[0].productVariantTitle,
    },
  };
}
