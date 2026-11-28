import type { Chaos, ChaosOptions } from "./chaos.js";
import { FLAG_KEY, ROLLOUT_ID, benchPlan, recordOf } from "./bench.js";
import { chaosSeeds, isReplay } from "./runs.js";
import { cleanTicks, runChaos } from "./chaos.js";
import { describe, expect, it, vi } from "vitest";
import { lostEvents, notConverged, safetyViolations } from "./chaos.invariants.js";

vi.setConfig({ testTimeout: 600_000 });

/**
 * Seeded runs of the chaotic runtime in `chaos.ts`, each checked by the oracle in `chaos.invariants.ts`.
 * A failure prints the seed and the sentence that names the README claim. Replay one with
 * `SIM_CHAOS_SEED=<seed> pnpm exec vitest run src/sim/chaos`, which also prints the story.
 *
 * The quick suite runs seeds 1 to 150. `SIM_CHAOS_RUNS=2000` has found what the quick suite did not: steps
 * that moved on seconds before they had really been served for their watch (`breaks.watch.test.ts` is that
 * finding made plain), and, on a provider that checks no revisions, a worker stalled 18 minutes inside a
 * write that landed 3 seconds after its rollback settled. The second is the README's known limit for such
 * providers, so `notConverged` does not count it.
 */

const USUAL_RUNS = 150,
  SEEDS = chaosSeeds(USUAL_RUNS),
  ROUNDS = 60,
  CLEAN_TICKS = 6,
  LONG_ENOUGH = 90,
  TRIES = 3,
  TWO_MINUTES = 120_000,
  MS_PER_SECOND = 1000,
  BASE: Omit<ChaosOptions, "seed"> = { checksRevision: true, people: true, rounds: ROUNDS, skewMs: 0 },
  [FIRST, SECOND] = benchPlan().steps,
  GATED = { requiresApprovalToRelease: true, steps: [FIRST, { ...SECOND, requiresApproval: true }] };

interface Verdict {
  readonly seed: number;
  readonly problems: readonly string[];
}

/** The record's versions and the flag's changes on one clock, for reading a replay. */
function timeline(chaos: Chaos): string[] {
  const start = chaos.bench.served[0].at,
    versions = chaos.bench.store.versions(ROLLOUT_ID).map((saved) => ({ at: saved.at, line: `v${saved.version} ${saved.record.phase} step ${saved.record.stepIndex} wants ${saved.record.desired.treatment} epoch ${saved.record.epoch}/${saved.record.confirmedEpoch} pause ${saved.record.pause?.reason ?? "-"}` })),
    changes = chaos.bench.provider.changes(FLAG_KEY).map((change) => ({ at: change.at, line: `FLAG ${change.allocation.treatment}/${change.allocation.control} r${change.revision} by ${change.by}` })),
    lines = [...versions, ...changes].filter((entry) => Number.isFinite(entry.at));
  lines.sort((left, right) => left.at - right.at);
  return lines.map((entry) => `  ${Math.round((entry.at - start) / MS_PER_SECOND)}s ${entry.line}`);
}

async function verdictOf(options: ChaosOptions, extra: (chaos: Chaos) => Promise<string[]>): Promise<Verdict> {
  const chaos = await runChaos(options),
    safety = safetyViolations(chaos),
    more = await extra(chaos),
    problems = [...safety, ...more];
  if (isReplay()) {
    // eslint-disable-next-line no-console -- replaying one seed is for reading its story
    console.log([...chaos.story, ...timeline(chaos), ...problems].join("\n"));
  }
  return { problems, seed: options.seed };
}

async function all(options: Omit<ChaosOptions, "seed">, extra: (chaos: Chaos) => Promise<string[]>): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const seed of SEEDS) {
    // eslint-disable-next-line no-await-in-loop -- one run at a time, so a failure's output is its own
    verdicts.push(await verdictOf({ ...options, seed }, extra));
  }
  return verdicts.filter((verdict) => verdict.problems.length > 0);
}

