// Run with: node scripts/verify-composer-dates.mjs
// Add --live with KLAVIYO_PRIVATE_API_KEY set to verify actual template renders.
// Shopify data and sends are mocked; no customer email is sent.
/* global globalThis */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import Module, {createRequire} from "node:module";
import path from "node:path";
import {setTimeout as wait} from "node:timers/promises";
import {build} from "esbuild";

import {JSDOM} from "jsdom";
import {getExtension} from "@shopify/ui-extensions-tester";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement});
// Shopify owns the visual implementation. Expose its documented element
// properties in jsdom, then exercise real DOM events through the Preact render.
const tags = {Button: "s-button", TextField: "s-text-field", Select: "s-select", DatePicker: "s-date-picker", Pressable: "s-clickable", DateField: "s-date-field"};
for (const tag of Object.values(tags)) {
  dom.window.customElements.define(tag, class extends dom.window.HTMLElement {
    value = ""; disabled = false; loading = false; label = "";
    accessibilityLabel = ""; type = "";
    get href() { return this.getAttribute("href") || ""; }
    set href(value) { if (value) this.setAttribute("href", value); else this.removeAttribute("href"); }
    setValue(value) {
      this.value = value;
      this.dispatchEvent(new dom.window.Event(tag === "s-text-field" ? "input" : "change", {bubbles: true}));
    }
    click() {
      assert.equal(this.disabled, false, `Cannot click disabled ${tag}: ${this.textContent}`);
      super.click();
    }
  });
}
const extension = getExtension("admin.order-details.action.render", {configSearchDir: path.resolve("extensions/notify-dock-action")});
extension.setUp();
const require = createRequire(import.meta.url);
const {h, render} = require("preact");
const actionPath = "extensions/notify-dock-action/src/action.jsx";
const result = await build({
  stdin: {
    contents: `${readFileSync(actionPath, "utf8")}\nexport {ActionComposer};`,
    resolveDir: path.resolve(path.dirname(actionPath)), loader: "jsx",
  },
  bundle: true, platform: "node", format: "cjs", jsx: "automatic",
  jsxImportSource: "preact", packages: "external", write: false,
});
const compiled = new Module(path.resolve("scripts/composer-test-bundle.cjs"));
compiled.filename = path.resolve("scripts/composer-test-bundle.cjs");
compiled.paths = Module._nodeModulePaths(path.resolve("scripts"));
compiled._compile(result.outputFiles[0].text, compiled.filename);

