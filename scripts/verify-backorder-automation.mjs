// Run with: npm run test:backorder-automation. All services are mocked; no email is sent.
/* global globalThis */
import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";
import {
  BACKORDER_PILOT_VENDOR, getBackorderAutomationConfig, hasBackorderTag,
  isValidAvailabilityDate, normalizeAvailabilityDate, selectBackorderNotice,
} from "../app/backorder-automation.js";
import {processBackorderJob} from "../app/backorder-automation-worker.js";
import {loadBackorderOrder} from "../app/backorder-automation-shopify.js";

const config = {
  mode: "live", startAt: new Date("2026-09-28T07:00:00Z"),
  fromAddress: "orders@example.com", metricName: "Notify Dock Dynamic Shipping Delay Email Requested",
};
const now = new Date("2026-09-28T12:00:00Z");
function item(sku = "RH-1", overrides = {}) {
  return {
    sku, title: `Product ${sku}`, variantTitle: "Default Title", unfulfilledQuantity: 1, currentQuantity: 1,
    variant: {
      id: `gid://shopify/ProductVariant/${sku}`, sku,
      product: {vendor: BACKORDER_PILOT_VENDOR},
      availability: {value: "Backorder", type: "single_line_text_field"},
      availabilityDate: {value: "2026-10-15", type: "date"},
      ...overrides,
    },
  };
}
function order(overrides = {}) {
  return {
    id: "gid://shopify/Order/123", name: "#123", tags: ["Backorder"],
    createdAt: "2026-09-28T08:00:00Z", email: "customer@example.com",
    customer: {firstName: "Customer"}, lineItems: [item()], ...overrides,
  };
}
const select = (value) => selectBackorderNotice({order: value, config, today: "2026-09-28"});

test("configuration defaults off and requires a deliberate store and activation timestamp", () => {
  assert.equal(getBackorderAutomationConfig({}).mode, "off");
  for (const env of [
    {NOTIFY_DOCK_AUTOMATION_MODE: "live"},
    {NOTIFY_DOCK_AUTOMATION_MODE: "typo"},
    {NOTIFY_DOCK_AUTOMATION_MODE: "live", NOTIFY_DOCK_AUTOMATION_SHOPS: "bad.example.com", NOTIFY_DOCK_AUTOMATION_START_AT: "2026-09-28T00:00:00Z"},
    {NOTIFY_DOCK_AUTOMATION_MODE: "live", NOTIFY_DOCK_AUTOMATION_SHOPS: "test.myshopify.com", NOTIFY_DOCK_AUTOMATION_START_AT: "2026-09-28"},
  ]) assert.throws(() => getBackorderAutomationConfig(env));
  assert.deepEqual(getBackorderAutomationConfig({
    NOTIFY_DOCK_AUTOMATION_MODE: "dry-run", NOTIFY_DOCK_AUTOMATION_SHOPS: "TEST.myshopify.com",
    NOTIFY_DOCK_AUTOMATION_START_AT: "2026-09-28T00:00:00-07:00",
  }).shops, ["test.myshopify.com"]);
});

test("tag matching is exact and accepts Shopify webhook strings", () => {
  assert.ok(hasBackorderTag("VIP, Backorder"));
  assert.ok(hasBackorderTag([" backorder "]));
  assert.equal(hasBackorderTag(["Not Backorder"]), false);
});

test("only new, tagged, uncancelled orders with outstanding items qualify", () => {
  for (const value of [
    null, order({tags: []}), order({createdAt: "2026-09-28T06:59:59Z"}),
    order({cancelledAt: now.toISOString()}), order({test: true}),
    order({lineItems: [{...item(), unfulfilledQuantity: 0}]}),
    order({lineItems: [{...item(), currentQuantity: 0}]}),
  ]) assert.equal(select(value).status, "skipped");
  assert.equal(select(order({createdAt: config.startAt.toISOString()})).status, "ready");
});

