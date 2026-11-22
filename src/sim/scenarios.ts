import { CONVERSION, ERRORS, ERRORS_PER_UNIT, ERROR_RATIO, LATENCY, LATENCY_PER_REQUEST } from "./montecarlo";
import type { Guardrail, RolloutPlan } from "../plan";
import { DEFAULT_POPULATION } from "./population";
import type { EffectName } from "./effects";
import type { Scenario } from "./montecarlo";
import type { Scripted } from "./driver";
import type { World } from "./world";
import { standardPlan } from "../plan";

/**
 * The scenarios the statistics are measured on. Healthy ones (the new code changes nothing) measure how
 * often the library acts when it shouldn't; the rest measure how fast, and whether, each kind of
 * regression is caught.
 */

const FLAG = "new-checkout",
  MINUTE = 60_000,
  TWO_SECONDS = 2000,
  SIX_SECONDS = 6000,
  FAST_TICKS: readonly [number, number] = [TWO_SECONDS, SIX_SECONDS],
  SKEW_MS = 180_000,
  TINY_SHARE = 50,
  SMALL_SHARE = 500,
  HALF = 5000,
  FIVE_MINUTES = 5,
  PATIENCE = 6,
  FEW_UNITS = 20,
  RARE = 0.0001,
  COMMON = 0.6,
  QUIET_PEAK = 25,
  NIGHT_HOUR = 2,
  SOME_LOG_IN = 0.1,
  MOST_LOG_IN = 0.6,
  TWELVE = 12,
  AN_HOUR_AND_A_HALF = 5_400_000,
  TWENTY_FIVE = 25,
  FLAKY = { failChance: 0.2, lostReplyChance: 0.15, staleReadChance: 0.5, staleReadMs: 45_000 },
  ALL_FIVE: readonly Guardrail[] = [ERRORS, ERROR_RATIO, ERRORS_PER_UNIT, LATENCY, CONVERSION];

function low(guardrails: readonly Guardrail[]): RolloutPlan {
  return standardPlan({ flagKey: FLAG, guardrails, risk: "low" });
}

function medium(guardrails: readonly Guardrail[]): RolloutPlan {
  return standardPlan({ flagKey: FLAG, guardrails, risk: "medium" });
}

/** A plan that starts on a sliver of traffic, with short steps: the fewest units a guardrail will ever be read on. */
function tinyFirstStep(guardrails: readonly Guardrail[]): RolloutPlan {
  const steps = [TINY_SHARE, SMALL_SHARE, HALF].map((treatmentShare) => ({ maxDurationMs: FIVE_MINUTES * MINUTE * PATIENCE, minDurationMs: FIVE_MINUTES * MINUTE, minFreshUnits: FEW_UNITS, requiresApproval: false, treatmentShare }));
  return { ...low(guardrails), steps };
}

const HEALTHY: readonly Scenario[] = [
  { name: "healthy: low risk plan, error rate", plan: low([ERRORS]), runtime: {}, world: {} },
  { name: "healthy: medium risk plan, error rate", plan: medium([ERRORS]), runtime: {}, world: {} },
  { name: "healthy: five guardrails", plan: low(ALL_FIVE), runtime: {}, world: {} },
  { name: "healthy: errors per person (heavy-tailed mean)", plan: low([ERRORS_PER_UNIT]), runtime: {}, world: {} },
  { name: "healthy: latency per person (heavy-tailed mean)", plan: low([LATENCY]), runtime: {}, world: {} },
  { name: "healthy: errors per request (ratio, few heavy people)", plan: low([ERROR_RATIO]), runtime: {}, world: {} },
  { name: "healthy: latency per request (ratio)", plan: low([LATENCY_PER_REQUEST]), runtime: {}, world: {} },
  { name: "healthy: a rare error (rate near zero)", plan: low([ERRORS]), runtime: {}, world: { baseErrorChance: RARE } },
  { name: "healthy: a common error (rate near one)", plan: low([ERRORS]), runtime: {}, world: { baseErrorChance: COMMON } },
  { name: "healthy: looking every few seconds", plan: low([ERRORS]), runtime: { tickEveryMs: FAST_TICKS }, world: {} },
  { name: "healthy: a tiny first step, five guardrails, looking every few seconds", plan: tinyFirstStep(ALL_FIVE), runtime: { tickEveryMs: FAST_TICKS }, world: {} },
  { name: "healthy: three workers, clocks three minutes apart, replays", plan: low([ERRORS]), runtime: { repeatChance: 0.3, workers: [{ clockOffsetMs: 0, name: "a" }, { clockOffsetMs: SKEW_MS, name: "b" }, { clockOffsetMs: -SKEW_MS, name: "c" }] }, world: {} },
  { name: "healthy: a tenth of people log in (two identities)", plan: low([ERRORS]), runtime: {}, world: { population: { ...DEFAULT_POPULATION, loginShare: SOME_LOG_IN, stickyIdentity: false } } },
  { name: "healthy: most people log in (two identities)", plan: low([ERRORS]), runtime: { horizonMs: AN_HOUR_AND_A_HALF }, world: { population: { ...DEFAULT_POPULATION, loginShare: MOST_LOG_IN, stickyIdentity: false } } },
  { name: "healthy: a small product (25 visits a minute at peak)", plan: low([ERRORS]), runtime: {}, world: { peakPerMinute: QUIET_PEAK } },
  { name: "healthy: started at two in the morning", plan: low([ERRORS]), runtime: {}, world: { startHour: NIGHT_HOUR } },
  { name: "healthy: an incident that hits both arms", plan: low([ERRORS, ERROR_RATIO]), runtime: {}, world: { effect: "common_mode" } },
];

