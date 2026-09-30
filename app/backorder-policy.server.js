import prisma from "./db.server";
import {getBackorderAutomationConfig} from "./backorder-automation.js";

// Policies are provisioned by migration, never created from runtime settings.
// A missing record, missing setting, mismatch or database failure blocks automation.
export async function requireBackorderPolicy(shop, db = prisma, env = process.env) {
  const config = getBackorderAutomationConfig(env);
  if (!config.shops.includes(shop) || !Number.isFinite(config.startAt.getTime())) {
    throw new Error("Automatic backorder processing requires an allowed shop and a valid creation cutoff.");
  }
  const policy = await db.notifyDockAutomationPolicy.findUnique({where: {shop}});
  if (!policy || !Number.isFinite(policy.startAt?.getTime()) ||
    policy.startAt.getTime() !== config.startAt.getTime()) {
    throw new Error("Backorder cutoff is missing or differs from the locked database policy. Processing stopped.");
  }
  return {...config, startAt: policy.startAt, initialStartAt: policy.initialStartAt};
}

// The expanded initial-email rollout has its own locked creation cutoff.
// Keep the original cutoff for already-enrolled follow-ups and manual prefill.
export async function requireInitialBackorderPolicy(shop, db = prisma, env = process.env) {
  const config = await requireBackorderPolicy(shop, db, env);
  const initial = getBackorderAutomationConfig({...env,
    NOTIFY_DOCK_AUTOMATION_START_AT: env.NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT || "",
  });
  if (!Number.isFinite(initial.startAt.getTime()) || !Number.isFinite(config.initialStartAt?.getTime()) ||
    initial.startAt.getTime() !== config.initialStartAt.getTime() || initial.startAt < config.startAt) {
    throw new Error("Initial-email cutoff is missing, changed, or earlier than the locked original policy. Processing stopped.");
  }
  return {...config, startAt: config.initialStartAt};
}

export function followupEnabled(shop) {
  return process.env.NOTIFY_DOCK_FOLLOWUP_ENABLED === "true" &&
    (process.env.NOTIFY_DOCK_FOLLOWUP_SHOPS || "").split(",").map((s) => s.trim()).includes(shop);
}
