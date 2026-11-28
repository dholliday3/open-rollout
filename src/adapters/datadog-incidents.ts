import type { Incident, IncidentFeed } from "../ports.js";
import { z } from "zod";

/**
 * An incident feed over Datadog monitors: a monitor with the tags you choose, in alert, holds every rollout.
 * Tag the monitors that watch the whole product (error rate, latency, a dependency's health), the ones that
 * fire on an incident that hits both arms of a rollout alike.
 */

/** One call to Datadog's API. `path` starts after the host, such as `/api/v1/monitor?...`. */
interface DatadogCall {
  readonly method: "GET";
  readonly path: string;
}

/**
 * How the adapter reaches Datadog. The app supplies it: a `fetch` to `https://api.<site>` with the
 * `DD-API-KEY` and `DD-APPLICATION-KEY` headers (monitors read scope) and a timeout.
 */
type DatadogTransport = (call: DatadogCall) => Promise<{ readonly status: number; readonly body: unknown }>;

type MonitorState = "Alert" | "Warn" | "No Data";

interface DatadogIncidentsOptions {
  readonly transport: DatadogTransport;
  /** Monitors carrying every one of these tags hold rollouts while they alert, such as `["open-rollout:hold"]`. */
  readonly monitorTags: readonly string[];
  /** The monitor states that count as an incident. Left out, Alert only. */
  readonly states?: readonly MonitorState[];
}

const monitorSchema = z.object({ id: z.number(), name: z.string(), overall_state: z.string().nullish(), tags: z.array(z.string()).default([]) }),
  pageSchema = z.array(monitorSchema),
  PAGE_SIZE = 1000,
  OK_FROM = 200,
  OK_BELOW = 300,
  ALERT_ONLY: readonly MonitorState[] = ["Alert"];

type Monitor = z.infer<typeof monitorSchema>;

async function page(options: DatadogIncidentsOptions, index: number): Promise<Monitor[]> {
  const query = new URLSearchParams({ monitor_tags: options.monitorTags.join(","), page: String(index), page_size: String(PAGE_SIZE) }),
    call: DatadogCall = { method: "GET", path: `/api/v1/monitor?${query.toString()}` },
    reply = await options.transport(call);
  if (reply.status < OK_FROM || reply.status >= OK_BELOW) {
    throw new Error(`Datadog answered ${reply.status} to GET ${call.path}.`);
  }
  return pageSchema.parse(reply.body);
}

/** Every monitor with the tags, page after page until a page comes back short. */
async function monitors(options: DatadogIncidentsOptions, index = 0): Promise<Monitor[]> {
  const found = await page(options, index);
  return found.length < PAGE_SIZE ? found : [...found, ...(await monitors(options, index + 1))];
}

/** Datadog filters by tag already; the adapter checks again, so a filter Datadog reads more loosely can't hold rollouts by accident. */
function isIncident(monitor: Monitor, options: DatadogIncidentsOptions): boolean {
  const states: readonly string[] = options.states ?? ALERT_ONLY;
  return states.includes(monitor.overall_state ?? "") && options.monitorTags.every((tag) => monitor.tags.includes(tag));
}

/** An `IncidentFeed` over Datadog monitors. Throws at once when given no tags: every monitor in the account would hold every rollout. */
function createDatadogIncidents(options: DatadogIncidentsOptions): IncidentFeed {
  if (options.monitorTags.length === 0) {
    throw new Error("Name the tags of the monitors that hold rollouts, such as open-rollout:hold.");
  }
  return {
    open: async (): Promise<Incident[]> => {
      const found = await monitors(options);
      return found.filter((monitor) => isIncident(monitor, options)).map((monitor) => ({ id: `datadog-monitor-${monitor.id}`, title: monitor.name }));
    },
  };
}

export type { DatadogCall, DatadogIncidentsOptions, DatadogTransport, MonitorState };
export { createDatadogIncidents };
