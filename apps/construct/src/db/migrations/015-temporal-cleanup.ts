import { type Kysely, sql } from "kysely";

/**
 * Expire observations with stale relative weekend references.
 *
 * Problem: the LLM observer previously left "this weekend" / "next weekend"
 * unresolved in observation content. When surfaced days or weeks later, the
 * agent would interpret those phrases relative to *today* instead of the
 * observation_date, causing temporal mismatches (e.g. surfacing a past
 * weekend plan as a current one).
 *
 * Fix: set expires_at = observation_date for all active observations that
 * contain unresolved weekend references and whose observation_date has
 * already passed. This hides them from future context. The observer prompt
 * has been updated to resolve weekend references going forward.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE observations
    SET expires_at = observation_date
    WHERE superseded_at IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND observation_date < date('now')
      AND (
        content LIKE '%this weekend%'
        OR content LIKE '%next weekend%'
        OR content LIKE '%this past weekend%'
      )
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Additive-only — no-op
}
