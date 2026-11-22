import { EVERYBODY, NOBODY, measuredStep } from "../allocation";
import { FIRST_SHARE, FLAG_KEY, MINUTE, ROLLOUT_ID, SECOND_SHARE, createBench, gatedWorker, idleFor, recordOf, runFor, send, startedBench, treatmentShare } from "./bench";
import { describe, expect, it, vi } from "vitest";
import type { Bench } from "./bench";
import type { Command } from "../commands";
import type { Gate } from "./gate";
import { createGate } from "./gate";

vi.setConfig({ testTimeout: 10_000 });

const A_WHILE = 5,
  STEP_AND_A_BIT = 13,
  HALF_AN_HOUR = 30,
  TWENTY_MINUTES = 20,
  TEN_MINUTES = 10,
  BROKEN = 0.5;

interface Stalled {
  readonly bench: Bench;
  readonly gate: Gate;
  /** The stalled worker's tick, which ends once its write is let through. */
  readonly tick: Promise<unknown>;
}

/**
 * A rollout whose first write failed, with a worker ("zombie") stalled inside the retry of that write a
 * minute later: it has saved its decision, has checked the record's version, and its provider call is on
 * the wire.
 */
async function withStalledWrite(checksRevision: boolean): Promise<Stalled> {
  const bench = createBench({ checksRevision }),
    gate = createGate();
  bench.provider.faults.writesDown = true;
  await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
  bench.provider.faults.writesDown = false;
  idleFor(bench, 1);
  const tick = gatedWorker(bench, gate, "zombie").tick(ROLLOUT_ID, bench.now);
  await gate.runUntil("zombie", "flags.write");
  return { bench, gate, tick };
}

/** The stalled write lands at last, and its worker's tick ends. */
async function land(stalled: Stalled): Promise<void> {
  await stalled.gate.finish("zombie");
  await stalled.tick;
}

/** A person's command, then some ticks a minute apart. */
async function sendThenRun(bench: Bench, command: Command, minutes: number): Promise<void> {
  await send(bench, command);
  await runFor(bench, minutes);
}

/** One read is answered with what the flag served before its last change; nobody touched the flag. */
async function oneStaleRead(bench: Bench): Promise<void> {
  Object.assign(bench.provider.faults, { staleReadChance: 1, staleReadMs: HALF_AN_HOUR * MINUTE });
  await runFor(bench, 1);
  Object.assign(bench.provider.faults, { staleReadChance: 0, staleReadMs: 0 });
  await runFor(bench, 2);
}

/** README claim 7, "Everything converges", and `settleMs`: "so a late write from a stalled worker gets put right". */
describe("claim 7: a stalled worker's write that lands late", () => {
  it("is put right after a rollback, inside the settle window", async () => {
    expect.hasAssertions();
    const stalled = await withStalledWrite(false),
      { bench } = stalled;
    await runFor(bench, 1);
    await sendThenRun(bench, { by: "dana", id: "undo", type: "rollback" }, 2);
    expect(recordOf(bench).phase).toBe("rolled_back");
    await land(stalled);
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
    await runFor(bench, 2);
    expect(treatmentShare(bench)).toBe(0);
  });

  it("is put right after a release, inside the settle window", async () => {
    expect.hasAssertions();
    const stalled = await withStalledWrite(false),
      { bench } = stalled;
    await runFor(bench, 1);
    await sendThenRun(bench, { by: "dana", id: "ship", type: "release" }, 1);
    expect(recordOf(bench).phase).toBe("released");
    // Three minutes after it stalled, well inside settleMs, the stalled write lands on a provider with no revision check.
    await land(stalled);
    expect(bench.provider.serving(FLAG_KEY)).toMatchObject({ allocation: measuredStep(FIRST_SHARE), by: "zombie" });
    await runFor(bench, A_WHILE);
    expect(recordOf(bench).settled).toBe(false);
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });

  it("is refused outright by a provider that checks revisions", async () => {
    expect.hasAssertions();
    const stalled = await withStalledWrite(true),
      { bench } = stalled;
    await runFor(bench, 1);
    await sendThenRun(bench, { by: "dana", id: "ship", type: "release" }, 1);
    await land(stalled);
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });
});

/** Two workers tick at the same instant, and both reach their save before either is let through. */
async function raceToSave(bench: Bench, gate: Gate): Promise<void> {
  const first = gatedWorker(bench, gate, "first").tick(ROLLOUT_ID, bench.now),
    second = gatedWorker(bench, gate, "second").tick(ROLLOUT_ID, bench.now);
  await gate.runUntil("first", "store.save");
  await gate.runUntil("second", "store.save");
  await gate.finish("first");
  await gate.finish("second");
  await Promise.all([first, second]);
}

