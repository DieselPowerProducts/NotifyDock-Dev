/* global globalThis */
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {build} from "esbuild";

test("order webhooks process only their eligible new order, lock concurrent work, and reuse retries", async () => {
  const savedEnv = {...process.env};
  const shop = "pilot.myshopify.com";
  Object.assign(process.env, {NOTIFY_DOCK_AUTOMATION_MODE: "live", NOTIFY_DOCK_AUTOMATION_SHOPS: shop,
    NOTIFY_DOCK_AUTOMATION_START_AT: "2026-09-24T21:40:39Z", NOTIFY_DOCK_FOLLOWUP_ENABLED: "false"});
  const cutoff = new Date(process.env.NOTIFY_DOCK_AUTOMATION_START_AT);
  const rows = [], sends = [], histories = [], loads = [];
  const orders = new Map();
  let failSend = false;
  let beforeLoad = () => {};
  const orderFor = (id) => ({id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: "2026-09-24T21:53:00Z",
    tags: ["Backorder"], email: "audit@example.com", lineItems: [{id: `L${id}`, sku: `RH-${id}`, title: "Red Head",
      currentQuantity: 1, unfulfilledQuantity: 1, variant: {id: `V${id}`, product: {vendor: "Red-Head Steering Gears Inc."},
        availability: {value: "Backorder"}, availabilityDate: {type: "date", value: "2026-10-15"}}}]});
  const eventFor = (order) => ({shop, payload: {admin_graphql_api_id: order.id, name: order.name, tags: "Backorder", created_at: order.createdAt}});
  const matches = (row, where) => Object.entries(where).every(([k, v]) => {
    if (k === "OR") return v.some((condition) => matches(row, condition));
    if (v === null) return row[k] == null;
    if (typeof v === "object") return v.in ? v.in.includes(row[k]) : v.lt ? row[k] < v.lt : true;
    return row[k] === v;
  });
  const db = {
    notifyDockAutomationPolicy: {findUnique: async () => ({startAt: cutoff})},
    notifyDockBackorderJob: {
      createMany: async ({data}) => {for (const row of data) if (!rows.some((r) => r.id === row.id)) rows.push({...row, status: "queued"});},
      updateMany: async ({where, data}) => {const selected = rows.filter((r) => matches(r, where)); selected.forEach((r) => Object.assign(r, data)); return {count: selected.length};},
      findUnique: async ({where}) => structuredClone(rows.find((r) => matches(r, where))),
      update: async ({where, data}) => Object.assign(rows.find((r) => matches(r, where)), data),
    },
    notifyDockEmailHistory: {findFirst: async ({where}) => histories.find((r) => matches(r, where)),
      upsert: async ({create}) => {if (!histories.some((r) => r.sourceEventId === create.sourceEventId)) histories.push(create); return {...create, id: "history"};}},
    $transaction: async (fn) => fn(db),
  };
  globalThis.webhookTest = {db,
    load: async (_admin, id) => {loads.push(id); beforeLoad(id); await new Promise((r) => setTimeout(r, 5));
      return {order: orders.get(id), today: "2026-09-24", timeZone: "America/Los_Angeles"};},
    send: async (payload) => {sends.push(structuredClone(payload)); if (failSend) throw new Error("Provider unavailable"); return {metricName: "audit"};},
  };
  try {
    const bundle = await build({entryPoints: ["app/backorder-automation.server.js"], bundle: true, platform: "node", format: "esm", write: false,
      plugins: [{name: "offline-services", setup(b) {
        b.onResolve({filter: /\/(db|shopify|klaviyo)\.server$|\/backorder-automation-shopify\.js$/}, (a) => ({path: a.path, namespace: "mock"}));
        b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
          a.path.includes("db.server") ? "export default globalThis.webhookTest.db;"
            : a.path.includes("shopify.server") ? "export const unauthenticated={admin:async()=>({admin:{}})};"
              : a.path.includes("klaviyo") ? "export const METRIC_NAMES={dynamic_shipping_delay:'audit'};export const sendNotifyDockEvent=globalThis.webhookTest.send;"
                : "export const loadBackorderOrder=globalThis.webhookTest.load;"}));
      }}]});
    const {processBackorderWebhook: processEvent} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    for (const createdAt of ["2026-09-24T21:40:38Z", "2026-01-01T00:00:00Z", "", undefined]) {
      const old = {...orderFor(1), createdAt};
      assert.equal(await processEvent(eventFor(old)), "ignored");
    }
    assert.equal(rows.length, 0); assert.equal(loads.length, 0); assert.equal(sends.length, 0);
    // A fresh webhook timestamp cannot make an old actual Shopify order eligible.
    orders.set(orderFor(2).id, {...orderFor(2), createdAt: "2026-01-01T00:00:00Z"});
    assert.equal(await processEvent(eventFor(orderFor(2))), "skipped");
    assert.equal(sends.length, 0);
    const first = orderFor(3); orders.set(first.id, first);
    const results = await Promise.all([processEvent(eventFor(first)), processEvent(eventFor(first))]);
    assert.ok(results.includes("accepted")); assert.ok(results.includes("busy"));
    assert.equal(sends.length, 1); assert.equal(histories.length, 1);
    assert.equal(await processEvent(eventFor(first)), "complete");
    assert.equal(sends.length, 1);
    // A queued unrelated order must never get drained by this event.
    rows.push({id: "unrelated", shop, orderId: "gid://shopify/Order/999", status: "queued"});
    const second = orderFor(4); orders.set(second.id, second);
    failSend = true;
    assert.equal(await processEvent(eventFor(second)), "retry");
    failSend = false;
    assert.equal(await processEvent(eventFor(second)), "accepted");
    assert.equal(sends.length, 3); assert.deepEqual(sends[1], sends[2]);
    assert.equal(histories.length, 2);
    assert.ok(!loads.includes("gid://shopify/Order/999"));
    assert.equal(rows.find((r) => r.id === "unrelated").status, "queued");
    process.env.NOTIFY_DOCK_AUTOMATION_START_AT = "2026-01-01T00:00:00Z";
    await assert.rejects(processEvent(eventFor(orderFor(5))));
    assert.equal(sends.length, 3);
    process.env.NOTIFY_DOCK_AUTOMATION_START_AT = cutoff.toISOString();

    // Tag present at creation: the very first event sends, with no scan/refresh.
    const taggedAtCreation = orderFor(10); orders.set(taggedAtCreation.id, taggedAtCreation);
    assert.equal(await processEvent(eventFor(taggedAtCreation)), "accepted");
    assert.equal(sends.length, 4);

    // Created without a tag, followed by a later update adding it.
    const laterTagged = orderFor(11); orders.set(laterTagged.id, laterTagged);
    const untaggedEvent = eventFor(laterTagged); untaggedEvent.payload.tags = "VIP";
    laterTagged.tags = ["VIP"];
    assert.equal(await processEvent(untaggedEvent), "ignored");
    assert.ok(!rows.some((r) => r.orderId === laterTagged.id));
    laterTagged.tags = ["VIP", "Backorder"];
    const taggedEvent = eventFor(laterTagged); taggedEvent.payload.tags = "VIP, Backorder";
    assert.equal(await processEvent(taggedEvent), "accepted");
    assert.equal(sends.length, 5);
    // Late/reordered creation delivery and repeated updates cannot send again.
    assert.equal(await processEvent(untaggedEvent), "ignored");
    assert.equal(await processEvent(taggedEvent), "complete");
    assert.equal(sends.length, 5);

    // Missing customer information can be supplied on a subsequent order update.
    const pending = orderFor(12); pending.email = ""; orders.set(pending.id, pending);
    assert.equal(await processEvent(eventFor(pending)), "waiting");
    pending.email = "audit@example.com";
    assert.equal(await processEvent(eventFor(pending)), "accepted");
    assert.equal(sends.length, 6);

    // Older-order edits cannot alter eligibility, including adding a Red Head item,
    // changing availability/ETA/message, retagging, and a brand-new updated_at.
    const unchanged = {rows: rows.length, loads: loads.length, sends: sends.length};
    const mutations = [
      (o) => {o.tags = ["Backorder"];},
      (o) => {o.lineItems.push(structuredClone(orderFor(80).lineItems[0]));},
      (o) => {o.tags = ["VIP", "Backorder"]; o.lineItems = orderFor(81).lineItems;},
      (o) => {o.lineItems[0].variant.availability.value = "Built to Order";
        o.lineItems[0].variant.buildToOrderMessage = {value: "Ships in two weeks", type: "single_line_text_field"};},
      (o) => {o.lineItems[0].variant.availabilityDate.value = "2027-01-01";},
      (o) => {o.email = "different@example.com"; o.processedAt = "2026-09-25T00:00:00Z";},
    ];
    for (const createdAt of ["2026-09-24T21:40:38.999Z", "2026-09-24T14:40:38.999-07:00", "2025-01-01T00:00:00Z"]) {
      for (const mutate of mutations) {
        const old = {...orderFor(20), createdAt}; mutate(old); orders.set(old.id, old);
        const event = eventFor(old); event.payload.updated_at = "2026-09-25T00:00:00Z";
        assert.equal(await processEvent(event), "ignored");
      }
    }
    assert.deepEqual({rows: rows.length, loads: loads.length, sends: sends.length}, unchanged);

    // Even a selection that already passed cannot bypass the final fresh lookup.
    const changedBeforeSend = orderFor(30); orders.set(changedBeforeSend.id, changedBeforeSend);
    let reads = 0;
    beforeLoad = (id) => {
      if (id === changedBeforeSend.id && ++reads === 2) changedBeforeSend.createdAt = "2025-01-01T00:00:00Z";
    };
    assert.equal(await processEvent(eventFor(changedBeforeSend)), "retry");
    assert.equal(reads, 2); assert.equal(sends.length, 6);
    assert.ok(rows.find((r) => r.orderId === changedBeforeSend.id).sendPayload,
      "A saved payload still cannot bypass the final cutoff check");
  } finally {
    delete globalThis.webhookTest;
    for (const key of ["NOTIFY_DOCK_AUTOMATION_MODE", "NOTIFY_DOCK_AUTOMATION_SHOPS", "NOTIFY_DOCK_AUTOMATION_START_AT", "NOTIFY_DOCK_FOLLOWUP_ENABLED"]) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
});

