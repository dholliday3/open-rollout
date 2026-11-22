/** One call to PostHog's API. `path` starts after the host, such as `/api/projects/1/feature_flags/`. */
interface PostHogCall {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}

interface PostHogReply {
  readonly status: number;
  /** The parsed JSON body. */
  readonly body: unknown;
}

/**
 * How the adapters reach PostHog. The app supplies it (a `fetch` with a personal API key and a timeout),
 * so this package stays free of any one platform's HTTP client.
 */
type PostHogTransport = (call: PostHogCall) => Promise<PostHogReply>;

const OK_FROM = 200,
  OK_BELOW = 300,
  CONFLICT = 409;

/** The reply's body when the call worked; otherwise an error that says what PostHog answered. */
function bodyOf(reply: PostHogReply, call: PostHogCall): unknown {
  if (reply.status === CONFLICT) {
    throw new Error(`PostHog refused ${call.path}: the flag changed since it was read.`);
  }
  if (reply.status < OK_FROM || reply.status >= OK_BELOW) {
    throw new Error(`PostHog answered ${reply.status} to ${call.method} ${call.path}.`);
  }
  return reply.body;
}

export type { PostHogCall, PostHogReply, PostHogTransport };
export { bodyOf };
