package main

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type PriceRow struct {
	Symbol    string
	Name      string
	PriceUSD  float64
	MarketCap sql.NullFloat64
	Volume24h sql.NullFloat64
	Change24h sql.NullFloat64
	Change7d  sql.NullFloat64
	CapturedAt string
}

type NewsRow struct {
	Title           string
	Source          string
	PublishedAt     string
	TokensMentioned sql.NullString
	MemoryID        sql.NullString
}

type SignalRow struct {
	Symbol     string
	SignalType string
	Confidence float64
	Reasoning  string
	CreatedAt  string
}

type GraphRow struct {
	SourceLabel string
	Relation    string
	TargetLabel string
	Weight      float64
}

type Stats struct {
	Memories int
	Nodes    int
	Edges    int
	Signals  int
	News     int
}

type CortexDB struct {
	db *sql.DB
}

func OpenDB(path string) (*CortexDB, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro&_journal_mode=WAL", path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return &CortexDB{db: db}, nil
}

func (c *CortexDB) Close() error {
	return c.db.Close()
}

func (c *CortexDB) GetPrices() ([]PriceRow, error) {
	rows, err := c.db.Query(`
		SELECT t.symbol, t.name, p.price_usd, p.market_cap, p.volume_24h,
		       p.change_24h, p.change_7d, p.captured_at
		FROM price_snapshots p
		JOIN tracked_tokens t ON t.id = p.token_id
		WHERE p.captured_at = (
			SELECT MAX(p2.captured_at) FROM price_snapshots p2 WHERE p2.token_id = p.token_id
		)
		ORDER BY p.price_usd DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []PriceRow
	for rows.Next() {
		var r PriceRow
		if err := rows.Scan(&r.Symbol, &r.Name, &r.PriceUSD, &r.MarketCap, &r.Volume24h,
			&r.Change24h, &r.Change7d, &r.CapturedAt); err != nil {
			continue
		}
		result = append(result, r)
	}
	return result, nil
}

func (c *CortexDB) GetSparkline(symbol string) ([]float64, error) {
	rows, err := c.db.Query(`
		SELECT price_usd FROM price_snapshots
		WHERE token_id = (SELECT id FROM tracked_tokens WHERE symbol = ?)
		  AND captured_at > datetime('now', '-24 hours')
		ORDER BY captured_at`, symbol)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var data []float64
	for rows.Next() {
		var v float64
		if err := rows.Scan(&v); err != nil {
			continue
		}
		data = append(data, v)
	}
	return data, nil
}

func (c *CortexDB) GetNews() ([]NewsRow, error) {
	rows, err := c.db.Query(`
		SELECT title, source, published_at, tokens_mentioned, memory_id
		FROM news_items ORDER BY published_at DESC LIMIT 30`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []NewsRow
	for rows.Next() {
		var r NewsRow
		if err := rows.Scan(&r.Title, &r.Source, &r.PublishedAt, &r.TokensMentioned, &r.MemoryID); err != nil {
			continue
		}
		result = append(result, r)
	}
	return result, nil
}

func (c *CortexDB) GetSignals() ([]SignalRow, error) {
	rows, err := c.db.Query(`
		SELECT t.symbol, s.signal_type, s.confidence, s.reasoning, s.created_at
		FROM signals s
		JOIN tracked_tokens t ON t.id = s.token_id
		ORDER BY s.created_at DESC LIMIT 20`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []SignalRow
	for rows.Next() {
		var r SignalRow
		if err := rows.Scan(&r.Symbol, &r.SignalType, &r.Confidence, &r.Reasoning, &r.CreatedAt); err != nil {
			continue
		}
		result = append(result, r)
	}
	return result, nil
}

func (c *CortexDB) GetGraph() ([]GraphRow, error) {
	rows, err := c.db.Query(`
		SELECT gn.display_name, ge.relation, gn2.display_name, ge.weight
		FROM graph_edges ge
		JOIN graph_nodes gn ON gn.id = ge.source_id
		JOIN graph_nodes gn2 ON gn2.id = ge.target_id
		ORDER BY ge.weight DESC LIMIT 30`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []GraphRow
	for rows.Next() {
		var r GraphRow
		if err := rows.Scan(&r.SourceLabel, &r.Relation, &r.TargetLabel, &r.Weight); err != nil {
			continue
		}
		result = append(result, r)
	}
	return result, nil
}

func (c *CortexDB) GetStats() (Stats, error) {
	var s Stats
	err := c.db.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM memories WHERE archived_at IS NULL),
			(SELECT COUNT(*) FROM graph_nodes),
			(SELECT COUNT(*) FROM graph_edges),
			(SELECT COUNT(*) FROM signals),
			(SELECT COUNT(*) FROM news_items)`).Scan(&s.Memories, &s.Nodes, &s.Edges, &s.Signals, &s.News)
	return s, err
}

func (c *CortexDB) GetTokenSymbols() ([]string, error) {
	rows, err := c.db.Query("SELECT symbol FROM tracked_tokens WHERE active = 1")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			continue
		}
		result = append(result, s)
	}
	return result, nil
}

func TimeAgo(iso string) string {
	layouts := []string{
		"2006-01-02T15:04:05.999999999Z",
		"2006-01-02T15:04:05Z",
		"2006-01-02 15:04:05",
	}
	var t time.Time
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, iso); err == nil {
			t = parsed
			break
		}
	}
	if t.IsZero() {
		return "?"
	}
	diff := time.Since(t)
	mins := int(diff.Minutes())
	if mins < 60 {
		return fmt.Sprintf("%dm", mins)
	}
	hours := mins / 60
	if hours < 24 {
		return fmt.Sprintf("%dh", hours)
	}
	return fmt.Sprintf("%dd", hours/24)
}
