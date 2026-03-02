use anyhow::Result;
use rusqlite::Connection;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PriceRow {
    pub symbol: String,
    pub name: String,
    pub price_usd: f64,
    pub market_cap: Option<f64>,
    pub volume_24h: Option<f64>,
    pub change_24h: Option<f64>,
    pub change_7d: Option<f64>,
    pub captured_at: String,
}

#[derive(Debug, Clone)]
pub struct NewsRow {
    pub title: String,
    pub url: Option<String>,
    pub source: String,
    pub published_at: String,
    pub tokens_mentioned: Option<String>,
    pub memory_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SignalRow {
    pub symbol: String,
    pub signal_type: String,
    pub confidence: f64,
    pub reasoning: String,
    pub timeframe: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct GraphRow {
    pub source_label: String,
    pub relation: String,
    pub target_label: String,
    pub weight: f64,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct CommandRow {
    pub id: String,
    pub command: String,
    pub completed_at: Option<String>,
    pub created_at: String,
}

/// Chart data for a token: (x, y) points + price bounds
#[derive(Debug, Clone)]
pub struct ChartData {
    pub points: Vec<(f64, f64)>,
    pub min_price: f64,
    pub max_price: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Stats {
    pub memories: u64,
    pub nodes: u64,
    pub edges: u64,
    pub signals: u64,
    pub news: u64,
}

pub struct CortexDb {
    read_conn: Connection,
    write_conn: Connection,
}

impl CortexDb {
    pub fn open(path: &str) -> Result<Self> {
        let read_conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        read_conn.pragma_update(None, "journal_mode", "WAL")?;

        let write_conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        write_conn.pragma_update(None, "journal_mode", "WAL")?;

        Ok(Self { read_conn, write_conn })
    }

    pub fn get_prices(&self) -> Result<Vec<PriceRow>> {
        // Compute 24h/7d change from stored snapshots rather than relying on API fields
        let mut stmt = self.read_conn.prepare(
            "SELECT t.symbol, t.name, p.price_usd, p.market_cap, p.volume_24h,
                    p.captured_at,
                    (SELECT p24.price_usd FROM price_snapshots p24
                     WHERE p24.token_id = p.token_id
                       AND p24.captured_at <= datetime('now', '-23 hours')
                     ORDER BY p24.captured_at DESC LIMIT 1) as price_24h_ago,
                    (SELECT p7d.price_usd FROM price_snapshots p7d
                     WHERE p7d.token_id = p.token_id
                       AND p7d.captured_at <= datetime('now', '-6 days')
                     ORDER BY p7d.captured_at DESC LIMIT 1) as price_7d_ago
             FROM price_snapshots p
             JOIN tracked_tokens t ON t.id = p.token_id
             WHERE p.captured_at = (
               SELECT MAX(p2.captured_at) FROM price_snapshots p2 WHERE p2.token_id = p.token_id
             )
             ORDER BY p.price_usd DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let price_usd: f64 = row.get(2)?;
            let price_24h_ago: Option<f64> = row.get(6)?;
            let price_7d_ago: Option<f64> = row.get(7)?;
            Ok(PriceRow {
                symbol: row.get(0)?,
                name: row.get(1)?,
                price_usd,
                market_cap: row.get(3)?,
                volume_24h: row.get(4)?,
                change_24h: price_24h_ago.map(|old| (price_usd - old) / old * 100.0),
                change_7d: price_7d_ago.map(|old| (price_usd - old) / old * 100.0),
                captured_at: row.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_chart_data(&self, symbol: &str) -> Result<ChartData> {
        let mut stmt = self.read_conn.prepare(
            "SELECT price_usd FROM price_snapshots
             WHERE token_id = (SELECT id FROM tracked_tokens WHERE symbol = ?1)
               AND captured_at > datetime('now', '-24 hours')
             ORDER BY captured_at",
        )?;
        let prices: Vec<f64> = stmt
            .query_map([symbol], |row| row.get::<_, f64>(0))?
            .filter_map(|r| r.ok())
            .collect();

        if prices.is_empty() {
            return Ok(ChartData {
                points: vec![],
                min_price: 0.0,
                max_price: 0.0,
            });
        }

        let min_price = prices.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_price = prices.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        let points: Vec<(f64, f64)> = prices
            .iter()
            .enumerate()
            .map(|(i, &p)| (i as f64, p))
            .collect();

        Ok(ChartData {
            points,
            min_price,
            max_price,
        })
    }

    pub fn get_news(&self) -> Result<Vec<NewsRow>> {
        let mut stmt = self.read_conn.prepare(
            "SELECT title, url, source, published_at, tokens_mentioned, memory_id
             FROM news_items ORDER BY published_at DESC LIMIT 50",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(NewsRow {
                title: row.get(0)?,
                url: row.get(1)?,
                source: row.get(2)?,
                published_at: row.get(3)?,
                tokens_mentioned: row.get(4)?,
                memory_id: row.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_signals(&self) -> Result<Vec<SignalRow>> {
        // Latest signal per (token, timeframe)
        let mut stmt = self.read_conn.prepare(
            "SELECT t.symbol, s.signal_type, s.confidence, s.reasoning,
                    COALESCE(s.timeframe, 'short'), s.created_at
             FROM signals s
             JOIN tracked_tokens t ON t.id = s.token_id
             WHERE s.created_at = (
               SELECT MAX(s2.created_at) FROM signals s2
               WHERE s2.token_id = s.token_id
                 AND COALESCE(s2.timeframe, 'short') = COALESCE(s.timeframe, 'short')
             )
             ORDER BY t.symbol, s.timeframe",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SignalRow {
                symbol: row.get(0)?,
                signal_type: row.get(1)?,
                confidence: row.get(2)?,
                reasoning: row.get(3)?,
                timeframe: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_graph(&self) -> Result<Vec<GraphRow>> {
        let mut stmt = self.read_conn.prepare(
            "SELECT gn.display_name, ge.relation, gn2.display_name, ge.weight, ge.updated_at
             FROM graph_edges ge
             JOIN graph_nodes gn ON gn.id = ge.source_id
             JOIN graph_nodes gn2 ON gn2.id = ge.target_id
             WHERE ge.weight > 1.0
             ORDER BY ge.updated_at DESC, ge.weight DESC
             LIMIT 30",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(GraphRow {
                source_label: row.get(0)?,
                relation: row.get(1)?,
                target_label: row.get(2)?,
                weight: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_stats(&self) -> Result<Stats> {
        let mut stmt = self.read_conn.prepare(
            "SELECT
               (SELECT COUNT(*) FROM memories WHERE archived_at IS NULL),
               (SELECT COUNT(*) FROM graph_nodes),
               (SELECT COUNT(*) FROM graph_edges),
               (SELECT COUNT(*) FROM signals),
               (SELECT COUNT(*) FROM news_items)",
        )?;
        stmt.query_row([], |row| {
            Ok(Stats {
                memories: row.get::<_, i64>(0)? as u64,
                nodes: row.get::<_, i64>(1)? as u64,
                edges: row.get::<_, i64>(2)? as u64,
                signals: row.get::<_, i64>(3)? as u64,
                news: row.get::<_, i64>(4)? as u64,
            })
        })
        .map_err(Into::into)
    }

    pub fn get_token_symbols(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .read_conn
            .prepare("SELECT symbol FROM tracked_tokens WHERE active = 1")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ── Command Queue ───────────────────────────────────────────────────

    pub fn insert_command(&self, command: &str) -> Result<()> {
        let id = format!("{:016x}", rand_id());
        self.write_conn.execute(
            "INSERT INTO commands (id, command) VALUES (?1, ?2)",
            rusqlite::params![id, command],
        )?;
        Ok(())
    }

    pub fn get_recent_commands(&self) -> Result<Vec<CommandRow>> {
        let mut stmt = self.read_conn.prepare(
            "SELECT id, command, completed_at, created_at
             FROM commands ORDER BY created_at DESC LIMIT 5",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CommandRow {
                id: row.get(0)?,
                command: row.get(1)?,
                completed_at: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

fn rand_id() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // Mix in some bits for uniqueness
    (nanos as u64) ^ (nanos.wrapping_shr(64) as u64)
}

// ── Synapse DB (read-only) ──────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PortfolioRow {
    pub cash_usd: f64,
    pub total_value_usd: f64,
    pub high_water_mark_usd: f64,
    pub drawdown_pct: f64,
    pub halted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct PositionRow {
    pub token_symbol: String,
    pub direction: String,
    pub entry_price_usd: f64,
    pub current_price_usd: f64,
    pub size_usd: f64,
    pub unrealized_pnl_usd: f64,
    pub stop_loss_price: f64,
    pub take_profit_price: f64,
    pub opened_at: String,
}

#[derive(Debug, Clone)]
pub struct TradeRow {
    pub token_symbol: String,
    pub direction: String,
    pub price_usd: f64,
    pub size_usd: f64,
    pub gas_usd: f64,
    pub executed_at: String,
}

#[derive(Debug, Clone)]
pub struct SignalLogRow {
    pub token_id: String,
    pub signal_type: String,
    pub confidence: f64,
    pub action: String,
    pub skip_reason: Option<String>,
    pub processed_at: String,
}

#[derive(Debug, Clone)]
pub struct RiskEventRow {
    pub event_type: String,
    pub details: String,
    pub created_at: String,
}

pub struct SynapseDb {
    conn: Connection,
}

impl SynapseDb {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Ok(Self { conn })
    }

    pub fn get_portfolio(&self) -> Result<Option<PortfolioRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT cash_usd, total_value_usd, high_water_mark_usd, drawdown_pct, halted, updated_at
             FROM portfolio_state WHERE id = 1",
        )?;
        let row = stmt
            .query_row([], |row| {
                Ok(PortfolioRow {
                    cash_usd: row.get(0)?,
                    total_value_usd: row.get(1)?,
                    high_water_mark_usd: row.get(2)?,
                    drawdown_pct: row.get(3)?,
                    halted: row.get::<_, i64>(4)? != 0,
                    updated_at: row.get(5)?,
                })
            })
            .ok();
        Ok(row)
    }

    pub fn get_open_positions(&self) -> Result<Vec<PositionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT token_symbol, direction, entry_price_usd, current_price_usd,
                    size_usd, unrealized_pnl_usd, stop_loss_price, take_profit_price, opened_at
             FROM positions WHERE closed_at IS NULL
             ORDER BY size_usd DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PositionRow {
                token_symbol: row.get(0)?,
                direction: row.get(1)?,
                entry_price_usd: row.get(2)?,
                current_price_usd: row.get(3)?,
                size_usd: row.get(4)?,
                unrealized_pnl_usd: row.get(5)?,
                stop_loss_price: row.get(6)?,
                take_profit_price: row.get(7)?,
                opened_at: row.get(8)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_recent_trades(&self, limit: u32) -> Result<Vec<TradeRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.token_symbol, t.direction, t.price_usd, t.size_usd, t.gas_usd, t.executed_at
             FROM trades t
             JOIN positions p ON p.id = t.position_id
             ORDER BY t.executed_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |row| {
            Ok(TradeRow {
                token_symbol: row.get(0)?,
                direction: row.get(1)?,
                price_usd: row.get(2)?,
                size_usd: row.get(3)?,
                gas_usd: row.get(4)?,
                executed_at: row.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_recent_signal_log(&self, limit: u32) -> Result<Vec<SignalLogRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT token_id, signal_type, confidence, action, skip_reason, processed_at
             FROM signal_log
             ORDER BY processed_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |row| {
            Ok(SignalLogRow {
                token_id: row.get(0)?,
                signal_type: row.get(1)?,
                confidence: row.get(2)?,
                action: row.get(3)?,
                skip_reason: row.get(4)?,
                processed_at: row.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_recent_risk_events(&self, limit: u32) -> Result<Vec<RiskEventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT event_type, details, created_at
             FROM risk_events
             ORDER BY created_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |row| {
            Ok(RiskEventRow {
                event_type: row.get(0)?,
                details: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}
