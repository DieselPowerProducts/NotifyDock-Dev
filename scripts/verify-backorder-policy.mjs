/* global globalThis */
import assert from "node:assert/strict";
import {test, after} from "node:test";
import {build} from "esbuild";
import {isOrderAfterBackorderCutoff, selectBackorderNotice} from "../app/backorder-automation.js";

const shop = "pilot.myshopify.com";
const orderId = "gid://shopify/Order/123";
const cutoff = "2026-09-24T21:40:39Z";
const state = {sends: [], policy: null, order: null};
globalThis.cutoffGate = state;
state.db = {notifyDockAutomationPolicy: {findUnique: async () => {
  if (state.databaseFailure) throw new Error("Database unavailable");
  return state.policy;
}}};
const bundle = await build({entryPoints: ["app/backorder-automatic-send.server.js"], bundle: true,
  platform: "node", format: "esm", write: false, plugins: [{name: "mock-external-services", setup(b) {
    b.onResolve({filter: /\/(db|shopify|klaviyo)\.server$|\/backorder-automation-shopify\.js$/}, (a) => ({path: a.path, namespace: "mock"}));
    b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
      a.path.includes("db.server") ? "export default globalThis.cutoffGate.db;"
        : a.path.includes("shopify.server") ? "export const unauthenticated={admin:async()=>({admin:{}})};"
          : a.path.includes("klaviyo") ? "export const sendNotifyDockEvent=async(payload)=>{globalThis.cutoffGate.sends.push(payload);return {metricName:'test'};};"
            : "export const loadBackorderOrder=async()=>{if(globalThis.cutoffGate.shopifyFailure)throw new Error('Shopify unavailable');return {order:globalThis.cutoffGate.order};};"}));
  }}]});
const {sendAutomaticBackorderEvent} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
after(() => { delete globalThis.cutoffGate; });

async function isolated(run) {
  const saved = {...process.env};
  const values = {NOTIFY_DOCK_AUTOMATION_MODE: "off", NOTIFY_DOCK_AUTOMATION_SHOPS: shop,
    NOTIFY_DOCK_AUTOMATION_START_AT: cutoff, NOTIFY_DOCK_FOLLOWUP_ENABLED: "true", NOTIFY_DOCK_FOLLOWUP_SHOPS: shop};
  Object.assign(process.env, values);
  Object.assign(state, {sends: [], policy: {startAt: new Date(cutoff)},
    order: {id: orderId, createdAt: "2026-09-24T21:53:00Z"}, databaseFailure: false, shopifyFailure: false});
  try { await run(); }
  finally { for (const key of Object.keys(values)) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }}
}
const send = (kind = "followup", payload = {orderId}) => sendAutomaticBackorderEvent({shop, orderId, payload, kind});

test("final provider gate rejects missing/changed settings, absent policy and database failures in both modes", async () => isolated(async () => {
  for (const mode of ["off", "live"]) {
    process.env.NOTIFY_DOCK_AUTOMATION_MODE = mode;
    for (const value of ["", "invalid", "2026-09-24T19:00:00Z", "2026-09-24T23:00:00Z"]) {
      process.env.NOTIFY_DOCK_AUTOMATION_START_AT = value;
      await assert.rejects(send()); await assert.rejects(send("initial"));
    }
  }
  process.env.NOTIFY_DOCK_AUTOMATION_START_AT = cutoff;
  state.policy = null;
  await assert.rejects(send());
  state.databaseFailure = true;
  await assert.rejects(send());
  assert.equal(state.sends.length, 0);
}));

test("final provider gate rejects old or unverifiable live orders even with an already prepared payload", async () => isolated(async () => {
  process.env.NOTIFY_DOCK_AUTOMATION_MODE = "live";
  for (const createdAt of ["2026-09-24T21:40:38.999Z", "2026-09-24T14:40:38.999-07:00",
    "2025-01-01T00:00:00Z", "2026-09-24T21:53:00", "2026-02-30T23:00:00Z", "invalid", "", null, undefined]) {
    state.order = {id: orderId, createdAt};
    await assert.rejects(send()); await assert.rejects(send("initial"));
  }
  state.order = null;
  await assert.rejects(send());
  state.shopifyFailure = true;
  await assert.rejects(send());
  assert.equal(state.sends.length, 0);
}));

test("final provider gate binds the queued payload to the actual order and observes enable flags", async () => isolated(async () => {
  await assert.rejects(send("initial"), /disabled/);
  await assert.rejects(send("unknown"), /disabled/);
  await assert.rejects(send("followup", {orderId: "gid://shopify/Order/999"}), /identity/);
  state.order.id = "gid://shopify/Order/999";
  await assert.rejects(send());
  state.order.id = orderId; state.order.cancelledAt = cutoff;
  await assert.rejects(send());
  delete state.order.cancelledAt;
  process.env.NOTIFY_DOCK_FOLLOWUP_ENABLED = "false";
  await assert.rejects(send(), /disabled/);
  process.env.NOTIFY_DOCK_FOLLOWUP_ENABLED = "true";
  process.env.NOTIFY_DOCK_AUTOMATION_SHOPS = "other.myshopify.com";
  await assert.rejects(send());
  assert.equal(state.sends.length, 0);
}));

test("valid new orders pass the final provider gate, with UTC and Pacific boundaries equivalent", async () => isolated(async () => {
  for (const createdAt of [cutoff, "2026-09-24T14:40:39-07:00", "2026-09-24T21:53:00Z"]) {
    state.order.createdAt = createdAt;
    await send();
  }
  process.env.NOTIFY_DOCK_AUTOMATION_MODE = "live";
  await send("initial");
  assert.equal(state.sends.length, 4);
}));

test("creation cutoff remains the first eligibility decision and invalid cutoff never selects products", () => {
  const old = {createdAt: "2026-09-24T21:40:38.999Z"};
  for (const key of ["tags", "lineItems", "email"]) Object.defineProperty(old, key, {get() {throw new Error(`Reached ${key} on an older order`);}});
  assert.equal(selectBackorderNotice({order: old, config: {startAt: new Date(cutoff)}}).status, "skipped");
  assert.equal(isOrderAfterBackorderCutoff({createdAt: cutoff}, new Date("invalid")), false);
});
