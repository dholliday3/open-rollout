import { EVERYBODY, HALF_SHARE, measuredStep, sameAllocation } from "../allocation.js";
import { FLAG_KEY, ROLLOUT_ID } from "./bench.js";
import type { Chaos } from "./chaos.js";
import type { FlagChange } from "./provider.js";
import type { Saved } from "./store.js";

/**
 * The oracle for a chaotic run. Every check reads what really happened (the provider's own list of changes
 * with who made them, the people really served, when the metric source was really down) against what the
 * library decided (each version of the record as it was saved, with the true time). Nothing here trusts the
 * record's own bookkeeping about the flag.
 */

const MS_PER_SECOND = 1000;

function isPerson(change: FlagChange): boolean {
  return change.by.startsWith("person") || change.by === "nobody";
}

/** The last item that is accepted, or undefined. */
function lastWhere<Item>(items: readonly Item[], accepts: (item: Item) => boolean): Item | undefined {
  const accepted = items.filter((item) => accepts(item));
  return accepted.at(-1);
}

function versionAt(versions: readonly Saved[], at: number): Saved | undefined {
  return lastWhere(versions, (saved) => saved.at <= at);
}

/** Claim 1: the flag is only ever written to something the record wanted. */
function writesNobodyAskedFor(chaos: Chaos): string[] {
  const versions = chaos.bench.store.versions(ROLLOUT_ID);
  return chaos.bench.provider
    .changes(FLAG_KEY)
    .filter((change) => !isPerson(change) && !versions.some((saved) => saved.at <= change.at && sameAllocation(saved.record.desired, change.allocation)))
    .map((change) => `claim 1: ${change.by} wrote ${change.allocation.treatment}/${change.allocation.control}, which no saved record had asked for`);
}

function forced(chaos: Chaos, by: number): boolean {
  return [...chaos.sent.values()].some((command) => command.type === "release" && (chaos.sentAt.get(command.id) ?? Number.POSITIVE_INFINITY) <= by);
}

/** Claim 1: steps are taken one at a time, and everybody only after the last one, unless a person forced the release. */
function skippedSteps(chaos: Chaos): string[] {
  const versions = chaos.bench.store.versions(ROLLOUT_ID),
    last = chaos.bench.plan.steps.length - 1,
    problems: string[] = [];
  for (const [index, after] of versions.entries()) {
    const before = versions.at(Math.max(0, index - 1)) ?? after,
      jumped = after.record.stepIndex > before.record.stepIndex + 1,
      released = sameAllocation(after.record.desired, EVERYBODY) && !sameAllocation(before.record.desired, EVERYBODY) && before.record.stepIndex < last;
    if ((jumped || released) && !forced(chaos, after.at)) {
      problems.push(`claim 1: version ${after.version} went from step ${before.record.stepIndex} to ${released ? "everybody" : `step ${after.record.stepIndex}`}`);
    }
  }
  return problems;
}

function servedBy(chaos: Chaos, at: number): { control: number; treatment: number } {
  return lastWhere(chaos.bench.served, (entry) => entry.at <= at) ?? { control: 0, treatment: 0 };
}

interface Stretch {
  readonly from: number;
  readonly to: number;
}

/** Every stretch of time, up to an instant, in which the flag really served an allocation. */
function stretchesServing(chaos: Chaos, allocation: { control: number; treatment: number }, upTo: number): Stretch[] {
  const changes = chaos.bench.provider.changes(FLAG_KEY).filter((change) => change.at < upTo);
  return changes.flatMap((change, index) => (sameAllocation(change.allocation, allocation) ? [{ from: change.at, to: changes.at(index + 1)?.at ?? upTo }] : []));
}

function metricsWereDown(chaos: Chaos, at: number): boolean {
  return lastWhere(chaos.outages, (outage) => outage.at <= at)?.down ?? false;
}

function gainedIn(chaos: Chaos, stretches: readonly Stretch[]): { control: number; treatment: number; ms: number } {
  const gained = { control: 0, ms: 0, treatment: 0 };
  for (const stretch of stretches) {
    gained.ms += stretch.to - stretch.from;
    gained.control += servedBy(chaos, stretch.to).control - servedBy(chaos, stretch.from).control;
    gained.treatment += servedBy(chaos, stretch.to).treatment - servedBy(chaos, stretch.from).treatment;
  }
  return gained;
}

/**
 * Why a move forward at `after` had no right to happen, from the truth; an empty list when it had. The time
 * and the people are added up over every stretch the flag really served the step, which is more generous
 * than the library's own rule (one unbroken watch), so anything listed here is a real shortfall.
 */
