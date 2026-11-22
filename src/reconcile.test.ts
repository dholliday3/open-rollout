import { EVERYBODY, NOBODY, measuredStep } from "./allocation.js";
import { FIRST_SHARE, MINUTE, SECOND_SHARE, START } from "./__tests__/world.js";
import type { RolloutRecord, WriteAttempt } from "./record.js";
import { describe, expect, it, vi } from "vitest";
import { flagAt, watchingStep } from "./__tests__/records.js";
import { isLateWrite, reconcile, retreat } from "./reconcile.js";
import { DEFAULT_LIMITS } from "./plan.js";

vi.setConfig({ testTimeout: 5000 });

const LATER = START + MINUTE,
  LOWER = 100,
  MORE = 3000,
  SENT_AT = 5,
  MOVED_ON = 6,
  SETTLED = START + DEFAULT_LIMITS.settleMs,
  PROPAGATED = START + DEFAULT_LIMITS.propagationMs;

function seen(flag: ReturnType<typeof flagAt> | null, staleWritesRefused = true): { flag: ReturnType<typeof flagAt> | null; staleWritesRefused: boolean } {
  return { flag, staleWritesRefused };
}

/** A write for the second wish, sent while the flag served the first step at `base`. */
function sent(base: number | null, epoch = 2): WriteAttempt {
  return { at: START, base, epoch, over: measuredStep(FIRST_SHARE) };
}

/** The flag serving equal shares of `share`, as one read saw it. */
function at(share: number, revision = 1, staleWritesRefused = true): ReturnType<typeof seen> {
  return seen(flagAt(share, revision), staleWritesRefused);
}

/** A rollout whose rollback or release has been written and not yet seen to hold. */
function ending(phase: "rolling_back" | "releasing"): RolloutRecord {
  return { ...watchingStep(), attempt: sent(SENT_AT), confirmedAt: null, desired: phase === "releasing" ? EVERYBODY : NOBODY, epoch: 2, phase, stepIndex: 1 };
}

function done(phase: "rolled_back" | "released"): RolloutRecord {
  return { ...ending(phase === "released" ? "releasing" : "rolling_back"), confirmedAt: START, confirmedEpoch: 2, phase };
}

describe("squaring the record with the flag", () => {
  it("leaves the record alone when the flag couldn't be read", () => {
    expect.hasAssertions();
    const record = watchingStep();
    expect(reconcile(record, seen(null), LATER)).toBe(record);
  });

  it("finishes a rollback or a release only when the flag is seen to serve it", () => {
    expect.hasAssertions();
    expect(reconcile(ending("rolling_back"), seen({ allocation: NOBODY, revision: MOVED_ON }), LATER)).toMatchObject({ confirmedAt: LATER, confirmedEpoch: 2, phase: "rolled_back" });
    expect(reconcile({ ...ending("rolling_back"), correctingDrift: true }, seen({ allocation: NOBODY, revision: MOVED_ON }), LATER).correctingDrift).toBe(false);
    expect(reconcile(ending("releasing"), seen({ allocation: EVERYBODY, revision: MOVED_ON }), LATER).phase).toBe("released");
    expect(reconcile(ending("rolling_back"), at(FIRST_SHARE, MOVED_ON), LATER).phase).toBe("rolling_back");
  });

  it("says someone is first exposed only when the step it confirms serves somebody", () => {
    expect.hasAssertions();
    const waiting: RolloutRecord = { ...watchingStep(), confirmedEpoch: 0, desired: NOBODY, exposedSince: null, phase: "awaiting_approval" },
      stepping: RolloutRecord = { ...watchingStep(), confirmedEpoch: 0, exposedSince: null };
    expect(reconcile(waiting, seen({ allocation: NOBODY, revision: 1 }), LATER)).toMatchObject({ confirmedEpoch: 1, exposedSince: null, outbox: [] });
    expect(reconcile(stepping, at(FIRST_SHARE), LATER)).toMatchObject({ exposedSince: LATER, outbox: [{ type: "step_started" }] });
  });
});

