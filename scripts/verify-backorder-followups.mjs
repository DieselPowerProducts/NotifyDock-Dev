/* global globalThis */
import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";
import {genericFollowupCandidates, nextFollowupCheck, resolveFollowupItem, isFollowupRunHour} from "../app/backorder-followup.js";
const now = new Date("2026-09-24T20:55:00Z");
const line = (id, kind = "Backorder") => ({id, sku: id, title: id, currentQuantity: 1, unfulfilledQuantity: 1,
  variant: {id: `v-${id}`, product: {vendor: "Red-Head Steering Gears Inc."}, availability: {value: kind},
    availabilityDate: {type: "date", value: "2026-10-15"}, buildToOrderMessage: {type: "single_line_text_field", value: "Ships in 2 weeks"}}});
const order = {id: "gid://shopify/Order/1", name: "#1", createdAt: "2026-09-24T20:00:00Z", tags: ["Backorder"], lineItems: [line("A"), line("B", "Built to Order"), line("UNTRACKED")]};
test("daily checks use 4pm Pacific through daylight saving, with one future test time", () => {
  assert.equal(nextFollowupCheck(now).toISOString(), "2026-09-24T23:00:00.000Z");
  assert.equal(nextFollowupCheck(new Date("2026-12-01T20:00:00Z")).toISOString(), "2026-12-02T00:00:00.000Z");
  assert.equal(nextFollowupCheck(new Date("2026-09-24T20:50:00Z"), now.toISOString()).toISOString(), now.toISOString());
  assert.equal(nextFollowupCheck(now, now.toISOString()).toISOString(), "2026-09-24T23:00:00.000Z");
  assert.equal(nextFollowupCheck(new Date("2026-09-24T23:01:00Z")).toISOString(), "2026-09-25T23:00:00.000Z");
  for (const [date, expected] of [
    ["2026-09-24T22:59:59Z", false], ["2026-09-24T23:00:00Z", true],
    ["2026-09-24T23:05:00Z", true], ["2026-09-25T00:00:00Z", false],
    ["2026-12-01T23:00:00Z", false], ["2026-12-02T00:00:00Z", true],
  ]) assert.equal(isFollowupRunHour(new Date(date)), expected, date);
});
test("only generic items actually included in the manual email can be tracked", () => {
  const input = {order, emailType: "dynamic_shipping_delay", products: [{sku: "A", delayState: "no_confirmed_date"}, {sku: "B", delayState: "build_to_order_message", delayMessage: "Ships soon"}]};
  assert.deepEqual(genericFollowupCandidates(input).map((r) => r.sku), ["A"]);
  assert.deepEqual(genericFollowupCandidates({...input, products: [input.products[0],
    {sku: "B", delayState: "specific_date", delayDate: "2026-10-15"}]}).map((r) => r.sku), ["A"]);
  assert.deepEqual(genericFollowupCandidates({...input, globalShipDate: "2026-10-15"}), []);
  assert.deepEqual(genericFollowupCandidates({...input, emailType: "awaiting_stock"}), []);
  assert.deepEqual(genericFollowupCandidates({...input, order: {...order, cancelledAt: now}}), []);
});
test("resolution checks exact item/variant, fulfillment and the original field type", () => {
  const record = {lineItemId: "A", variantId: "v-A", sku: "A", kind: "backorder"};
  const loaded = {order, today: "2026-09-24", timeZone: "America/Los_Angeles"};
  assert.equal(resolveFollowupItem(record, loaded).status, "ready");
  assert.equal(resolveFollowupItem({...record, variantId: "other"}, loaded).status, "skipped");
  assert.equal(resolveFollowupItem(record, {...loaded, order: {...order, cancelledAt: now}}).status, "skipped");
  const pending = structuredClone(order); pending.lineItems[0].variant.availabilityDate = null;
  assert.equal(resolveFollowupItem(record, {...loaded, order: pending}).status, "pending");
  pending.lineItems[0].unfulfilledQuantity = 0;
  assert.equal(resolveFollowupItem(record, {...loaded, order: pending}).status, "skipped");
});

