import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('messages')
    .addColumn('telegram_message_id', 'integer')
    .execute()

  await db.schema
    .createIndex('idx_messages_telegram_message_id')
    .on('messages')
    .column('telegram_message_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex('idx_messages_telegram_message_id')
    .execute()

  await db.schema
    .alterTable('messages')
    .dropColumn('telegram_message_id')
    .execute()
}