const products = [
  {sku: "TEST-A", productTitle: "Test product A", title: "Test product A"},
  {sku: "TEST-B", productTitle: "Test product B", title: "Test product B"},
];
let backorderFixture = null;
let historyFixture = [];
const historyActions = [];
let failNextSend = false;
const queriedOrderIds = [];
Object.assign(extension.shopify, {
  data: {selected: [{id: "gid://shopify/Order/123"}]},
  close() {},
  query: async (_query, options) => { queriedOrderIds.push(options.variables.id); return {data: {
    shop: {name: "Test shop"},
    order: {name: "#TEST", email: backorderFixture ? "" : "preview@example.com", tags: backorderFixture ? ["Backorder"] : [], lineItems: {nodes: []}},
  }}; },
});
let blockExtension;
const previewRequests = [];
const sends = [];
const verifiedPreviews = [];
let holdPreviews = false;
const pendingPreviews = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (url.startsWith("/api/backorder-details")) {
    return Response.json({status: "ready", payload: {products: backorderFixture, sku: backorderFixture.map((p) => p.sku).join(", ")}});
  }
  if (url === "/api/notify-dock-preview-link") {
    const payload = JSON.parse(options.body);
    previewRequests.push(payload);
    const response = Response.json({url: `https://preview.invalid/?payload=${encodeURIComponent(JSON.stringify(payload))}`});
    if (holdPreviews) {
      return new Promise((resolve) => pendingPreviews.push(() => resolve(response)));
    }
    return response;
  }
  if (url.startsWith("/api/product-by-sku")) {
    return Response.json({products, missingSkus: []});
  }
  if (url.startsWith("/api/email-history")) {
    if (options?.method === "POST") {
      const payload = JSON.parse(options.body);
      historyActions.push(payload);
      historyFixture = historyFixture.map((entry) => entry.id === payload.id ? {...entry, customerEmail: payload.customerEmail} : entry);
      return Response.json({historyEntry: historyFixture.find((entry) => entry.id === payload.id)});
    }
    return Response.json({history: historyFixture});
  }
  if (url === "/api/backorder-email") {
    sends.push(JSON.parse(options.body));
    if (failNextSend) { failNextSend = false; return Response.json({error: "Test provider rejection"}, {status: 502}); }
    return Response.json({ok: true});
  }
  throw new Error(`Unexpected request: ${url}`);
};
const root = {
  render(vnode) { render(vnode, document.body); },
  unmount() { render(null, document.body); },
};
function nodes() { return Array.from(document.body.querySelectorAll("*")); }
function find(type, predicate = () => true) {
  const node = nodes().find((node) => node.localName === tags[type] && predicate(node));
  assert.ok(node, `Missing ${type}`);
  return node;
}
function textOf(node) { return node.textContent; }
function previewButton() {
  return find("Button", (node) => /Rendered preview|Preparing preview/.test(textOf(node)));
}
function previewPayload() {
  const button = previewButton();
  assert.equal(Boolean(button.disabled), false, "Preview should be ready");
  return JSON.parse(new URL(button.href).searchParams.get("payload"));
}
async function chooseSharedDate(label, date) {
  const oldField = nodes().find((node) => node.localName === "s-date-field");
  if (oldField) {
    oldField.setValue(date);
  } else {
    find("Button", (node) => node.accessibilityLabel === `Choose ${label}`).click();
    await wait(20);
    find("DatePicker").setValue(date);
  }
  await wait(20);
}
async function clearGlobalDate() {
  find("Button", (node) => node.accessibilityLabel === "Clear global ship date").click();
  await wait(20);
}
function assertPreviewPending() {
  assert.equal(Boolean(previewButton().disabled), true, "A changed date must disable the stale preview immediately, before the 300ms debounce");
  assert.ok(!previewButton().href, "The previous preview URL must not be exposed");
}

