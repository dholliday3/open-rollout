// `open-rollout/datadog`: an incident feed over Datadog monitors, kept off the core entry so it loads neither it nor zod.
export type { DatadogCall, DatadogIncidentsOptions, DatadogTransport, MonitorState } from "./adapters/datadog-incidents.js";
export { createDatadogIncidents } from "./adapters/datadog-incidents.js";
