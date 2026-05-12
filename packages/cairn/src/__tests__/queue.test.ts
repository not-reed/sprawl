import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import type { CairnDatabase } from "../db/types.js";
import { PipelineQueue } from "../queue.js";
import { setupCairnTestDb } from "./test-db.js";

interface MockMemoryManager {
  runObserver: ReturnType<typeof vi.fn>;
  promoteObservations: ReturnType<typeof vi.fn>;
  runReflector: ReturnType<typeof vi.fn>;
}

function createMockManager(): MockMemoryManager {
  return {
    runObserver: vi.fn().mockResolvedValue(true),
    promoteObservations: vi.fn().mockResolvedValue(1),
    runReflector: vi.fn().mockResolvedValue({ ran: true, usage: null }),
  };
}

function setupQueue() {
  let db: Kysely<CairnDatabase>;
  let mockManager: MockMemoryManager;
  let queue: PipelineQueue;

  beforeEach(async () => {
    db = await setupCairnTestDb();
    mockManager = createMockManager();
    queue = new PipelineQueue(db, mockManager as any, {
      backoffBaseMs: 50,
      maxBackoffMs: 200,
    });
  });

  afterEach(async () => {
    queue.stop();
    await db.destroy();
  });

  return {
    getDb: () => db,
    getManager: () => mockManager,
    getQueue: () => queue,
  };
}

describe("enqueue / dequeue", () => {
  const { getDb, getManager, getQueue } = setupQueue();

  it("enqueues a job and returns an id", async () => {
    const id = await getQueue().enqueue("post_turn", "conv-1");
    expect(id).toBeTypeOf("string");

    const row = await getDb()
      .selectFrom("pipeline_jobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row!.type).toBe("post_turn");
    expect(row!.status).toBe("pending");
  });

  it("processes a pending job on start", async () => {
    await getQueue().enqueue("observer", "conv-1");
    await getQueue().start();

    await new Promise((r) => setTimeout(r, 50));

    expect(getManager().runObserver).toHaveBeenCalledWith("conv-1");

    const row = await getDb().selectFrom("pipeline_jobs").select("status").executeTakeFirst();
    expect(row!.status).toBe("completed");
  });

  it("chains observer → promoter when observer produces observations", async () => {
    await getQueue().enqueue("observer", "conv-1");
    await getQueue().start();
    await new Promise((r) => setTimeout(r, 50));

    expect(getManager().runObserver).toHaveBeenCalledWith("conv-1");
    expect(getManager().promoteObservations).toHaveBeenCalledWith("conv-1");

    const jobs = await getDb()
      .selectFrom("pipeline_jobs")
      .select(["type", "status"])
      .orderBy("created_at", "asc")
      .execute();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].type).toBe("observer");
    expect(jobs[0].status).toBe("completed");
    expect(jobs[1].type).toBe("promoter");
    expect(jobs[1].status).toBe("completed");
  });

  it("does not chain promoter when observer produces nothing", async () => {
    getManager().runObserver.mockResolvedValue(false);
    await getQueue().enqueue("observer", "conv-1");
    await getQueue().start();
    await new Promise((r) => setTimeout(r, 50));

    expect(getManager().promoteObservations).not.toHaveBeenCalled();

    const jobs = await getDb().selectFrom("pipeline_jobs").selectAll().execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("completed");
  });

  it("runs the full post_turn pipeline", async () => {
    await getQueue().enqueue("post_turn", "conv-1");
    await getQueue().start();
    await new Promise((r) => setTimeout(r, 50));

    expect(getManager().runObserver).toHaveBeenCalledWith("conv-1");
    expect(getManager().promoteObservations).toHaveBeenCalledWith("conv-1");
    expect(getManager().runReflector).toHaveBeenCalledWith("conv-1");

    const row = await getDb().selectFrom("pipeline_jobs").select("status").executeTakeFirst();
    expect(row!.status).toBe("completed");
  });

  it("invokes postTurnExtras after post_turn completes", async () => {
    const extras = vi.fn().mockResolvedValue(undefined);
    getQueue().stop();

    const q = new PipelineQueue(getDb(), getManager() as any, {
      backoffBaseMs: 50,
      maxBackoffMs: 200,
      postTurnExtras: extras,
    });

    await q.enqueue("post_turn", "conv-1");
    await q.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(extras).toHaveBeenCalledWith("conv-1");
    q.stop();
  });
});