test("mixed-vendor order includes only exact Red Head matches and only delayed items", () => {
  const result = select(order({lineItems: [
    item("RH-A"),
    item("RH-B", {availability: {value: "Build to Order"}, availabilityDate: {value: "2026-10-22"}}),
    item("OTHER", {product: {vendor: "Another vendor"}, availabilityDate: null}),
    item("SIMILAR", {product: {vendor: "Red Head"}}),
    item("STOCK", {availability: {value: "In Stock"}, availabilityDate: null}),
    {...item("FULFILLED"), unfulfilledQuantity: 0},
  ]}));
  assert.equal(result.status, "ready");
  assert.deepEqual(result.payload.products.map((p) => [p.sku, p.delayDate]), [
    ["RH-A", "2026-10-15"], ["RH-B", "2026-10-22"],
  ]);
  assert.equal(result.payload.globalShipDate, "");
  assert.equal(result.payload.emailType, "dynamic_shipping_delay");
});

test("missing, malformed, impossible or past date holds the entire notice", () => {
  for (const value of ["", "true", "October 15", "2026-02-30", "2026-13-01", "2026-09-27"]) {
    const result = select(order({lineItems: [item("GOOD"), item("BAD", {availabilityDate: {value}})]}));
    assert.equal(result.status, "waiting", value);
    assert.match(result.reason, /BAD/);
    assert.equal(result.payload, undefined);
  }
  assert.ok(isValidAvailabilityDate("2028-02-29"));
  assert.equal(isValidAvailabilityDate("2026-02-29"), false);
});

test("date_time is converted to the store's calendar date across UTC midnight", () => {
  const field = (value) => ({type: "date_time", value});
  assert.equal(normalizeAvailabilityDate(field("2026-10-16T01:30:00Z"), "America/Los_Angeles"), "2026-10-15");
  assert.equal(normalizeAvailabilityDate(field("2026-10-15T18:30:00-07:00"), "America/Los_Angeles"), "2026-10-15");
  assert.equal(normalizeAvailabilityDate(field("2026-10-15T20:30:00Z"), "Asia/Tokyo"), "2026-10-16");
  assert.equal(normalizeAvailabilityDate(field("2026-10-16T01:30:00.123"), "America/Los_Angeles"), "2026-10-15", "Shopify zone-less date_time values default to GMT");
});

test("conversion follows the store's daylight-saving rules", () => {
  const field = (value) => ({type: "date_time", value});
  assert.equal(normalizeAvailabilityDate(field("2026-07-15T07:30:00Z"), "America/Los_Angeles"), "2026-07-15");
  assert.equal(normalizeAvailabilityDate(field("2026-12-15T07:30:00Z"), "America/Los_Angeles"), "2026-12-14");
});

test("invalid timestamps, unsupported types and missing timezone cannot become send dates", () => {
  for (const value of ["", "true", "2026-10-15", "2026-02-30T12:00:00Z", "2026-10-15T25:00:00Z", "2026-10-15T12:60:00Z", "2026-10-15T12:00:00+99:00", '["2026-10-15T12:00:00Z"]']) {
    assert.equal(normalizeAvailabilityDate({type: "date_time", value}, "America/Los_Angeles"), "", value);
  }
  assert.equal(normalizeAvailabilityDate({type: "boolean", value: "2026-10-15"}, "UTC"), "");
  assert.equal(normalizeAvailabilityDate({type: "date_time", value: "2026-10-15T12:00:00Z"}), "");
  assert.equal(normalizeAvailabilityDate({type: "date_time", value: "2026-10-15T12:00:00Z"}, "Invalid/Timezone"), "");
  assert.equal(normalizeAvailabilityDate({type: "date", value: "2026-10-15"}, "America/Los_Angeles"), "2026-10-15");
});