test("production has one daily Pacific schedule and no Vercel pollers", () => {
  assert.deepEqual(JSON.parse(readFileSync("vercel.json", "utf8")).crons, []);
  const workflow = readFileSync("docs/workflow-templates/backorder-followups.yml", "utf8");
  assert.match(workflow, /cron: '0 16 \* \* \*'/);
  assert.match(workflow, /timezone: America\/Los_Angeles/);
  assert.doesNotMatch(workflow, /workflow_dispatch|\/api\/cron\/backorders/);
});

test("webhook route acknowledges completed work and asks Shopify to retry busy/failed work", async () => {
  globalThis.webhookRouteTest = {topic: "ORDERS_UPDATED", result: "accepted", keptAlive: 0, calls: 0};
  try {
    const bundle = await build({entryPoints: ["app/routes/webhooks.orders.updated.jsx"], bundle: true, platform: "node", format: "esm", write: false,
      plugins: [{name: "mock-webhook", setup(b) {
        b.onResolve({filter: /shopify\.server$|backorder-automation\.server$|^@vercel\/functions$/}, (a) => ({path: a.path, namespace: "mock"}));
        b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
          a.path.includes("shopify.server") ? "export const authenticate={webhook:async()=>({shop:'pilot.myshopify.com',payload:{},topic:globalThis.webhookRouteTest.topic})};"
            : a.path.includes("vercel") ? "export const waitUntil=()=>{globalThis.webhookRouteTest.keptAlive++;};"
              : "export const processBackorderWebhook=async()=>{globalThis.webhookRouteTest.calls++;return globalThis.webhookRouteTest.result;};"}));
      }}]});
    const {action} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    for (const topic of ["ORDERS_CREATE", "ORDERS_UPDATED"]) {
      globalThis.webhookRouteTest.topic = topic;
      for (const [result, expected] of [["accepted", 200], ["ignored", 200], ["complete", 200], ["waiting", 200], ["busy", 503], ["retry", 503]]) {
        globalThis.webhookRouteTest.result = result;
        assert.equal((await action({request: new Request("https://test/webhook", {method: "POST"})})).status, expected);
      }
    }
    assert.equal(globalThis.webhookRouteTest.keptAlive, 12);
    globalThis.webhookRouteTest.topic = "PRODUCTS_UPDATE";
    assert.equal((await action({request: new Request("https://test/webhook", {method: "POST"})})).status, 400);
    assert.equal(globalThis.webhookRouteTest.calls, 12);
  } finally { delete globalThis.webhookRouteTest; }
});