try {
  root.render(h(compiled.exports.ActionComposer));
  await wait(400);
  find("TextField", (node) => node.label === "SKU").setValue("TEST-A, TEST-B");
  await wait(750);
  assert.equal(previewPayload().globalShipDate, "");

  await chooseSharedDate("global ship date", "2026-09-16");
  assertPreviewPending();
  assert.equal(nodes().filter((node) => node.localName === "s-date-picker").length, 0, "Selecting a calendar date closes the calendar immediately");
  await wait(350);
  assert.equal(previewPayload().globalShipDate, "2026-09-16");
  assert.equal(previewPayload().shipDate, "2026-09-16");
  verifiedPreviews.push({payload: previewPayload(), expectedDates: ["September 16, 2026"]});
  assert.ok(previewPayload().products.every((product) => !product.delayDate));
  assert.equal(find("Pressable", (node) => node.accessibilityLabel === "Set Item Ship Date").disabled, true);
  find("Button", (node) => textOf(node) === "Send email").click();
  await wait(30);
  assert.equal(sends.at(-1).global_ship_date, "2026-09-16");
  console.log("PASS: global date immediately updates preview and send; item controls stay locked");

  holdPreviews = true;
  await chooseSharedDate("global ship date", "2026-09-17");
  await wait(350);
  await chooseSharedDate("global ship date", "2026-09-18");
  assertPreviewPending();
  await wait(350);
  assert.equal(pendingPreviews.length, 2);
  pendingPreviews[1]();
  await wait(20);
  assert.equal(previewPayload().globalShipDate, "2026-09-18");
  pendingPreviews[0]();
  await wait(20);
  assert.equal(previewPayload().globalShipDate, "2026-09-18", "An older response cannot replace the newest preview");
  holdPreviews = false;
  console.log("PASS: out-of-order preview responses keep the newest date");

  await clearGlobalDate();
  assertPreviewPending();
  find("Pressable", (node) => node.accessibilityLabel === "Set Item Ship Date").click();
  await wait(20);
  find("DatePicker").setValue("2026-09-22");
  await wait(370);
  assert.equal(previewPayload().products[0].delayDate, "2026-09-22");
  assert.equal(previewPayload().products[0].delayState, "specific_date");
  assert.equal(previewPayload().globalShipDate, "");
  assert.equal(previewPayload().shipDate, "");
  verifiedPreviews.push({payload: previewPayload(), expectedDates: ["September 22, 2026"]});
  find("Button", (node) => textOf(node) === "Send email").click();
  await wait(30);
  assert.equal(sends.at(-1).products[0].delay_date, "2026-09-22");
  assert.equal(sends.at(-1).global_ship_date, "");
  find("Pressable", (node) => node.accessibilityLabel === "Set Item Ship Date").click();
  await wait(20);
  find("DatePicker").setValue("2026-09-24");
  await wait(370);
  assert.equal(previewPayload().products[0].delayDate, "2026-09-22");
  assert.equal(previewPayload().products[1].delayDate, "2026-09-24");
  verifiedPreviews.push({payload: previewPayload(), expectedDates: ["September 22, 2026", "September 24, 2026"]});
  await wait(20);
  find("Pressable", (node) => node.accessibilityLabel === "Built to Order" && !node.disabled).click();
  await wait(20);
  assert.equal(find("DatePicker").value, "");
  find("DatePicker").setValue("2026-09-23");
  await wait(20);
  assert.equal(
    find("DatePicker").value,
    "2026-09-23",
    "The first built-to-order click must use Shopify's painted single-date state",
  );
  find("DatePicker").setValue("2026-09-25");
  await wait(20);
  assert.deepEqual(
    find("DatePicker").value,
    "2026-09-23--2026-09-25",
    "The second built-to-order click must use Shopify's painted range state",
  );
  assert.equal(
    find("Button", (node) => textOf(node) === "Apply range").disabled,
    false,
  );
  assert.equal(previewPayload().products[0].delayState, "specific_date");
  find("Button", (node) => textOf(node) === "Apply range").click();
  await wait(370);
  const perItem = previewPayload();
  assert.equal(perItem.globalShipDate, "");
  assert.equal(perItem.shipDate, "");
  assert.equal(perItem.products[0].delayState, "business_days_range");
  assert.equal(perItem.products[0].delayRangeStart, "2026-09-23");
  assert.equal(perItem.products[1].delayDate, "2026-09-24");
  assert.equal(find("Button", (node) => node.accessibilityLabel === "Choose global ship date").disabled, true);
  find("Button", (node) => textOf(node) === "Send email").click();
  await wait(30);
  assert.equal(sends.at(-1).global_ship_date, "");
  assert.equal(sends.at(-1).products[0].delay_range_start, "2026-09-23");
  console.log("PASS: clearing global date restores per-item dates and built-to-order ranges");

  find("Select", (node) => node.label === "Email type").setValue("awaiting_stock");
  await wait(370);
  await chooseSharedDate("expected stock date", "2026-09-09");
  assertPreviewPending();
  assert.equal(find("Button", (node) => textOf(node) === "Send email").disabled, false);
  await wait(350);
  assert.equal(previewPayload().shipDate, "2026-09-09");
  assert.equal(previewPayload().products.length, 0);
  verifiedPreviews.push({payload: previewPayload(), expectedDates: ["September 9, 2026"]});
  find("Button", (node) => textOf(node) === "Send email").click();
  await wait(30);
  assert.equal(sends.at(-1).ship_date, "2026-09-09");
  console.log("PASS: Awaiting Stock commits the date on calendar selection for preview and send");
  const backorderProduct = {...products[0], delayState: "specific_date", delayDate: "2026-10-15"};
  const builtToOrderProduct = {...products[1], delayState: "build_to_order_message", delayMessage: "This product will ship in 2 Weeks from the manufacturer"};
  const genericBackorder = {...products[0], delayState: "no_confirmed_date"};
  const genericBuiltToOrder = {...products[1], delayState: "no_confirmed_date"};
  let fixtureIndex = 0;
  for (const fixture of [[backorderProduct], [builtToOrderProduct], [backorderProduct, builtToOrderProduct],
    [genericBackorder], [genericBuiltToOrder], [genericBackorder, builtToOrderProduct], [backorderProduct, genericBuiltToOrder]]) {
    backorderFixture = fixture;
    const before = sends.length;
    root.render(h(compiled.exports.ActionComposer, {key: `backorder-fixture-${fixtureIndex++}`}));
    await wait(1000);
    assert.equal(sends.length, before, "Opening the order and prefilling must never send automatically");
    const preview = previewPayload();
    assert.equal(preview.products.length, fixture.length);
    for (const product of fixture) {
      const actual = preview.products.find((p) => p.sku === product.sku);
      assert.equal(actual.delayState, product.delayState);
      assert.equal(actual.delayMessage, product.delayMessage || "");
      assert.equal(actual.delayDate, product.delayDate || "");
    }
    assert.equal(find("Button", (node) => textOf(node) === "Send email").disabled, true, "A missing recipient must block sending, not product previews");
    find("TextField", (node) => node.label === "To").setValue("personal@example.com");
    await wait(350);
    assert.equal(find("Button", (node) => textOf(node) === "Send email").disabled, false);
    find("Button", (node) => textOf(node) === "Send email").click();
    await wait(30);
    assert.equal(sends.length, before + 1);
    assert.equal(sends.at(-1).customer_email, "personal@example.com");
    assert.equal(sends.at(-1).products.length, fixture.length);
    assert.deepEqual(sends.at(-1).products.map((p) => p.delay_state), fixture.map((p) => p.delayState));
    if (fixture.includes(builtToOrderProduct)) {
      assert.equal(sends.at(-1).products.find((p) => p.sku === "TEST-B").delay_message, builtToOrderProduct.delayMessage);
    }
  }
  console.log("PASS: single Backorder, single Built to Order and mixed orders prefill and send only on click to the chosen email");
  backorderFixture = null;
  root.render(h(compiled.exports.ActionComposer, {key: "will-call"}));
  await wait(700);
  assert.equal(document.querySelector('s-button[slot="primary-action"]').textContent, "Send email");
  assert.equal(document.querySelector('s-button[slot="secondary-actions"]').textContent, "Close");
  for (const emailType of ["will_call_in_progress", "will_call_partially_ready", "will_call_ready"]) {
    find("Select", (node) => node.label === "Email type").setValue(emailType);
    await wait(50);
    const skuField = nodes().find((node) => node.localName === "s-text-field" && node.label === "SKU");
    if (skuField) skuField.setValue("TEST-A, TEST-B");
    await wait(750);
    assert.equal(previewPayload().emailType, emailType);
    const before = sends.length;
    find("Button", (node) => textOf(node) === "Send email").click();
    await wait(40);
    assert.equal(sends.length, before + 1);
    assert.equal(sends.at(-1).email_type, emailType);
  }
  failNextSend = true;
  find("TextField", (node) => node.label === "To").setValue("latest@example.com");
  await wait(20);
  find("Button", (node) => textOf(node) === "Send email").click();
  await wait(40);
  assert.equal(sends.at(-1).customer_email, "latest@example.com");
  assert.ok(document.body.textContent.includes("Test provider rejection"));
  assert.equal(find("Button", (node) => textOf(node) === "Send email").disabled, false);
  console.log("PASS: all three Will Call templates, primary/secondary action slots, latest recipient, and provider failure recovery");

  historyFixture = [{id: "history-test", emailType: "will_call_ready", customerEmail: "old@example.com", subject: "Ready", message: "Test saved message", sentAt: "2026-09-29T12:00:00Z", orderNumber: "#TEST", deliveryStatus: "accepted"}];
  extension.shopify.intents.launchUrl = "extension:notify-dock-action?orderId=gid%3A%2F%2Fshopify%2FOrder%2F456&openedAt=history-test&showHistory=1";
  root.render(h(compiled.exports.ActionComposer, {key: "history-test"}));
  await wait(700);
  assert.equal(queriedOrderIds.at(-1), "gid://shopify/Order/456", "Launch order takes precedence over stale selection");
  const recipient = find("TextField", (node) => node.label === "Recipient email");
  recipient.setValue("history-new@example.com");
  await wait(20);
  recipient.dispatchEvent(new dom.window.Event("blur"));
  await wait(40);
  assert.deepEqual(historyActions.at(-1), {customerEmail: "history-new@example.com", id: "history-test", intent: "update_customer_email"});
  find("Button", (node) => textOf(node) === "Resend").click();
  await wait(50);
  assert.deepEqual(historyActions.at(-1), {customerEmail: "history-new@example.com", id: "history-test", intent: "resend"});
  console.log("PASS: correct reopened order, saved history recipient changes, and explicit resend");
  assert.equal(nodes().some((node) => node.localName === "s-date-field"), false);
  root.unmount();
  const mockFetch = globalThis.fetch;
  const mockQuery = extension.shopify.query;
  extension.tearDown();
  blockExtension = getExtension("admin.order-details.block.render", {configSearchDir: path.resolve("extensions/backorder-email")});
  blockExtension.setUp();
  globalThis.fetch = mockFetch;
  const navigations = [];
  Object.assign(blockExtension.shopify, {
    data: {selected: [{id: "gid://shopify/Order/789"}]},
    query: mockQuery,
    navigation: {navigate: (url) => navigations.push(url)},
  });
  const blockBundle = await build({entryPoints: ["extensions/backorder-email/src/index.jsx"], bundle: true, platform: "node", format: "cjs", jsx: "automatic", jsxImportSource: "preact", packages: "external", write: false});
  const blockModule = new Module(path.resolve("scripts/block-test-bundle.cjs"));
  blockModule.filename = path.resolve("scripts/block-test-bundle.cjs");
  blockModule.paths = compiled.paths;
  blockModule._compile(blockBundle.outputFiles[0].text, blockModule.filename);
  blockModule.exports.default();
  await wait(300);
  assert.ok(document.querySelector("s-admin-block"));
  assert.ok(document.body.textContent.includes("Email history"));
  find("Button", node => textOf(node) === "Open composer").click();
  assert.equal(new URL(navigations.at(-1)).searchParams.get("orderId"), "gid://shopify/Order/789");
  root.unmount();
  blockExtension.shopify.data = {selected: []};
  blockModule.exports.default();
  await wait(100);
  assert.equal(find("Button", node => textOf(node) === "Open composer").disabled, true);
  console.log("PASS: order-page block renders history, opens the selected order, and blocks launch without an order");
  console.log(`${previewRequests.length} preview requests checked; ${sends.length} sends intercepted locally.`);
} finally {
  root.unmount();
  await wait(20);
  globalThis.fetch = originalFetch;
  blockExtension?.tearDown();
  extension.tearDown();
  dom.window.close();
}

if (process.argv.includes("--live")) {
  assert.ok(process.env.KLAVIYO_PRIVATE_API_KEY, "Set KLAVIYO_PRIVATE_API_KEY to run live renders");
  const bundled = await build({
    entryPoints: ["app/klaviyo.server.js"],
    bundle: true, platform: "node", format: "cjs", write: false,
  });
  const backend = new Module(path.resolve("scripts/klaviyo-test-bundle.cjs"));
  backend.filename = path.resolve("scripts/klaviyo-test-bundle.cjs");
  backend.paths = compiled.paths;
  backend._compile(bundled.outputFiles[0].text, backend.filename);
  for (const {payload, expectedDates} of verifiedPreviews) {
    const rendered = await backend.exports.renderNotifyDockTemplate(payload);
    for (const date of expectedDates) {
      assert.ok(rendered.html.includes(date), `Template ${rendered.templateId} must show ${date}`);
    }
    console.log(`PASS: live ${payload.emailType} template ${rendered.templateId} renders ${expectedDates.join(", ")} from composer input`);
  }
}