test("worker only sends tracked items to the initial recipient and deduplicates uncertain retries", async () => {
  const shop = "pilot.myshopify.com";
  const savedEnv = {...process.env};
  process.env.NOTIFY_DOCK_FOLLOWUP_ENABLED = "true";
  process.env.NOTIFY_DOCK_FOLLOWUP_SHOPS = shop;
  process.env.NOTIFY_DOCK_AUTOMATION_MODE = "off";
  process.env.NOTIFY_DOCK_AUTOMATION_SHOPS = shop;
  process.env.NOTIFY_DOCK_AUTOMATION_START_AT = "2026-09-24T19:00:00Z";
  const history = {id: "history-1", shop, orderId: order.id, orderNumber: order.name,
    source: "backorder_automation", requestEventUniqueId: "initial-accepted", emailType: "dynamic_shipping_delay", customerEmail: "work@example.com"};
  const rows = [];
  const batches = [];
  const sends = [];
  const histories = [];
  const lease = {};
  let failComplete = false;
  let policy = {startAt: new Date("2026-09-24T19:00:00Z")};
  let failPolicyRead = false;
  const matches = (row, where) => Object.entries(where).every(([key, value]) =>
    value && typeof value === "object" && !(value instanceof Date)
      ? value.in ? value.in.includes(row[key]) : value.lte ? row[key] <= value.lte : true
      : row[key] === value);
  const db = {
    notifyDockAutomationPolicy: {findUnique: async () => {if (failPolicyRead) throw new Error("Database unavailable"); return policy;}},
    notifyDockFollowupLease: {
      upsert: async () => lease,
      updateMany: async ({where, data}) => {
        if ((where.token && lease.token !== where.token) || (where.OR && lease.leaseUntil > now)) return {count: 0};
        Object.assign(lease, data); return {count: 1};
      },
      update: async ({data}) => Object.assign(lease, data),
    },
    notifyDockFollowupItem: {
      count: async ({where}) => rows.filter((r) => matches(r, where)).length,
      createMany: async ({data}) => { for (const row of data) if (!rows.some((r) => r.id === row.id)) rows.push({...row, status: "pending", initialHistory: history}); },
      findMany: async ({where}) => rows.filter((r) => matches(r, where)).map((r) => structuredClone(r)),
      update: async ({where, data}) => Object.assign(rows.find((r) => matches(r, where)), data),
      updateMany: async ({where, data}) => { rows.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, data)); },
    },
    notifyDockFollowupBatch: {
      count: async ({where}) => batches.filter((r) => matches(r, where)).length,
      findMany: async ({where}) => batches.filter((r) => matches(r, where)).map((r) => structuredClone(r)),
      create: async ({data}) => { const row = {...data, status: "pending"}; batches.push(row); return row; },
      update: async ({where, data}) => Object.assign(batches.find((r) => matches(r, where)), data),
    },
    notifyDockEmailHistory: {upsert: async ({create}) => { histories.push(create); return create; }},
    $transaction: async (arg) => {
      if (typeof arg === "function") return arg(db);
      if (failComplete) { batches[0].status = "pending"; rows.forEach((r) => {r.status = "batched";}); throw new Error("Database failure after provider acceptance"); }
      return Promise.all(arg);
    },
  };
  globalThis.followupTest = {db, load: async () => ({order, today: "2026-09-24", timeZone: "America/Los_Angeles"}),
    send: async (payload) => {assert.ok(batches.some((b) => b.id === payload.requestEventUniqueId)); sends.push(structuredClone(payload)); return {metricName: "test"};}};
  try {
    const bundle = await build({entryPoints: ["app/backorder-followup.server.js"], bundle: true, platform: "node", format: "esm", write: false,
      plugins: [{name: "mock-services", setup(b) {
        b.onResolve({filter: /\/(db|shopify|klaviyo)\.server$|\/backorder-automation-shopify\.js$/}, (a) => ({path: a.path, namespace: "mock"}));
        b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
          a.path.includes("db.server") ? "export default globalThis.followupTest.db;"
            : a.path.includes("shopify.server") ? "export const unauthenticated={admin:async()=>({admin:{}})};"
              : a.path.includes("klaviyo") ? "export const METRIC_NAMES={dynamic_shipping_delay:'test'}; export const sendNotifyDockEvent=globalThis.followupTest.send;"
                : "export const loadBackorderOrder=globalThis.followupTest.load;"}));
      }}]});
    const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    await api.runBackorderFollowups(now);
    assert.equal(sends.length, 0, "No enrollment means no automatic email, even with eligible orders");
    await api.saveFollowupTracking(history, [{lineItemId: "A", variantId: "v-A", sku: "A", kind: "backorder"},
      {lineItemId: "B", variantId: "v-B", sku: "B", kind: "built_to_order"}], new Date("2026-09-23T20:00:00Z"));
    assert.equal(rows.length, 2);
    failComplete = true;
    await api.runBackorderFollowups(now);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].customerEmail, "work@example.com");
    assert.deepEqual(sends[0].products.map((p) => p.sku), ["A", "B"]);
    assert.doesNotMatch(sends[0].message, /UNTRACKED/);
    failComplete = false;
    await api.runBackorderFollowups(nextFollowupCheck(now));
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0], sends[1], "Uncertain retry must use the same event ID and frozen payload");
    await api.runBackorderFollowups(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    assert.equal(sends.length, 2, "Accepted items never send again");
    assert.ok(rows.every((r) => r.status === "accepted"));
    process.env.NOTIFY_DOCK_AUTOMATION_MODE = "off";
    process.env.NOTIFY_DOCK_AUTOMATION_SHOPS = shop;
    order.createdAt = "2026-09-24T18:00:00Z";
    rows.forEach((r) => {r.status = "pending";});
    await api.runBackorderFollowups(new Date("2026-09-25T23:00:00Z"));
    assert.ok(rows.every((r) => r.status === "skipped"), "Pre-activation tracked orders are excluded");
    assert.equal(sends.length, 2);
    batches[0].status = "pending";
    await api.runBackorderFollowups(new Date("2026-09-26T23:00:00Z"));
    assert.equal(batches[0].status, "held", "Pre-activation queued batches cannot send either");
    assert.equal(sends.length, 2);
    // Reproduce both audit findings: existing pending work must stay blocked
    // when settings disappear or change, regardless of the initial-email mode.
    rows.forEach((r) => {r.status = "pending";}); batches[0].status = "pending";
    for (const mode of ["off", "live"]) {
      process.env.NOTIFY_DOCK_AUTOMATION_MODE = mode;
      for (const value of ["", "invalid", "2026-09-24T17:00:00Z", "2026-09-24T21:00:00Z"]) {
        process.env.NOTIFY_DOCK_AUTOMATION_START_AT = value;
        await assert.rejects(api.runBackorderFollowups(new Date("2026-09-27T23:00:00Z")));
        assert.equal(sends.length, 2);
        assert.ok(rows.every((r) => r.status === "pending"));
        assert.deepEqual(await api.prepareFollowupTracking({admin: {}, shop, orderId: order.id,
          products: [{sku: "A", delayState: "no_confirmed_date"}], emailType: "dynamic_shipping_delay"}), []);
      }
    }
    process.env.NOTIFY_DOCK_AUTOMATION_MODE = "off";
    process.env.NOTIFY_DOCK_AUTOMATION_START_AT = "2026-09-24T19:00:00Z";
    policy = null;
    await assert.rejects(api.runBackorderFollowups(now));
    failPolicyRead = true;
    await assert.rejects(api.runBackorderFollowups(now));
    assert.equal(sends.length, 2);
  } finally {
    delete globalThis.followupTest;
    for (const key of ["NOTIFY_DOCK_FOLLOWUP_ENABLED", "NOTIFY_DOCK_FOLLOWUP_SHOPS", "NOTIFY_DOCK_AUTOMATION_MODE", "NOTIFY_DOCK_AUTOMATION_SHOPS", "NOTIFY_DOCK_AUTOMATION_START_AT"]) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
});
