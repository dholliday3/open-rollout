import type { ArmPair, MetricQuery, MetricSnapshot, MetricSource } from "../ports.js";
import type { ArmSample } from "../stats.js";
import type { Guardrail } from "../plan.js";
import type { PostHogTransport } from "./posthog-transport.js";
import { bodyOf } from "./posthog-transport.js";
import { z } from "zod";

/** Which PostHog events make up one guardrail's metric. */
interface MetricDefinition {
  /** The event counted for a rate or a ratio's top, or counted or summed for a mean. */
  readonly event: string;
  /** For a mean: the numeric event property summed per unit. Without it the events are counted. */
  readonly property?: string;
  /** For a ratio: the event under the line, such as every request. */
  readonly denominatorEvent?: string;
  /**
   * True for an event that may really not have happened in a month (a rare error). Otherwise an event the
   * project has not seen in a month is taken for a misspelt or missing one: its zeros on both arms would
   * read as a healthy metric.
   */
  readonly mayBeUnseen?: boolean;
}

interface PostHogMetricsOptions {
  readonly projectId: number | string;
  readonly transport: PostHogTransport;
  /** The caller's clock, in milliseconds. */
  readonly now: () => number;
  /** How far behind the clock PostHog's events can be trusted to be complete. Past a few minutes, plan with it as `sourceLagMs`. */
  readonly ingestionLagMs: number;
  /** Each guardrail's metric name, and the events behind it. */
  readonly metrics: Readonly<Record<string, MetricDefinition>>;
  readonly variants?: { readonly control: string; readonly treatment: string };
  /**
   * What is counted as one unit: a person (the default), or a PostHog group such as the company behind a
   * B2B account, by its group type index (the events' `$group_0` to `$group_4`). Events without that group
   * are left out. A product with few accounts has few units, so plan with fewer `minFreshUnits` and longer
   * steps (`standardPlan`'s `overrides`).
   */
  readonly unit?: "person" | { readonly groupTypeIndex: number } | undefined;
}

interface HogQuery {
  readonly query: string;
  readonly values: Record<string, number | string | string[]>;
}

type Row = Readonly<Record<string, unknown>>;

const cell = z.unknown(),
  resultSchema = z.object({ columns: z.array(z.string()), results: z.array(z.array(cell)) }),
  DEFAULT_VARIANTS = { control: "control", treatment: "treatment" },
  /** Units seen on both arms are counted under this name and left out of both. */
  BOTH = "both",
  /** PostHog keeps five group types, `$group_0` to `$group_4`. */
  GROUP_TYPES = 5,
  MS_PER_SECOND = 1000,
  PROPERTY_NAME = /^[\w$]+$/,
  NO_SAMPLE: ArmSample = { denominator: { crossSum: 0, sum: 0, sumSquares: 0 }, sum: 0, sumSquares: 0, units: 0 };

function definitionOf(options: PostHogMetricsOptions, guardrail: Guardrail): MetricDefinition {
  const definition = new Map(Object.entries(options.metrics)).get(guardrail.metric);
  if (definition === undefined || (definition.property !== undefined && !PROPERTY_NAME.test(definition.property))) {
    throw new Error(`The metric ${guardrail.metric} has no usable PostHog definition.`);
  }
  return definition;
}

/** The events' column that names the unit. It goes into the query's text, so a group type index must be one PostHog has. */
function unitColumn(options: PostHogMetricsOptions): string {
  const unit = options.unit ?? "person";
  if (unit === "person") {
    return "person_id";
  }
  if (!Number.isInteger(unit.groupTypeIndex) || unit.groupTypeIndex < 0 || unit.groupTypeIndex >= GROUP_TYPES) {
    throw new Error(`A PostHog group type index is a whole number from 0 to ${GROUP_TYPES - 1}; got ${unit.groupTypeIndex}.`);
  }
  return `$group_${unit.groupTypeIndex}`;
}

/** One unit's value for a guardrail, counting only what the unit did after it was first exposed. */
function unitColumns(guardrail: Guardrail, definition: MetricDefinition, index: number): string[] {
  const after = `activity.timestamp >= exposure.first_seen`,
    hit = `activity.event = {event${index}} AND ${after}`,
    count = `countIf(${hit})`,
    total = definition.property === undefined ? count : `sumIf(activity.value${index}, ${hit})`,
    top = guardrail.kind === "rate" ? `least(1, ${count})` : total;
  return [`${top} AS n${index}`, `countIf(activity.event = {under${index}} AND ${after}) AS d${index}`];
}

