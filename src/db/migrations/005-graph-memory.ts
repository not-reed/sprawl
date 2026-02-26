import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('graph_nodes')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('display_name', 'text', (col) => col.notNull())
    .addColumn('node_type', 'text', (col) => col.notNull().defaultTo('entity'))
    .addColumn('description', 'text')
    .addColumn('embedding', 'text')
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .addColumn('updated_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createIndex('idx_gn_name_type')
    .on('graph_nodes')
    .columns(['name', 'node_type'])
    .unique()
    .execute()

  await db.schema
    .createTable('graph_edges')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('source_id', 'text', (col) =>
      col.notNull().references('graph_nodes.id'),
    )
    .addColumn('target_id', 'text', (col) =>
      col.notNull().references('graph_nodes.id'),
    )
    .addColumn('relation', 'text', (col) => col.notNull())
    .addColumn('weight', 'real', (col) => col.defaultTo(1.0))
    .addColumn('properties', 'text')
    .addColumn('memory_id', 'text', (col) => col.references('memories.id'))
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .addColumn('updated_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createIndex('idx_ge_source')
    .on('graph_edges')
    .column('source_id')
    .execute()

  await db.schema
    .createIndex('idx_ge_target')
    .on('graph_edges')
    .column('target_id')
    .execute()

  await db.schema
    .createIndex('idx_ge_unique')
    .on('graph_edges')
    .columns(['source_id', 'target_id', 'relation'])
    .unique()
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('graph_edges').execute()
  await db.schema.dropTable('graph_nodes').execute()
}
