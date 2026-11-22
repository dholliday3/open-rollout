import { EVERYBODY, NOBODY } from "./allocation.js";
import { MINUTE, START, testPlan } from "./__tests__/world.js";
import { describe, expect, it, vi } from "vitest";
import type { Command } from "./commands.js";
import type { RolloutRecord } from "./record.js";
import { applyCommand } from "./commands.js";
import { newRecord } from "./record.js";
import { proceedTo } from "./transitions.js";

vi.setConfig({ testTimeout: 5000 });

const LATER = START + MINUTE,
  WHO = { by: "dana", id: "c1" },
  PAUSE: Command = { ...WHO, type: "pause" },
  RESUME: Command = { ...WHO, id: "c2", type: "resume" },
  OUT_OF_RANGE = 9;

function ramping(): RolloutRecord {
  return proceedTo(newRecord("r1", testPlan(), START), 0, START);
}

function waitingAt(gate: 1 | "release"): RolloutRecord {
  return { ...ramping(), pendingGate: gate, phase: "awaiting_approval" };
}

function pausedFor(reason: "manual" | "regression"): RolloutRecord {
  return { ...ramping(), pause: { detail: "", reason, since: START }, phase: "paused" };
}

describe("applying a command", () => {
  it("applies a command once and calls the second sending a duplicate", () => {
    expect.hasAssertions();
    const first = applyCommand(ramping(), PAUSE, LATER);
    expect(first).toMatchObject({ record: { phase: "paused", pause: { reason: "manual" } }, status: "applied" });
    expect(applyCommand(first.record, PAUSE, LATER)).toMatchObject({ status: "duplicate" });
  });

  it("changes nothing but its memory of the command when it refuses", () => {
    expect.hasAssertions();
    const record = ramping(),
      refusal = "Only a paused rollout can be resumed.";
    expect(applyCommand(record, RESUME, LATER)).toStrictEqual({ record: { ...record, commands: [{ ask: "resume", id: "c2", refusal }] }, refusal, status: "refused" });
  });

  it("refuses a command again when it is sent later, even if it would make sense by then", () => {
    expect.hasAssertions();
    const refused = applyCommand(ramping(), RESUME, LATER).record,
      later: RolloutRecord = { ...refused, pause: { detail: "", reason: "regression", since: LATER }, phase: "paused" };
    expect(applyCommand(later, RESUME, LATER)).toMatchObject({ record: { phase: "paused" }, refusal: "Only a paused rollout can be resumed.", status: "refused" });
  });
});

describe("a command sent again", () => {
  it("does not let an id that was used for one thing swallow a rollback sent under the same id", () => {
    expect.hasAssertions();
    const paused = applyCommand(ramping(), PAUSE, LATER).record;
    expect(applyCommand(paused, { ...WHO, type: "rollback" }, LATER)).toMatchObject({ record: { phase: "rolling_back" }, status: "applied" });
    expect(applyCommand(paused, { ...WHO, gate: 1, type: "approve" }, LATER).status).toBe("applied");
  });

  it("remembers a command however many came after it", () => {
    expect.hasAssertions();
    const MANY = 200,
      paused = applyCommand(ramping(), PAUSE, LATER).record,
      busy: RolloutRecord = { ...paused, commands: [...paused.commands, ...Array.from({ length: MANY }, (_unused, index) => ({ ask: "pause", id: `other-${index}`, refusal: null }))], pause: null, phase: "ramping" };
    expect(applyCommand(busy, PAUSE, LATER).status).toBe("duplicate");
  });

  it("resumes onto a new epoch, so the step is applied and watched again", () => {
    expect.hasAssertions();
    const paused = pausedFor("manual"),
      { record } = applyCommand(paused, RESUME, LATER);
    expect(record).toMatchObject({ confirmedAt: null, epoch: paused.epoch + 1, monitoringSince: START, pause: null, phase: "ramping" });
  });

  it("starts the evidence again when resuming past a regression", () => {
    expect.hasAssertions();
    expect(applyCommand(pausedFor("regression"), RESUME, LATER).record.monitoringSince).toBe(LATER);
  });

  it("goes back to waiting for approval when that is where it was paused", () => {
    expect.hasAssertions();
    const waiting = applyCommand(newRecord("r1", testPlan(), START), PAUSE, START).record;
    expect(applyCommand(waiting, RESUME, LATER).record.phase).toBe("awaiting_approval");
  });
});

