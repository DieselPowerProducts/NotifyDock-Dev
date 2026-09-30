/* global globalThis */
import assert from "node:assert/strict";
import {test, after} from "node:test";
import {build} from "esbuild";
import {selectBackorderNotice} from "../app/backorder-automation.js";
import {genericFollowupCandidates, resolveFollowupItem} from "../app/backorder-followup.js";

const shop = "pilot.myshopify.com";
const originalCutoff = "2026-09-24T21:40:39Z";
const rollout = "2026-09-30T22:30:00Z";
const day = (n) => new Date(`2026-10-${String(n).padStart(2, "0")}T23:00:00Z`);
const line = (id, vendor, availability = "Backorder") => ({id, sku: id, title: id,
  currentQuantity: 1, unfulfilledQuantity: 1, variant: {id: `v-${id}`, product: {vendor},
    availability: {value: availability}, availabilityDate: null, buildToOrderMessage: null}});
const freshOrder = () => ({id: "gid://shopify/Order/123", name: "#123", createdAt: rollout,
  tags: ["Backorder"], email: "original@example.com", lineItems: [
    line("A", "Industrial Injection"), line("B", "BD Diesel", "Built to Order"),
    line("C", "Red-Head Steering Gears Inc."), line("D", "", "In Stock"),
  ]});

test("mixed vendors use the same initial rules and only generic emailed items enroll", () => {
  const order = freshOrder();
  order.lineItems[2].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  const input = {order, config: {startAt: new Date(rollout)}, today: "2026-09-30", timeZone: "America/Los_Angeles"};
  const selected = selectBackorderNotice(input);
  assert.equal(selected.status, "ready");
  assert.deepEqual(selected.payload.products.map((p) => p.sku), ["A", "B", "C"]);
  assert.deepEqual(genericFollowupCandidates({order, ...selected.payload}).map((p) => p.sku), ["A", "B"]);
  // Vendor labels, including empty ones, do not participate in eligibility.
  order.lineItems[0].variant.product = null;
  assert.equal(selectBackorderNotice(input).status, "ready");
  order.tags = [];
  assert.equal(selectBackorderNotice(input).status, "skipped");
});

test("non-Red-Head follow-ups keep date validation and stop on status, identity or fulfillment changes", () => {
  const order = freshOrder(), record = {lineItemId: "A", variantId: "v-A", sku: "A", kind: "backorder"};
  const loaded = {order, today: "2026-10-01", timeZone: "America/Los_Angeles"};
  for (const value of ["", "bad", "2026-02-30", "2026-09-30"]) {
    order.lineItems[0].variant.availabilityDate = {type: "date", value};
    assert.equal(resolveFollowupItem(record, loaded).status, "pending");
  }
  order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  assert.equal(resolveFollowupItem(record, loaded).status, "ready");
  for (const availability of ["In Stock", "Discontinued", "Built to Order", ""]) {
    order.lineItems[0].variant.availability.value = availability;
    assert.equal(resolveFollowupItem(record, loaded).status, "skipped");
  }
  order.lineItems[0].variant.availability.value = "Backorder";
  order.lineItems[0].unfulfilledQuantity = 0;
  assert.equal(resolveFollowupItem(record, loaded).status, "skipped");
});

