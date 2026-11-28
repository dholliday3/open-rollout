import type { Limits } from "./plan.js";
import { z } from "zod";

/** The zod 4 input schemas of the agent's rollout tools: what the model reads about each field, and what it may send. */

const idShape = z.string().min(1).describe("The rollout's id."),
  noteShape = z.string().optional().describe("Why, in a sentence. It goes on the record."),
  guardrailShape = z.object({
    metric: z.string().min(1).describe("The metric's name, as the metric source knows it."),
    kind: z.enum(["rate", "mean", "ratio"]).describe("rate: share of people with the event. mean: average per person. ratio: one total over another, such as errors per request."),
    direction: z.enum(["lower_is_better", "higher_is_better"]),
    tolerance: z.number().min(0).default(0).describe("How much worse is still fine, in the metric's own units."),
    onRegression: z.enum(["rollback", "pause"]).default("rollback"),
    mustRuleOut: z.number().positive().optional().describe("How large a regression must be ruled out before a step may pass, in the metric's own units. Leave out to pass a step when nothing was detected."),
    mustImproveBy: z.number().min(0).optional().describe("Makes this metric a goal: the release waits until the new behaviour is shown better than the old by more than this, in the metric's own units. For a bug fix, the bug's own error, with 0. Leave out for a metric that only must not get worse."),
  }),
  durationShape = z.number().int().positive(),
  everyStepShape = z.object({
    minDurationMs: durationShape.optional().describe("The least time each step is watched."),
    maxDurationMs: durationShape.optional().describe("When a step still short of traffic gives up. Left out, six times its watch plus the source's lag."),
    minFreshUnits: z.number().int().min(0).optional().describe("New units each arm must gain during a step. Lower it for a product with few people or accounts."),
    requiresApproval: z.boolean().optional().describe("Ask a person before every step."),
  }),
  // Every limit but the lag, which is its own input so the deadlines move with it; `satisfies` fails when Limits changes.
  limitsShape = z.object({
    alpha: z.number().optional(),
    goalAlpha: z.number().optional(),
    tuneAtUnits: z.number().optional(),
    sampleRatioAlpha: z.number().optional(),
    minUnitsToJudge: z.number().optional(),
    maxStalenessMs: z.number().optional(),
    maxBlindMs: z.number().optional(),
    propagationMs: z.number().optional(),
    expireAfterIdleMs: z.number().optional(),
    settleMs: z.number().optional(),
    maxContaminatedShare: z.number().optional(),
  } satisfies Record<keyof Omit<Limits, "sourceLagMs">, z.ZodOptional<z.ZodNumber>>),
  overridesShape = z.object({
    everyStep: everyStepShape.optional().describe("Set on every step of the standard ladder."),
    limits: limitsShape.optional().describe("The plan's limits by name, each replacing the standard value. Rarely needed."),
    onInsufficientData: z.enum(["rollback", "pause"]).optional().describe("What a step that never gets enough traffic does. Standard: pause."),
    onMetricsOutage: z.enum(["hold", "rollback"]).optional().describe("What the rollout does when the metrics are down for too long. Standard: hold."),
    onSampleRatioMismatch: z.enum(["rollback", "pause"]).optional().describe("What uneven arms do. Standard: rollback."),
    requiresApprovalToRelease: z.boolean().optional().describe("Ask a person before the release to everybody. Standard: only for high risk."),
  }),
  startShape = z.object({
    id: idShape,
    flagKey: z.string().min(1).describe("The feature flag to roll out."),
    risk: z.enum(["low", "medium", "high"]).describe("How much could go wrong. Higher risk means smaller first steps, longer watches, and approval before the release."),
    guardrails: z.array(guardrailShape).describe("The metrics the rollout must not make worse. With none, it is a timed ramp with no automatic rollback."),
    sourceLagMs: z.number().int().min(0).optional().describe("How far behind the clock the metrics run, in milliseconds, such as 3600000 for a warehouse loaded hourly. Every step gets that much longer before it gives up. Leave out when the metrics are minutes behind at most."),
    unitsPerHour: z.number().min(0).optional().describe("New people (or accounts) an hour that reach the code behind the flag. Each step is made long enough for its units to arrive. Leave out to measure it from the flag's own evaluations over the last day, where the metric source can."),
    overrides: overridesShape.optional().describe("Changes to the standard plan, for a product with little traffic or a team with its own rules."),
  }),
  forecastShape = startShape.omit({ id: true }),
  targetShape = z.object({ id: idShape }),
  notedShape = z.object({ id: idShape, note: noteShape }),
  approveShape = z.object({ id: idShape, gate: z.union([z.literal("release"), z.number().int().min(0)]).describe("What to approve: a step's index, counting from 0, or \"release\" for the release to everybody.") });

export { approveShape, forecastShape, guardrailShape, notedShape, startShape, targetShape };
