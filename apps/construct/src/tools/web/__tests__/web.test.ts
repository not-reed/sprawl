import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebReadTool } from "../web-read.js";
import { createWebSearchTool } from "../web-search.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: string, init?: { status?: number; ok?: boolean }) {
  const status = init?.status ?? 200;
  const ok = init?.ok ?? (status >= 200 && status < 300);
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  });
}

// ---------- web_read ----------

describe("web_read", () => {
  it("returns markdown content on success", async () => {
    const md = "# Hello World\n\nSome content here.";
    mockFetch(md);

    const tool = createWebReadTool();
    const result = await tool.execute("t1", { url: "https://example.com" });

    expect(result.output).toBe(md);
    expect((result.details as any).url).toBe("https://example.com");
    expect((result.details as any).truncated).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://r.jina.ai/https://example.com",
      expect.objectContaining({ headers: { Accept: "text/markdown" } }),
    );
  });

  it("throws on HTTP error with status and body snippet", async () => {
    mockFetch("Not Found", { status: 404, ok: false });

    const tool = createWebReadTool();
    await expect(tool.execute("t1", { url: "https://bad.com" })).rejects.toThrow(
      /Jina Reader returned 404.*Not Found/,
    );
  });

  it("truncates long content at 12000 chars", async () => {
    const long = "x".repeat(15_000);
    mockFetch(long);

    const tool = createWebReadTool();
    const result = await tool.execute("t1", { url: "https://example.com" });

    expect(result.output.length).toBeLessThan(15_000);
    expect(result.output).toContain("[... truncated]");
    expect((result.details as any).truncated).toBe(true);
    expect((result.details as any).length).toBe(15_000);
  });

  it("returns short content in full", async () => {
    const short = "Brief page.";
    mockFetch(short);

    const tool = createWebReadTool();
    const result = await tool.execute("t1", { url: "https://example.com" });

    expect(result.output).toBe(short);
    expect((result.details as any).truncated).toBe(false);
  });

  it("propagates network errors", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const tool = createWebReadTool();
    await expect(tool.execute("t1", { url: "https://down.com" })).rejects.toThrow("ECONNREFUSED");
  });
});

// ---------- web_search ----------

describe("web_search", () => {
  it("formats results with summary and results", async () => {
    const body = JSON.stringify({
      answer: "TypeScript is great.",
      results: [
        { title: "TS Docs", url: "https://ts.dev", content: "Official docs", score: 0.9 },
        { title: "TS Guide", url: "https://guide.ts", content: "A guide", score: 0.8 },
      ],
    });
    mockFetch(body);

    const tool = createWebSearchTool("tavily-key");
    const result = await tool.execute("t1", { query: "typescript" });

    expect(result.output).toContain("**Summary:** TypeScript is great.");
    expect(result.output).toContain("### TS Docs");
    expect(result.output).toContain("https://ts.dev");
    expect(result.output).toContain("### TS Guide");
    expect((result.details as any).resultCount).toBe(2);
    expect((result.details as any).hasAnswer).toBe(true);
  });

  it("omits summary when no answer", async () => {
    const body = JSON.stringify({
      results: [{ title: "Result", url: "https://r.com", content: "Content", score: 0.7 }],
    });
    mockFetch(body);

    const tool = createWebSearchTool("tavily-key");
    const result = await tool.execute("t1", { query: "test" });

    expect(result.output).not.toContain("**Summary:**");
    expect(result.output).toContain("### Result");
    expect((result.details as any).hasAnswer).toBe(false);
  });

  it('returns "No results found." when empty', async () => {
    const body = JSON.stringify({ results: [] });
    mockFetch(body);

    const tool = createWebSearchTool("tavily-key");
    const result = await tool.execute("t1", { query: "gibberish" });

    expect(result.output).toBe("No results found.");
    expect((result.details as any).resultCount).toBe(0);
  });

  it("passes custom max_results to Tavily body", async () => {
    const body = JSON.stringify({ results: [] });
    mockFetch(body);

    const tool = createWebSearchTool("tavily-key");
    await tool.execute("t1", { query: "test", max_results: 3 });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(fetchCall[1].body);
    expect(sentBody.max_results).toBe(3);
    expect(sentBody.api_key).toBe("tavily-key");
  });

  it("throws on HTTP error with status and body snippet", async () => {
    mockFetch("Unauthorized", { status: 401, ok: false });

    const tool = createWebSearchTool("bad-key");
    await expect(tool.execute("t1", { query: "test" })).rejects.toThrow(
      /Tavily returned 401.*Unauthorized/,
    );
  });
});
