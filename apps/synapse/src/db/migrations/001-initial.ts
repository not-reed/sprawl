import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // portfolio_state — singleton row
  await db.schema
    .createTable('portfolio_state')
    .addColumn('id', 'integer', (col) => col.primaryKey().defaultTo(1))
    .addColumn('cash_usd', 'real', (col) => col.notNull())
    .addColumn('total_value_usd', 'real', (col) => col.notNull())
    .addColumn('high_water_mark_usd', 'real', (col) => col.notNull())
    .addColumn('drawdown_pct', 'real', (col) => col.notNull().defaultTo(0))
    .addColumn('halted', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('updated_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  // positions
  await db.schema
    .createTable('positions')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('token_id', 'text', (col) => col.notNull())
    .addColumn('token_symbol', 'text', (col) => col.notNull())
    .addColumn('direction', 'text', (col) => col.notNull().defaultTo('long'))
    .addColumn('quantity', 'real', (col) => col.notNull())
    .addColumn('entry_price_usd', 'real', (col) => col.notNull())
    .addColumn('current_price_usd', 'real', (col) => col.notNull())
    .addColumn('size_usd', 'real', (col) => col.notNull())
    .addColumn('unrealized_pnl_usd', 'real', (col) => col.notNull().defaultTo(0))
    .addColumn('realized_pnl_usd', 'real', (col) => col.notNull().defaultTo(0))
    .addColumn('stop_loss_price', 'real', (col) => col.notNull())
    .addColumn('take_profit_price', 'real', (col) => col.notNull())
    .addColumn('signal_id', 'text', (col) => col.notNull())
    .addColumn('opened_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .addColumn('closed_at', 'text')
    .execute()

  await db.schema
    .createIndex('idx_positions_token')
    .on('positions')
    .column('token_id')
    .execute()

  await db.schema
    .createIndex('idx_positions_open')
    .on('positions')
    .column('closed_at')
    .execute()

  // trades
  await db.schema
    .createTable('trades')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('position_id', 'text', (col) =>
      col.notNull().references('positions.id'),
    )
    .addColumn('signal_id', 'text', (col) => col.notNull())
    .addColumn('token_id', 'text', (col) => col.notNull())
    .addColumn('direction', 'text', (col) => col.notNull())
    .addColumn('quantity', 'real', (col) => col.notNull())
    .addColumn('price_usd', 'real', (col) => col.notNull())
    .addColumn('size_usd', 'real', (col) => col.notNull())
    .addColumn('gas_usd', 'real', (col) => col.notNull())
    .addColumn('slippage_bps', 'integer', (col) => col.notNull())
    .addColumn('executed_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createIndex('idx_trades_position')
    .on('trades')
    .column('position_id')
    .execute()

  // snapshots
  await db.schema
    .createTable('snapshots')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('cash_usd', 'real', (col) => col.notNull())
    .addColumn('positions_value_usd', 'real', (col) => col.notNull())
    .addColumn('total_value_usd', 'real', (col) => col.notNull())
    .addColumn('drawdown_pct', 'real', (col) => col.notNull())
    .addColumn('open_position_count', 'integer', (col) => col.notNull())
    .addColumn('captured_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  // signal_log
  await db.schema
    .createTable('signal_log')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('cortex_signal_id', 'text', (col) => col.notNull().unique())
    .addColumn('token_id', 'text', (col) => col.notNull())
    .addColumn('signal_type', 'text', (col) => col.notNull())
    .addColumn('confidence', 'real', (col) => col.notNull())
    .addColumn('timeframe', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('skip_reason', 'text')
    .addColumn('processed_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createIndex('idx_signal_log_cortex_id')
    .on('signal_log')
    .column('cortex_signal_id')
    .execute()

  // risk_events
  await db.schema
    .createTable('risk_events')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('details', 'text', (col) => col.notNull())
    .addColumn('position_id', 'text')
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('risk_events').execute()
  await db.schema.dropTable('signal_log').execute()
  await db.schema.dropTable('snapshots').execute()
  await db.schema.dropTable('trades').execute()
  await db.schema.dropTable('positions').execute()
  await db.schema.dropTable('portfolio_state').execute()
}
