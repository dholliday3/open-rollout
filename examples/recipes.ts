import type { Autopilot, FlagControl, Guardrail, IncidentFeed, MetricSource, RolloutPlan } from "open-rollout";
import type { MetricDefinition, PostHogMetricsOptions } from "open-rollout/posthog";
import { forecast, planProblems, standardPlan } from "open-rollout";
import type { RolloutTools } from "open-rollout/tools";
import { createDatadogIncidents } from "open-rollout/datadog";
import { createPostHogMetrics } from "open-rollout/posthog";
import { rolloutTools } from "open-rollout/tools";

/** Where PostHog is and how far behind it runs, as `examples/posthog.ts` sets them up. */
type PostHogConnection = Pick<PostHogMetricsOptions, "ingestionLagMs" | "now" | "projectId" | "transport">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function billingEngine(postHog: PostHogConnection): { metrics: MetricSource; plan: RolloutPlan } {
  const metrics = createPostHogMetrics({
    ...postHog,
    unit: { groupTypeIndex: 0 },
    metrics: { invoice_failed: { event: "invoice failed", mayBeUnseen: true } },
  });
  const plan = standardPlan({
    flagKey: "billing-engine-v2",
    risk: "low",
    guardrails: [
      { metric: "invoice_failed", kind: "rate", direction: "lower_is_better", tolerance: 0,
        mustRuleOut: 0.05, onRegression: "rollback" },
    ],
    overrides: {
      everyStep: { minDurationMs: DAY, minFreshUnits: 20 },
      requiresApprovalToRelease: true,
    },
  });
  return { metrics, plan };
}

const checkoutPlan = standardPlan({
  flagKey: "checkout-redesign",
  risk: "medium",
  guardrails: [
    { metric: "converted", kind: "rate", direction: "higher_is_better", tolerance: 0,
      onRegression: "rollback" },
    { metric: "errors", kind: "rate", direction: "lower_is_better", tolerance: 0,
      onRegression: "rollback" },
  ],
});

const serviceMetrics: Record<string, MetricDefinition> = {
  ms_per_request: { event: "api request", property: "duration_ms", denominatorEvent: "api request" },
  errors_per_request: { event: "api error", denominatorEvent: "api request", mayBeUnseen: true },
  had_error: { event: "api error", mayBeUnseen: true },
};

const serviceGuardrails: Guardrail[] = [
  { metric: "ms_per_request", kind: "ratio", direction: "lower_is_better", tolerance: 20,
    onRegression: "rollback" },
  { metric: "errors_per_request", kind: "ratio", direction: "lower_is_better", tolerance: 0,
    onRegression: "rollback" },
  { metric: "had_error", kind: "rate", direction: "lower_is_better", tolerance: 0,
    onRegression: "rollback" },
];

function serviceRewrite(postHog: PostHogConnection): { metrics: MetricSource; plan: RolloutPlan } {
  return {
    metrics: createPostHogMetrics({ ...postHog, metrics: serviceMetrics }),
    plan: standardPlan({ flagKey: "orders-service-v2", risk: "medium", guardrails: serviceGuardrails }),
  };
}

const searchErrors: Guardrail = {
  metric: "errors",
  kind: "rate",
  direction: "lower_is_better",
  tolerance: 0,
  onRegression: "rollback",
};

const searchPlan = standardPlan({
  flagKey: "search-ranking-v2",
  risk: "low",
  guardrails: [searchErrors],
  sourceLagMs: HOUR,
});

const unprepared = standardPlan({
  flagKey: "search-ranking-v2",
  risk: "low",
  guardrails: [searchErrors],
});
const lagProblems = planProblems({
  ...unprepared,
  limits: { ...unprepared.limits, sourceLagMs: HOUR },
});

const releaseLeads = new Set(["U02LEAD", "U07LEAD"]);
const anyone = new Set(["rollout_status", "rollout_pause", "rollout_rollback"]);

function slackTools(autopilot: Autopilot): RolloutTools {
  return rolloutTools(autopilot, {
    authorize: ({ tool, actor }) =>
      anyone.has(tool) || releaseLeads.has(actor)
        ? { allowed: true }
        : { allowed: false, reason: "Only a release lead can do that." },
  });
}

interface FlagRow { readonly control: number; readonly treatment: number; readonly revision: number }
type QueryRow = (sql: string, values: readonly unknown[]) => Promise<FlagRow>;

function tableFlags(queryRow: QueryRow): FlagControl {
  return {
    refusesStaleWrites: true,
    read: async (flagKey) => {
      const row = await queryRow("SELECT * FROM flags WHERE key = $1", [flagKey]);
      return { allocation: { control: row.control, treatment: row.treatment }, revision: row.revision };
    },
    write: async (flagKey, allocation, expectedRevision) => {
      const row = await queryRow(
        `UPDATE flags SET control = $2, treatment = $3, revision = revision + 1
         WHERE key = $1 AND ($4::bigint IS NULL OR revision = $4) RETURNING *`,
        [flagKey, allocation.control, allocation.treatment, expectedRevision ?? null],
      );
      return row.revision;
    },
  };
}

const BUG_FLAG = "fix-double-charge";

async function bugFix(autopilot: Autopilot): Promise<RolloutPlan | null> {
  const unitsPerHour = await autopilot.traffic(BUG_FLAG);
  const plan = standardPlan({
    flagKey: BUG_FLAG,
    risk: "low",
    guardrails: [
      { metric: "double_charged", kind: "rate", direction: "lower_is_better", tolerance: 0,
        mustImproveBy: 0, onRegression: "rollback" },
      { metric: "errors", kind: "rate", direction: "lower_is_better", tolerance: 0,
        onRegression: "rollback" },
    ],
    unitsPerHour: unitsPerHour ?? undefined,
  });
  const tooQuiet = unitsPerHour === null || forecast(plan, unitsPerHour).problems.length > 0;
  return tooQuiet ? null : plan;
}

const onboardingPlan = standardPlan({
  flagKey: "onboarding-v3-ios",
  risk: "medium",
  guardrails: [
    { metric: "crashed", kind: "rate", direction: "lower_is_better", tolerance: 0,
      onRegression: "rollback" },
  ],
  overrides: { limits: { propagationMs: 30 * MINUTE } },
});

function datadogHold(keys: { api: string; app: string }): IncidentFeed {
  return createDatadogIncidents({
    monitorTags: ["open-rollout:hold"],
    transport: async (call) => {
      const response = await fetch(new URL(call.path, "https://api.datadoghq.com"), {
        headers: { "DD-API-KEY": keys.api, "DD-APPLICATION-KEY": keys.app },
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: response.ok ? await response.json() : null };
    },
  });
}

export type { FlagRow, PostHogConnection, QueryRow };
export { BUG_FLAG, billingEngine, bugFix, checkoutPlan, datadogHold, lagProblems, onboardingPlan, searchPlan, serviceRewrite, slackTools, tableFlags, unprepared };
