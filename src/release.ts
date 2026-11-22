import type { Autopilot } from "./controller";
import type { RolloutPlan } from "./plan";
import { planProblems } from "./plan";

/**
 * A release takes one change through environments in order (staging, then production), each with its
 * own rollout. It is LaunchDarkly's flag release plan: the next environment starts only after the one
 * before it has released, and a rollback anywhere pauses everything that hasn't started.
 */

/**
 * What starts an environment's rollout once the one before it has released.
 * - `promotion`: nothing more; it starts by itself.
 * - `deploy_signal`: the deploy pipeline says the code is live there.
 * - `manual`: a person says go.
 */
type Trigger = "promotion" | "deploy_signal" | "manual";

interface ReleaseStage {
  readonly environment: string;
  readonly trigger: Trigger;
  readonly plan: RolloutPlan;
}

type StageStatus = "waiting" | "running" | "released" | "rolled_back";

interface StageState {
  readonly status: StageStatus;
  /** True once this environment's signal or go-ahead has arrived. It can arrive early and is kept. */
  readonly triggered: boolean;
  /** Counts rollouts tried here, so a second try after a rollback gets a rollout id of its own. */
  readonly attempt: number;
}

/** Everything about one release. Like a rollout's record, it lives in a store and any worker can carry it on. */
interface ReleaseRecord {
  readonly id: string;
  readonly stages: readonly ReleaseStage[];
  readonly states: readonly StageState[];
  /** Why nothing new will start, or null when the release is moving. */
  readonly pausedBecause: string | null;
}

interface StoredRelease {
  readonly record: ReleaseRecord;
  readonly version: number;
}

/** Where releases live. Compare-and-set on `version`, as for rollouts. */
interface ReleaseStore {
  create: (record: ReleaseRecord) => Promise<boolean>;
  load: (id: string) => Promise<StoredRelease | null>;
  save: (record: ReleaseRecord, expectedVersion: number) => Promise<number | null>;
}

interface ReleasePorts {
  readonly store: ReleaseStore;
  /** The autopilot that owns an environment's flags and metrics. */
  readonly autopilotFor: (environment: string) => Autopilot;
}

interface Releaser {
  /** False when the id is taken, an environment is named twice, or a stage's plan can't run. Nothing is started then. */
  start: (id: string, stages: readonly ReleaseStage[]) => Promise<boolean>;
  /** Records that an environment's deploy finished, or that a person said go there. Safe to send twice. False for an environment the release doesn't have. */
  signal: (id: string, environment: string) => Promise<boolean>;
  /** Carries on after a rollback paused the release. The environment that rolled back waits for its signal again. */
  resume: (id: string) => Promise<boolean>;
  /** Looks at each environment's rollout and starts the next one when its turn and its trigger have come. */
  tick: (id: string, now: number) => Promise<ReleaseRecord | null>;
}

const WAITING: StageState = { attempt: 0, status: "waiting", triggered: false };

function newRelease(id: string, stages: readonly ReleaseStage[]): ReleaseRecord {
  return { id, pausedBecause: null, stages, states: stages.map(() => WAITING) };
}

/** The id of an environment's rollout. The same every time it is worked out, so starting it twice starts it once. */
function rolloutId(release: ReleaseRecord, index: number): string {
  return `${release.id}/${release.stages.at(index)?.environment ?? index}/${release.states.at(index)?.attempt ?? 0}`;
}

function withState(release: ReleaseRecord, index: number, patch: Partial<StageState>): ReleaseRecord {
  return { ...release, states: release.states.map((state, at) => (at === index ? { ...state, ...patch } : state)) };
}

/** Notes an environment's signal. It is kept if it comes early, and ignored if that environment has already started. */
function signalled(release: ReleaseRecord, environment: string): ReleaseRecord {
  const index = release.stages.findIndex((stage) => stage.environment === environment);
  return index === -1 || release.states.at(index)?.status !== "waiting" ? release : withState(release, index, { triggered: true });
}

/** Takes in how an environment's rollout ended. A rollback pauses the release. */
function observed(release: ReleaseRecord, index: number, phase: string | null): ReleaseRecord {
  if (release.states.at(index)?.status !== "running") {
    return release;
  }
  if (phase === "released") {
    return withState(release, index, { status: "released" });
  }
  if (phase !== "rolled_back") {
    return release;
  }
  const environment = release.stages.at(index)?.environment ?? "an environment";
  return { ...withState(release, index, { status: "rolled_back" }), pausedBecause: `The rollout in ${environment} was rolled back.` };
}

/** The environment whose rollout should start now, or -1: the first one waiting, if every one before it has released. */
function nextToStart(release: ReleaseRecord): number {
  const index = release.states.findIndex((state) => state.status !== "released"),
    state = release.states.at(index),
    stage = release.stages.at(index);
  if (release.pausedBecause !== null || state?.status !== "waiting" || stage === undefined) {
    return -1;
  }
  return stage.trigger === "promotion" || state.triggered ? index : -1;
}