function armColumns(index: number): string[] {
  return [`sum(n${index}) AS n${index}_sum`, `sum(n${index} * n${index}) AS n${index}_squares`, `sum(d${index}) AS d${index}_sum`, `sum(d${index} * d${index}) AS d${index}_squares`, `sum(n${index} * d${index}) AS cross${index}`];
}

function valuesFor(options: PostHogMetricsOptions, query: MetricQuery, until: number): HogQuery["values"] {
  const variants = options.variants ?? DEFAULT_VARIANTS,
    definitions = query.guardrails.map((guardrail) => definitionOf(options, guardrail)),
    values: HogQuery["values"] = {
      arms: [variants.control, variants.treatment],
      events: definitions.flatMap((definition) => [definition.event, definition.denominatorEvent ?? definition.event]),
      flag: query.flagKey,
      since: Math.floor(query.since / MS_PER_SECOND),
      until: Math.floor(until / MS_PER_SECOND),
    };
  for (const [index, definition] of definitions.entries()) {
    values[`event${index}`] = definition.event;
    values[`under${index}`] = definition.denominatorEvent ?? "";
  }
  return values;
}

/**
 * One query for every guardrail: which unit was first exposed on which arm, then what each of them did after
 * that, then totals per arm. A unit (a person, or a group) with many events counts once.
 */
function snapshotQuery(options: PostHogMetricsOptions, query: MetricQuery, until: number): HogQuery {
  const unit = unitColumn(options),
    // A group's column is empty on events sent without that group, which belong to no unit.
    grouped = unit === "person_id" ? "" : ` AND ${unit} != ''`,
    definitions = query.guardrails.map((guardrail) => definitionOf(options, guardrail)),
    valueColumns = definitions.map((definition, index) => `toFloat(properties.${definition.property ?? "$value"}) AS value${index}`),
    perUnit = query.guardrails.flatMap((guardrail, index) => unitColumns(guardrail, definitionOf(options, guardrail), index)),
    perArm = query.guardrails.flatMap((_guardrail, index) => armColumns(index)),
    window = `timestamp >= toDateTime({since}) AND timestamp <= toDateTime({until})`,
    exposures = `SELECT ${unit} AS unit, argMin(properties.$feature_flag_response, timestamp) AS first_arm, min(timestamp) AS first_seen, uniqExact(properties.$feature_flag_response) AS arms FROM events WHERE event = '$feature_flag_called' AND properties.$feature_flag = {flag} AND properties.$feature_flag_response IN {arms} AND ${window}${grouped} GROUP BY unit`,
    activity = `SELECT ${[`${unit} AS unit`, "event", "timestamp", ...valueColumns].join(", ")} FROM events WHERE event IN {events} AND ${window}${grouped}`,
    units = `SELECT ${["exposure.unit AS unit", `if(any(exposure.arms) > 1, '${BOTH}', any(exposure.first_arm)) AS arm`, ...perUnit].join(", ")} FROM (${exposures}) AS exposure LEFT JOIN (${activity}) AS activity ON activity.unit = exposure.unit GROUP BY unit`;
  return { query: `SELECT ${["arm", "count() AS units", ...perArm].join(", ")} FROM (${units}) GROUP BY arm`, values: valuesFor(options, query, until) };
}

/**
 * PostHog's own clock, the newest event of any kind (when it is old, PostHog is behind or the product is
 * quiet, and either way there is no news), and whether each named event has been seen at all in a month.
 */
function latestQuery(until: number, events: readonly string[]): HogQuery {
  const seen = events.map((_event, index) => `countIf(event = {seen${index}} AND timestamp >= toDateTime({until}) - INTERVAL 30 DAY) AS seen${index}`),
    columns = ["toUnixTimestamp(now()) AS as_of", "toUnixTimestamp(maxIf(timestamp, timestamp >= toDateTime({until}) - INTERVAL 1 DAY)) AS latest", ...seen],
    values: HogQuery["values"] = { until: Math.floor(until / MS_PER_SECOND) };
  for (const [index, event] of events.entries()) {
    values[`seen${index}`] = event;
  }
  return { query: `SELECT ${columns.join(", ")} FROM events WHERE timestamp <= toDateTime({until}) AND timestamp >= toDateTime({until}) - INTERVAL 30 DAY`, values };
}