const state = {};
globalThis.allVendorTest = state;
const matches = (r, where) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if (v.in) return v.in.includes(r[k]);
    if (Object.hasOwn(v, "not")) return r[k] !== v.not;
    if (v.lte) return r[k] <= v.lte;
    if (v.lt) return r[k] < v.lt;
  }
  return r[k] === v;
});
const model = (key) => ({
  findFirst: async ({where}) => structuredClone(state[key].find((r) => matches(r, where)) || null),
  findMany: async ({where, take}) => structuredClone(state[key].filter((r) => matches(r, where)).slice(0, take)),
  count: async ({where}) => state[key].filter((r) => matches(r, where)).length,
  create: async ({data}) => {
    assert.ok(!state[key].some((r) => r.id === data.id), "Unique identity must be preserved");
    const r = {...structuredClone(data), status: "pending", createdAt: state.now}; state[key].push(r); return structuredClone(r);
  },
  createMany: async ({data}) => {for (const r of data) if (!state[key].some((x) => x.id === r.id)) {
    state[key].push({...structuredClone(r), status: "pending", initialHistory: structuredClone(state.history)});
  }},
  update: async ({where, data}) => Object.assign(state[key].find((r) => matches(r, where)), structuredClone(data)),
  updateMany: async ({where, data}) => {
    const rows = state[key].filter((r) => matches(r, where)); rows.forEach((r) => Object.assign(r, structuredClone(data))); return {count: rows.length};
  },
  upsert: async ({create}) => {
    const old = state[key].find((r) => r.sourceEventId === create.sourceEventId);
    if (old) return old; state[key].push(structuredClone(create)); return create;
  },
});
state.db = {
  notifyDockAutomationPolicy: {findUnique: async () => ({startAt: new Date(originalCutoff), initialStartAt: new Date(rollout)})},
  notifyDockFollowupItem: model("rows"), notifyDockFollowupBatch: model("batches"), notifyDockEmailHistory: model("histories"),
  notifyDockFollowupLease: {
    upsert: async () => {},
    updateMany: async ({where, data}) => {
      if (where.OR && state.leased) return {count: 0};
      if (where.token && where.token !== state.leaseToken) return {count: 0};
      state.leased = !!data.token; state.leaseToken = data.token; return {count: 1};
    },
    update: async () => {},
  },
  $transaction: async (arg) => typeof arg === "function" ? arg(state.db) : Promise.all(arg),
};
state.load = async () => {
  state.loads++;
  state.beforeLoad?.(state.loads);
  return {order: structuredClone(state.order), today: state.now.toISOString().slice(0, 10), timeZone: "America/Los_Angeles"};
};
state.send = async (payload) => {
  state.sends.push(structuredClone(payload));
  if (state.failSend) throw new Error("Uncertain provider response");
  return {metricName: "test"};
};
const bundle = await build({entryPoints: ["app/backorder-followup.server.js"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{name: "offline-all-vendor", setup(b) {
    b.onResolve({filter: /\/(db|shopify|klaviyo)\.server$|\/backorder-automation-shopify\.js$/}, (a) => ({path: a.path, namespace: "mock"}));
    b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
      a.path.includes("db.server") ? "export default globalThis.allVendorTest.db;"
        : a.path.includes("shopify.server") ? "export const unauthenticated={admin:async()=>({admin:{}})};"
          : a.path.includes("klaviyo") ? "export const METRIC_NAMES={dynamic_shipping_delay:'test'};export const sendNotifyDockEvent=globalThis.allVendorTest.send;"
            : "export const loadBackorderOrder=globalThis.allVendorTest.load;"}));
  }}]});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
after(() => {delete globalThis.allVendorTest;});
async function fixture(run) {
  const values = {NOTIFY_DOCK_AUTOMATION_MODE: "live", NOTIFY_DOCK_AUTOMATION_SHOPS: shop,
    NOTIFY_DOCK_AUTOMATION_START_AT: originalCutoff, NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT: rollout,
    NOTIFY_DOCK_FOLLOWUP_ENABLED: "true", NOTIFY_DOCK_FOLLOWUP_SHOPS: shop, NOTIFY_DOCK_FOLLOWUP_TEST_AT: ""};
  const saved = {...process.env}; Object.assign(process.env, values);
  Object.assign(state, {order: freshOrder(), now: day(1), rows: [], batches: [], histories: [], sends: [],
    loads: 0, leased: false, leaseToken: null, failSend: false, beforeLoad: null});
  state.history = {id: "initial", shop, orderId: state.order.id, orderNumber: state.order.name,
    source: "backorder_automation", requestEventUniqueId: "initial-accepted", emailType: "dynamic_shipping_delay", customerEmail: "original@example.com"};
  const enroll = async () => {
    const selected = selectBackorderNotice({order: state.order, config: {startAt: new Date(originalCutoff)},
      today: "2026-09-30", timeZone: "America/Los_Angeles"});
    assert.equal(selected.status, "ready");
    await api.saveFollowupTracking(state.history, genericFollowupCandidates({order: state.order, ...selected.payload}), new Date(rollout));
  };
  const runDay = async (n) => {state.now = day(n); return api.runBackorderFollowups(state.now);};
  try {await run({enroll, runDay});}
  finally {for (const k of Object.keys(values)) {if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];}}
}