/** Switches a fault on for a while: `set(true)` after `fromMin` minutes, `set(false)` `forMin` minutes later. */
function during(fromMin: number, forMin: number, set: (world: World, on: boolean) => void): Scripted[] {
  return [
    {
      afterMs: fromMin * MINUTE,
      run: (world) => {
        set(world, true);
      },
    },
    {
      afterMs: (fromMin + forMin) * MINUTE,
      run: (world) => {
        set(world, false);
      },
    },
  ];
}

function sourceDown(world: World, on: boolean): void {
  world.source.faults.down = on;
}

function providerDown(world: World, on: boolean): void {
  world.provider.faults.down = on;
}

function flakyProvider(world: World): void {
  Object.assign(world.provider.faults, FLAKY);
}

/** Healthy code in a world where the things around the rollout misbehave. Nothing here is a reason to act. */
const TROUBLED: readonly Scenario[] = [
  { name: "troubled: a flaky provider (failed calls, lost replies, stale reads)", plan: low([ERRORS]), prepare: flakyProvider, runtime: {}, world: {} },
  { name: "troubled: a flaky provider that checks no revisions", plan: low([ERRORS]), prepare: flakyProvider, runtime: {}, world: { checksRevision: false } },
  { name: "troubled: the metric source down for 12 minutes, twice", plan: low([ERRORS]), runtime: { script: [...during(FIVE_MINUTES, TWELVE, sourceDown), ...during(TWENTY_FIVE, TWELVE, sourceDown)] }, world: {} },
  { name: "troubled: the provider down for 8 minutes at each step", plan: low([ERRORS]), runtime: { script: [...during(TWELVE - 2, TWELVE - FIVE_MINUTES + 1, providerDown), ...during(TWENTY_FIVE - 2, TWELVE - FIVE_MINUTES + 1, providerDown)] }, world: {} },
  { name: "troubled: the watermark is the newest event counted", plan: low([ERRORS]), runtime: {}, world: { watermark: "newest" } },
  { name: "troubled: a small product at night, watermark as PostHog's adapter", plan: low([ERRORS]), runtime: {}, world: { peakPerMinute: QUIET_PEAK, startHour: NIGHT_HOUR } },
];

function regression(effect: EffectName, guardrails: readonly Guardrail[] = [ERRORS]): Scenario {
  return { name: `regression: ${effect}`, plan: medium(guardrails), runtime: {}, world: { effect } };
}

const REGRESSIONS: readonly Scenario[] = [
  regression("outage"),
  regression("moderate"),
  regression("subtle"),
  regression("leak"),
  regression("segment"),
  regression("heavy_users"),
  regression("load"),
  regression("novelty"),
  regression("latency", [LATENCY]),
  { ...regression("latency", [LATENCY_PER_REQUEST]), name: "regression: latency, on latency per request" },
  regression("conversion", [CONVERSION]),
  { ...regression("outage", [ERROR_RATIO]), name: "regression: outage, on errors per request" },
  { ...regression("moderate", [ERROR_RATIO]), name: "regression: moderate, on errors per request" },
  { ...regression("heavy_users", [ERROR_RATIO]), name: "regression: heavy_users, on errors per request" },
  regression("exposure_loss"),
  { ...regression("outage"), name: "regression: outage, provider down from minute 1 to 6", runtime: { script: during(1, FIVE_MINUTES, providerDown) } },
  { ...regression("outage"), name: "regression: outage, metric source down from minute 1 to 13", runtime: { script: during(1, TWELVE, sourceDown) } },
  { ...regression("moderate"), name: "regression: moderate, a small product (25 visits a minute)", world: { effect: "moderate", peakPerMinute: QUIET_PEAK } },
];

export { ALL_FIVE, FLAG, HEALTHY, REGRESSIONS, TROUBLED, low, medium, tinyFirstStep };
