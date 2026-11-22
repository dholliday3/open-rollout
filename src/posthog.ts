// `open-rollout/posthog`: the PostHog flag and metric adapters, kept off the core entry so it loads neither them nor zod.
export type { HogQuery, MetricDefinition, PostHogMetricsOptions } from "./adapters/posthog-metrics.js";
export type { PostHogCall, PostHogReply, PostHogTransport } from "./adapters/posthog-transport.js";
export type { PostHogFlag, PostHogFlagsOptions } from "./adapters/posthog-flags.js";
export { createPostHogFlags } from "./adapters/posthog-flags.js";
export { createPostHogMetrics } from "./adapters/posthog-metrics.js";
