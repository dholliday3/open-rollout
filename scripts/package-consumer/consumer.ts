// A consumer's own TypeScript, compiled against the packed package with every strict option a consumer might turn on.
import type { MetricSnapshot, PlanRequest, RolloutPlan } from "open-rollout";
import { createAutopilot, createMemoryFlags, createMemoryMetrics, createMemoryNotifier, createMemoryStore, planProblems, standardPlan } from "open-rollout";
import type { DatadogTransport } from "open-rollout/datadog";
import { createDatadogIncidents } from "open-rollout/datadog";
import type { PostHogTransport } from "open-rollout/posthog";
import { createPostHogFlags, createPostHogMetrics } from "open-rollout/posthog";
import { rolloutTools } from "open-rollout/tools";

const now = Date.UTC(2026, 0, 5, 9);
const plan: RolloutPlan = standardPlan({
  flagKey: "new-checkout",
  risk: "low",
  guardrails: [{ metric: "errors", kind: "rate", direction: "lower_is_better", tolerance: 0, onRegression: "rollback" }],
});
// @ts-expect-error A plan needs a risk. If the package's types fell back to `any` this line would compile, and the check fails.
const missingRisk: PlanRequest = { flagKey: "new-checkout", guardrails: [] };
void missingRisk;

const snapshot: MetricSnapshot = {
  asOf: now,
  watermark: now,
  contaminated: 0,
  exposed: { control: 0, treatment: 0 },
  metrics: { errors: { control: { units: 0, sum: 0 }, treatment: { units: 0, sum: 0 } } },
};

const flags = createMemoryFlags();
const metrics = createMemoryMetrics();
metrics.set(snapshot);
const datadog: DatadogTransport = async () => ({ status: 200, body: [] });
const incidents = createDatadogIncidents({ transport: datadog, monitorTags: ["open-rollout:hold"] });
const autopilot = createAutopilot({ flags, metrics, incidents, notifier: createMemoryNotifier(), store: createMemoryStore() });
const started = await autopilot.start({ id: "checkout-1", plan, now });
const tools = rolloutTools(autopilot, {
  authorize: (request) => (request.tool === "rollout_start" && request.input.risk === "high" ? { allowed: false, reason: "High risk needs a person." } : { allowed: true }),
});
const status = await tools.rollout_status.run({ id: "checkout-1" }, { actor: "ci", callKey: "ci:1", now });

const transport: PostHogTransport = async () => ({ status: 200, body: null });
const posthog = {
  flags: createPostHogFlags({ projectId: 1, transport }),
  metrics: createPostHogMetrics({ projectId: 1, transport, now: () => now, ingestionLagMs: 60_000, metrics: { errors: { event: "$exception" } } }),
};

if (started.status !== "started" || status.rollout === null || planProblems(plan).length > 0 || typeof posthog.metrics.snapshot !== "function") {
  throw new Error("The packed package did not start a rollout.");
}
console.log(`compiled consumer: ${status.rollout.headline}`);
