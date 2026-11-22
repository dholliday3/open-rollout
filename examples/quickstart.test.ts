import { NOBODY, createAutopilot, createMemoryFlags, createMemoryNotifier, createMemoryStore, standardPlan } from "open-rollout";
import { describe, expect, it, vi } from "vitest";
// eslint-disable-next-line import/no-nodejs-modules -- the README is read from disk so its samples can't drift from these files
import { readFile, readdir } from "node:fs/promises";
import { simulatedTraffic } from "./simulated-traffic";

vi.setConfig({ testTimeout: 10_000 });

const FLAG_KEY = "new-checkout",
  ROLLOUT_ID = "checkout-1",
  BASE_ERROR_RATE = 0.02,
  BROKEN_ERROR_RATE = 0.1,
  AN_HOUR = 60,
  MINUTE = 60_000,
  HERE = new URL(".", import.meta.url),
  README = await readFile(new URL("../README.md", HERE), "utf8"),
  README_SAMPLES = [...README.matchAll(/```ts\n(?<code>[\s\S]*?)```/g)].map((match) => match.groups?.code ?? ""),
  EXAMPLE_NAMES = (await readdir(HERE)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
  EXAMPLES = await Promise.all(
    EXAMPLE_NAMES.map(async (name) => {
      const source = await readFile(new URL(name, HERE), "utf8");
      return source;
    }),
  );

/** The quickstart's rollout with another error rate on the new arm, for the README's claim about a broken change. */
async function rollOut(treatmentErrorRate: number) {
  const flags = createMemoryFlags(),
    notifier = createMemoryNotifier(),
    store = createMemoryStore(),
    traffic = simulatedTraffic({ errorRate: { control: BASE_ERROR_RATE, treatment: treatmentErrorRate }, flagKey: FLAG_KEY, flags, metric: "errors" }),
    autopilot = createAutopilot({ flags, metrics: traffic, notifier, store }),
    plan = standardPlan({ flagKey: FLAG_KEY, guardrails: [{ direction: "lower_is_better", kind: "rate", metric: "errors", onRegression: "rollback", tolerance: 0 }], risk: "low" }),
    startedAt = traffic.now();
  await autopilot.start({ id: ROLLOUT_ID, now: startedAt, plan });
  for (let minute = 0; minute < AN_HOUR; minute += 1) {
    traffic.passMinute();
    await autopilot.tickAll(traffic.now());
  }
  const rolledBack = notifier.events.find((event) => event.type === "rolled_back");
  return { flags, minutesToRollBack: rolledBack === undefined ? null : (rolledBack.at - startedAt) / MINUTE, notifier, stored: await store.load(ROLLOUT_ID) };
}

describe("the README's quickstart", () => {
  it("releases a change that is no worse, one step at a time, and prints what the README shows", async () => {
    expect.hasAssertions();
    const log = vi.spyOn(console, "log");
    await import("./quickstart");
    expect(log.mock.calls.map(([line]: unknown[]) => line)).toStrictEqual([
      "started: Rollout of new-checkout started.",
      "step_started: 10% of traffic is on the new behaviour.",
      "step_started: 50% of traffic is on the new behaviour.",
      "releasing: Every step passed. Releasing to everybody.",
      "released: Released: the flag is on for everybody.",
    ]);
    expect(README).toContain(`\`\`\`text\n${log.mock.calls.map(([line]: unknown[]) => String(line)).join("\n")}\n\`\`\``);
  });

  it("rolls the same rollout back within three minutes when the new behaviour errors five times as often", async () => {
    expect.hasAssertions();
    const { flags, minutesToRollBack, notifier, stored } = await rollOut(BROKEN_ERROR_RATE);
    expect(notifier.events.map((event) => event.type)).toStrictEqual(["started", "step_started", "rolling_back", "rolled_back"]);
    expect(minutesToRollBack).toBeLessThanOrEqual(3);
    expect(stored?.record.outcome?.reason).toBe("regression");
    expect(stored?.record.settled).toBe(true);
    expect(flags.peek(FLAG_KEY).allocation).toStrictEqual(NOBODY);
  });
});

describe("the README's code samples", () => {
  it("open with the whole quickstart", () => {
    expect.hasAssertions();
    expect(README_SAMPLES[0]).toBe(EXAMPLES[EXAMPLE_NAMES.indexOf("quickstart.ts")]);
  });

  it("are each a slice of a file in examples/, so the type-check covers them", () => {
    expect.hasAssertions();
    expect(README_SAMPLES.length).toBeGreaterThan(1);
    expect(README_SAMPLES.filter((sample) => !EXAMPLES.some((source) => source.includes(sample)))).toStrictEqual([]);
  });
});