/** The events a query's guardrails name that must have been seen before their zeros can be believed. */
function requiredEvents(options: PostHogMetricsOptions, query: MetricQuery): string[] {
  return query.guardrails.flatMap((guardrail) => {
    const definition = definitionOf(options, guardrail);
    return definition.mayBeUnseen === true ? [] : [definition.event, ...(definition.denominatorEvent === undefined ? [] : [definition.denominatorEvent])];
  });
}

/** A cell as a number. A row that isn't there is an arm nobody is on yet, so its totals are 0; a cell that is there and isn't a number stays NaN, so the snapshot is refused. */
function numberAt(row: Row | undefined, column: string): number {
  return row === undefined ? 0 : Number(row[column] ?? 0);
}

function sampleOf(row: Row | undefined, index: number): ArmSample {
  if (row === undefined) {
    return NO_SAMPLE;
  }
  return {
    denominator: { crossSum: numberAt(row, `cross${index}`), sum: numberAt(row, `d${index}_sum`), sumSquares: numberAt(row, `d${index}_squares`) },
    sum: numberAt(row, `n${index}_sum`),
    sumSquares: numberAt(row, `n${index}_squares`),
    units: numberAt(row, "units"),
  };
}

function rowsOf(body: unknown): Row[] {
  const { columns, results } = resultSchema.parse(body);
  return results.map((cells) => Object.fromEntries(columns.map((column, index) => [column, cells.at(index)])));
}

/** Turns the query's rows (one per arm, and one for units seen on both) into a snapshot. */
function snapshotFrom(rows: readonly Row[], request: { query: MetricQuery; asOf: number; watermark: number; variants?: { control: string; treatment: string } }): MetricSnapshot {
  const variants = request.variants ?? DEFAULT_VARIANTS,
    control = rows.find((row) => row["arm"] === variants.control),
    treatment = rows.find((row) => row["arm"] === variants.treatment),
    metrics: Record<string, ArmPair<ArmSample>> = {};
  for (const [index, guardrail] of request.query.guardrails.entries()) {
    metrics[guardrail.metric] = { control: sampleOf(control, index), treatment: sampleOf(treatment, index) };
  }
  return {
    asOf: request.asOf,
    contaminated: numberAt(
      rows.find((row) => row["arm"] === BOTH),
      "units",
    ),
    exposed: { control: numberAt(control, "units"), treatment: numberAt(treatment, "units") },
    metrics,
    watermark: request.watermark,
  };
}

async function run(options: PostHogMetricsOptions, query: HogQuery): Promise<Row[]> {
  const call = { body: { query: { kind: "HogQLQuery", ...query } }, method: "POST" as const, path: `/api/projects/${options.projectId}/query/` },
    reply = await options.transport(call);
  return rowsOf(bodyOf(reply, call));
}

/** The events PostHog has not seen in a month, among those that must have been. */
function unseen(events: readonly string[], latest: Row | undefined): string[] {
  return events.filter((_event, index) => numberAt(latest, `seen${index}`) === 0);
}

/**
 * A `MetricSource` over PostHog events: exposures are `$feature_flag_called`, and each metric is the events its
 * definition names. Throws at once on a `unit` PostHog doesn't have.
 */
function createPostHogMetrics(options: PostHogMetricsOptions): MetricSource {
  unitColumn(options);
  return {
    snapshot: async (query) => {
      const until = options.now() - options.ingestionLagMs,
        events = requiredEvents(options, query),
        [rows, freshness] = await Promise.all([run(options, snapshotQuery(options, query, until)), run(options, latestQuery(until, events))]),
        latest = freshness.at(0),
        missing = unseen(events, latest);
      if (missing.length > 0) {
        throw new Error(`PostHog has not seen ${missing.join(", ")} in a month. Check the event's name, or mark its metric mayBeUnseen.`);
      }
      const asOf = numberAt(latest, "as_of") * MS_PER_SECOND,
        // Complete up to the lag behind PostHog's own clock (a caller whose clock is fast can't claim more), unless nothing at all has arrived that recently.
        watermark = Math.min(until, asOf - options.ingestionLagMs, numberAt(latest, "latest") * MS_PER_SECOND);
      return snapshotFrom(rows, { asOf, query, variants: options.variants ?? DEFAULT_VARIANTS, watermark });
    },
  };
}

export type { HogQuery, MetricDefinition, PostHogMetricsOptions };
export { createPostHogMetrics, latestQuery, snapshotFrom, snapshotQuery };
