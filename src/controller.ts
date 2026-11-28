import type { Command, CommandResult } from "./commands.js";
import type { Ports, Stored } from "./ports.js";
import { acknowledge, applyWrite } from "./write.js";
import { isDone, newRecord, withEvent } from "./record.js";
import { judge, snapshotProblem } from "./judge.js";
import { messageOf, readFlag, readIncidents, readMetrics } from "./observe.js";
import { planProblems, samePlan } from "./plan.js";
import type { Judgement } from "./judge.js";
import type { RolloutPlan } from "./plan.js";
import type { RolloutRecord } from "./record.js";
import { applyCommand } from "./commands.js";
import { decide } from "./decide.js";
import { proceedTo } from "./transitions.js";

interface StartRequest {
  readonly id: string;
  readonly plan: RolloutPlan;
  readonly now: number;
}

interface StartResult {
  /** `refused` carries why in `problems`: a plan that can't run, a flag already on, or a rollout already there. */
  readonly status: "started" | "refused";
  readonly record: RolloutRecord | null;
  readonly problems: readonly string[];
}

interface TickResult {
  /**
   * `lost_race` means another worker's tick got there first; its decision stands and this one did nothing.
   * `failed` means the store itself couldn't be reached; nothing was decided, and the next tick starts over.
   */
  readonly status: "not_found" | "settled" | "lost_race" | "ticked" | "failed";
  readonly record: RolloutRecord | null;
  readonly wrote: boolean;
  /** Reads, writes or notices that failed this tick, for logs. None of them stops the next tick trying again. */
  readonly problems: readonly string[];
}

interface CommandOutcome {
  readonly status: CommandResult["status"] | "not_found" | "busy";
  readonly refusal: string | null;
  readonly record: RolloutRecord | null;
}

interface Inspection {
  readonly record: RolloutRecord;
  /** What the guardrails read right now; null when nobody is exposed yet or the metrics can't be read. */
  readonly judgement: Judgement | null;
}

/** The whole library from a runtime's side: start a rollout, tick it, tell it things, look at it. */
interface Autopilot {
  start: (request: StartRequest) => Promise<StartResult>;
  /**
   * One look at the world and at most one write. Safe to call late, twice, or from two workers at once.
   * It never throws: a store that can't be reached comes back as `failed`, and nothing was decided. A
   * runtime that retries a step only when it throws should throw on `failed` itself.
   */
  tick: (id: string, now: number) => Promise<TickResult>;
  /** Ticks every rollout that still needs it. One rollout's failure is reported as `failed` and never hides another's tick. */
  tickAll: (now: number) => Promise<TickResult[]>;
  command: (id: string, command: Command, now: number) => Promise<CommandOutcome>;
  inspect: (id: string) => Promise<Inspection | null>;
  /**
   * Units an hour that evaluated the flag over the last day, whatever it served them, for `forecast` and
   * `standardPlan({ unitsPerHour })`. Null when the metric source can't measure it, or the measure failed.
   */
  traffic: (flagKey: string) => Promise<number | null>;
}

/** A command is tried again when another worker saved first. A rollback must not give up after a few lost races. */
const COMMAND_ATTEMPTS = 20,
  /** A whole day, so a quiet night and a busy afternoon both count. */
  TRAFFIC_WINDOW_MS = 86_400_000;

async function notifyOne(ports: Ports, event: RolloutRecord["outbox"][number], problems: string[]): Promise<boolean> {
  try {
    await ports.notifier.notify(event);
    return true;
  } catch (error) {
    problems.push(`Sending ${event.key} failed: ${messageOf(error)}`);
    return false;
  }
}

/**
 * Sends what the saved record still owes people, then drops what was sent. An event is saved before it is
 * sent, so a crash in between sends it again next tick with the same key; it is never lost.
 */
async function deliver(ports: Ports, stored: Stored, problems: string[]): Promise<void> {
  const { outbox } = stored.record;
  if (outbox.length === 0) {
    return;
  }
  const sending: Promise<boolean>[] = [];
  for (const event of outbox) {
    sending.push(notifyOne(ports, event, problems));
  }
  const sent = await Promise.all(sending),
    remaining = outbox.filter((_event, index) => !(sent.at(index) ?? false));
  if (remaining.length < outbox.length) {
    await ports.store.save({ ...stored.record, outbox: remaining }, stored.version);
  }
}

async function tick(ports: Ports, id: string, now: number): Promise<TickResult> {
  const stored = await ports.store.load(id);
  if (stored === null || stored.record.settled) {
    return { problems: [], record: stored?.record ?? null, status: stored === null ? "not_found" : "settled", wrote: false };
  }
  const problems: string[] = [],
    // The flag first, then the metrics: a step's watch starts from a snapshot asked for after the flag was seen serving it.
    flag = await readFlag(ports, stored.record, problems),
    metrics = await readMetrics(ports, stored.record, problems),
    incidents = await readIncidents(ports, stored.record, problems),
    decision = decide(stored.record, { flag, incidents, metrics, staleWritesRefused: ports.flags.refusesStaleWrites }, now),
    // The decision is saved before anything acts on it: only the worker whose save wins may touch the flag.
    version = decision.record === stored.record ? stored.version : await ports.store.save(decision.record, stored.version);
  if (version === null) {
    return { problems, record: null, status: "lost_race", wrote: false };
  }
  const revision = await applyWrite(ports, decision, { problems, version }),
    saved = { record: decision.record, version },
    after = revision === null ? saved : await acknowledge(ports, saved, revision);
  await deliver(ports, after, problems);
  return { problems, record: after.record, status: "ticked", wrote: revision !== null };
}

