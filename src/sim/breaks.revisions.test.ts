import { FIRST_SHARE, FLAG_KEY, ROLLOUT_ID, SECOND_SHARE, createBench, gatedWorker, recordOf, runFor, send, startedBench, treatmentShare } from "./bench.js";
import { NOBODY, measuredStep } from "../allocation.js";
import { describe, expect, it, vi } from "vitest";
import type { Bench } from "./bench.js";
import type { Gate } from "./gate.js";
import { createGate } from "./gate.js";

vi.setConfig({ testTimeout: 10_000 });

/**
 * The ownership rules after round three: a flag's revision is a number that only goes up, the record keeps
 * the highest it has seen (`seenRevision`), and a reading below that is "a read that is behind" and is
 * ignored, for as long as it stays below.
 *
 * Round two's test here used a provider whose revision was a tag of the flag's content. The README now puts
 * that provider outside the contract ("Revisions must be ordered numbers"), so that test is retired. These
 * show what the tighter contract costs instead: the rule has no way back. If the number ever comes down
 * (the flag is deleted and made again, which restarts PostHog's `version`), or a write once answers with a
 * number that is too high, every later reading is "behind" for good. Nothing is reported, the rollout can
 * no longer see its own flag, and a rollback can never be seen to hold, so it never settles and the flag
 * can't be given another rollout.
 */

const STEP_MINUTES = 10,
  HALF_AN_HOUR = 30,
  A_WHILE = 5,
  TOO_HIGH_BY = 5,
  MANY_EDITS = 300;

/** The worker's write goes through, and the provider's answer never arrives: the call fails after the flag has changed. */
async function landsThenTimesOut(bench: Bench, gate: Gate): Promise<void> {
  const write = gate.parked().find((call) => call.port === "flags.write");
  bench.provider.faults.lostReplyChance = 1;
  if (write !== undefined) {
    await gate.pass(write);
  }
  bench.provider.faults.lostReplyChance = 0;
}

/** The flag has a history, as a flag in use does: its revision is in the hundreds by the time the rollout reads it. */
async function withAHistory(bench: Bench): Promise<void> {
  for (let edit = 0; edit < MANY_EDITS; edit += 1) {
    bench.provider.setByHand(FLAG_KEY, measuredStep(FIRST_SHARE), "person: edits the description");
  }
  await runFor(bench, 1);
}

describe("claim 7: a flag whose revision comes back down", () => {
  it("is noticed when the flag is deleted and made again, switched off", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, 2);
    await withAHistory(bench);
    bench.provider.recreate(FLAG_KEY, NOBODY);
    await runFor(bench, HALF_AN_HOUR);
    // The flag serves nobody and has for half an hour. The record still says its first step is in force.
    expect(recordOf(bench).pause?.reason).toBe("external_change");
  });

  it("still lets a rollback finish and settle", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, 2);
    await withAHistory(bench);
    bench.provider.recreate(FLAG_KEY, measuredStep(FIRST_SHARE));
    await send(bench, { by: "dana", id: "undo", type: "rollback" });
    await runFor(bench, HALF_AN_HOUR);
    expect(treatmentShare(bench)).toBe(0);
    expect(recordOf(bench)).toMatchObject({ phase: "rolled_back", settled: true });
  });
});

describe("claim 7: a write that answers with a revision that is too high", () => {
  it("does not stop the rollout ever seeing its own first step", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
    await runFor(bench, 1);
    // From here every write's answer overstates the revision, as an adapter that adds up versions wrongly would.
    bench.provider.faults.revisionOverstatedBy = TOO_HIGH_BY;
    await runFor(bench, STEP_MINUTES + A_WHILE);
    bench.provider.faults.revisionOverstatedBy = 0;
    await runFor(bench, HALF_AN_HOUR);
    expect(recordOf(bench).phase).not.toBe("ramping");
  });
});

/** README claim 4: only a person who lowers the flag pauses the rollout. */
describe("claim 4: a write that failed, then an edit that changed no shares", () => {
  it("does not blame a person for lowering the flag", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, STEP_MINUTES + 1);
    // The step-up is decided and saved, and its write fails. Before the retry, someone edits the flag's description.
    bench.provider.faults.writesDown = true;
    await runFor(bench, 1);
    bench.provider.setByHand(FLAG_KEY, measuredStep(FIRST_SHARE), "person: edits the description");
    bench.provider.faults.writesDown = false;
    await runFor(bench, 2);
    expect(recordOf(bench).pause).toBeNull();
    expect(treatmentShare(bench)).toBe(SECOND_SHARE);
  });
});

/**
 * README claim 4 again, against the retry inside one tick (`write.ts`): a write that fails is sent once more
 * when the flag's revision has moved and its shares are what they were when the write was decided. A write
 * that lands and then times out, followed by a person turning the flag back off, looks exactly like that.
 */
describe("claim 4: a kill switch pulled while a write that landed was still waiting for its answer", () => {
  it("is not written over by the retry", async () => {
    expect.hasAssertions();
    const bench = createBench(),
      gate = createGate(),
      starting = gatedWorker(bench, gate, "worker").start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
    await gate.runUntil("worker", "flags.write");
    await landsThenTimesOut(bench, gate);
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
    bench.provider.setByHand(FLAG_KEY, NOBODY, "person: kills the flag");
    await gate.finish("worker");
    await starting;
    expect(bench.provider.serving(FLAG_KEY)).toMatchObject({ allocation: NOBODY, by: "person: kills the flag" });
  });
});