describe("a flag someone else changed", () => {
  it("pauses when the new behaviour reaches fewer people, and is put back when it reaches more or the control arm moved", () => {
    expect.hasAssertions();
    const lopsided = { allocation: { control: 0, treatment: FIRST_SHARE }, revision: MOVED_ON };
    expect(reconcile(watchingStep(), at(LOWER, MOVED_ON), LATER).pause?.reason).toBe("external_change");
    expect(reconcile(watchingStep(), at(MORE, MOVED_ON), LATER)).toMatchObject({ correctingDrift: true, pause: null });
    expect(reconcile(watchingStep(), seen(lopsided), LATER)).toMatchObject({ correctingDrift: true, pause: null });
  });

  it("is reported once, however many ticks it takes to put back", () => {
    expect.hasAssertions();
    const noticed = reconcile(watchingStep(), at(MORE, MOVED_ON), LATER);
    expect(reconcile(noticed, at(MORE, MOVED_ON), LATER + MINUTE)).toBe(noticed);
  });

  it("is not blamed for a write of ours that hasn't landed, or one that went out blind", () => {
    expect.hasAssertions();
    const owed: RolloutRecord = { ...watchingStep(), attempt: sent(SENT_AT), desired: measuredStep(SECOND_SHARE), epoch: 2 },
      blind: RolloutRecord = { ...owed, attempt: sent(null) };
    expect(reconcile(owed, at(FIRST_SHARE, SENT_AT), LATER)).toBe(owed);
    expect(reconcile(blind, at(FIRST_SHARE, MOVED_ON), LATER)).toBe(blind);
    expect(reconcile({ ...owed, attempt: null }, at(FIRST_SHARE, MOVED_ON), LATER).pause).toBeNull();
    expect(reconcile(owed, at(LOWER, MOVED_ON), LATER).pause?.reason).toBe("external_change");
  });

  it("is not blamed for one edit that left the shares as they were when the write was sent", () => {
    expect.hasAssertions();
    const owed: RolloutRecord = { ...watchingStep(), attempt: sent(SENT_AT), desired: measuredStep(SECOND_SHARE), epoch: 2 };
    expect(reconcile(owed, at(FIRST_SHARE, MOVED_ON), LATER)).toBe(owed);
  });

  it("is blamed when the old shares are back two revisions on: the write may have landed and been undone", () => {
    expect.hasAssertions();
    const owed: RolloutRecord = { ...watchingStep(), attempt: sent(SENT_AT), desired: measuredStep(SECOND_SHARE), epoch: 2 },
      unknown: RolloutRecord = { ...owed, attempt: { ...sent(SENT_AT), over: null } };
    expect(reconcile(owed, at(FIRST_SHARE, MOVED_ON + 1), LATER).pause?.reason).toBe("external_change");
    expect(reconcile(unknown, at(FIRST_SHARE, MOVED_ON), LATER).pause?.reason).toBe("external_change");
  });
});

describe("a finished rollout, watched until it settles", () => {
  it("settles once the flag has held for the settle time, to the millisecond", () => {
    expect.hasAssertions();
    expect(reconcile(done("rolled_back"), seen({ allocation: NOBODY, revision: MOVED_ON }), SETTLED - 1).settled).toBe(false);
    expect(reconcile(done("rolled_back"), seen({ allocation: NOBODY, revision: MOVED_ON }), SETTLED).settled).toBe(true);
  });

  it("turns a flag off again that came back on after a rollback, whoever turned it on", () => {
    expect.hasAssertions();
    expect(reconcile(done("rolled_back"), at(LOWER, MOVED_ON), LATER)).toMatchObject({ confirmedAt: null, outbox: [{ type: "drift_corrected" }], phase: "rolling_back" });
  });

  it("leaves a released flag a person changed, says so once, and watches afresh when it is put back", () => {
    expect.hasAssertions();
    const changed = reconcile(done("released"), at(FIRST_SHARE, MOVED_ON), LATER);
    expect(changed).toMatchObject({ correctingDrift: true, outbox: [{ type: "external_change" }], phase: "released" });
    expect(reconcile(changed, at(FIRST_SHARE, MOVED_ON), LATER + MINUTE)).toBe(changed);
    expect(reconcile(changed, seen({ allocation: EVERYBODY, revision: MOVED_ON + 1 }), LATER + MINUTE)).toMatchObject({ confirmedAt: LATER + MINUTE, correctingDrift: false });
  });
});

describe("a late write from a stalled worker", () => {
  it("is equal shares of one of the rollout's own steps, on a provider that can't refuse it", () => {
    expect.hasAssertions();
    expect(isLateWrite(done("released"), at(FIRST_SHARE, 1, false))).toBe(true);
    expect(isLateWrite(done("released"), at(FIRST_SHARE, 1, true))).toBe(false);
    expect(isLateWrite(done("released"), at(LOWER, 1, false))).toBe(false);
    expect(isLateWrite(done("released"), seen(null, false))).toBe(false);
  });

  it("is reported as one, not as a person's change, where it can land", () => {
    expect.hasAssertions();
    expect(reconcile(done("released"), at(FIRST_SHARE, MOVED_ON, false), LATER).outbox.at(-1)?.type).toBe("drift_corrected");
  });
});

describe("a release whose write never went through", () => {
  const unlanded = { allocation: measuredStep(SECOND_SHARE), revision: SENT_AT };

  it("goes back to its gate once the write has had time to show and the flag is still as it was", () => {
    expect.hasAssertions();
    expect(retreat(ending("releasing"), unlanded, PROPAGATED)).toMatchObject({ confirmedEpoch: 3, desired: measuredStep(SECOND_SHARE), epoch: 3, outcome: null, pendingGate: "release", phase: "awaiting_approval" });
    expect(retreat(ending("releasing"), unlanded, PROPAGATED - 1).phase).toBe("releasing");
  });

  it("stays a release when a person forced it, the flag has moved on, or there is nothing to go by", () => {
    expect.hasAssertions();
    const forced: RolloutRecord = { ...ending("releasing"), outcome: { at: START, detail: "", reason: "forced" } },
      stays = [retreat(forced, unlanded, PROPAGATED), retreat(ending("releasing"), { ...unlanded, revision: MOVED_ON }, PROPAGATED), retreat(ending("releasing"), flagAt(FIRST_SHARE, SENT_AT), PROPAGATED), retreat(ending("releasing"), null, PROPAGATED), retreat({ ...ending("releasing"), attempt: null }, unlanded, PROPAGATED), retreat({ ...ending("releasing"), attempt: sent(SENT_AT, 1) }, unlanded, PROPAGATED)];
    expect(stays.map((record) => record.phase)).toStrictEqual(stays.map(() => "releasing"));
    expect(retreat(watchingStep(), unlanded, PROPAGATED).phase).toBe("ramping");
  });
});
