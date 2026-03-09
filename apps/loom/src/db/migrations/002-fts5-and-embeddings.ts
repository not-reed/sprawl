import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      content,
      tags,
      category UNINDEXED,
      content=memories,
      content_rowid=rowid
    )
  `.execute(db)

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, id, content, tags, category)
      VALUES (NEW.rowid, NEW.id, NEW.content, NEW.tags, NEW.category);
    END
  `.execute(db)

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, content, tags, category)
      VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.tags, OLD.category);
    END
  `.execute(db)

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, content, tags, category)
      VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.tags, OLD.category);
      INSERT INTO memories_fts(rowid, id, content, tags, category)
      VALUES (NEW.rowid, NEW.id, NEW.content, NEW.tags, NEW.category);
    END
  `.execute(db)

  await sql`
    INSERT INTO memories_fts(rowid, id, content, tags, category)
    SELECT rowid, id, content, tags, category FROM memories
  `.execute(db)

  await db.schema
    .alterTable('memories')
    .addColumn('embedding', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS memories_au`.execute(db)
  await sql`DROP TRIGGER IF EXISTS memories_ad`.execute(db)
  await sql`DROP TRIGGER IF EXISTS memories_ai`.execute(db)
  await sql`DROP TABLE IF EXISTS memories_fts`.execute(db)
}
