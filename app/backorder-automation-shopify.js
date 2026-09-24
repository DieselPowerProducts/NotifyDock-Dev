import {formatStoreDate} from "./backorder-automation.js";

export const BACKORDER_SCAN_QUERY = `#graphql
  query BackorderOrders($after: String, $query: String!) {
    orders(first: 100, after: $after, query: $query, sortKey: CREATED_AT) {
      nodes { id name createdAt tags }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ORDER_QUERY = `#graphql
  query BackorderOrder($id: ID!, $after: String) {
    shop { name ianaTimezone }
    order(id: $id) {
      id name email createdAt cancelledAt test tags
      customer { email firstName }
      shippingAddress { firstName }
      lineItems(first: 100, after: $after) {
        nodes {
          id sku title variantTitle currentQuantity unfulfilledQuantity
          image { url altText }
          variant {
            id sku image { url altText }
            product { vendor }
            availability: metafield(namespace: "custom", key: "product_availability") { type value }
            availabilityDate: metafield(namespace: "custom", key: "product_availability_date") { type value }
            buildToOrderMessage: metafield(namespace: "custom", key: "build_to_order_message") { type value }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export async function queryBackorderShopify(admin, query, variables) {
  const response = await admin.graphql(query, {variables, signal: AbortSignal.timeout(15000), tries: 1});
  const result = await response.json();
  if (!response.ok || result.errors?.length || !result.data) {
    throw new Error("Shopify could not read order/product data. Check access scopes, offline access, and API availability.");
  }
  return result.data;
}

export async function loadBackorderOrder(admin, orderId, now = new Date()) {
  let after = null;
  let order;
  let shop;
  const lineItems = [];
  const deadline = Date.now() + 25000;
  // Never send from a partial list. Unusually large orders go to review.
  for (let page = 0; page < 20; page += 1) {
    if (Date.now() >= deadline) throw new Error("Order lookup exceeded its time budget; no partial notice was sent.");
    const data = await queryBackorderShopify(admin, ORDER_QUERY, {id: orderId, after});
    shop = data.shop;
    order = data.order;
    if (!order) return {order: null};
    lineItems.push(...order.lineItems.nodes);
    if (!order.lineItems.pageInfo.hasNextPage) {
      const today = formatStoreDate(now, shop.ianaTimezone);
      if (!today) throw new Error("Shopify store timezone is missing or invalid.");
      return {
        order: {...order, lineItems},
        shopName: shop.name,
        timeZone: shop.ianaTimezone,
        today,
      };
    }
    const cursor = order.lineItems.pageInfo.endCursor;
    if (!cursor || cursor === after) throw new Error("Shopify returned an incomplete order item page.");
    after = cursor;
  }
  throw new Error("Order exceeds 2,000 items; manual review is required.");
}
