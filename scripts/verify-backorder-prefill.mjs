// Offline regression: recipient-less dummy orders must still prefill the composer.
import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";
import {BACKORDER_PILOT_VENDOR, selectBackorderNotice} from "../app/backorder-automation.js";

const order = {
  id: "gid://shopify/Order/123", name: "#968218", createdAt: "2026-09-24T20:00:00Z",
  email: null, customer: null, tags: ["Backorder"],
  lineItems: ["Backorder", "Built to Order"].map((availability, index) => ({
    sku: `RH-${index}`, title: `Steering gear ${index}`, currentQuantity: 1, unfulfilledQuantity: 1,
    variant: {sku: `RH-${index}`, product: {vendor: BACKORDER_PILOT_VENDOR},
      availability: {value: availability}, availabilityDate: {type: "date", value: "2099-10-15"},
      buildToOrderMessage: {type: "single_line_text_field", value: "This product will ship in 2 Weeks from the manufacturer"},
    },
  })),
};

test("background selection still requires an email by default", () => {
  const selected = selectBackorderNotice({order, today: "2026-09-24", config: {startAt: new Date(0)}});
  assert.equal(selected.status, "waiting");
  assert.match(selected.reason, /customer email/);
});

const select = (lineItems) => selectBackorderNotice({
  order: {...order, lineItems}, today: "2026-09-24", config: {startAt: new Date(0)}, requireCustomerEmail: false,
});
const genericMessage = "Based on information that we have received from the manufacturer, there is not yet a confirmed ship date for this item.";

test("absent and blank dates/messages keep both products with generic messaging", () => {
  for (const field of [undefined, null, {value: ""}, {value: "  "}]) {
    const result = select(order.lineItems.map((item, index) => ({...item, variant: {
      ...item.variant, [index === 0 ? "availabilityDate" : "buildToOrderMessage"]: field,
    }})));
    assert.equal(result.status, "ready");
    assert.equal(result.payload.products.length, 2);
    assert.ok(result.payload.products.every((p) => p.delayState === "no_confirmed_date" && !p.delayDate && !p.delayMessage));
  }
});

test("invalid or past dates and unsupported message types still require correction", () => {
  for (const field of [{value: "not a date"}, {type: "date", value: "2026-02-30"}, {type: "date", value: "2000-01-01"}]) {
    assert.equal(select([{...order.lineItems[0], variant: {...order.lineItems[0].variant, availabilityDate: field}}]).status, "waiting");
  }
  assert.equal(select([{...order.lineItems[1], variant: {...order.lineItems[1].variant,
    buildToOrderMessage: {type: "rich_text_field", value: '{"type":"root"}'},
  }}]).status, "waiting");
});

test("mixed known and missing information renders exact fallback per item without placeholders", async () => {
  const selected = select([
    ...order.lineItems,
    {...order.lineItems[0], sku: "NO-DATE", variant: {...order.lineItems[0].variant, availabilityDate: null}},
    {...order.lineItems[1], sku: "NO-MESSAGE", variant: {...order.lineItems[1].variant, buildToOrderMessage: null}},
  ]);
  assert.equal(selected.status, "ready");
  const bundle = await build({entryPoints: ["app/notify-dock-email-template.server.js"], bundle: true,
    platform: "node", format: "esm", write: false});
  const {buildNotifyDockMessage} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const html = buildNotifyDockMessage(selected.payload);
  assert.equal(html.split(genericMessage).length - 1, 2);
  assert.match(html, /October 15, 2099/);
  assert.match(html, /This product will ship in 2 Weeks from the manufacturer/);
  assert.match(html, /NO-DATE/);
  assert.match(html, /NO-MESSAGE/);
  assert.doesNotMatch(html, /Insert Ship date/);
});

async function buildPrefillLoader(testOrder) {
  const data = {shop: {name: "Test shop", ianaTimezone: "America/Los_Angeles"},
    order: {...testOrder, lineItems: {nodes: testOrder.lineItems, pageInfo: {hasNextPage: false}}}};
  const bundle = await build({entryPoints: ["app/routes/api.backorder-details.jsx"], bundle: true,
    platform: "node", format: "esm", write: false, plugins: [{
      name: "mock-authenticated-shopify",
      setup(builder) {
        builder.onResolve({filter: /^(?:@remix-run\/node)$|\/(?:shopify|db)\.server$/}, (args) => ({path: args.path, namespace: "mock"}));
        builder.onLoad({filter: /.*/, namespace: "mock"}, (args) => ({contents: args.path.includes("@remix")
          ? "export const json = (data, init) => Response.json(data, init);"
          : args.path.includes("db.server")
            ? 'export default {notifyDockAutomationPolicy:{findUnique:async()=>({startAt:new Date("2026-09-24T21:40:39Z")})}};'
            : `export const authenticate = {admin: async () => ({session:{shop:"pilot.myshopify.com"},cors: (r) => r, admin: {graphql: async () => Response.json({data: ${JSON.stringify(data)}})}})};`,
        }));
      },
    }],
  });
  const {loader} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  return loader;
}

