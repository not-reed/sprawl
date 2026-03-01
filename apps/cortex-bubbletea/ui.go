package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"image/color"
	"math"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// Panels
type panel int

const (
	panelPrices panel = iota
	panelNews
	panelSignals
	panelGraph
	panelCount
)

// Messages
type tickMsg time.Time
type refreshMsg struct {
	prices     []PriceRow
	sparklines map[string][]float64
	news       []NewsRow
	signals    []SignalRow
	graph      []GraphRow
	stats      Stats
}

// Model
type Model struct {
	db           *CortexDB
	focused      panel
	scrollOffset [panelCount]int
	width        int
	height       int
	prices       []PriceRow
	sparklines   map[string][]float64
	news         []NewsRow
	signals      []SignalRow
	graph        []GraphRow
	stats        Stats
	lastRefresh  time.Time
}

func NewModel(db *CortexDB) Model {
	return Model{
		db:         db,
		sparklines: make(map[string][]float64),
	}
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		m.doRefresh(),
		m.tickCmd(),
	)
}

func (m Model) tickCmd() tea.Cmd {
	return tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m Model) doRefresh() tea.Cmd {
	return func() tea.Msg {
		msg := refreshMsg{
			sparklines: make(map[string][]float64),
		}
		msg.prices, _ = m.db.GetPrices()
		msg.news, _ = m.db.GetNews()
		msg.signals, _ = m.db.GetSignals()
		msg.graph, _ = m.db.GetGraph()
		msg.stats, _ = m.db.GetStats()

		symbols, _ := m.db.GetTokenSymbols()
		for _, sym := range symbols {
			if data, err := m.db.GetSparkline(sym); err == nil && len(data) > 0 {
				msg.sparklines[sym] = data
			}
		}
		return msg
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "r":
			return m, m.doRefresh()
		case "tab":
			m.focused = (m.focused + 1) % panelCount
			return m, nil
		case "j", "down":
			m.scrollOffset[m.focused]++
			return m, nil
		case "k", "up":
			if m.scrollOffset[m.focused] > 0 {
				m.scrollOffset[m.focused]--
			}
			return m, nil
		}

	case tickMsg:
		return m, tea.Batch(m.doRefresh(), m.tickCmd())

	case refreshMsg:
		m.prices = msg.prices
		m.sparklines = msg.sparklines
		m.news = msg.news
		m.signals = msg.signals
		m.graph = msg.graph
		m.stats = msg.stats
		m.lastRefresh = time.Now()
		return m, nil
	}
	return m, nil
}

func (m Model) View() tea.View {
	v := tea.NewView("")
	v.AltScreen = true

	if m.width == 0 || m.height == 0 {
		v.SetContent("Loading...")
		return v
	}

	leftW := m.width * 45 / 100
	rightW := m.width - leftW - 1

	priceH := min(len(m.prices)+4, 12)
	sparkH := 5
	statusH := 3
	mainH := m.height - statusH
	newsH := max(3, mainH-priceH-sparkH)
	sigH := mainH * 45 / 100
	graphH := mainH - sigH

	priceView := m.renderPrices(leftW, priceH)
	sparkView := m.renderSparklines(leftW, sparkH)
	newsView := m.renderNews(leftW, newsH)
	sigView := m.renderSignals(rightW, sigH)
	graphView := m.renderGraph(rightW, graphH)
	statusView := m.renderStatus(m.width, statusH)

	left := lipgloss.JoinVertical(lipgloss.Left, priceView, sparkView, newsView)
	right := lipgloss.JoinVertical(lipgloss.Left, sigView, graphView)
	body := lipgloss.JoinHorizontal(lipgloss.Top, left, " ", right)

	v.SetContent(lipgloss.JoinVertical(lipgloss.Left, body, statusView))
	return v
}

// Style helpers
func borderStyle(p panel, focused panel, title string, w, h int) lipgloss.Style {
	color := lipgloss.Color("240")
	if p == focused {
		switch p {
		case panelPrices:
			color = lipgloss.Color("6") // cyan
		case panelNews:
			color = lipgloss.Color("3") // yellow
		case panelSignals:
			color = lipgloss.Color("2") // green
		case panelGraph:
			color = lipgloss.Color("5") // magenta
		}
	}
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(color).
		Width(w - 2).
		Height(h - 2).
		Padding(0, 1)
}

func (m Model) renderPrices(w, h int) string {
	style := borderStyle(panelPrices, m.focused, "Prices", w, h)
	header := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("6")).
		Render("SYMBOL    PRICE        24H      7D      VOLUME")

	var lines []string
	lines = append(lines, header)
	for _, p := range m.prices {
		pct24 := formatPctGo(p.Change24h)
		pct7d := formatPctGo(p.Change7d)
		line := fmt.Sprintf("%-8s %12s %8s %8s  %s",
			p.Symbol, formatUsdGo(p.PriceUSD), pct24, pct7d, formatVolumeGo(p.Volume24h))
		lines = append(lines, line)
	}
	return style.Render(strings.Join(lines, "\n"))
}