test("staggered vendor estimates send once per item, grouped by day, until tracking is finished", async () => fixture(async ({enroll, runDay}) => {
  await enroll(); assert.equal(state.rows.length, 3);
  await runDay(1); assert.equal(state.sends.length, 0);
  const loadsAfterFirst = state.loads;
  await runDay(1); assert.equal(state.loads, loadsAfterFirst, "No repeat checks on the same day");
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  await runDay(2); assert.equal(state.sends.length, 1);
  assert.deepEqual(state.sends[0].products.map((p) => p.sku), ["A"]);
  assert.equal(state.rows.find((r) => r.sku === "A").status, "accepted");
  assert.ok(state.rows.filter((r) => r.sku !== "A").every((r) => r.status === "pending"));
  // Tomorrow only B's new message is emailed; A changing its date does not restart A.
  state.order.lineItems[0].variant.availabilityDate.value = "2026-10-30";
  state.order.lineItems[1].variant.buildToOrderMessage = {type: "single_line_text_field", value: "Ships in 2 weeks"};
  await runDay(3); assert.equal(state.sends.length, 2);
  assert.deepEqual(state.sends[1].products.map((p) => p.sku), ["B"]);
  state.order.lineItems[2].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  await runDay(4); assert.equal(state.sends.length, 3);
  assert.deepEqual(state.sends[2].products.map((p) => p.sku), ["C"]);
  assert.ok(state.rows.every((r) => r.status === "accepted"));
  const completedLoads = state.loads;
  await runDay(5); assert.equal(state.sends.length, 3); assert.equal(state.loads, completedLoads);
  assert.equal(new Set(state.sends.map((p) => p.requestEventUniqueId)).size, 3);
}));

test("in-stock items terminate without sending and never restart if backordered again", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.order.lineItems[0].variant.availability.value = "In Stock";
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  await runDay(1); assert.equal(state.sends.length, 0); assert.equal(state.rows[0].status, "skipped");
  const loads = state.loads;
  state.order.lineItems[0].variant.availability.value = "Backorder";
  await runDay(2); assert.equal(state.loads, loads); assert.equal(state.sends.length, 0);
}));

test("existing Red Head tracking survives the new cutoff, and other vendors use their original field types", async () => fixture(async ({enroll, runDay}) => {
  state.order.createdAt = "2026-09-25T12:00:00Z";
  await enroll();
  state.order.lineItems[1].variant.buildToOrderMessage = {type: "single_line_text_field", value: "Ships in 2 weeks"};
  state.order.lineItems[2].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  await runDay(1); assert.equal(state.sends.length, 1);
  assert.deepEqual(state.sends[0].products.map((p) => p.sku), ["B", "C"]);
}));

test("uncertain follow-up retries preserve one event and the original recipient", async () => fixture(async ({enroll, runDay}) => {
  await enroll(); state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  state.failSend = true; await runDay(1); assert.equal(state.sends.length, 1);
  state.failSend = false; state.order.email = "changed@example.com";
  await runDay(2); assert.equal(state.sends.length, 2); assert.deepEqual(state.sends[0], state.sends[1]);
  assert.equal(state.batches.length, 1);
  await runDay(3); assert.equal(state.sends.length, 2);
}));

test("a last-moment availability change is rechecked before contacting Klaviyo", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  state.beforeLoad = (count) => {if (count === 2) state.order.lineItems[0].variant.availability.value = "In Stock";};
  await runDay(1); assert.equal(state.sends.length, 0);
  await runDay(2); assert.equal(state.sends.length, 0); assert.equal(state.batches[0].status, "held");
  assert.ok(state.rows.every((r) => r.status === "skipped"));
}));

test("five products receive five staggered updates on five different days", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = Array.from({length: 5}, (_, n) => line(`SKU-${n}`, `Vendor ${n}`));
  await enroll();
  for (let n = 0; n < 5; n++) {
    state.order.lineItems[n].variant.availabilityDate = {type: "date", value: "2026-10-20"};
    await runDay(n + 1);
    assert.equal(state.sends.length, n + 1);
    assert.deepEqual(state.sends[n].products.map((p) => p.sku), [`SKU-${n}`]);
  }
  const loads = state.loads;
  await runDay(6); assert.equal(state.loads, loads); assert.equal(state.sends.length, 5);
}));
