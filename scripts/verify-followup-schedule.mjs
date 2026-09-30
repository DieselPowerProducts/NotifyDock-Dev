/* global globalThis */
import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";

test("daily endpoint authenticates and never starts product checks outside the 4pm Pacific hour", async () => {
  const OriginalDate = Date;
  const state = {at: "2026-09-24T22:59:59Z", authorized: true, runs: 0};
  globalThis.scheduleTest = state;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [state.at])); }
  };
  try {
    const bundle = await build({entryPoints: ["app/routes/api.cron.backorder-followups.jsx"], bundle: true, platform: "node", format: "esm", write: false,
      plugins: [{name: "mock-scheduler-services", setup(b) {
        b.onResolve({filter: /^@remix-run\/node$|\/backorder-followup\.server$/}, (a) => ({path: a.path, namespace: "mock"}));
        b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
          a.path.includes("@remix") ? "export const json=(value,options)=>new Response(JSON.stringify(value),options);"
            : "export const authorizeFollowupCron=()=>globalThis.scheduleTest.authorized;export const runBackorderFollowups=async()=>{globalThis.scheduleTest.runs++;return {hasMore:false};};"}));
      }}]});
    const {loader} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    const request = new Request("https://test/api/cron/backorder-followups");
    for (const at of ["2026-09-24T00:00:00Z", "2026-09-24T22:59:59Z", "2026-09-25T00:00:00Z", "2026-12-01T23:00:00Z"]) {
      state.at = at;
      assert.equal((await (await loader({request})).json()).status, "outside_daily_window");
    }
    assert.equal(state.runs, 0);
    state.at = "2026-09-24T23:00:00Z";
    state.authorized = false;
    assert.equal((await loader({request})).status, 401); assert.equal(state.runs, 0);
    state.authorized = true;
    await loader({request}); assert.equal(state.runs, 1);
    state.at = "2026-12-02T00:00:00Z";
    await loader({request}); assert.equal(state.runs, 2);
  } finally { globalThis.Date = OriginalDate; delete globalThis.scheduleTest; }
});