/** A tick that reports a store it couldn't reach instead of throwing, so one rollout's trouble never hides another's tick. */
async function safeTick(ports: Ports, id: string, now: number): Promise<TickResult> {
  try {
    const result = await tick(ports, id, now);
    return result;
  } catch (error) {
    return { problems: [`The tick failed: ${messageOf(error)}`], record: null, status: "failed", wrote: false };
  }
}

async function tickAll(ports: Ports, now: number): Promise<TickResult[]> {
  const ids = await ports.store.listUnsettled(),
    ticking: Promise<TickResult>[] = [];
  for (const id of ids) {
    ticking.push(safeTick(ports, id, now));
  }
  const results = await Promise.all(ticking);
  return results;
}

async function startProblems(ports: Ports, plan: RolloutPlan): Promise<string[]> {
  const problems = planProblems(plan);
  if (problems.length > 0) {
    return problems;
  }
  try {
    const flag = await ports.flags.read(plan.flagKey);
    if (flag.allocation.treatment > 0) {
      return ["The flag already serves the new behaviour to some traffic. Turn it off, or finish its rollout, before starting one."];
    }
    const setup = (await ports.flags.setupProblem?.(plan.flagKey)) ?? null;
    return setup === null ? [] : [setup];
  } catch (error) {
    return [`The flag couldn't be read: ${messageOf(error)}`];
  }
}

/**
 * A start that is sent again with the same plan (a retried step) finds its own rollout and says so,
 * instead of refusing itself. The same id with another plan, or for a rollout that has already finished,
 * is a different request, and is refused: nothing would start.
 */
async function alreadyStarted(ports: Ports, request: StartRequest): Promise<StartResult | null> {
  const stored = await ports.store.load(request.id);
  if (stored === null) {
    return null;
  }
  if (!samePlan(stored.record.plan, request.plan)) {
    return { problems: ["A rollout with this id already exists, with a different plan."], record: null, status: "refused" };
  }
  if (isDone(stored.record)) {
    return { problems: ["A rollout with this id has already finished. Start a new one under a new id."], record: null, status: "refused" };
  }
  return { problems: [], record: stored.record, status: "started" };
}

async function start(ports: Ports, request: StartRequest): Promise<StartResult> {
  const before = await alreadyStarted(ports, request),
    problems = before === null ? await startProblems(ports, request.plan) : [];
  if (before !== null || problems.length > 0) {
    return before ?? { problems, record: null, status: "refused" };
  }
  const fresh = withEvent(newRecord(request.id, request.plan, request.now), { at: request.now, detail: `Rollout of ${request.plan.flagKey} started.`, type: "started" }),
    record = proceedTo(fresh, 0, request.now);
  if (!(await ports.store.create(record))) {
    return { problems: ["A rollout with this id exists, or this flag already has a rollout in progress."], record: null, status: "refused" };
  }
  await safeTick(ports, request.id, request.now);
  return { problems: [], record, status: "started" };
}

/** Loads, applies and saves a command, trying again when another worker saved in between. */
async function command(ports: Ports, request: { id: string; command: Command; now: number }, attemptsLeft: number): Promise<CommandOutcome> {
  const stored = await ports.store.load(request.id);
  if (stored === null) {
    return { record: null, refusal: null, status: "not_found" };
  }
  const result = applyCommand(stored.record, request.command, request.now);
  // A first refusal is saved too, so the same command sent later is refused again.
  if (result.record !== stored.record && (await ports.store.save(result.record, stored.version)) === null) {
    return attemptsLeft > 1 ? command(ports, request, attemptsLeft - 1) : { record: null, refusal: null, status: "busy" };
  }
  if (result.status === "applied") {
    // A person who says "roll back" shouldn't wait for the next scheduled tick.
    await safeTick(ports, request.id, request.now);
  }
  return result;
}

async function inspect(ports: Ports, id: string): Promise<Inspection | null> {
  const stored = await ports.store.load(id);
  if (stored === null) {
    return null;
  }
  const snapshot = await readMetrics(ports, stored.record, []),
    readable = snapshot !== null && snapshotProblem(stored.record.plan, snapshot) === null;
  return { judgement: readable ? judge(stored.record.plan, snapshot) : null, record: stored.record };
}

async function traffic(ports: Ports, flagKey: string): Promise<number | null> {
  try {
    const perHour = await ports.metrics.traffic?.({ flagKey, windowMs: TRAFFIC_WINDOW_MS });
    return perHour !== undefined && Number.isFinite(perHour) && perHour >= 0 ? perHour : null;
  } catch {
    return null;
  }
}

/** An autopilot over these ports. It holds no state of its own: every call starts from the store. */
function createAutopilot(ports: Ports): Autopilot {
  return {
    command: async (id, issued, now) => {
      const outcome = await command(ports, { command: issued, id, now }, COMMAND_ATTEMPTS);
      return outcome;
    },
    inspect: async (id) => {
      const inspection = await inspect(ports, id);
      return inspection;
    },
    start: async (request) => {
      const result = await start(ports, request);
      return result;
    },
    tick: async (id, now) => {
      const result = await safeTick(ports, id, now);
      return result;
    },
    tickAll: async (now) => {
      const results = await tickAll(ports, now);
      return results;
    },
    traffic: async (flagKey) => {
      const perHour = await traffic(ports, flagKey);
      return perHour;
    },
  };
}

export type { Autopilot, CommandOutcome, Inspection, StartRequest, StartResult, TickResult };
export { createAutopilot };
