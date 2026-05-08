import { EmbeddingError, MemoryError } from "./errors.js";
import type { CairnLogger } from "./types.js";
import { nullLogger } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  logger?: CairnLogger;
}

const DEFAULT_RETRY: Required<Omit<RetryOpts, "logger">> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Error from a fetch-based LLM or embedding API call that includes HTTP status info.
 * Provides status + headers for rate-limit handling.
 */
export interface FetchError extends Error {
  status?: number;
  headers?: Headers;
}

function isFetchError(err: unknown): err is FetchError {
  return err instanceof Error && "status" in err;
}

/**
 * Build a FetchError from a raw response, preserving status and headers.
 */
export function fetchErrorFromResponse(
  response: Response,
  body: string,
  label: string,
): FetchError {
  const err = new Error(`${label}: ${response.status} ${body}`) as FetchError;
  err.status = response.status;
  err.headers = response.headers;
  return err;
}

/**
 * Determine if an error warrants a retry.
 * Retries: network errors (TypeError from fetch), 5xx, 429 (rate limit).
 * Does NOT retry: 4xx (except 429) — those are auth/config errors.
 * Non-fetch errors (e.g. JSON parse after successful fetch) are NOT retried.
 */
export function shouldRetry(err: unknown): boolean {
  if (isFetchError(err)) {
    const status = err.status;
    if (status === 429) return true;
    if (status !== undefined && status >= 500) return true;
    if (status === undefined) return true; // network error (no status)
    return false; // 4xx (except 429)
  }
  // Non-fetch errors are typically parse/validation issues — not retryable
  if (err instanceof TypeError) return true; // network errors via fetch()
  return false;
}

/**
 * Extract retry-after duration from response headers if present.
 * Honors Retry-After header (seconds or HTTP-date).
 */
export function retryAfterFromHeaders(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const value = headers.get("retry-after");
  if (!value) return null;

  // Numeric seconds
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // HTTP-date format
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const delay = date - Date.now();
    return delay > 0 ? delay : null;
  }

  return null;
}

/**
 * Jitter: randomize delay by ±25% to avoid thundering herd.
 */
function jitter(ms: number): number {
  const factor = 0.75 + Math.random() * 0.5; // 0.75–1.25
  return Math.round(ms * factor);
}

/**
 * Wrap an async function with exponential backoff retry.
 *
 * Behavior:
 * - Retries on network errors, 5xx, and 429 (rate limit).
 * - Does NOT retry on 4xx (auth/config errors) or parse failures.
 * - 429 responses: reads Retry-After header and uses it as minimum delay.
 * - Exponential delay: baseDelay * 2^attempt + jitter, capped at maxDelay.
 * - Logs each retry attempt at warning level.
 *
 * @param fn — The async function to retry.
 * @param opts — Retry configuration (maxRetries, delays, logger).
 * @returns The result of fn.
 * @throws The last error if all retries are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...opts };
  const logger: CairnLogger = opts.logger ?? nullLogger;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Execute fn() inside a promise chain so synchronous throws
      // become rejections with a synchronous .catch() attachment.
      // This prevents PromiseRejectionHandledWarning under fake timers.
      const promise = Promise.resolve().then(() => fn());
      promise.catch(() => {});
      return await promise;
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries || !shouldRetry(err)) {
        throw err;
      }

      let delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);

      if (isFetchError(err)) {
        const ra = retryAfterFromHeaders(err.headers);
        if (ra !== null) {
          delay = Math.max(delay, ra);
        }
      }

      delay = jitter(delay);

      logger.warning(
        `Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Wrap an embedding API call (fetch-based) with retry.
 * Converts raw fetch TypeError into EmbeddingError for consistent error handling.
 */
export async function withEmbeddingRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  try {
    return await withRetry(fn, opts);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new EmbeddingError(`Embedding API network error: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Wrap a memory LLM call (observer/reflector) with retry.
 * Converts raw fetch TypeError into MemoryError for consistent error handling.
 */
export async function withMemoryRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  try {
    return await withRetry(fn, opts);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new MemoryError(`Memory API network error: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
}