describe("retry / dead letter", () => {
  const { getDb, getManager, getQueue } = setupQueue();

  it("retries a failed job with exponential backoff", async () => {
    getManager().runObserver.mockRejectedValue(new Error("boom"));
    await getQueue().enqueue("observer", "conv-1");
    await getQueue().start();

    await new Promise((r) => setTimeout(r, 400));
    expect(getManager().runObserver).toHaveBeenCalledTimes(3);

    const row = await getDb()
      .selectFrom("pipeline_jobs")
      .select(["status", "attempts", "last_error"])
      .executeTakeFirst();
    expect(row!.status).toBe("dead_letter");
    expect(row!.attempts).toBe(3);
    expect(row!.last_error).toBe("boom");
  });

  it("caps backoff at maxBackoffMs", async () => {
    getManager().runObserver.mockRejectedValue(new Error("boom"));
    getQueue().stop();

    const q = new PipelineQueue(getDb(), getManager() as any, {
      backoffBaseMs: 10,
      maxBackoffMs: 30,
    });

    await q.enqueue("observer", "conv-1");
    await q.start();

    await new Promise((r) => setTimeout(r, 200));
    expect(getManager().runObserver).toHaveBeenCalledTimes(3);
    q.stop();
  });
});

describe("crash recovery", () => {
  const { getDb, getManager, getQueue } = setupQueue();

  it("resets running jobs to pending on start", async () => {
    const id = crypto.randomUUID();
    await getDb()
      .insertInto("pipeline_jobs")
      .values({
        id,
        type: "observer",
        conversation_id: "conv-1",
        status: "running",
        attempts: 0,
        max_attempts: 3,
        created_at: new Date().toISOString(),
        next_attempt_at: new Date().toISOString(),
      })
      .execute();

    await getQueue().start();
    await new Promise((r) => setTimeout(r, 50));

    const row = await getDb()
      .selectFrom("pipeline_jobs")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirst();
    expect(row!.status).toBe("completed");
    expect(getManager().runObserver).toHaveBeenCalledWith("conv-1");
  });
});

describe("status", () => {
  const { getDb, getQueue } = setupQueue();

  it("getStatus returns correct counts", async () => {
    await getDb()
      .insertInto("pipeline_jobs")
      .values([
        { id: crypto.randomUUID(), type: "a", conversation_id: "c1", status: "pending" },
        { id: crypto.randomUUID(), type: "a", conversation_id: "c1", status: "pending" },
        { id: crypto.randomUUID(), type: "a", conversation_id: "c1", status: "completed" },
        { id: crypto.randomUUID(), type: "a", conversation_id: "c1", status: "failed" },
      ])
      .execute();

    const status = await getQueue().getStatus();
    expect(status).toEqual({
      pending: 2,
      running: 0,
      completed: 1,
      failed: 1,
      dead_letter: 0,
    });
  });
});

describe("scheduleNextWakeup", () => {
  const { getDb, getManager, getQueue } = setupQueue();

  it("schedules a wakeup timer for future pending jobs", async () => {
    getManager().runObserver.mockRejectedValue(new Error("boom"));
    await getQueue().enqueue("observer", "conv-1");
    await getQueue().start();

    await new Promise((r) => setTimeout(r, 30));
    expect(getManager().runObserver).toHaveBeenCalledTimes(1);

    getQueue().stop();

    const row = await getDb()
      .selectFrom("pipeline_jobs")
      .select(["status", "next_attempt_at"])
      .executeTakeFirst();
    expect(row!.status).toBe("pending");

    const nextAttempt = new Date(row!.next_attempt_at!).getTime();
    expect(nextAttempt).toBeGreaterThan(Date.now());
  });
});
