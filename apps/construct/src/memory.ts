import {
  MemoryManager,
  type ObserverOutput,
  type CairnMessage,
  estimateTokens,
  DEFAULT_OBSERVER_PROMPT,
  DEFAULT_REFLECTOR_PROMPT,
} from "@repo/cairn";
import type { Observation } from "@repo/cairn";
import { sql } from "kysely";
import { nanoid } from "nanoid";

// --- Custom observer prompt with expires_at extraction ---

export const CONSTRUCT_OBSERVER_PROMPT = DEFAULT_OBSERVER_PROMPT.replace(
  "## Output Format",
  `## Temporal Expiry

For time-bound tasks, events, or reminders, include expires_at (ISO datetime, local timezone, no offset):
- "Take garbage out before 2pm" on 2025-03-08 → expires_at: "2025-03-08T14:00:00"
- "Meeting at 3pm tomorrow" on 2025-03-08 → expires_at: "2025-03-09T16:00:00" (pad ~1hr after)
- "Dinner on Sunday" on 2025-03-08 (Saturday) → expires_at: "2025-03-09T23:59:00"
Ongoing facts ("User lives in Portland") have no expiry — omit expires_at entirely.
Single-occurrence events must include the specific date in content AND set expires_at.

## Output Format`,
).replace(
  // Update example to show optional expires_at
  `    {
      "content": "User scheduled a dentist appointment for 2025-03-05 at 9am",
      "priority": "high",
      "observation_date": "2025-01-15"
    },`,
  `    {
      "content": "User scheduled a dentist appointment for 2025-03-05 at 9am",
      "priority": "high",
      "observation_date": "2025-01-15",
      "expires_at": "2025-03-05T10:00:00"
    },`,
);

// --- Custom reflector prompt with expires_at preservation ---

export const CONSTRUCT_REFLECTOR_PROMPT = DEFAULT_REFLECTOR_PROMPT.replace(
  "## Temporal Handling",
  `## Temporal Expiry

Preserve expires_at on observations that have one. When merging, keep the earliest expires_at.
If an observation's expires_at is in the past, it may be dropped regardless of priority.

## Temporal Handling`,
);

/** Message shape with construct-specific telegram_message_id. */
export interface ConstructMessage extends CairnMessage {
  telegram_message_id: number | null;
}

/**
 * Construct-specific MemoryManager that adds expires_at support
 * and includes telegram_message_id in message queries.
 */
export class ConstructMemoryManager extends MemoryManager {
  override async getUnobservedMessages(conversationId: string): Promise<ConstructMessage[]> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["observed_up_to_message_id", "observation_token_count"])
      .where("id", "=", conversationId)
      .executeTakeFirst();

    const watermarkId = conv?.observed_up_to_message_id;

    if (watermarkId) {
      const rows = await sql<ConstructMessage>`
        SELECT id, conversation_id, role, content, created_at, telegram_message_id
        FROM messages
        WHERE conversation_id = ${conversationId}
          AND rowid > (SELECT rowid FROM messages WHERE id = ${watermarkId})
        ORDER BY rowid ASC
      `.execute(this.db);
      return rows.rows;
    }

    const rows = await sql<ConstructMessage>`
      SELECT id, conversation_id, role, content, created_at, telegram_message_id
      FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at ASC
    `.execute(this.db);
    return rows.rows;
  }

  override async getActiveObservations(conversationId: string): Promise<Observation[]> {
    // Use raw SQL to filter on expires_at (construct-specific column not in cairn's schema)
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM observations
      WHERE conversation_id = ${conversationId}
        AND superseded_at IS NULL
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at ASC
    `.execute(this.db);

    return rows.rows.map((r) => ({
      id: r.id as string,
      conversation_id: r.conversation_id as string,
      content: r.content as string,
      priority: r.priority as Observation["priority"],
      observation_date: r.observation_date as string,
      source_message_ids: r.source_message_ids ? JSON.parse(r.source_message_ids as string) : [],
      token_count: (r.token_count as number) ?? 0,
      generation: (r.generation as number) ?? 0,
      superseded_at: r.superseded_at as string | null,
      created_at: r.created_at as string,
    }));
  }

  protected override async storeObservation(
    conversationId: string,
    obs: ObserverOutput["observations"][0],
    messageIds: string[] | null,
    generation: number,
  ): Promise<void> {
    // Use raw SQL to write expires_at (construct-specific column)
    const id = nanoid();
    const expiresAt = (obs.expires_at as string | undefined) ?? null;
    await sql`
      INSERT INTO observations (id, conversation_id, content, priority, observation_date, source_message_ids, token_count, generation, expires_at)
      VALUES (${id}, ${conversationId}, ${obs.content}, ${obs.priority}, ${obs.observation_date}, ${messageIds ? JSON.stringify(messageIds) : null}, ${estimateTokens(obs.content)}, ${generation}, ${expiresAt})
    `.execute(this.db);
  }
}
