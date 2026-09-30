import assert from "node:assert/strict";
import {test} from "node:test";
import {processBackorderJob} from "../app/backorder-automation-worker.js";
import {getBackorderAutomationConfig, selectBackorderNotice} from "../app/backorder-automation.js";

const config = getBackorderAutomationConfig({NOTIFY_DOCK_AUTOMATION_MODE: "live",
  NOTIFY_DOCK_AUTOMATION_SHOPS: "pilot.myshopify.com", NOTIFY_DOCK_AUTOMATION_START_AT: "2026-09-24T21:55:00Z"});
const line = (id, date) => ({id, sku: id, title: id, currentQuantity: 1, unfulfilledQuantity: 1,
  variant: {id: `v-${id}`, product: {vendor: "Red-Head Steering Gears Inc."}, availability: {value: "Backorder"},
    availabilityDate: date ? {type: "date", value: date} : null}});
const order = {id: "gid://shopify/Order/1", name: "#1", createdAt: "2026-09-24T21:56:00Z", tags: ["Backorder"],
  email: "test@example.com", lineItems: [line("GENERIC"), line("SPECIFIC", "2026-10-15")]};
const loaded = {order, today: "2026-09-24", timeZone: "America/Los_Angeles"};

test("cutoff remains configured with initial automation off and rejects malformed timestamps", () => {
  assert.equal(getBackorderAutomationConfig({NOTIFY_DOCK_AUTOMATION_MODE: "off",
    NOTIFY_DOCK_AUTOMATION_START_AT: "2026-09-24T21:40:39Z"}).startAt.toISOString(), "2026-09-24T21:40:39.000Z");
  assert.throws(() => getBackorderAutomationConfig({NOTIFY_DOCK_AUTOMATION_MODE: "off",
    NOTIFY_DOCK_AUTOMATION_START_AT: "invalid"}));
});

test("initial worker excludes older orders even when newly tagged and never contacts sender", async () => {
  for (const createdAt of ["2026-09-24T21:54:59Z", "2025-01-01T00:00:00Z", "invalid"]) {
    for (const status of ["queued", "waiting", "ready", "retry"]) {
      for (const sendPayload of [null, {orderId: order.id, customerEmail: order.email, products: []}]) {
        let sends = 0;
        const result = await processBackorderJob({job: {id: "old", status, sendPayload}, config,
          repository: {update: async () => {}}, loadOrder: async () => ({...loaded, order: {...order, createdAt}}),
          send: async () => {sends++;}, buildMessage: () => "test"});
        assert.equal(result, "skipped"); assert.equal(sends, 0);
      }
    }
  }
});
test("mixed initial notice enrolls only its generic product and freezes stable retry identity", async () => {
  const job = {id: "stable-id", shop: "pilot.myshopify.com"};
  let captured;
  const result = await processBackorderJob({job, config,
    repository: {update: async (_id, data) => {Object.assign(job, data);}, hasPreviousNotice: async () => false,
      complete: async (_job, payload) => {captured = payload;}}, loadOrder: async () => loaded,
    send: async (payload) => {assert.equal(job.sendPayload, payload); return {metricName: "test"};}, buildMessage: () => "test"});
  assert.equal(result, "accepted");
  assert.deepEqual(captured.products.map((p) => p.sku), ["GENERIC", "SPECIFIC"]);
  assert.deepEqual(captured.followupCandidates.map((p) => p.sku), ["GENERIC"]);
  assert.equal(captured.requestEventUniqueId, "stable-id");
});
test("tag, vendor, and previously sent notice gates remain enforced", async () => {
  assert.equal(selectBackorderNotice({...loaded, config, order: {...order, tags: ["Backordered"]}}).status, "skipped");
  const other = structuredClone(order); other.lineItems.forEach((p) => {p.variant.product.vendor = "Other";});
  assert.equal(selectBackorderNotice({...loaded, config, order: other}).status, "waiting");
  const result = await processBackorderJob({job: {id: "manual-already-sent"}, config,
    repository: {update: async () => {}, hasPreviousNotice: async () => true}, loadOrder: async () => loaded,
    send: async () => assert.fail("Already notified orders must not send"), buildMessage: () => "test"});
  assert.equal(result, "previously_notified");
});
