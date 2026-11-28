import type { ArmPair, FlagControl, Incident, IncidentFeed, MetricQuery, MetricSnapshot, MetricSource, Ports } from "../ports.js";
import type { SimNotifier, SimStore } from "./store.js";
import { createSimNotifier, createSimStore } from "./store.js";
import type { Autopilot } from "../controller.js";
import type { Command } from "../commands.js";
import { DEFAULT_LIMITS } from "../plan.js";
import { FULL_SHARE } from "../allocation.js";
import type { Gate } from "./gate.js";
import type { RolloutPlan } from "../plan.js";
import type { RolloutRecord } from "../record.js";
import type { SimProvider } from "./provider.js";
import { createAutopilot } from "../controller.js";
import { createRandom } from "./random.js";
import { createSimProvider } from "./provider.js";

/**
 * A small exact bench for proving one break at a time: steady traffic, fixed error rates, no randomness.
 * It runs on the simulation's provider and store (so their history can be asserted on) and lets a test
 * distort what the metric source answers. The stochastic world in `world.ts` is where realism lives.
 */
interface Bench {
  readonly autopilot: Autopilot;
  readonly provider: SimProvider;
  readonly flags: FlagControl;
  readonly metrics: MetricSource;
  readonly store: SimStore;
  readonly notifier: SimNotifier;
  readonly plan: RolloutPlan;
  /** A monitoring system's incidents, when the bench has one; `incident` says whether one is open. */
  readonly incidents?: IncidentFeed;
  incident: boolean;
  /** What each worker's last read of the incident feed answered: true when an incident was open. */
  readonly incidentSeen: Map<string, boolean>;
  now: number;
  /** Units a minute across all traffic. */
  perMinute: number;
  errorRate: ArmPair<number>;
  lagMs: number;
  metricsDown: boolean;
  /** Changes what the metric source answers; the honest snapshot goes in. */
  distort: (snapshot: MetricSnapshot) => MetricSnapshot;
  metricReads: number;
  seen: Seen;
  /** How many people had really been served each arm at each instant time was let pass to. */
  readonly served: { at: number; control: number; treatment: number }[];
  /** What had been seen when each `since` was first asked for: evidence counted from a later instant starts from nothing. */
  readonly marks: Map<number, Seen>;
}

interface Seen {
  control: number;
  treatment: number;
  controlErrors: number;
  treatmentErrors: number;
}

interface BenchOptions {
  readonly plan?: Partial<RolloutPlan> | undefined;
  readonly checksRevision?: boolean | undefined;
  /** Gives the bench an incident feed. */
  readonly incidents?: boolean | undefined;
}

const MINUTE = 60_000,
  ROLLOUT_ID = "rollout-1",
  FLAG_KEY = "new-checkout",
  METRIC = "errors",
  STEP_MINUTES = 10,
  PATIENCE_MINUTES = 60,
  FRESH_UNITS = 20,
  FIRST_SHARE = 1000,
  SECOND_SHARE = 5000,
  BASE_ERROR_RATE = 0.02,
  TRAFFIC_PER_MINUTE = 1000,
  START = 1_700_000_000_000,
  BENCH_SEED = 7,
  MICROSECOND = 0.001,
  MOST_PER_INSTANT = 900,
  NOTHING_SEEN: Seen = { control: 0, controlErrors: 0, treatment: 0, treatmentErrors: 0 };

function benchPlan(overrides: Partial<RolloutPlan> = {}): RolloutPlan {
  const step = { maxDurationMs: PATIENCE_MINUTES * MINUTE, minDurationMs: STEP_MINUTES * MINUTE, minFreshUnits: FRESH_UNITS, requiresApproval: false };
  return {
    flagKey: FLAG_KEY,
    guardrails: [{ direction: "lower_is_better", kind: "rate", metric: METRIC, onRegression: "rollback", tolerance: 0 }],
    limits: DEFAULT_LIMITS,
    onInsufficientData: "rollback",
    onMetricsOutage: "hold",
    onSampleRatioMismatch: "rollback",
    requiresApprovalToRelease: false,
    steps: [
      { ...step, treatmentShare: FIRST_SHARE },
      { ...step, treatmentShare: SECOND_SHARE },
    ],
    ...overrides,
  };
}

/** Everything in a bench but the parts that are built on top of the rest. */
type Parts = Omit<Bench, "autopilot" | "metrics" | "incidents">;

const EVERYONE_SEES_IT: Incident = { id: "incident-1", title: "Errors up everywhere" };

function incidentsOf(bench: Parts): IncidentFeed {
  return {
    open: async () => {
      await Promise.resolve();
      return bench.incident ? [EVERYONE_SEES_IT] : [];
    },
  };
}

/** What the source has counted since `since`: everything, less what it had counted when that instant was first asked for. */
function honestSnapshot(bench: Parts, since = START): MetricSnapshot {
  const { seen } = bench,
    mark = bench.marks.get(since) ?? (since > START ? { ...seen } : NOTHING_SEEN),
    control = seen.control - mark.control,
    treatment = seen.treatment - mark.treatment;
  bench.marks.set(since, mark);
  return {
    // The source's clock is the true one; the workers' may not be.
    asOf: bench.now,
    contaminated: 0,
    exposed: { control, treatment },
    metrics: { [METRIC]: { control: { sum: seen.controlErrors - mark.controlErrors, units: control }, treatment: { sum: seen.treatmentErrors - mark.treatmentErrors, units: treatment } } },
    watermark: bench.now - bench.lagMs,
  };
}

