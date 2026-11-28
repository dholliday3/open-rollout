import { EVERYBODY, NOBODY, measuredStep } from "../allocation.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryMetrics, createMemoryNotifier, createMemoryStore } from "./memory.js";
import type { MetricSnapshot } from "../ports.js";
import type { PostHogTransport } from "./posthog-transport.js";
import { createAutopilot } from "../controller.js";
import { createPostHogFlags } from "./posthog-flags.js";
import { createPostHogMetrics } from "./posthog-metrics.js";
import { standardPlan } from "../standard-plan.js";
import { z } from "zod";

/**
 * Runs against a real PostHog project, on flags it makes for itself and deletes afterwards. Nothing
 * evaluates those flags, so nobody is served anything. Off unless `OPEN_ROLLOUT_POSTHOG_LIVE=1`, with
 * `POSTHOG_HOST`, `POSTHOG_PROJECT_ID` and `POSTHOG_PERSONAL_API_KEY` (feature flag write and query read
 * scopes). `pnpm live:posthog` runs it.
 */

vi.setConfig({ testTimeout: 120_000 });

// eslint-disable-next-line node/no-process-env -- the live suite's switch and credentials live here and nowhere else
const { OPEN_ROLLOUT_POSTHOG_LIVE, POSTHOG_HOST, POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID } = process.env,
  live = OPEN_ROLLOUT_POSTHOG_LIVE === "1",
  host = POSTHOG_HOST ?? "https://us.posthog.com",
  projectId = POSTHOG_PROJECT_ID ?? "",
  run = Date.now(),
  MINUTE = 60_000,
  CREATED = 201,
  EVEN = 50,
  ONE_PERCENT = 100,
  HALF = 5000,
  TICKS = 12,
  TICK_MS = 600_000,
  HEALTHY_UNITS = 2000,
  ERROR_SHARE = 0.02,
  madeSchema = z.object({ id: z.number() }),
  ERRORS = { direction: "lower_is_better", kind: "rate", metric: "errors", onRegression: "rollback", tolerance: 0 } as const;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, host), {
    body: body === undefined ? null : JSON.stringify(body),
    headers: { authorization: `Bearer ${POSTHOG_PERSONAL_API_KEY ?? ""}`, "content-type": "application/json" },
    method,
    signal: AbortSignal.timeout(MINUTE / 2),
  });
  return { body: response.ok ? await response.json() : await response.text(), status: response.status };
}

const transport: PostHogTransport = async (request) => {
    const reply = await call(request.method, request.path, request.body);
    return reply;
  },
  flags = createPostHogFlags({ projectId, transport });

/**
 * A flag set up the way a rollout needs (two even variants, one release condition with no filters, serving
 * nobody), made before the tests in this block and deleted after them.
 */
function liveFlag(name: string): string {
  const key = `open-rollout-live-${name}-${run}`;
  let id: number | null = null;
  beforeAll(async () => {
    const variants = [{ key: "control", rollout_percentage: EVEN }, { key: "treatment", rollout_percentage: EVEN }],
      reply = await call("POST", `/api/projects/${projectId}/feature_flags/`, { active: true, filters: { groups: [{ properties: [], rollout_percentage: 0 }], multivariate: { variants } }, key, name: "open-rollout live test. Safe to delete." });
    if (reply.status !== CREATED) {
      throw new Error(`Making the test flag answered ${reply.status}: ${JSON.stringify(reply.body)}`);
    }
    ({ id } = madeSchema.parse(reply.body));
  });

  afterAll(async () => {
    if (id !== null) {
      await call("PATCH", `/api/projects/${projectId}/feature_flags/${id}/`, { deleted: true });
    }
  });
  return key;
}

function healthy(asOf: number): MetricSnapshot {
  const arm = { sum: HEALTHY_UNITS * ERROR_SHARE, units: HEALTHY_UNITS };
  return { asOf, contaminated: 0, exposed: { control: HEALTHY_UNITS, treatment: HEALTHY_UNITS }, metrics: { errors: { control: arm, treatment: arm } }, watermark: asOf };
}

