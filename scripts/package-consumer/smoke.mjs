// Plain node, no loader: the package's own JavaScript, from each entry point.
import { createAutopilot, createMemoryFlags, createMemoryMetrics, createMemoryNotifier, createMemoryStore, standardPlan } from "open-rollout";
import { createPostHogMetrics } from "open-rollout/posthog";
import { rolloutTools } from "open-rollout/tools";

const now = Date.UTC(2026, 0, 5, 9);
const metrics = createMemoryMetrics();
metrics.set({ asOf: now, watermark: now, contaminated: 0, exposed: { control: 0, treatment: 0 }, metrics: {} });
const autopilot = createAutopilot({ flags: createMemoryFlags(), metrics, notifier: createMemoryNotifier(), store: createMemoryStore() });
const started = await autopilot.start({ id: "r1", plan: standardPlan({ flagKey: "f", risk: "low", guardrails: [] }), now });
if (started.status !== "started" || typeof createPostHogMetrics !== "function" || typeof rolloutTools(autopilot).rollout_start.run !== "function") {
  throw new Error("The packed package did not load.");
}
console.log(`import: ${started.status}`);
