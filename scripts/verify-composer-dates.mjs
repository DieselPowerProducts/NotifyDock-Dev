// Run with: node scripts/verify-composer-dates.mjs
// Add --revision=<commit> to run the same interaction against committed code.
// Add --live with KLAVIYO_PRIVATE_API_KEY set to verify actual template renders.
// Shopify data and sends are mocked; no customer email is sent.
/* global globalThis */
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import Module, {createRequire} from "node:module";
import path from "node:path";
import {setTimeout as wait} from "node:timers/promises";
import {build} from "esbuild";

const require = createRequire(import.meta.url);
const React = require("react");
const {createRemoteRoot, createRoot} = require("@remote-ui/react");
const revision = process.argv.find((arg) => arg.startsWith("--revision="))?.slice(11);
const actionPath = "extensions/notify-dock-action/src/action.jsx";
const sourceAtRevision = (file) => revision
  ? execFileSync("git", ["show", `${revision}:${file}`], {encoding: "utf8"})
  : readFileSync(file, "utf8");
const result = await build({
  stdin: {
    contents: `${sourceAtRevision(actionPath)}\nexport {ActionComposer};`,
    resolveDir: path.resolve(path.dirname(actionPath)),
    loader: "jsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  packages: "external",
  write: false,
  plugins: [{
    name: "shopify-test-api",
    setup(builder) {
      builder.onResolve({filter: /.*/, namespace: "test-api"}, (args) => ({path: args.path, external: true}));
      builder.onResolve({filter: /^@shopify\/ui-extensions-react\/admin$/}, () => ({
        path: "admin-test-api", namespace: "test-api",
      }));
      builder.onLoad({filter: /.*/, namespace: "test-api"}, () => ({
        contents: `module.exports = {...require(${JSON.stringify(require.resolve("@shopify/ui-extensions-react/admin"))}), useApi: () => globalThis.composerTestApi};`,
        loader: "js",
      }));
      if (revision) {
        builder.onLoad({filter: /composer\.jsx$/}, () => ({
          contents: sourceAtRevision("extensions/notify-dock-action/src/composer.jsx"),
          loader: "jsx",
        }));
      }
    },
  }],
});
const compiled = new Module(path.resolve("scripts/composer-test-bundle.cjs"));
compiled.filename = path.resolve("scripts/composer-test-bundle.cjs");
compiled.paths = Module._nodeModulePaths(path.resolve("scripts"));
compiled._compile(result.outputFiles[0].text, compiled.filename);

const products = [
  {sku: "TEST-A", productTitle: "Test product A"},
  {sku: "TEST-B", productTitle: "Test product B"},
];
globalThis.composerTestApi = {
  data: {selected: [{id: "gid://shopify/Order/123"}]},
  close() {},
  query: async () => ({data: {
    shop: {name: "Test shop"},
    order: {name: "#TEST", email: "preview@example.com", lineItems: {nodes: []}},
  }}),
};
const previewRequests = [];
const sends = [];
const verifiedPreviews = [];
let holdPreviews = false;
const pendingPreviews = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
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
  if (url.startsWith("/api/email-history")) return Response.json({history: []});
  if (url === "/api/backorder-email") {
    sends.push(JSON.parse(options.body));
    return Response.json({ok: true});
  }
  throw new Error(`Unexpected request: ${url}`);
};
const remote = createRemoteRoot(() => {}, {strict: false});
const root = createRoot(remote);

function nodes(node = remote) {
  return [node, ...(node.children || []).flatMap((child) => nodes(child)),
    ...Object.values(node.props || {}).filter((prop) => prop?.kind === 3).flatMap((fragment) => nodes(fragment))];
}
function find(type, predicate = () => true) {
  const node = nodes().find((node) => node.type === type && predicate(node));
  assert.ok(node, `Missing ${type}`);
  return node;
}
function textOf(node) {
  return node.text || (node.children || []).map(textOf).join("");
}
function previewButton() {
  return find("Button", (node) => /Rendered preview|Preparing preview/.test(textOf(node)));
}
function previewPayload() {
  const button = previewButton();
  assert.equal(Boolean(button.props.disabled), false, "Preview should be ready");
  return JSON.parse(new URL(button.props.href).searchParams.get("payload"));
}
async function chooseSharedDate(label, date) {
  const oldField = nodes().find((node) => node.type === "DateField");
  if (oldField) {
    oldField.props.onChange(date);
  } else {
    find("Button", (node) => node.props.accessibilityLabel === `Choose ${label}`).props.onPress();
    await wait(20);
    find("DatePicker").props.onChange(date);
  }
  await wait(20);
}
async function clearGlobalDate() {
  find("Button", (node) => node.props.accessibilityLabel === "Clear global ship date").props.onPress();
  await wait(20);
}
function assertPreviewPending() {
  assert.equal(Boolean(previewButton().props.disabled), true, "A changed date must disable the stale preview immediately, before the 300ms debounce");
  assert.ok(!previewButton().props.href, "The previous preview URL must not be exposed");
}

