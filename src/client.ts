import { APIPromise, requestIdFrom } from "./api-promise";
import { ENV, fromCodeOrEnv, readEnv } from "./env";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeError,
} from "./errors";
import {
  consoleLogger,
  DEFAULT_LOG_LEVEL,
  parseLogLevel,
  redactHeaders,
  withLevel,
} from "./logging";
import { validateQuestions } from "./questions";
import { Models } from "./resources/models";
import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
  isRetryableStatus,
  retryDelayMs,
  sleep,
} from "./retry";
import { describeRuntime, isBrowser } from "./runtime";
import type {
  Fetch,
  Logger,
  LogLevel,
  Questions,
  RequestOptions,
  RetryPolicy,
  SystemOneRequest,
  SystemOneRequestPayload,
  SystemOneResult,
  TypeSafeClientConfig,
} from "./types";
import { VERSION } from "./version";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";

// ---------------------------------------------------------------------------
// Construction-time checks
// ---------------------------------------------------------------------------

const missingApiKey = (): never => {
  throw new TypeSafeError(
    `No API key was provided. Pass \`apiKey\` to the TypeSafeClient constructor or set the ${ENV.apiKey} environment variable.`,
  );
};

const missingFetch = (): never => {
  throw new TypeSafeError(
    "No global `fetch` is available in this runtime. Pass a `fetch` implementation to the TypeSafeClient constructor.",
  );
};

const refuseBrowser = (): never => {
  throw new TypeSafeError(
    "TypeSafeClient is running in a browser, which would expose your API key to anyone using the page. " +
      "Call the API from a server instead, or pass `dangerouslyAllowBrowser: true` if you understand the risk.",
  );
};

/** Call global `fetch` with its required receiver in browsers. */
const defaultFetch: Fetch = (input, init) => globalThis.fetch(input, init);

const assertNonNegativeInteger = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeSafeError(`\`${name}\` must be a non-negative integer, got ${String(value)}.`);
  }
  return value;
};

const assertPositiveMs = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeSafeError(
      `\`${name}\` must be a positive number of milliseconds, got ${String(value)}.`,
    );
  }
  return value;
};

const assertNonNegativeMs = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeSafeError(
      `\`${name}\` must be a non-negative number of milliseconds, got ${String(value)}.`,
    );
  }
  return value;
};

const assertFraction = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeSafeError(`\`${name}\` must be between 0 and 1, got ${String(value)}.`);
  }
  return value;
};

const assertStatusSet = (name: string, statuses: ReadonlySet<number>): ReadonlySet<number> => {
  for (const status of statuses) {
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      throw new TypeSafeError(`\`${name}\` must contain HTTP status codes, got ${String(status)}.`);
    }
  }
  return statuses;
};

/** Merge and validate retry overrides, copying the status set to isolate later mutations. */
const resolveRetryPolicy = (
  base: RetryPolicy,
  overrides: Partial<RetryPolicy> | undefined,
): RetryPolicy => {
  const o = overrides ?? {};
  return {
    maxRetries:
      o.maxRetries === undefined
        ? base.maxRetries
        : assertNonNegativeInteger("retry.maxRetries", o.maxRetries),
    backoffInitialMs:
      o.backoffInitialMs === undefined
        ? base.backoffInitialMs
        : assertNonNegativeMs("retry.backoffInitialMs", o.backoffInitialMs),
    backoffMaxMs:
      o.backoffMaxMs === undefined
        ? base.backoffMaxMs
        : assertNonNegativeMs("retry.backoffMaxMs", o.backoffMaxMs),
    backoffJitter:
      o.backoffJitter === undefined
        ? base.backoffJitter
        : assertFraction("retry.backoffJitter", o.backoffJitter),
    httpStatuses: new Set(
      o.httpStatuses === undefined
        ? base.httpStatuses
        : assertStatusSet("retry.httpStatuses", o.httpStatuses),
    ),
    respectRetryAfter: o.respectRetryAfter ?? base.respectRetryAfter,
    maxRetryAfterMs:
      o.maxRetryAfterMs === undefined
        ? base.maxRetryAfterMs
        : assertNonNegativeMs("retry.maxRetryAfterMs", o.maxRetryAfterMs),
    apiConnectionError: o.apiConnectionError ?? base.apiConnectionError,
    apiTimeoutError: o.apiTimeoutError ?? base.apiTimeoutError,
  };
};

