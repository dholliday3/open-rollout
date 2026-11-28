// Public surface of open-rollout's core. Deep imports into src/ are not part of the contract.
// The PostHog adapters, the Datadog incident feed and `rolloutTools` are `open-rollout/posthog` (src/posthog.ts),
// `open-rollout/datadog` (src/datadog.ts) and `open-rollout/tools` (src/tools.ts), so the core loads none of them nor zod.
export type { Allocation } from "./allocation.js";
export type { ArmPair, FlagControl, FlagReading, Incident, IncidentFeed, MetricQuery, MetricSnapshot, MetricSource, Notifier, Ports, RolloutStore, Stored, TrafficQuery } from "./ports.js";
export type { ArmSample, DenominatorSample, Estimate, Interval, MetricKind, SequenceTuning } from "./stats.js";
export type { Autopilot, CommandOutcome, Inspection, StartRequest, StartResult, TickResult } from "./controller.js";
export type { Command, CommandResult } from "./commands.js";
export type { Decision, FlagWrite, Observation } from "./decide.js";
export type { Direction, Guardrail, Limits, RolloutPlan, Step } from "./plan.js";
export type { PlanOverrides, PlanRequest, Risk } from "./standard-plan.js";
export type { Baseline, CommandEntry, EventType, Finding, Gate, Hold, Outcome, Pause, PauseReason, Phase, RollbackReason, RolloutEvent, RolloutRecord, WriteAttempt } from "./record.js";
export type { Judgement, Regression } from "./judge.js";
export type { GuardrailReading, RolloutSummary } from "./summary.js";
export type { Forecast, StepForecast } from "./traffic.js";
export type { MemoryFlags, MemoryMetrics, MemoryNotifier } from "./adapters/memory.js";
export type { ReleasePorts, ReleaseRecord, ReleaseStage, ReleaseStore, Releaser, StageState, StageStatus, StoredRelease, Trigger } from "./release.js";
export { DEFAULT_LIMITS, planProblems, stepAt } from "./plan.js";
export { standardPlan } from "./standard-plan.js";
export { forecast } from "./traffic.js";
export { EVERYBODY, FULL_SHARE, HALF_SHARE, NOBODY, exposesMore, isValidAllocation, measuredStep, sameAllocation } from "./allocation.js";
export { createMemoryFlags, createMemoryMetrics, createMemoryNotifier, createMemoryStore } from "./adapters/memory.js";
export { createMemoryReleaseStore, createReleaser, newRelease } from "./release.js";
export { differenceInterval, estimateArm, estimateArms, isSampleRatioMismatch, sequenceRadius } from "./stats.js";
export { RECORD_SCHEMA_VERSION, isDone, isLive, newRecord } from "./record.js";
export { applyCommand } from "./commands.js";
export { createAutopilot } from "./controller.js";
export { decide } from "./decide.js";
export { judge, snapshotProblem } from "./judge.js";
export { summarize } from "./summary.js";