async function safetyOnly(): Promise<string[]> {
  await Promise.resolve();
  return [];
}

/** Claim 7: a few clean ticks after everything calms down bring the flag to what the record wants. */
async function converges(chaos: Chaos): Promise<string[]> {
  await cleanTicks(chaos, CLEAN_TICKS);
  return [...notConverged(chaos), ...lostEvents(chaos)];
}

/** Says yes to everything a person could be asked, then waits: a healthy rollout must end. */
async function nudge(chaos: Chaos, triesLeft: number): Promise<void> {
  const { bench } = chaos;
  if (recordOf(bench).settled || triesLeft <= 0) {
    return;
  }
  await bench.autopilot.command(ROLLOUT_ID, { by: "closer", id: `resume-${triesLeft}`, type: "resume" }, bench.now);
  await bench.autopilot.command(ROLLOUT_ID, { by: "closer", gate: 1, id: `step-${triesLeft}`, type: "approve" }, bench.now);
  await bench.autopilot.command(ROLLOUT_ID, { by: "closer", gate: "release", id: `release-${triesLeft}`, type: "approve" }, bench.now);
  await cleanTicks(chaos, LONG_ENOUGH);
  await nudge(chaos, triesLeft - 1);
}

async function ends(chaos: Chaos): Promise<string[]> {
  await nudge(chaos, TRIES);
  const record = recordOf(chaos.bench);
  return record.settled ? [] : [`claim 7: still ${record.phase} (step ${record.stepIndex}, pause ${record.pause?.reason ?? "none"}, gate ${String(record.pendingGate)}) after ${TRIES * LONG_ENOUGH} clean minutes with every question answered yes`];
}

describe("a chaotic runtime, checked against the truth", () => {
  it("breaks no safety claim on a provider that checks revisions", async () => {
    expect.hasAssertions();
    await expect(all(BASE, safetyOnly)).resolves.toStrictEqual([]);
  });

  it("breaks no safety claim on a provider that does not check revisions", async () => {
    expect.hasAssertions();
    await expect(all({ ...BASE, checksRevision: false }, safetyOnly)).resolves.toStrictEqual([]);
  });

  it("breaks no safety claim when workers' clocks are up to two minutes out", async () => {
    expect.hasAssertions();
    await expect(all({ ...BASE, skewMs: TWO_MINUTES }, safetyOnly)).resolves.toStrictEqual([]);
  });

  it("breaks no safety claim when a person must approve every gate", async () => {
    expect.hasAssertions();
    await expect(all({ ...BASE, plan: GATED }, safetyOnly)).resolves.toStrictEqual([]);
  });

  it("breaks no safety claim, and raises nothing during an incident, while incidents come and go", async () => {
    expect.hasAssertions();
    await expect(all({ ...BASE, incidents: true }, safetyOnly)).resolves.toStrictEqual([]);
  });
});

describe("a chaotic runtime, once it calms down", () => {
  it("brings the flag to what the record wants within a few clean ticks, and loses no event", async () => {
    expect.hasAssertions();
    await expect(all(BASE, converges)).resolves.toStrictEqual([]);
  });

  it("does the same on a provider that does not check revisions", async () => {
    expect.hasAssertions();
    await expect(all({ ...BASE, checksRevision: false }, converges)).resolves.toStrictEqual([]);
  });

  it("always ends, with no machine left to break it and a person saying yes", async () => {
    expect.hasAssertions();
    await expect(all({ ...BASE, people: false }, ends)).resolves.toStrictEqual([]);
  });

  it("always ends once incidents stop coming and a person says yes", async () => {
    expect.hasAssertions();
    await expect(all({ ...BASE, incidents: true, people: false }, ends)).resolves.toStrictEqual([]);
  });

  it("always ends after people were at the console too, once they stop and say yes", async () => {
    expect.hasAssertions();
    await expect(all({ ...BASE, checksRevision: false, skewMs: TWO_MINUTES }, ends)).resolves.toStrictEqual([]);
  });
});
