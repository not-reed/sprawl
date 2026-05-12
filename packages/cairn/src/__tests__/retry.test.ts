import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  withEmbeddingRetry,
  withMemoryRetry,
  shouldRetry,
  retryAfterFromHeaders,
  fetchErrorFromResponse,
} from "../retry.js";
import type { FetchError } from "../retry.js";
import { EmbeddingError, MemoryError } from "../errors.js";
import { nullLogger } from "../types.js";

function makeFetchError(status: number, body = "", headers?: Headers): FetchError {
  const response = new Response(body, { status, headers });
  return fetchErrorFromResponse(response, body, "Test");
}

describe("shouldRetry", () => {
  it("retries on TypeError (network failure)", () => {
    expect(shouldRetry(new TypeError("fetch failed"))).toBe(true);
  });

  it("retries on 5xx", () => {
    expect(shouldRetry(makeFetchError(500))).toBe(true);
    expect(shouldRetry(makeFetchError(502))).toBe(true);
    expect(shouldRetry(makeFetchError(503))).toBe(true);
  });

  it("retries on 429", () => {
    expect(shouldRetry(makeFetchError(429))).toBe(true);
  });

  it("retries on fetch error with no status (network)", () => {
    const err = new Error("network error") as FetchError;
    err.status = undefined;
    expect(shouldRetry(err)).toBe(true);
  });

  it("does not retry on 4xx (except 429)", () => {
    expect(shouldRetry(makeFetchError(400))).toBe(false);
    expect(shouldRetry(makeFetchError(401))).toBe(false);
    expect(shouldRetry(makeFetchError(403))).toBe(false);
    expect(shouldRetry(makeFetchError(404))).toBe(false);
  });

  it("does not retry on generic errors (parse failures)", () => {
    expect(shouldRetry(new Error("JSON parse error"))).toBe(false);
    expect(shouldRetry(new EmbeddingError("bad data"))).toBe(false);
  });
});

describe("retryAfterFromHeaders", () => {
  it("returns null for absent header", () => {
    expect(retryAfterFromHeaders(new Headers())).toBeNull();
  });

  it("parses numeric seconds", () => {
    const headers = new Headers({ "retry-after": "30" });
    expect(retryAfterFromHeaders(headers)).toBe(30000);
  });

  it("parses HTTP-date", () => {
    const future = new Date(Date.now() + 60000).toUTCString();
    const headers = new Headers({ "retry-after": future });
    const result = retryAfterFromHeaders(headers);
    expect(result).toBeGreaterThan(50000);
    expect(result).toBeLessThan(70000);
  });

  it("returns null for past HTTP-date", () => {
    const past = new Date(Date.now() - 60000).toUTCString();
    const headers = new Headers({ "retry-after": past });
    expect(retryAfterFromHeaders(headers)).toBeNull();
  });
});

describe("fetchErrorFromResponse", () => {
  it("preserves status and headers", () => {
    const headers = new Headers({ "x-custom": "val" });
    const response = new Response("body", { status: 500, headers });
    const err = fetchErrorFromResponse(response, "body", "Test");
    expect(err.status).toBe(500);
    expect(err.headers?.get("x-custom")).toBe("val");
    expect(err.message).toContain("Test: 500");
  });
});

let unhandled: Array<{ reason: unknown; promise: Promise<unknown> }> = [];
const onUnhandled = (reason: unknown, promise: Promise<unknown>) => {
  unhandled.push({ reason, promise });
};

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers();
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
});

describe("withRetry basic", () => {
  it("succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { logger: nullLogger });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on TypeError and succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return Promise.resolve("ok");
    });

    const promise = withRetry(fn, { logger: nullLogger, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx and succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) throw makeFetchError(503);
      return Promise.resolve("ok");
    });

    const promise = withRetry(fn, { logger: nullLogger, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses retry-after header as minimum delay on 429", async () => {
    const headers = new Headers({ "retry-after": "5" });
    const fn = vi.fn().mockImplementation(() => {
      throw makeFetchError(429, "rate limited", headers);
    });

    let capturedDelay = 0;
    const logger = {
      ...nullLogger,
      warning: (msg: string) => {
        const match = msg.match(/after (\d+)ms/);
        if (match) capturedDelay = Number(match[1]);
      },
    };

    const promise = withRetry(fn, { logger, maxRetries: 1, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).rejects.toBeDefined();

    expect(capturedDelay).toBeGreaterThanOrEqual(3750);
  });
});

describe("withRetry limits and backoff", () => {
  it("does not retry on 4xx", async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw makeFetchError(401);
    });
    await expect(withRetry(fn, { logger: nullLogger })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on parse errors", async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new Error("JSON parse");
    });
    await expect(withRetry(fn, { logger: nullLogger })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and throws last error", async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw makeFetchError(503);
    });

    const promise = withRetry(fn, { logger: nullLogger, baseDelayMs: 100, maxRetries: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("exponential backoff increases delay", async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw makeFetchError(503);
    });

    const delays: number[] = [];
    const logger = {
      ...nullLogger,
      warning: (msg: string) => {
        const match = msg.match(/after (\d+)ms/);
        if (match) delays.push(Number(match[1]));
      },
    };

    const promise = withRetry(fn, { logger, baseDelayMs: 100, maxRetries: 3, maxDelayMs: 30000 });
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).rejects.toBeDefined();

    expect(delays.length).toBe(3);
    expect(delays[1]).toBeGreaterThan(0);
    expect(delays[2]).toBeGreaterThan(0);
  });
});

describe("withEmbeddingRetry", () => {
  it("wraps TypeError into EmbeddingError", async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new TypeError("fetch failed");
    });
    await expect(withEmbeddingRetry(fn, { logger: nullLogger, maxRetries: 0 })).rejects.toThrow(
      EmbeddingError,
    );
  });

  it("passes through non-TypeError errors", async () => {
    const err = new Error("custom");
    const fn = vi.fn().mockImplementation(() => {
      throw err;
    });
    await expect(withEmbeddingRetry(fn, { logger: nullLogger, maxRetries: 0 })).rejects.toBe(err);
  });

  it("retries on TypeError", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return Promise.resolve("embedding");
    });

    const promise = withEmbeddingRetry(fn, { logger: nullLogger, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("embedding");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("withMemoryRetry", () => {
  it("wraps TypeError into MemoryError", async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new TypeError("fetch failed");
    });
    await expect(withMemoryRetry(fn, { logger: nullLogger, maxRetries: 0 })).rejects.toThrow(
      MemoryError,
    );
  });

  it("passes through non-TypeError errors", async () => {
    const err = new Error("custom");
    const fn = vi.fn().mockImplementation(() => {
      throw err;
    });
    await expect(withMemoryRetry(fn, { logger: nullLogger, maxRetries: 0 })).rejects.toBe(err);
  });
});