test("actual prefill endpoint enforces the cutoff with automation off and still allows recipient-less new orders", async () => {
  const savedEnv = {...process.env};
  try {
    process.env.NOTIFY_DOCK_AUTOMATION_MODE = "off";
    process.env.NOTIFY_DOCK_AUTOMATION_SHOPS = "pilot.myshopify.com";
    process.env.NOTIFY_DOCK_AUTOMATION_START_AT = "2026-09-24T21:40:39Z";
    const request = () => ({request: new Request(`https://example.com/api/backorder-details?order_id=${order.id}`)});
    for (const createdAt of ["2026-09-24T21:53:00Z", "2026-09-24T21:40:39Z"]) {
      const loader = await buildPrefillLoader({...order, createdAt});
      const response = await loader(request());
      assert.equal(response.status, 200);
      const selected = await response.json();
      assert.equal(selected.status, "ready");
      assert.equal(selected.payload.customerEmail, "");
      assert.equal(selected.payload.products.length, 2);
      assert.equal(selected.payload.products[0].delayDate, "2099-10-15");
      assert.equal(selected.payload.products[1].delayMessage, "This product will ship in 2 Weeks from the manufacturer");
    }
    for (const createdAt of [order.createdAt, "2026-09-24T21:40:38.999Z"]) {
      const loader = await buildPrefillLoader({...order, createdAt});
      const selected = await (await loader(request())).json();
      assert.equal(selected.status, "skipped");
      assert.match(selected.reason, /predates/);
      assert.equal(selected.payload, undefined, "Older orders must not return any autofill products or SKUs");
    }
    const loader = await buildPrefillLoader({...order, createdAt: "2026-09-24T21:53:00Z"});
    for (const value of ["", "invalid", "2026-09-24T19:00:00Z", "2026-09-24T23:00:00Z"]) {
      process.env.NOTIFY_DOCK_AUTOMATION_START_AT = value;
      assert.equal((await (await loader(request())).json()).status, "skipped", "Missing, invalid or changed settings cannot bypass the locked cutoff");
    }
  } finally {
    for (const key of ["NOTIFY_DOCK_AUTOMATION_MODE", "NOTIFY_DOCK_AUTOMATION_START_AT", "NOTIFY_DOCK_AUTOMATION_SHOPS"]) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
});

test("fixed cutoff suppresses old-order warnings while newer orders still report nonmatching availability", async () => {
  const savedEnv = {...process.env};
  try {
    process.env.NOTIFY_DOCK_AUTOMATION_MODE = "off";
    process.env.NOTIFY_DOCK_AUTOMATION_SHOPS = "pilot.myshopify.com";
    process.env.NOTIFY_DOCK_AUTOMATION_START_AT = "2026-09-24T21:40:39Z";
    const manualOrder = structuredClone(order);
    manualOrder.lineItems.forEach((item) => {item.variant.availability.value = "In Stock";});
    const request = () => ({request: new Request(`https://example.com/api/backorder-details?order_id=${order.id}`)});
    for (const [createdAt, expectedStatus] of [["2026-09-24T20:00:00Z", "skipped"], ["2026-09-24T21:53:00Z", "waiting"]]) {
      const loader = await buildPrefillLoader({...manualOrder, createdAt});
      const selected = await (await loader(request())).json();
      assert.equal(selected.status, expectedStatus);
      assert.match(selected.reason, expectedStatus === "skipped" ? /predates/ : /No unfulfilled Red Head/);
      assert.equal(selected.payload, undefined);
    }
    const invalidOrder = structuredClone(order);
    invalidOrder.createdAt = "2026-09-24T21:53:00Z";
    invalidOrder.lineItems[0].variant.availabilityDate.value = "invalid";
    const invalidLoader = await buildPrefillLoader(invalidOrder);
    assert.equal((await (await invalidLoader(request())).json()).status, "waiting");
  } finally {
    for (const key of ["NOTIFY_DOCK_AUTOMATION_MODE", "NOTIFY_DOCK_AUTOMATION_START_AT", "NOTIFY_DOCK_AUTOMATION_SHOPS"]) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
});