/** Whether the policy retries a connection error or timeout. */
const isRetryableError = (err: unknown, policy: RetryPolicy): boolean => {
  if (err instanceof APITimeoutError) return policy.apiTimeoutError;
  if (err instanceof APIConnectionError) return policy.apiConnectionError;
  return false;
};

/** Resolve and validate the log level from configuration or the environment. */
const resolveLogLevel = (fromCode: LogLevel | undefined): LogLevel => {
  if (fromCode !== undefined) return parseLogLevel(fromCode, "the `logLevel` option");
  const fromEnv = readEnv(ENV.logLevel);
  if (fromEnv !== undefined) return parseLogLevel(fromEnv, ENV.logLevel);
  return DEFAULT_LOG_LEVEL;
};

const stripTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

/** Last value wins regardless of casing; undefined removes a protected header. */
const mergeHeaders = (
  ...sources: Readonly<Record<string, string | undefined>>[]
): Record<string, string> => {
  const entries = new Map<string, [string, string]>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) entries.delete(name.toLowerCase());
      else entries.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(entries.values());
};

/** Drain a clone so the original response retains its metadata and a readable, buffered body. */
const bufferResponse = async (response: Response, signal: AbortSignal): Promise<void> => {
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  // Older native fetch implementations cancel the original tee branch on abort. Keeping it
  // locked prevents their unhandled cancellation rejection; we cancel through its reader below.
  // Acquiring a reader does not consume the original body, so raw handoff remains readable.
  const originalReader = response.body?.getReader();
  // This reader is intentionally not consumed; observe errors and lock-release rejections.
  void originalReader?.closed.catch(() => {});
  const cancel = (): void => {
    // Cancel both tee branches without waiting for an underlying source to acknowledge it.
    void reader.cancel(signal.reason).catch(() => {});
    void originalReader?.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    while (!(await reader.read()).done) {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
    originalReader?.releaseLock();
  }
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Method = "GET" | "POST";

/** Per-call transport options with an optional JSON body. */
export interface RawRequestOptions extends RequestOptions {
  body?: unknown;
}

/** Internal transport interface used by API resources. */
export interface Transport {
  request<T>(method: "GET" | "POST", path: string, options?: RawRequestOptions): APIPromise<T>;
  readonly defaultModel: string;
}

interface ResolvedRequest {
  method: Method;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  timeout: number;
  retry: RetryPolicy;
}

/** Runtime description cached for the process lifetime. */
const RUNTIME = describeRuntime();

/** Client for the TypeSafe AI API. */
export class TypeSafeClient {
  /** API key excluded from serialization and public properties. */
  readonly #apiKey: string;
  /** API root with trailing slashes removed. */
  readonly baseURL: string;
  /** Model used when a request omits `model`. */
  readonly defaultModel: string;
  /** Configured log verbosity. */
  readonly logLevel: LogLevel;
  /** The configured logger, filtered to `logLevel`. */
  readonly logger: Logger;
  /** Retry settings with constructor overrides applied. */
  readonly retry: RetryPolicy;
  /** Timeout per attempt in milliseconds. */
  readonly timeout: number;
  /** Additional headers sent with each request. */
  readonly defaultHeaders: Readonly<Record<string, string>>;
  /** HTTP fetch implementation. */
  readonly fetch: Fetch;

  /** The models available to the account. */
  readonly models: Models;

  #requestCount = 0;

  /**
   * Create a client for the TypeSafe AI API.
   *
   * Explicit options take precedence over environment variables, then SDK defaults.
   * Empty or whitespace-only environment values are ignored.
   *
   * @throws {TypeSafeError} The API key is missing, configuration is invalid, or the runtime is unsupported.
   */
  constructor(config: TypeSafeClientConfig = {}) {
    if (isBrowser() && !config.dangerouslyAllowBrowser) refuseBrowser();

    this.#apiKey = fromCodeOrEnv(config.apiKey, ENV.apiKey) ?? missingApiKey();
    this.baseURL = stripTrailingSlashes(
      fromCodeOrEnv(config.baseURL, ENV.baseURL) ?? DEFAULT_BASE_URL,
    );
    this.defaultModel = fromCodeOrEnv(config.defaultModel, ENV.defaultModel) ?? DEFAULT_MODEL;
    this.logLevel = resolveLogLevel(config.logLevel);
    this.logger = withLevel(config.logger ?? consoleLogger, this.logLevel);
    this.retry = resolveRetryPolicy(DEFAULT_RETRY_POLICY, config.retry);
    this.timeout = assertPositiveMs("timeout", config.timeout ?? DEFAULT_TIMEOUT_MS);
    this.defaultHeaders = { ...config.defaultHeaders };

    if (config.fetch === undefined && typeof globalThis.fetch !== "function") missingFetch();
    this.fetch = config.fetch ?? defaultFetch;

    const transport: Transport = {
      request: (method, path, options) => this.#request(method, path, options),
      defaultModel: this.defaultModel,
    };
    this.models = new Models(transport);
  }

  /**
   * Answer named questions about text or structured state.
   *
   * @param request - State, questions, and an optional model override.
   * @param options - Per-call timeout, retry, headers, and cancellation settings.
   * @returns Answers typed by question name and criteria, with model and token usage.
   * @throws {TypeSafeError} Questions are empty, or score criteria are not a list of at least two entries.
   * @throws {APIError} The server returns a non-2xx response after retries.
   * @throws {APIConnectionError} The request cannot connect or times out after retries.
   * @throws {APIUserAbortError} The caller aborts the request.
   *
   * @example
   * ```ts
   * const { answers } = await client.systemOne({
   *   state: "I was charged twice. Please help.",
   *   questions: { billing: noul("Is this about billing?") },
   * });
   * console.log(answers.billing.noul);
   * ```
   */
  systemOne<const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: RequestOptions = {},
  ): APIPromise<SystemOneResult<Q>> {
    validateQuestions(request.questions);
    const body = {
      ...request,
      model: request.model ?? this.defaultModel,
    } satisfies SystemOneRequestPayload;

    return this.#request<SystemOneResult<Q>>("POST", "/v1/systemone", {
      ...options,
      body,
    });
  }

  /** Send a request and parse its response body. */
  #request<T>(method: Method, path: string, options: RawRequestOptions = {}): APIPromise<T> {
    const resolved: ResolvedRequest = {
      method,
      path,
      body: options.body,
      headers: mergeHeaders(this.defaultHeaders, options.headers ?? {}),
      signal: options.signal,
      timeout:
        options.timeout === undefined ? this.timeout : assertPositiveMs("timeout", options.timeout),
      retry: resolveRetryPolicy(this.retry, options.retry),
    };
    // Numbered so concurrent requests, and the attempts within one, can be told apart in the logs.
    const tag = `#${++this.#requestCount} ${method} ${path}`;

    return new APIPromise<T>(this.fetchWithRetries(tag, resolved), async (res) => {
      const parsed = await parseBody(res);
      this.logger.debug(`${tag} <- body`, parsed);
      return parsed as T;
    });
  }

  /** Retry eligible failures, logging attempt summaries at `info` and headers and bodies at `debug`. */
  private async fetchWithRetries(tag: string, req: ResolvedRequest): Promise<Response> {
    const url = `${this.baseURL}${req.path}`;
    // User-supplied headers go first so they can't clobber auth or the JSON content type.
    const headers = mergeHeaders(req.headers, {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      "User-Agent": `typesafe-sdk/${VERSION}`,
      "X-TypeSafe-SDK": `typesafe-sdk/${VERSION}`,
      "X-TypeSafe-Runtime": RUNTIME,
      "Content-Type": req.body === undefined ? undefined : "application/json",
      "X-TypeSafe-Retry-Count": undefined,
    });
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);

    for (let attempt = 0; ; attempt++) {
      const retriesLeft = req.retry.maxRetries - attempt;
      const attemptHeaders =
        attempt === 0 ? headers : { ...headers, "X-TypeSafe-Retry-Count": String(attempt) };
      this.logger.debug(`${tag} -> ${url}`, {
        headers: redactHeaders(attemptHeaders),
        body: req.body,
      });

      const started = Date.now();
      let res: Response;
      try {
        res = await this.attempt(
          tag,
          url,
          { method: req.method, headers: attemptHeaders, body },
          req,
        );
      } catch (err) {
        if (err instanceof APIUserAbortError || retriesLeft <= 0) throw err;
        if (!isRetryableError(err, req.retry)) throw err;
        await this.backOff(tag, attempt, retriesLeft, (err as Error).message, undefined, req);
        continue;
      }

      const requestId = requestIdFrom(res.headers);
      this.logger.info(
        `${tag} <- ${res.status} in ${Date.now() - started}ms${requestId ? ` (request ${requestId})` : ""}`,
      );
      if (res.ok) return res;

      const errorBody = await parseBody(res);
      this.logger.debug(`${tag} <- error body`, errorBody);
      const error = APIError.fromResponse(res.status, errorBody, res.headers);
      if (retriesLeft <= 0 || !isRetryableStatus(res.status, req.retry)) throw error;
      await this.backOff(tag, attempt, retriesLeft, `${res.status}`, res.headers, req);
    }
  }

  /**
   * One HTTP round trip, including body delivery, with a timeout. The caller's signal and our
   * timer both abort the same controller; we check which fired to choose the error class.
   */
  private async attempt(
    tag: string,
    url: string,
    init: { method: Method; headers: Record<string, string>; body: string | undefined },
    { signal, timeout }: ResolvedRequest,
  ): Promise<Response> {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);

    const started = Date.now();
    const elapsed = (): string => `${Date.now() - started}ms`;
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal });
      await bufferResponse(response, controller.signal);
      return response;
    } catch (err) {
      if (signal?.aborted) {
        this.logger.info(`${tag} aborted by caller after ${elapsed()}`);
        throw new APIUserAbortError(undefined, { cause: err });
      }
      if (timedOut) {
        this.logger.info(`${tag} timed out after ${elapsed()}`);
        throw new APITimeoutError(timeout, { cause: err });
      }
      this.logger.info(`${tag} connection error after ${elapsed()}`, err);
      throw new APIConnectionError(
        err instanceof Error ? `Connection error: ${err.message}` : undefined,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /** Wait before retrying; caller cancellation throws `APIUserAbortError`. */
  private async backOff(
    tag: string,
    attempt: number,
    retriesLeft: number,
    reason: string,
    headers: Headers | undefined,
    { retry, signal }: ResolvedRequest,
  ): Promise<void> {
    const delay = retryDelayMs(attempt, headers, retry);
    const nth = attempt + 1;
    const total = attempt + retriesLeft;
    this.logger.info(`${tag} retrying in ${delay}ms (retry ${nth}/${total}) after ${reason}`);
    try {
      await sleep(delay, signal);
    } catch (err) {
      this.logger.info(`${tag} aborted by caller while waiting to retry`);
      throw new APIUserAbortError(undefined, { cause: err });
    }
  }
}

const parseBody = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (text.length === 0) return undefined;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  // Be lenient: servers and proxies don't always set content-type.
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