/** README claim 5: "Two workers ticking at once: one save wins and only the winner writes." */
describe("claim 5: two workers on one decision", () => {
  it("makes one flag write when both tick while a write is still owed", async () => {
    expect.hasAssertions();
    const { bench, gate, tick } = await withStalledWrite(false),
      second = gatedWorker(bench, gate, "second").tick(ROLLOUT_ID, bench.now);
    await gate.runUntil("second", "flags.write");
    await gate.finish("zombie");
    await gate.finish("second");
    await Promise.all([tick, second]);
    expect(bench.provider.changes(FLAG_KEY).filter((change) => change.allocation.treatment === FIRST_SHARE)).toHaveLength(1);
  });

  it("lets only the worker whose save won write when the record changes", async () => {
    expect.hasAssertions();
    const bench = await startedBench({ checksRevision: false }),
      gate = createGate();
    await runFor(bench, STEP_AND_A_BIT - 2);
    bench.now += MINUTE;
    await raceToSave(bench, gate);
    expect(bench.provider.changes(FLAG_KEY).filter((change) => change.allocation.treatment === SECOND_SHARE)).toHaveLength(1);
  });
});

/** README, Lifecycle: "Guardrails are read on every tick while anyone is exposed". */
describe("guardrails while people are exposed", () => {
  it("reads them during the first step even when the flag can't be read back", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
    // The step is live. Now the provider's read call fails (a rate limit, a flag the adapter can no longer parse).
    bench.provider.faults.readsDown = true;
    bench.errorRate = { control: 0, treatment: BROKEN };
    await runFor(bench, HALF_AN_HOUR);
    expect(bench.metricReads).toBeGreaterThan(0);
    expect(treatmentShare(bench)).toBe(0);
  });

  it("keeps reading them after one tick from a worker whose clock is twenty minutes fast", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, 2);
    await bench.autopilot.tick(ROLLOUT_ID, bench.now + TWENTY_MINUTES * MINUTE);
    bench.errorRate = { control: 0, treatment: 1 };
    await runFor(bench, TEN_MINUTES);
    expect(recordOf(bench).outcome?.reason).toBe("regression");
    expect(treatmentShare(bench)).toBe(0);
  });
});

describe("a provider that is down during a rollback", () => {
  it("turns the flag off as soon as the provider answers again", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, 2);
    bench.provider.faults.down = true;
    await sendThenRun(bench, { by: "dana", id: "undo", type: "rollback" }, A_WHILE);
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
    bench.provider.faults.down = false;
    await runFor(bench, 2);
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(NOBODY);
    expect(recordOf(bench).phase).toBe("rolled_back");
  });
});

/** The tick that steps up reads the flag; before its write goes out, someone edits the flag's description. */
async function editedMidTick(bench: Bench, gate: Gate): Promise<void> {
  const stepping = gatedWorker(bench, gate, "worker").tick(ROLLOUT_ID, bench.now);
  await gate.runUntil("worker", "flags.write");
  bench.provider.setByHand(FLAG_KEY, measuredStep(FIRST_SHARE), "an edit to the flag's description");
  await gate.finish("worker");
  await stepping;
}

/** README claim 4: only "a person lowering the flag by hand" pauses the rollout. */
describe("claim 4: a pause for a flag nobody lowered", () => {
  it("does not blame a person when the flag's revision moved but its shares did not", async () => {
    expect.hasAssertions();
    const bench = await startedBench(),
      gate = createGate();
    await runFor(bench, STEP_AND_A_BIT - 2);
    bench.now += MINUTE;
    await editedMidTick(bench, gate);
    await runFor(bench, 2);
    expect(recordOf(bench).pause).toBeNull();
    expect(treatmentShare(bench)).toBe(SECOND_SHARE);
  });
});

describe("a rollout that can't start", () => {
  it("says so when the metrics are down from the start, rather than sitting silent", async () => {
    expect.hasAssertions();
    const bench = createBench();
    bench.metricsDown = true;
    await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
    await runFor(bench, HALF_AN_HOUR);
    expect(treatmentShare(bench)).toBe(0);
    expect(bench.notifier.calls.map((event) => event.type)).toContain("metrics_outage");
  });
});

/**
 * README claim 4 says a pause for a lowered flag is a person's doing, and claim 7 that failed reads are
 * ridden out. A provider's read API that answers once from a replica that is behind is neither a person
 * nor a failure the library can see, and it happens right after writes, which is when the library reads.
 */
describe("claims 4 and 7: one stale answer from the provider", () => {
  it("does not pause the rollout and blame a person for lowering the flag", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, STEP_AND_A_BIT);
    expect(recordOf(bench)).toMatchObject({ confirmedEpoch: recordOf(bench).epoch, stepIndex: 1 });
    await oneStaleRead(bench);
    expect(bench.provider.changes(FLAG_KEY).filter((change) => change.by.startsWith("person"))).toHaveLength(0);
    expect(recordOf(bench).pause).toBeNull();
  });

  it("does not report a rolled-back flag as turned back on", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, 2);
    await send(bench, { by: "dana", id: "undo", type: "rollback" });
    await runFor(bench, 1);
    expect(recordOf(bench).phase).toBe("rolled_back");
    await oneStaleRead(bench);
    expect(bench.notifier.calls.map((event) => event.type)).not.toContain("drift_corrected");
    expect(new Set(bench.notifier.calls.filter((event) => event.type === "rolled_back").map((event) => event.key)).size).toBe(1);
  });
});