/** Unpauses. The environment that rolled back goes back to waiting, for a new rollout and a new signal. */
function resumed(release: ReleaseRecord): ReleaseRecord {
  const states = release.states.map((state): StageState => (state.status === "rolled_back" ? { attempt: state.attempt + 1, status: "waiting", triggered: false } : state));
  return { ...release, pausedBecause: null, states };
}

async function phaseOf(ports: ReleasePorts, release: ReleaseRecord, index: number): Promise<string | null> {
  const stage = release.stages.at(index);
  if (stage === undefined || release.states.at(index)?.status !== "running") {
    return null;
  }
  const inspection = await ports.autopilotFor(stage.environment).inspect(rolloutId(release, index));
  return inspection?.record.phase ?? null;
}

/**
 * Starts the rollout of the environment marked running. Starting one that is already under way does
 * nothing, so a crash between saving and starting is put right here. Returns why it couldn't start, if it
 * couldn't: a stage whose rollout was refused is not running, and somebody has to be told.
 */
async function ensureStarted(ports: ReleasePorts, release: ReleaseRecord, now: number): Promise<string | null> {
  const index = release.states.findIndex((state) => state.status === "running"),
    stage = release.stages.at(index);
  if (index === -1 || stage === undefined) {
    return null;
  }
  const result = await ports.autopilotFor(stage.environment).start({ id: rolloutId(release, index), now, plan: stage.plan });
  return result.status === "started" ? null : `The rollout in ${stage.environment} couldn't start. ${result.problems.join(" ")}`;
}

/** A stage whose rollout was refused goes back to waiting and the release pauses, saying why; a resume tries it afresh. */
async function holdUnstarted(ports: ReleasePorts, stored: StoredRelease, why: string): Promise<ReleaseRecord> {
  const index = stored.record.states.findIndex((state) => state.status === "running"),
    state = stored.record.states.at(index),
    held: ReleaseRecord = { ...withState(stored.record, index, { attempt: (state?.attempt ?? 0) + 1, status: "waiting", triggered: false }), pausedBecause: why };
  await ports.store.save(held, stored.version);
  return held;
}

async function tick(ports: ReleasePorts, id: string, now: number): Promise<ReleaseRecord | null> {
  const stored = await ports.store.load(id);
  if (stored === null) {
    return null;
  }
  const running = stored.record.states.findIndex((state) => state.status === "running"),
    seen = observed(stored.record, running, await phaseOf(ports, stored.record, running)),
    next = nextToStart(seen),
    decided = next === -1 ? seen : withState(seen, next, { status: "running" });
  const version = decided === stored.record ? stored.version : await ports.store.save(decided, stored.version);
  if (version === null) {
    return null;
  }
  const refusal = await ensureStarted(ports, decided, now);
  return refusal === null ? decided : holdUnstarted(ports, { record: decided, version }, refusal);
}

/** Loads a release, changes it, and saves it; false when it isn't there, the change changes nothing it should, or another worker saved first. */
async function change(ports: ReleasePorts, id: string, apply: (release: ReleaseRecord) => ReleaseRecord | null): Promise<boolean> {
  const stored = await ports.store.load(id),
    next = stored === null ? null : apply(stored.record);
  if (stored === null || next === null) {
    return false;
  }
  const saved = await ports.store.save(next, stored.version);
  return saved !== null;
}

/** True when a release's stages can run: at least one, each environment once, every plan sound. */
function canRelease(stages: readonly ReleaseStage[]): boolean {
  const names = new Set(stages.map((stage) => stage.environment));
  return stages.length > 0 && names.size === stages.length && stages.every((stage) => planProblems(stage.plan).length === 0);
}

function createReleaser(ports: ReleasePorts): Releaser {
  return {
    resume: async (id) => {
      const done = await change(ports, id, resumed);
      return done;
    },
    signal: async (id, environment) => {
      const done = await change(ports, id, (release) => (release.stages.some((stage) => stage.environment === environment) ? signalled(release, environment) : null));
      return done;
    },
    start: async (id, stages) => {
      const created = canRelease(stages) && (await ports.store.create(newRelease(id, stages)));
      return created;
    },
    tick: async (id, now) => {
      const release = await tick(ports, id, now);
      return release;
    },
  };
}

function createMemoryReleaseStore(): ReleaseStore {
  const rows = new Map<string, StoredRelease>();
  return {
    create: async (record) => {
      await Promise.resolve();
      if (rows.has(record.id)) {
        return false;
      }
      rows.set(record.id, { record, version: 1 });
      return true;
    },
    load: async (id) => {
      await Promise.resolve();
      return rows.get(id) ?? null;
    },
    save: async (record, expectedVersion) => {
      await Promise.resolve();
      if (rows.get(record.id)?.version !== expectedVersion) {
        return null;
      }
      rows.set(record.id, { record, version: expectedVersion + 1 });
      return expectedVersion + 1;
    },
  };
}

export type { ReleasePorts, ReleaseRecord, ReleaseStage, ReleaseStore, Releaser, StageState, StageStatus, StoredRelease, Trigger };
export { createMemoryReleaseStore, createReleaser, newRelease, nextToStart, observed, resumed, rolloutId, signalled };