function evidenceProblems(chaos: Chaos, before: Saved, after: Saved): string[] {
  const { plan } = chaos.bench,
    step = plan.steps[before.record.stepIndex],
    stretches = stretchesServing(chaos, measuredStep(step.treatmentShare), after.at),
    gained = gainedIn(chaos, stretches),
    problems: string[] = [];
  if (metricsWereDown(chaos, after.at)) {
    problems.push("the metric source was down");
  }
  if (stretches.at(-1)?.to !== after.at) {
    problems.push("the flag was not serving the step");
  }
  if (gained.ms < step.minDurationMs + plan.limits.propagationMs - 2 * chaos.options.skewMs) {
    problems.push(`the step had really been in force for ${Math.round(gained.ms / MS_PER_SECOND)}s in all`);
  }
  if (Math.min(gained.control, gained.treatment) < step.minFreshUnits) {
    problems.push(`only ${Math.floor(Math.min(gained.control, gained.treatment))} people had really been served on an arm during it`);
  }
  return problems;
}

/** Claim 2: no step-up and no release of its own without the evidence the plan asks for. */
function forwardWithoutEvidence(chaos: Chaos): string[] {
  const versions = chaos.bench.store.versions(ROLLOUT_ID),
    problems: string[] = [];
  for (const [index, after] of versions.entries()) {
    const before = versions.at(Math.max(0, index - 1)) ?? after,
      steppedUp = before.record.stepIndex >= 0 && after.record.stepIndex === before.record.stepIndex + 1,
      released = after.record.phase === "releasing" && before.record.phase !== "releasing" && after.record.outcome?.reason === "completed";
    if ((steppedUp || released) && !forced(chaos, after.at)) {
      problems.push(...evidenceProblems(chaos, before, after).map((problem) => `claim 2: version ${after.version} moved on from step ${before.record.stepIndex} while ${problem}`));
    }
  }
  return problems;
}

/** Claim 3: once a rollback is saved, the record never wants anybody on the new behaviour again. */
function rollbackUndone(chaos: Chaos): string[] {
  const versions = chaos.bench.store.versions(ROLLOUT_ID),
    from = versions.findIndex((saved) => saved.record.phase === "rolling_back" || saved.record.phase === "rolled_back");
  if (from === -1) {
    return [];
  }
  return versions
    .slice(from)
    .filter((saved) => saved.record.desired.treatment > 0 || !["rolling_back", "rolled_back"].includes(saved.record.phase))
    .map((saved) => `claim 3: version ${saved.version} is ${saved.record.phase} wanting ${saved.record.desired.treatment} after the rollback was saved`);
}

/** When the pause that holds at an instant began, or null when the rollout wasn't paused then. */
function pausedSince(versions: readonly Saved[], at: number): number | null {
  let since: number | null = null;
  for (const saved of versions) {
    if (saved.at <= at) {
      since = saved.record.phase === "paused" ? (since ?? saved.at) : null;
    }
  }
  return since;
}

/** Claim 4: nothing the library sends after a pause was saved raises exposure. */
function raisedWhilePaused(chaos: Chaos): string[] {
  const versions = chaos.bench.store.versions(ROLLOUT_ID),
    changes = chaos.bench.provider.changes(FLAG_KEY),
    problems: string[] = [];
  for (const [index, change] of changes.entries()) {
    const previous = changes.at(Math.max(0, index - 1)) ?? change,
      since = pausedSince(versions, change.at),
      sentAt = chaos.wired.get(change.by) ?? change.at;
    if (!isPerson(change) && change.allocation.treatment > previous.allocation.treatment && since !== null && sentAt > since) {
      problems.push(`claim 4: ${change.by} raised the flag from ${previous.allocation.treatment} to ${change.allocation.treatment} while paused (${versionAt(versions, change.at)?.record.pause?.reason ?? "?"})`);
    }
  }
  return problems;
}

/** Nothing the library sends raises exposure when its worker's read of the incident feed answered with an open incident, unless a person forced a release. */
function raisedDuringIncident(chaos: Chaos): string[] {
  const changes = chaos.bench.provider.changes(FLAG_KEY);
  return changes.flatMap((change, index) => {
    const previous = changes.at(Math.max(0, index - 1)) ?? change;
    if (isPerson(change) || change.allocation.treatment <= previous.allocation.treatment || chaos.bench.incidentSeen.get(change.by) !== true || forced(chaos, change.at)) {
      return [];
    }
    return [`hold: ${change.by} raised the flag from ${previous.allocation.treatment} to ${change.allocation.treatment} after reading an open incident`];
  });
}