test("past-date checks use the converted calendar date, not the UTC date", () => {
  const result = selectBackorderNotice({
    order: order({lineItems: [item("RH", {availabilityDate: {type: "date_time", value: "2026-09-28T01:00:00Z"}})]}),
    config, today: "2026-09-28", timeZone: "America/Los_Angeles",
  });
  assert.equal(result.status, "waiting");
  assert.match(result.reason, /past/);
});

test("deleted variants, missing vendor, missing SKU and missing recipient hold the notice", () => {
  for (const value of [
    order({lineItems: [{...item(), variant: null}]}),
    order({lineItems: [item("RH", {product: null})]}),
    order({lineItems: [item("", {sku: ""})]}),
    order({email: ""}), order({email: "bad address"}),
  ]) assert.equal(select(value).status, "waiting");
});

test("orders without matching Red Head backorders wait and duplicate lines are consolidated", () => {
  assert.equal(select(order({lineItems: [item("OTHER", {product: {vendor: "Other"}})]})).status, "waiting");
  assert.equal(select(order({lineItems: [item(), item()]})).payload.products.length, 1);
});

function workerHarness(overrides = {}) {
  const state = {id: "stable-event-id", shop: "test.myshopify.com", orderId: "gid://shopify/Order/123"};
  const sends = [];
  let previous = false;
  let failComplete = false;
  const repository = {
    async update(_id, data) { Object.assign(state, data); },
    async hasPreviousNotice() { return previous; },
    async complete(_job, payload, result) {
      if (failComplete) throw new Error("Database unavailable after provider acceptance");
      Object.assign(state, {status: "accepted", history: {payload, result}});
    },
  };
  const run = (extra = {}) => processBackorderJob({
    job: structuredClone(state), config, repository, now,
    loadOrder: async () => ({order: order(), shopName: "Test store", today: "2026-09-28"}),
    send: async (payload) => {
      assert.deepEqual(state.sendPayload, payload, "snapshot must be durable before send");
      sends.push(structuredClone(payload));
      return {metricName: payload.metricName};
    },
    buildMessage: (payload) => `<p>${payload.sku}</p>`,
    ...overrides, ...extra,
  });
  return {state, sends, repository, run, previous: (value) => {previous = value;}, failComplete: (value) => {failComplete = value;}};
}

test("dry run saves a preview without sending or freezing a live payload", async () => {
  const h = workerHarness({config: {...config, mode: "dry-run"}});
  assert.equal(await h.run(), "ready");
  assert.equal(h.sends.length, 0);
  assert.ok(h.state.previewPayload);
  assert.equal(h.state.sendPayload, undefined);
});

test("an existing manual notice suppresses the initial automated notice", async () => {
  const h = workerHarness();
  h.previous(true);
  assert.equal(await h.run(), "previously_notified");
  assert.equal(h.sends.length, 0);
});

test("a failed durable write cannot send an email", async () => {
  const h = workerHarness();
  const update = h.repository.update;
  h.repository.update = async (id, data) => {
    if (data.sendPayload) throw new Error("Database unavailable");
    return update(id, data);
  };
  assert.equal(await h.run(), "retry");
  assert.equal(h.sends.length, 0);
});

test("acceptance followed by history failure retries the identical event and recipient", async () => {
  const h = workerHarness();
  h.failComplete(true);
  assert.equal(await h.run(), "retry");
  assert.equal(h.sends.length, 1);
  h.failComplete(false);
  assert.equal(await h.run({
    config: {...config, metricName: "Changed environment metric"},
  }), "accepted");
  assert.deepEqual(h.sends[0], h.sends[1]);
  assert.equal(h.state.history.payload.requestEventUniqueId, "stable-event-id");
});