describe("approving, releasing and rolling back", () => {
  it("refuses to approve a step already passed or one that doesn't exist", () => {
    expect.hasAssertions();
    expect(applyCommand(ramping(), { ...WHO, gate: 0, type: "approve" }, LATER).status).toBe("refused");
    expect(applyCommand(ramping(), { ...WHO, gate: OUT_OF_RANGE, type: "approve" }, LATER).status).toBe("refused");
  });

  it("remembers an approval given early without moving anything yet", () => {
    expect.hasAssertions();
    const { record } = applyCommand(ramping(), { ...WHO, gate: "release", type: "approve" }, LATER);
    expect(record).toMatchObject({ approvedGates: ["release"], phase: "ramping", stepIndex: 0 });
  });

  it("releases from a pause, and rolls back from a release that hasn't landed", () => {
    expect.hasAssertions();
    const releasing = applyCommand(pausedFor("manual"), { ...WHO, type: "release" }, LATER).record;
    expect(releasing).toMatchObject({ desired: EVERYBODY, outcome: { reason: "forced" }, phase: "releasing" });
    expect(applyCommand(releasing, { ...WHO, id: "c3", type: "rollback" }, LATER).record).toMatchObject({ desired: NOBODY, phase: "rolling_back" });
  });

  it("refuses everything once the rollout is finished", () => {
    expect.hasAssertions();
    const done: RolloutRecord = { ...ramping(), phase: "rolled_back" },
      asked: Command[] = [PAUSE, RESUME, { ...WHO, type: "rollback" }, { ...WHO, type: "release" }, { ...WHO, gate: "release", type: "approve" }];
    expect(asked.map((command) => applyCommand(done, command, LATER).status)).toStrictEqual(["refused", "refused", "refused", "refused", "refused"]);
  });

  it("never lets time run backwards", () => {
    expect.hasAssertions();
    const { record } = applyCommand(ramping(), PAUSE, START - MINUTE);
    expect(record.commands).toStrictEqual([{ ask: "pause", id: "c1", refusal: null }]);
    expect(record.clock).toBe(START);
  });
});

describe("what a command leaves on the record", () => {
  it("writes who paused and why, and refuses to pause twice", () => {
    expect.hasAssertions();
    const noted = applyCommand(ramping(), { ...WHO, note: "checking a graph", type: "pause" }, LATER).record;
    expect(noted.pause?.detail).toBe("Paused by dana: checking a graph.");
    expect(applyCommand(ramping(), PAUSE, LATER).record.pause?.detail).toBe("Paused by dana.");
    expect(applyCommand(noted, { ...WHO, id: "c9", type: "pause" }, LATER).status).toBe("refused");
  });

  it("writes who rolled back and why, and refuses once a rollback is under way", () => {
    expect.hasAssertions();
    const undone = applyCommand(ramping(), { ...WHO, note: "wrong flag", type: "rollback" }, LATER).record;
    expect(undone.outcome).toStrictEqual({ at: LATER, detail: "Rolled back by dana: wrong flag.", reason: "manual" });
    expect(applyCommand(ramping(), { ...WHO, type: "rollback" }, LATER).record.outcome?.detail).toBe("Rolled back by dana.");
    expect(applyCommand(undone, { ...WHO, id: "c9", type: "rollback" }, LATER).status).toBe("refused");
  });

  it("tells people about a resume and an approval", () => {
    expect.hasAssertions();
    const resumed = applyCommand(pausedFor("manual"), RESUME, LATER).record,
      approved = applyCommand(ramping(), { ...WHO, gate: 1, type: "approve" }, LATER).record;
    expect(resumed.outbox.at(-1)).toMatchObject({ at: LATER, detail: "Resumed by dana.", type: "resumed" });
    expect(approved.outbox.at(-1)).toMatchObject({ at: LATER, detail: "dana approved the step to 50%.", type: "approved" });
  });
});

describe("approving a gate", () => {
  it("accepts the last step and refuses the one past it", () => {
    expect.hasAssertions();
    expect(applyCommand(ramping(), { ...WHO, gate: 1, type: "approve" }, LATER).status).toBe("applied");
    expect(applyCommand(ramping(), { ...WHO, gate: 2, type: "approve" }, LATER).status).toBe("refused");
  });

  it("records the yes and moves nothing: the next tick opens the gate if the metrics still allow it", () => {
    expect.hasAssertions();
    const { record } = applyCommand(waitingAt(1), { ...WHO, gate: 1, type: "approve" }, LATER);
    expect(record).toMatchObject({ approvedGates: [1], pendingGate: 1, phase: "awaiting_approval", stepIndex: 0 });
  });

  it("says nothing new for a gate already approved", () => {
    expect.hasAssertions();
    const approved = { ...ramping(), approvedGates: [1] as const },
      again = applyCommand(approved, { ...WHO, gate: 1, type: "approve" }, LATER);
    expect(again.status).toBe("applied");
    expect(again.record.outbox).toHaveLength(approved.outbox.length);
  });
});
