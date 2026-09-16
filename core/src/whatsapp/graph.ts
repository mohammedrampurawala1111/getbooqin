/**
 * The one place that talks to Meta.
 *
 * Every call to the Graph API goes through `graph()`, for the same
 * reason every Razorpay call goes through its provider: so the rest of
 * the codebase never sees a vendor's error shape, and so there is one
 * place to change when Meta versions the API — which they do on a
 * schedule, deprecating the version underneath you.
 *
 * ## Errors
 *
 * Meta returns 200 with an `error` object about as often as it returns
 * a 4xx, and its errors carry three different identifiers (`code`,
 * `error_subcode`, `type`) plus a `message` that is sometimes an
 * English sentence and sometimes a stack trace. `GraphError` normalises
 * that to something a caller can branch on and a merchant can be shown.
 *
 * The codes worth knowing by name, because each needs different
 * handling rather than a retry:
 *
 *   190  token invalid or revoked — the merchant removed our app at
 *        Meta, and no retry will ever fix it. The account goes `revoked`.
 *   131047 no open service window and no template — a bug on our side,
 *        since everything proactive we send is a template.
 *   132000 template parameter count mismatch — the template at Meta and
 *        the one in templates.ts have drifted.
 *   131026 the recipient does not have WhatsApp. Not an error worth
 *        retrying or alarming about; it is just a fact about a phone
 *        number.
 *   80007  rate limited.
 */

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

const GRAPH_BASE = "https://graph.facebook.com";

export interface MetaErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

export class GraphError extends Error {
  readonly code: number;
  readonly subcode: number | null;
  readonly httpStatus: number;
  readonly details: string | null;
  readonly traceId: string | null;

  constructor(httpStatus: number, body: MetaErrorBody) {
    super(body.error_data?.details || body.message || `Meta Graph API error ${httpStatus}`);
    this.name = "GraphError";
    this.code = body.code ?? 0;
    this.subcode = body.error_subcode ?? null;
    this.httpStatus = httpStatus;
    this.details = body.error_data?.details ?? null;
    this.traceId = body.fbtrace_id ?? null;
  }

  /**
   * The merchant's access token is gone for good — they removed the app
   * at Meta, or changed the password on the business account.
   *
   * Worth its own predicate because it is the one error that must not
   * be retried and must change the account's status: retrying a revoked
   * token forever is how a dead integration looks healthy in the logs.
   */
  get isTokenRevoked(): boolean {
    return this.code === 190 || this.code === 102 || this.code === 10;
  }

  /** The number simply isn't on WhatsApp. Expected, not a fault. */
  get isNotOnWhatsApp(): boolean {
    return this.code === 131026;
  }

  get isRateLimited(): boolean {
    return this.code === 80007 || this.code === 130429 || this.httpStatus === 429;
  }

  /**
   * Worth trying again later. Deliberately narrow — retrying a
   * malformed request or a revoked token just turns one failure into
   * many, and Meta counts failed sends against the number's quality
   * rating.
   */
  get isRetryable(): boolean {
    return this.isRateLimited || this.httpStatus >= 500 || this.code === 131056;
  }
}

export interface GraphRequest {
  path: string;
  accessToken: string;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Overridable so tests need no network. */
  fetchImpl?: typeof fetch;
}

export async function graph<T>({
  path,
  accessToken,
  method = "GET",
  body,
  query,
  fetchImpl = fetch,
}: GraphRequest): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${GRAPH_VERSION}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetchImpl(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Meta occasionally answers with an HTML error page — a gateway
    // timeout, usually. Treated as a 5xx rather than crashing on the
    // parse, so the retry predicate gets a chance to be right.
    throw new GraphError(response.status || 502, { message: `Non-JSON response from Meta (${response.status})` });
  }

  const envelope = parsed as { error?: MetaErrorBody };
  // A 200 carrying an `error` object is normal at Meta, so the status
  // alone is not the question.
  if (envelope.error) throw new GraphError(response.status, envelope.error);
  if (!response.ok) throw new GraphError(response.status, { message: text.slice(0, 300) });

  return parsed as T;
}