test("changed recipient or dates after an uncertain send require review instead of a stale retry", async () => {
  for (const currentOrder of [
    order({email: "changed@example.com"}),
    order({lineItems: [item("RH-1", {availabilityDate: {value: "2026-10-22"}})]}),
  ]) {
    const h = workerHarness();
    h.failComplete(true);
    assert.equal(await h.run(), "retry");
    h.failComplete(false);
    assert.equal(await h.run({loadOrder: async () => ({order: currentOrder, today: "2026-09-28"})}), "waiting");
    assert.equal(h.sends.length, 1);
    assert.match(h.state.reason, /earlier request may already have been accepted/);
  }
});

test("Klaviyo/network failure remains retryable and does not record success", async () => {
  const h = workerHarness({send: async () => { throw new Error("Connection lost"); }});
  assert.equal(await h.run(), "retry");
  assert.equal(h.state.history, undefined);
  assert.ok(h.state.nextAttemptAt > now);
});

test("a tag removed or order fulfilled while queued does not send", async () => {
  const h = workerHarness({loadOrder: async () => ({order: order({tags: []}), today: "2026-09-28"})});
  assert.equal(await h.run(), "skipped");
  assert.equal(h.sends.length, 0);
});

test("a date supplied later releases a waiting order using the latest variant date", async () => {
  const h = workerHarness();
  assert.equal(await h.run({loadOrder: async () => ({
    order: order({lineItems: [item("RH", {availabilityDate: null})]}), today: "2026-09-28",
  })}), "waiting");
  assert.equal(h.sends.length, 0);
  assert.equal(await h.run({loadOrder: async () => ({
    order: order({lineItems: [item("RH", {availabilityDate: {value: "2026-10-22"}})]}), today: "2026-09-28",
  })}), "accepted");
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].products[0].delayDate, "2026-10-22");
});

test("worker uses the store timezone and passes a date-only value to the existing email flow", async () => {
  const h = workerHarness({loadOrder: async () => ({
    order: order({lineItems: [item("RH", {availabilityDate: {type: "date_time", value: "2026-10-16T01:30:00Z"}})]}),
    today: "2026-09-28", timeZone: "America/Los_Angeles",
  })});
  assert.equal(await h.run(), "accepted");
  assert.equal(h.sends[0].products[0].delayDate, "2026-10-15");
  assert.equal(h.sends[0].products[0].delayState, "specific_date");
});

test("line item pagination includes matching SKUs on the last page", async () => {
  const calls = [];
  const admin = {graphql: async (query, {variables}) => {
    assert.match(query, /key: "product_availability_date"/);
    assert.doesNotMatch(query, /availability_date_confirmed/);
    calls.push(variables);
    return Response.json({data: {
      shop: {name: "Shop", ianaTimezone: "America/Los_Angeles"},
      order: {...order(), lineItems: {
        nodes: variables.after ? [item("SECOND")] : [item("FIRST")],
        pageInfo: {hasNextPage: !variables.after, endCursor: "page-2"},
      }},
    }});
  }};
  const result = await loadBackorderOrder(admin, "gid://shopify/Order/123", new Date("2026-09-28T01:00:00Z"));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].after, "page-2");
  assert.equal(result.order.lineItems.length, 2);
  assert.equal(result.today, "2026-09-27");
  assert.equal(result.timeZone, "America/Los_Angeles");
});

test("partial GraphQL errors prevent sending with incomplete order data", async () => {
  const admin = {graphql: async () => Response.json({data: {order: order()}, errors: [{message: "Access denied"}]})};
  await assert.rejects(loadBackorderOrder(admin, "gid://shopify/Order/123"), /could not read/);
});