/** What each event key was used for; a key used for two different events is a problem. */
function eventsByKey(chaos: Chaos, problems: string[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const event of chaos.bench.notifier.calls) {
    const content = `${event.type}|${event.at}|${event.detail}`;
    if ((byKey.get(event.key) ?? content) !== content) {
      problems.push(`claim 5: the key ${event.key} named two events: ${byKey.get(event.key) ?? ""} and ${content}`);
    }
    byKey.set(event.key, content);
  }
  return byKey;
}

/** Claim 5: a command does its thing once, however often it is sent; and one key is one event. */
function repeatedEffects(chaos: Chaos): string[] {
  const problems: string[] = [],
    contents = [...eventsByKey(chaos, problems).values()];
  for (const id of chaos.sent.keys()) {
    const effects = contents.filter((content) => content.includes(`person(${id})`));
    if (effects.length > 1) {
      problems.push(`claim 5: the command ${id} took effect ${effects.length} times: ${effects.join(" ; ")}`);
    }
  }
  return problems;
}

/** Events the record counted that no one was ever told about, once the notifier was back. */
function lostEvents(chaos: Chaos): string[] {
  const record = chaos.bench.store.current(ROLLOUT_ID),
    told = new Set(chaos.bench.notifier.calls.map((event) => event.key)),
    owed = new Set(record.outbox.map((event) => event.key)),
    missing: string[] = [];
  for (let count = 1; count <= record.eventCount; count += 1) {
    const key = `${ROLLOUT_ID}:${count}`;
    if (!told.has(key) && !owed.has(key)) {
      missing.push(key);
    }
  }
  return missing.length === 0 ? [] : [`events never delivered and no longer owed: ${missing.join(", ")}`];
}

/**
 * The README's known limit for a provider that can't refuse a late write: a worker frozen inside a write for
 * longer than `settleMs` lands it after the rollout settled, when nothing is watching the flag any more.
 */
function landedAfterSettling(chaos: Chaos): boolean {
  const settled = chaos.bench.store.versions(ROLLOUT_ID).find((saved) => saved.record.settled),
    serving = chaos.bench.provider.serving(FLAG_KEY);
  return !chaos.options.checksRevision && settled !== undefined && !isPerson(serving) && serving.at >= settled.at;
}

/**
 * Claim 7: after clean ticks the flag is what the record wants. A paused rollout may sit below it; a person's
 * last word on a finished flag stands; and the known limit above is not counted against the claim.
 */
function notConverged(chaos: Chaos): string[] {
  const record = chaos.bench.store.current(ROLLOUT_ID),
    serving = chaos.bench.provider.serving(FLAG_KEY),
    { allocation } = serving,
    lower = record.phase === "paused" && allocation.treatment <= record.desired.treatment,
    theirs = (record.phase === "released" || record.settled) && isPerson(serving);
  if (sameAllocation(allocation, record.desired) || lower || theirs || landedAfterSettling(chaos)) {
    return [];
  }
  return [`claim 7: after clean ticks the flag serves ${allocation.treatment}/${allocation.control} (last set by ${serving.by}) but the record (${record.phase}${record.settled ? ", settled" : ""}) wants ${record.desired.treatment}/${record.desired.control}`];
}

/** Claim 1: more than half on the new behaviour only once a release was decided. */
function aboveHalfEarly(chaos: Chaos): string[] {
  const versions = chaos.bench.store.versions(ROLLOUT_ID);
  return chaos.bench.provider
    .changes(FLAG_KEY)
    .filter((change) => !isPerson(change) && change.allocation.treatment > HALF_SHARE && !versions.some((saved) => saved.at <= change.at && sameAllocation(saved.record.desired, EVERYBODY)))
    .map((change) => `claim 1: ${change.by} put ${change.allocation.treatment} on the new behaviour before any release was decided`);
}

/** Every safety invariant that can be read off the histories, as sentences; empty when all held. */
function safetyViolations(chaos: Chaos): string[] {
  return [...writesNobodyAskedFor(chaos), ...skippedSteps(chaos), ...aboveHalfEarly(chaos), ...forwardWithoutEvidence(chaos), ...rollbackUndone(chaos), ...raisedWhilePaused(chaos), ...raisedDuringIncident(chaos), ...repeatedEffects(chaos), ...chaos.rejected];
}

export { lostEvents, notConverged, safetyViolations };
