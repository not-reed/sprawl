import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('memories')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('category', 'text', (col) => col.notNull().defaultTo('general'))
    .addColumn('tags', 'text')
    .addColumn('source', 'text', (col) => col.notNull().defaultTo('user'))
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .addColumn('updated_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .addColumn('archived_at', 'text')
    .execute()

  await db.schema
    .createTable('conversations')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('external_id', 'text')
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .addColumn('updated_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createTable('messages')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('conversation_id', 'text', (col) =>
      col.notNull().references('conversations.id'),
    )
    .addColumn('role', 'text', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('tool_calls', 'text')
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createTable('schedules')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('description', 'text', (col) => col.notNull())
    .addColumn('cron_expression', 'text')
    .addColumn('run_at', 'text')
    .addColumn('message', 'text', (col) => col.notNull())
    .addColumn('chat_id', 'text', (col) => col.notNull())
    .addColumn('active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('last_run_at', 'text')
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createTable('ai_usage')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('model', 'text', (col) => col.notNull())
    .addColumn('input_tokens', 'integer')
    .addColumn('output_tokens', 'integer')
    .addColumn('cost_usd', 'real')
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createTable('settings')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  // Indexes for common queries
  await db.schema
    .createIndex('idx_memories_category')
    .on('memories')
    .column('category')
    .execute()

  await db.schema
    .createIndex('idx_memories_archived')
    .on('memories')
    .column('archived_at')
    .execute()

  await db.schema
    .createIndex('idx_messages_conversation')
    .on('messages')
    .column('conversation_id')
    .execute()

  await db.schema
    .createIndex('idx_conversations_external')
    .on('conversations')
    .column('external_id')
    .execute()

  await db.schema
    .createIndex('idx_schedules_active')
    .on('schedules')
    .column('active')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('settings').execute()
  await db.schema.dropTable('ai_usage').execute()
  await db.schema.dropTable('schedules').execute()
  await db.schema.dropTable('messages').execute()
  await db.schema.dropTable('conversations').execute()
  await db.schema.dropTable('memories').execute()
}