async function importBundle(entry, plugins = []) {
  const result = await build({entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, plugins});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

test("actual Klaviyo sender preserves provided IDs and uses fresh IDs for manual sends", async () => {
  const {sendNotifyDockEvent} = await importBundle("app/klaviyo.server.js");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  const bodies = [];
  process.env.KLAVIYO_PRIVATE_API_KEY = "offline-test-key";
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(null, {status: 202});
  };
  try {
    const payload = select(order()).payload;
    await sendNotifyDockEvent({...payload, requestEventUniqueId: "stable", metricName: "Frozen metric"});
    await sendNotifyDockEvent({...payload, requestEventUniqueId: "stable", metricName: "Frozen metric"});
    await sendNotifyDockEvent(payload);
    await sendNotifyDockEvent(payload);
    assert.equal(bodies[0].data.attributes.unique_id, "stable");
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(bodies[0].data.attributes.metric.data.attributes.name, "Frozen metric");
    assert.notEqual(bodies[2].data.attributes.unique_id, bodies[3].data.attributes.unique_id);
    assert.match(bodies[0].data.attributes.properties.delay_details_html, /October 15, 2026/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KLAVIYO_PRIVATE_API_KEY;
    else process.env.KLAVIYO_PRIVATE_API_KEY = originalKey;
  }
});

test("cron authorization rejects missing secrets and credentials", async () => {
  const runtime = await importBundle("app/backorder-automation.server.js", [{
    name: "offline-runtime",
    setup(builder) {
      builder.onResolve({filter: /\/(db|shopify|klaviyo)\.server$/}, (args) => ({path: args.path, namespace: "mock"}));
      builder.onLoad({filter: /.*/, namespace: "mock"}, (args) => ({
        contents: args.path.endsWith("db.server") ? "export default {};"
          : args.path.endsWith("shopify.server") ? "export const unauthenticated = {};"
          : "export const METRIC_NAMES = {}; export const sendNotifyDockEvent = () => {throw Error('Unexpected send')};",
      }));
    },
  }]);
  const request = (authorization) => new Request("https://example.com/api/cron/backorders", {headers: {authorization}});
  assert.equal(runtime.isBackorderCronAuthorized(request("Bearer undefined"), ""), false);
  assert.equal(runtime.isBackorderCronAuthorized(request("wrong"), "secret"), false);
  assert.equal(runtime.isBackorderCronAuthorized(request("Bearer secret"), "secret"), true);
});

test("duplicate webhooks, concurrent workers, and reconciliation produce only one event", async () => {
  const jobs = new Map();
  const history = new Map();
  const sends = [];
  let scan;
  const shop = "test.myshopify.com";
  const currentOrder = order({
    createdAt: new Date().toISOString(),
    lineItems: [item("RH", {availabilityDate: {type: "date_time", value: "2099-10-15T16:30:00Z"}})],
  });
  const apply = (entry, data) => {
    for (const [key, value] of Object.entries(data)) {
      entry[key] = value?.increment ? (entry[key] || 0) + value.increment : value;
    }
    return entry;
  };
  globalThis.automationTestDb = {
    notifyDockBackorderScan: {
      async upsert({create}) { scan ||= structuredClone(create); return scan; },
      async updateMany({where, data}) {
        if (where.leaseToken && where.leaseToken !== scan.leaseToken) return {count: 0};
        if (where.OR && scan.leaseUntil && scan.leaseUntil >= new Date()) return {count: 0};
        apply(scan, data);
        return {count: 1};
      },
      async findUnique() { return structuredClone(scan); },
      async update({data}) { return apply(scan, data); },
    },
    notifyDockBackorderJob: {
      async createMany({data}) {
        for (const entry of data) if (!jobs.has(entry.id)) jobs.set(entry.id, {
          ...entry, status: "queued", attempts: 0, nextAttemptAt: new Date(0), createdAt: new Date(),
        });
      },
      async updateMany({where, data}) {
        for (const entry of jobs.values()) if (entry.status === where.status && where.orderId.in.includes(entry.orderId)) apply(entry, data);
      },
      async findMany({where}) {
        return [...jobs.values()].filter((entry) => where.status.in.includes(entry.status) && entry.nextAttemptAt <= where.nextAttemptAt.lte).map((entry) => structuredClone(entry));
      },
      async update({where, data}) { return apply(jobs.get(where.id), data); },
    },
    notifyDockEmailHistory: {
      async findFirst() { return [...history.values()][0] || null; },
      async upsert({where, create}) { if (!history.has(where.sourceEventId)) history.set(where.sourceEventId, create); },
    },
    async $transaction(operations) { return Promise.all(operations); },
  };
  globalThis.automationTestAdmin = {
    async graphql(query) {
      if (query.includes("query BackorderOrders")) {
        return Response.json({data: {orders: {nodes: [currentOrder], pageInfo: {hasNextPage: false, endCursor: null}}}});
      }
      return Response.json({data: {
        shop: {name: "Test store", ianaTimezone: "America/Los_Angeles"},
        order: {...currentOrder, lineItems: {nodes: currentOrder.lineItems, pageInfo: {hasNextPage: false}}},
      }});
    },
  };
  globalThis.automationTestSend = async (payload) => {
    sends.push(payload);
    return {metricName: payload.metricName, requestEventUniqueId: payload.requestEventUniqueId};
  };
  const runtime = await importBundle("app/backorder-automation.server.js", [{
    name: "runtime-integration",
    setup(builder) {
      builder.onResolve({filter: /\/(db|shopify|klaviyo)\.server$/}, (args) => ({path: args.path, namespace: "mock"}));
      builder.onLoad({filter: /.*/, namespace: "mock"}, (args) => ({
        contents: args.path.endsWith("db.server") ? "export default globalThis.automationTestDb;"
          : args.path.endsWith("shopify.server") ? "export const unauthenticated = {admin: async () => ({admin: globalThis.automationTestAdmin})};"
          : "export const METRIC_NAMES = {dynamic_shipping_delay: 'Frozen metric'}; export const sendNotifyDockEvent = (...args) => globalThis.automationTestSend(...args);",
      }));
    },
  }]);
  const values = {
    NOTIFY_DOCK_AUTOMATION_MODE: "live",
    NOTIFY_DOCK_AUTOMATION_SHOPS: shop,
    NOTIFY_DOCK_AUTOMATION_START_AT: "2020-01-01T00:00:00Z",
  };
  const savedEnv = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    const webhook = {shop, payload: {
      admin_graphql_api_id: currentOrder.id, name: currentOrder.name,
      created_at: currentOrder.createdAt, tags: "Backorder",
    }};
    await runtime.enqueueBackorderWebhook({...webhook, shop: "unauthorized.myshopify.com"});
    await runtime.enqueueBackorderWebhook({...webhook, payload: {...webhook.payload, created_at: "2019-01-01T00:00:00Z"}});
    assert.equal(jobs.size, 0, "unlisted stores and pre-activation orders never enter the queue");
    await Promise.all([runtime.enqueueBackorderWebhook(webhook), runtime.enqueueBackorderWebhook(webhook)]);
    assert.equal(jobs.size, 1);
    const runs = await Promise.all([runtime.runBackorderAutomation(), runtime.runBackorderAutomation()]);
    assert.ok(runs.some((run) => run.shops[0].status === "busy"));
    assert.equal(sends.length, 1);
    assert.equal(history.size, 1);
    assert.equal([...jobs.values()][0].status, "accepted");
    await runtime.enqueueBackorderWebhook(webhook);
    await runtime.runBackorderAutomation();
    assert.equal(sends.length, 1, "accepted jobs stay closed when webhooks and scans repeat");
    process.env.NOTIFY_DOCK_AUTOMATION_START_AT = "2019-01-01T00:00:00Z";
    const changedCutoff = await runtime.runBackorderAutomation();
    assert.equal(changedCutoff.shops[0].status, "error");
    assert.match(changedCutoff.shops[0].error, /saved activation time/);
    assert.equal(scan.leaseToken, null, "lease is released after errors");
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete globalThis.automationTestDb;
    delete globalThis.automationTestAdmin;
    delete globalThis.automationTestSend;
  }
});
