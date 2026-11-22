import type { FlagControl, MetricSource } from "open-rollout";
import { createPostHogFlags, createPostHogMetrics } from "open-rollout/posthog";
import type { PostHogTransport } from "open-rollout/posthog";

function postHogTransport(host: string, apiKey: string): PostHogTransport {
  return async (call) => {
    const response = await fetch(new URL(call.path, host), {
      body: call.body === undefined ? null : JSON.stringify(call.body),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      method: call.method,
      signal: AbortSignal.timeout(10_000),
    });
    return { body: response.ok ? await response.json() : null, status: response.status };
  };
}

function postHogPorts(options: { host: string; apiKey: string; projectId: number }): { flags: FlagControl; metrics: MetricSource } {
  const transport = postHogTransport(options.host, options.apiKey);
  return {
    flags: createPostHogFlags({ projectId: options.projectId, transport }),
    metrics: createPostHogMetrics({
      projectId: options.projectId,
      transport,
      now: () => Date.now(),
      ingestionLagMs: 2 * 60_000,
      metrics: {
        errors: { event: "$exception" },
        checkout_completed: { event: "checkout completed" },
      },
    }),
  };
}

export { postHogPorts, postHogTransport };