func (m Model) renderSparklines(w, h int) string {
	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("6")).
		Width(w - 2).
		Height(h - 2).
		Padding(0, 1)

	sparkChars := []rune("▁▂▃▄▅▆▇█")
	var lines []string
	for sym, data := range m.sparklines {
		if len(data) == 0 {
			continue
		}
		minV, maxV := data[0], data[0]
		for _, v := range data {
			if v < minV {
				minV = v
			}
			if v > maxV {
				maxV = v
			}
		}
		rng := maxV - minV
		if rng == 0 {
			rng = 1
		}
		sparkW := max(10, w-12)
		step := max(1, len(data)/sparkW)
		var spark strings.Builder
		for i := 0; i < len(data); i += step {
			idx := int(math.Round((data[i] - minV) / rng * float64(len(sparkChars)-1)))
			spark.WriteRune(sparkChars[idx])
		}
		lines = append(lines, fmt.Sprintf("%-6s %s", sym,
			lipgloss.NewStyle().Foreground(lipgloss.Color("10")).Render(spark.String())))
	}
	if len(lines) == 0 {
		lines = append(lines, "No sparkline data")
	}
	return style.Render(strings.Join(lines, "\n"))
}

func (m Model) renderNews(w, h int) string {
	style := borderStyle(panelNews, m.focused, "News", w, h)
	offset := m.scrollOffset[panelNews]

	var lines []string
	for i := offset; i < len(m.news) && len(lines) < h-3; i++ {
		n := m.news[i]
		linked := " "
		if n.MemoryID.Valid {
			linked = "●"
		}
		src := strings.ReplaceAll(strings.ReplaceAll(n.Source, "rss:", ""), "cryptocompare:", "")
		tokens := ""
		if n.TokensMentioned.Valid {
			var toks []string
			if json.Unmarshal([]byte(n.TokensMentioned.String), &toks) == nil && len(toks) > 0 {
				tokens = fmt.Sprintf(" [%s]", strings.Join(toks, ","))
			}
		}
		title := n.Title
		if len(title) > 55 {
			title = title[:55]
		}
		line := fmt.Sprintf("%4s %s %s%s (%s)",
			TimeAgo(n.PublishedAt), linked, title, tokens, src)
		lines = append(lines, line)
	}
	return style.Render(strings.Join(lines, "\n"))
}

func (m Model) renderSignals(w, h int) string {
	style := borderStyle(panelSignals, m.focused, "Signals", w, h)
	offset := m.scrollOffset[panelSignals]

	sigColors := map[string]color.Color{
		"buy":  lipgloss.Color("2"),
		"sell": lipgloss.Color("1"),
		"hold": lipgloss.Color("3"),
	}

	var lines []string
	for i := offset; i < len(m.signals) && len(lines) < h-3; i++ {
		s := m.signals[i]
		color, ok := sigColors[s.SignalType]
		if !ok {
			color = lipgloss.Color("3")
		}
		sigStr := lipgloss.NewStyle().Bold(true).Foreground(color).
			Render(fmt.Sprintf("%-5s", strings.ToUpper(s.SignalType)))
		reasoning := s.Reasoning
		if len(reasoning) > 60 {
			reasoning = reasoning[:60]
		}
		line := fmt.Sprintf("%4s %-6s %s %3.0f%% %s",
			TimeAgo(s.CreatedAt), s.Symbol, sigStr, s.Confidence*100, reasoning)
		lines = append(lines, line)
	}
	return style.Render(strings.Join(lines, "\n"))
}

func (m Model) renderGraph(w, h int) string {
	style := borderStyle(panelGraph, m.focused, "Graph", w, h)
	offset := m.scrollOffset[panelGraph]

	var lines []string
	for i := offset; i < len(m.graph) && len(lines) < h-3; i++ {
		e := m.graph[i]
		line := fmt.Sprintf("%s → %s → %s (%.1f)", e.SourceLabel, e.Relation, e.TargetLabel, e.Weight)
		lines = append(lines, line)
	}
	return style.Render(strings.Join(lines, "\n"))
}

func (m Model) renderStatus(w, h int) string {
	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Width(w - 2).
		Height(h - 2).
		Padding(0, 1).
		Foreground(lipgloss.Color("240"))

	t := m.lastRefresh.Format("15:04:05")
	s := m.stats
	text := fmt.Sprintf("%s | mem:%d nodes:%d edges:%d sig:%d news:%d | q:quit r:refresh Tab:focus j/k:scroll",
		t, s.Memories, s.Nodes, s.Edges, s.Signals, s.News)
	return style.Render(text)
}

// Formatters
func formatUsdGo(n float64) string {
	if n >= 1000 {
		return fmt.Sprintf("$%.0f", n)
	}
	if n >= 1 {
		return fmt.Sprintf("$%.2f", n)
	}
	return fmt.Sprintf("$%.4f", n)
}

func formatPctGo(n sql.NullFloat64) string {
	if !n.Valid {
		return "   --"
	}
	sign := ""
	if n.Float64 >= 0 {
		sign = "+"
	}
	return fmt.Sprintf("%s%.1f%%", sign, n.Float64)
}

func formatVolumeGo(n sql.NullFloat64) string {
	if !n.Valid {
		return "--"
	}
	v := n.Float64
	switch {
	case v >= 1e12:
		return fmt.Sprintf("$%.1fT", v/1e12)
	case v >= 1e9:
		return fmt.Sprintf("$%.1fB", v/1e9)
	case v >= 1e6:
		return fmt.Sprintf("$%.1fM", v/1e6)
	default:
		return fmt.Sprintf("$%.0f", v)
	}
}

