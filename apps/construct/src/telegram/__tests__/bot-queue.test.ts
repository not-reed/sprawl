import { describe, it, expect } from "vitest";
import { ChatQueueManager } from "../bot-queue.js";

describe("ChatQueueManager", () => {
  it("processes messages sequentially for the same chat", async () => {
    const qm = new ChatQueueManager();
    const order: number[] = [];

    const p1 = qm.enqueue("chat1", async () => {
      order.push(1);
    });
    const p2 = qm.enqueue("chat1", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("decrements depth and cleans up when a task rejects", async () => {
    const qm = new ChatQueueManager();
    const err = new Error("boom");

    const p1 = qm.enqueue("chat1", async () => {
      throw err;
    });
    const p2 = qm.enqueue("chat1", async () => {
      // should still run despite p1 rejecting
    });

    await expect(p1).rejects.toBe(err);
    await p2;

    // Drain microtasks so the cleanup handlers run
    await new Promise<void>((r) => queueMicrotask(r));

    // After both complete, depth should be 0
    expect(qm.shouldReplyTo("chat1")).toBe(false);
  });

  it("activates reply-to when queue depth > 1 and cleans up after", async () => {
    const qm = new ChatQueueManager();

    const p1 = qm.enqueue("chat1", async () => {
      await new Promise<void>((r) => setTimeout(r, 10));
    });
    const p2 = qm.enqueue("chat1", async () => {});

    // While p1 is still running, depth is > 1
    expect(qm.shouldReplyTo("chat1")).toBe(true);

    await Promise.all([p1, p2]);
    // Drain microtasks so the .finally() handlers run
    await new Promise<void>((r) => queueMicrotask(r));

    // After completion, should clean up
    expect(qm.shouldReplyTo("chat1")).toBe(false);
  });

  it("processes different chats independently", async () => {
    const qm = new ChatQueueManager();
    const order: string[] = [];

    const p1 = qm.enqueue("chat1", async () => {
      order.push("a");
    });
    const p2 = qm.enqueue("chat2", async () => {
      order.push("b");
    });

    await Promise.all([p1, p2]);
    expect(order).toContain("a");
    expect(order).toContain("b");
  });
});