try {
  root.render(React.createElement(compiled.exports.ActionComposer));
  await wait(400);
  find("TextField", (node) => node.props.label === "SKU").props.onChange("TEST-A, TEST-B");
  await wait(750);
  assert.equal(previewPayload().globalShipDate, "");

  await chooseSharedDate("global ship date", "2026-09-16");
  assertPreviewPending();
  assert.equal(nodes().filter((node) => node.type === "DatePicker").length, 0, "Selecting a calendar date closes the calendar immediately");
  await wait(350);
  assert.equal(previewPayload().globalShipDate, "2026-09-16");
  assert.equal(previewPayload().shipDate, "2026-09-16");
  verifiedPreviews.push({payload: previewPayload(), expectedDates: ["September 16, 2026"]});
  assert.ok(previewPayload().products.every((product) => !product.delayDate));
  assert.equal(find("Pressable", (node) => node.props.accessibilityLabel === "Set Item Ship Date").props.onPress, undefined);
  find("Button", (node) => textOf(node) === "Send email").props.onPress();
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
  find("Pressable", (node) => node.props.accessibilityLabel === "Set Item Ship Date").props.onPress();
  await wait(20);
  find("DatePicker").props.onChange("2026-09-22");
  await wait(370);
  assert.equal(previewPayload().products[0].delayDate, "2026-09-22");
  assert.equal(previewPayload().products[0].delayState, "specific_date");
  assert.equal(previewPayload().globalShipDate, "");
  assert.equal(previewPayload().shipDate, "");
  verifiedPreviews.push({payload: previewPayload(), expectedDates: ["September 22, 2026"]});
  find("Button", (node) => textOf(node) === "Send email").props.onPress();
  await wait(30);
  assert.equal(sends.at(-1).products[0].delay_date, "2026-09-22");
  assert.equal(sends.at(-1).global_ship_date, "");
  find("Pressable", (node) => node.props.accessibilityLabel === "Set Item Ship Date").props.onPress();
  await wait(20);
  find("DatePicker").props.onChange("2026-09-24");
  await wait(370);
  assert.equal(previewPayload().products[0].delayDate, "2026-09-22");
  assert.equal(previewPayload().products[1].delayDate, "2026-09-24");
  verifiedPreviews.push({payload: previewPayload(), expectedDates: ["September 22, 2026", "September 24, 2026"]});
  await wait(20);
  find("Pressable", (node) => node.props.accessibilityLabel === "Built to Order" && node.props.onPress).props.onPress();
  await wait(20);
  find("DatePicker").props.onChange({start: "2026-09-23", end: "2026-09-25"});
  await wait(370);
  const perItem = previewPayload();
  assert.equal(perItem.globalShipDate, "");
  assert.equal(perItem.shipDate, "");
  assert.equal(perItem.products[0].delayState, "business_days_range");
  assert.equal(perItem.products[0].delayRangeStart, "2026-09-23");
  assert.equal(perItem.products[1].delayDate, "2026-09-24");
  assert.equal(find("Button", (node) => node.props.accessibilityLabel === "Choose global ship date").props.disabled, true);
  find("Button", (node) => textOf(node) === "Send email").props.onPress();
  await wait(30);
  assert.equal(sends.at(-1).global_ship_date, "");
  assert.equal(sends.at(-1).products[0].delay_range_start, "2026-09-23");
  console.log("PASS: clearing global date restores per-item dates and built-to-order ranges");

  find("Select", (node) => node.props.label === "Email type").props.onChange("awaiting_stock");
  await wait(370);
  await chooseSharedDate("expected stock date", "2026-09-09");
  assertPreviewPending();
  assert.equal(find("Button", (node) => textOf(node) === "Send email").props.disabled, false);
  await wait(350);
  assert.equal(previewPayload().shipDate, "2026-09-09");
  assert.equal(previewPayload().products.length, 0);
  verifiedPreviews.push({payload: previewPayload(), expectedDates: ["September 9, 2026"]});
  find("Button", (node) => textOf(node) === "Send email").props.onPress();
  await wait(30);
  assert.equal(sends.at(-1).ship_date, "2026-09-09");
  console.log("PASS: Awaiting Stock commits the date on calendar selection for preview and send");
  assert.equal(nodes().some((node) => node.type === "DateField"), false);
  console.log(`${previewRequests.length} preview requests checked; ${sends.length} sends intercepted locally.`);
} finally {
  root.unmount();
  await wait(20);
  globalThis.fetch = originalFetch;
  delete globalThis.composerTestApi;
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