function metricsOf(bench: Parts): MetricSource {
  return {
    snapshot: async (query: MetricQuery) => {
      await Promise.resolve();
      bench.metricReads += 1;
      if (bench.metricsDown) {
        throw new Error("The metric source is down.");
      }
      return bench.distort(honestSnapshot(bench, query.since));
    },
  };
}

/** A clock whose every reading by the provider or the store is a microsecond after the one before, so the oracle can tell their order. */
function createClock(): { now: number; ordinal: number; stamp: () => number } {
  const clock = {
    now: START,
    ordinal: 0,
    stamp: (): number => {
      clock.ordinal = Math.min(MOST_PER_INSTANT, clock.ordinal + 1);
      return clock.now + clock.ordinal * MICROSECOND;
    },
  };
  return clock;
}

function partsOf(options: BenchOptions): Parts {
  const random = createRandom(BENCH_SEED),
    clock = createClock(),
    provider = createSimProvider({ checksRevision: options.checksRevision ?? true, now: clock.stamp, random });
  return {
    distort: (snapshot) => snapshot,
    errorRate: { control: BASE_ERROR_RATE, treatment: BASE_ERROR_RATE },
    flags: provider.controlFor("autopilot"),
    incident: false,
    incidentSeen: new Map<string, boolean>(),
    lagMs: 0,
    marks: new Map<number, Seen>(),
    metricReads: 0,
    metricsDown: false,
    notifier: createSimNotifier(),
    get now() {
      return clock.now;
    },
    set now(value: number) {
      clock.now = value;
      clock.ordinal = 0;
    },
    perMinute: TRAFFIC_PER_MINUTE,
    plan: benchPlan(options.plan),
    provider,
    seen: { ...NOTHING_SEEN },
    served: [],
    store: createSimStore({ now: clock.stamp, random }),
  };
}

function createBench(options: BenchOptions = {}): Bench {
  const parts = partsOf(options),
    metrics = metricsOf(parts),
    incidents = options.incidents === true ? { incidents: incidentsOf(parts) } : {},
    autopilot = createAutopilot({ flags: parts.flags, metrics, notifier: parts.notifier, store: parts.store, ...incidents });
  return Object.assign(parts, { autopilot, metrics, ...incidents });
}

/** Some time of traffic through whatever the flag really serves. */
function passTime(bench: Bench, ms: number): void {
  const { allocation } = bench.provider.serving(FLAG_KEY),
    visits = (bench.perMinute * ms) / MINUTE,
    control = (visits * allocation.control) / FULL_SHARE,
    treatment = (visits * allocation.treatment) / FULL_SHARE;
  bench.now += ms;
  bench.seen.control += control;
  bench.seen.treatment += treatment;
  bench.seen.controlErrors += control * bench.errorRate.control;
  bench.seen.treatmentErrors += treatment * bench.errorRate.treatment;
  bench.served.push({ at: bench.now, control: bench.seen.control, treatment: bench.seen.treatment });
}

function passMinute(bench: Bench): void {
  passTime(bench, MINUTE);
}

/** Lets minutes pass, ticking once at the end of each. */
async function runFor(bench: Bench, minutes: number): Promise<void> {
  if (minutes <= 0) {
    return;
  }
  passMinute(bench);
  await bench.autopilot.tick(ROLLOUT_ID, bench.now);
  await runFor(bench, minutes - 1);
}

/** Lets minutes pass with nobody ticking: the runtime is down, the world is not. */
function idleFor(bench: Bench, minutes: number): void {
  for (let minute = 0; minute < minutes; minute += 1) {
    passMinute(bench);
  }
}

async function startedBench(options: BenchOptions = {}): Promise<Bench> {
  const bench = createBench(options);
  await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
  return bench;
}

async function send(bench: Bench, command: Command): Promise<string> {
  const outcome = await bench.autopilot.command(ROLLOUT_ID, command, bench.now);
  return outcome.status;
}

/** The bench's incident feed as one worker reads it, noting what each read answered when it really ran. */
function incidentsSeenBy(bench: Bench, name: string): Pick<Ports, "incidents"> {
  const feed = bench.incidents;
  if (feed === undefined) {
    return {};
  }
  return {
    incidents: {
      open: async () => {
        const open = await feed.open();
        bench.incidentSeen.set(name, open.length > 0);
        return open;
      },
    },
  };
}

/** Another worker on the same world, with its own name in the provider's list of changes and its port calls behind a gate. */
function gatedWorker(bench: Bench, gate: Gate, name: string): Autopilot {
  const ports: Ports = { flags: bench.provider.controlFor(name), metrics: bench.metrics, notifier: bench.notifier, store: bench.store, ...incidentsSeenBy(bench, name) };
  return createAutopilot(gate.portsFor(name, ports));
}

function recordOf(bench: Bench): RolloutRecord {
  return bench.store.current(ROLLOUT_ID);
}

function treatmentShare(bench: Bench): number {
  return bench.provider.serving(FLAG_KEY).allocation.treatment;
}

function eventTypes(bench: Bench): string[] {
  return bench.notifier.calls.map((event) => event.type);
}

export type { Bench, BenchOptions };
export { BASE_ERROR_RATE, FIRST_SHARE, FLAG_KEY, METRIC, MINUTE, ROLLOUT_ID, SECOND_SHARE, START, benchPlan, createBench, eventTypes, gatedWorker, honestSnapshot, idleFor, passMinute, passTime, recordOf, runFor, send, startedBench, treatmentShare };
