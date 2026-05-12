interface QueueEntry {
  pending: Promise<void>;
  depth: number;
}

export class ChatQueueManager {
  private chatQueues = new Map<string, QueueEntry>();
  private replyToActive = new Set<string>();

  enqueue(chatId: string, fn: () => Promise<void>): Promise<void> {
    const entry = this.chatQueues.get(chatId);
    const prev = entry?.pending ?? Promise.resolve();
    const depth = (entry?.depth ?? 0) + 1;
    const next = prev.then(fn, fn);
    this.chatQueues.set(chatId, { pending: next, depth });
    const cleanup = () => {
      const cur = this.chatQueues.get(chatId);
      if (cur) {
        cur.depth--;
        if (cur.depth <= 0) {
          this.chatQueues.delete(chatId);
          this.replyToActive.delete(chatId);
        }
      }
    };
    // Use .then instead of .finally so the cleanup promise resolves
    // rather than re-propagating rejections as unhandled.
    next.then(cleanup, cleanup);
    return next;
  }

  /** True if a reply-to thread should be added to the response. Activates when queue depth > 1. */
  shouldReplyTo(chatId: string): boolean {
    const depth = this.chatQueues.get(chatId)?.depth ?? 0;
    if (depth > 1) this.replyToActive.add(chatId);
    return this.replyToActive.has(chatId);
  }
}