describe.skipIf(!live)("the PostHog flag adapter on a real flag", () => {
  const key = liveFlag("adapter");

  it("reads a new flag as serving nobody, writes a step, and reads back the revision the write returned", async () => {
    expect.hasAssertions();
    const before = await flags.read(key);
    expect(before.allocation).toStrictEqual(NOBODY);
    const revision = await flags.write(key, measuredStep(ONE_PERCENT), before.revision);
    expect(revision).toBeGreaterThan(before.revision);
    await expect(flags.read(key)).resolves.toStrictEqual({ allocation: measuredStep(ONE_PERCENT), revision });
  });

  it("is refused a write from a stale revision, and writes nothing to a flag already at the step", async () => {
    expect.hasAssertions();
    const before = await flags.read(key);
    await expect(flags.write(key, measuredStep(HALF), before.revision - 1)).rejects.toThrow(/changed since it was read/u);
    await expect(flags.read(key)).resolves.toStrictEqual(before);
    await expect(flags.write(key, before.allocation, before.revision)).resolves.toBe(before.revision);
  });

  it("releases to everybody, turns everybody off, and then says the flag needs setting up again", async () => {
    expect.hasAssertions();
    const before = await flags.read(key),
      released = await flags.write(key, EVERYBODY, before.revision);
    await expect(flags.read(key)).resolves.toStrictEqual({ allocation: EVERYBODY, revision: released });
    const off = await flags.write(key, NOBODY, released);
    await expect(flags.read(key)).resolves.toStrictEqual({ allocation: NOBODY, revision: off });
    await expect(flags.setupProblem?.(key)).resolves.toMatch(/released to everybody before/u);
  });
});

describe.skipIf(!live)("a rollout on a real PostHog flag", () => {
  const key = liveFlag("rollout");

  it("goes through every step of a low risk plan to the release, guardrails read from memory", async () => {
    expect.hasAssertions();
    const metrics = createMemoryMetrics(),
      notifier = createMemoryNotifier(),
      autopilot = createAutopilot({ flags, metrics, notifier, store: createMemoryStore() }),
      plan = standardPlan({ flagKey: key, guardrails: [ERRORS], overrides: { everyStep: { minFreshUnits: 0 } }, risk: "low" }),
      start = Date.now();
    metrics.set(healthy(start));
    await expect(autopilot.start({ id: key, now: start, plan })).resolves.toMatchObject({ status: "started" });
    for (let tick = 1; tick <= TICKS; tick += 1) {
      metrics.set(healthy(start + tick * TICK_MS));
      // eslint-disable-next-line no-await-in-loop -- one tick after another, as a scheduler would send them
      await autopilot.tick(key, start + tick * TICK_MS);
    }
    await expect(autopilot.inspect(key)).resolves.toMatchObject({ record: { phase: "released" } });
    await expect(flags.read(key)).resolves.toMatchObject({ allocation: EVERYBODY });
    expect(notifier.events.map((event) => event.type)).toStrictEqual(["started", "step_started", "step_started", "releasing", "released"]);
  });
});

describe.skipIf(!live)("the PostHog metric source on a real project", () => {
  const key = liveFlag("metrics");

  it("runs its queries and counts nobody on a flag nobody evaluates", async () => {
    expect.hasAssertions();
    const source = createPostHogMetrics({ ingestionLagMs: 2 * MINUTE, metrics: { pageviews: { event: "$pageview" } }, now: () => Date.now(), projectId, transport }),
      snapshot = await source.snapshot({ flagKey: key, guardrails: [{ ...ERRORS, direction: "higher_is_better", metric: "pageviews" }], since: Date.now() - MINUTE });
    expect(snapshot.exposed).toStrictEqual({ control: 0, treatment: 0 });
    expect(snapshot.watermark).toBeLessThanOrEqual(snapshot.asOf);
  });
});
