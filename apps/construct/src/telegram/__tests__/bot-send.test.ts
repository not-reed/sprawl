import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendReply } from "../bot-send.js";

describe("sendReply chunking", () => {
  const mockReply = vi.fn().mockResolvedValue({ message_id: 1 });
  const mockDb = {} as any;

  beforeEach(() => {
    mockReply.mockClear();
  });

  it("sends short text in a single message", async () => {
    await sendReply(mockDb, { reply: mockReply }, "Hello world", {});
    expect(mockReply).toHaveBeenCalledTimes(1);
    expect(mockReply.mock.calls[0]![0]).toBe("Hello world");
  });

  it("chunks long text at word boundaries", async () => {
    const words = Array.from({ length: 2000 }, () => "word");
    const text = words.join(" ");

    await sendReply(mockDb, { reply: mockReply }, text, {});

    expect(mockReply.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstChunk = mockReply.mock.calls[0]![0] as string;

    // First chunk should respect the max length and not split mid-word
    expect(firstChunk.length).toBeLessThanOrEqual(4000);
    expect(firstChunk.endsWith("word")).toBe(true);
  });

  it("falls back to hard slice when no word boundary exists", async () => {
    const text = "a".repeat(5000);
    await sendReply(mockDb, { reply: mockReply }, text, {});

    expect(mockReply).toHaveBeenCalledTimes(2);
    expect(mockReply.mock.calls[0]![0].length).toBeLessThanOrEqual(4000);
  });
});
