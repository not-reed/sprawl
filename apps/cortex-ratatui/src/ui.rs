use crate::db::{ChartData, CommandRow, CortexDb, GraphRow, NewsRow, PriceRow, SignalRow, Stats};
use chrono::{NaiveDateTime, Utc};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    symbols,
    text::{Line, Span},
    widgets::{
        Axis, Block, Borders, Cell, Chart, Clear, Dataset, GraphType, List, ListItem, Paragraph,
        Row, Table, Wrap,
    },
    Frame,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Panel {
    Prices,
    News,
    Signals,
    Graph,
}

impl Panel {
    pub fn next(self) -> Self {
        match self {
            Panel::Prices => Panel::News,
            Panel::News => Panel::Signals,
            Panel::Signals => Panel::Graph,
            Panel::Graph => Panel::Prices,
        }
    }
}

pub struct AppState {
    pub focused: Panel,
    pub scroll_offsets: [usize; 4],
    pub prices: Vec<PriceRow>,
    pub chart_data: Vec<(String, ChartData)>,
    pub chart_index: usize,
    pub news: Vec<NewsRow>,
    pub news_cursor: usize,
    pub news_detail: bool,
    pub signals: Vec<SignalRow>,
    pub signal_cursor: usize,
    pub signal_detail: bool,
    pub graph: Vec<GraphRow>,
    pub stats: Stats,
    pub last_refresh: String,
    pub recent_commands: Vec<CommandRow>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            focused: Panel::Prices,
            scroll_offsets: [0; 4],
            prices: vec![],
            chart_data: vec![],
            chart_index: 0,
            news: vec![],
            news_cursor: 0,
            news_detail: false,
            signals: vec![],
            signal_cursor: 0,
            signal_detail: false,
            graph: vec![],
            stats: Stats::default(),
            last_refresh: String::new(),
            recent_commands: vec![],
        }
    }

    pub fn refresh(&mut self, db: &CortexDb) {
        self.prices = db.get_prices().unwrap_or_default();
        self.news = db.get_news().unwrap_or_default();
        self.signals = db.get_signals().unwrap_or_default();
        self.graph = db.get_graph().unwrap_or_default();
        self.stats = db.get_stats().unwrap_or_default();
        self.recent_commands = db.get_recent_commands().unwrap_or_default();

        let symbols = db.get_token_symbols().unwrap_or_default();
        self.chart_data = symbols
            .into_iter()
            .filter_map(|sym| {
                let data = db.get_chart_data(&sym).ok()?;
                if data.points.is_empty() {
                    None
                } else {
                    Some((sym, data))
                }
            })
            .collect();

        self.last_refresh = Utc::now().format("%H:%M:%S").to_string();
    }

    pub fn scroll_up(&mut self) {
        match self.focused {
            Panel::News => self.news_cursor = self.news_cursor.saturating_sub(1),
            Panel::Signals => self.signal_cursor = self.signal_cursor.saturating_sub(1),
            _ => {
                let idx = self.focused as usize;
                self.scroll_offsets[idx] = self.scroll_offsets[idx].saturating_sub(1);
            }
        }
    }

    pub fn scroll_down(&mut self) {
        match self.focused {
            Panel::News => {
                if !self.news.is_empty() {
                    self.news_cursor = (self.news_cursor + 1).min(self.news.len() - 1);
                }
            }
            Panel::Signals => {
                if !self.signals.is_empty() {
                    self.signal_cursor = (self.signal_cursor + 1).min(self.signals.len() - 1);
                }
            }
            _ => {
                let idx = self.focused as usize;
                self.scroll_offsets[idx] += 1;
            }
        }
    }

    pub fn cycle_focus(&mut self) {
        self.focused = self.focused.next();
    }

    pub fn toggle_news_detail(&mut self) {
        if !self.news.is_empty() {
            self.news_detail = !self.news_detail;
        }
    }

    pub fn selected_news(&self) -> Option<&NewsRow> {
        self.news.get(self.news_cursor)
    }

    pub fn open_news_url(&self) -> bool {
        if let Some(n) = self.selected_news() {
            if let Some(url) = &n.url {
                let _ = std::process::Command::new("xdg-open")
                    .arg(url)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
                return true;
            }
        }
        false
    }

    pub fn toggle_signal_detail(&mut self) {
        if !self.signals.is_empty() {
            self.signal_detail = !self.signal_detail;
        }
    }

    pub fn selected_signal(&self) -> Option<&SignalRow> {
        self.signals.get(self.signal_cursor)
    }

    /// Returns true if any modal is open
    pub fn has_modal(&self) -> bool {
        self.news_detail || self.signal_detail
    }

    pub fn cycle_chart(&mut self) {
        if !self.chart_data.is_empty() {
            self.chart_index = (self.chart_index + 1) % self.chart_data.len();
        }
    }

    /// Returns command status text for the status bar
    pub fn command_status(&self) -> Option<(&'static str, Color)> {
        let latest = self.recent_commands.first()?;
        if latest.completed_at.is_none() {
            Some(("Analysis requested...", Color::Yellow))
        } else {
            // Show "complete" briefly (within last 30s)
            let parsed = NaiveDateTime::parse_from_str(&latest.created_at, "%Y-%m-%d %H:%M:%S")
                .ok()?;
            let age = Utc::now().naive_utc() - parsed;
            if age.num_seconds() < 30 {
                Some(("Analysis complete", Color::Green))
            } else {
                None
            }
        }
    }
}

pub fn draw(frame: &mut Frame, state: &AppState) {
    let area = frame.area();

    // Main layout: body + status bar
    let main = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(3)])
        .split(area);

    // Body: left + right columns
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
        .split(main[0]);

    // Left column: prices, chart, news
    let left = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length((state.prices.len() as u16 + 3).min(12)),
            Constraint::Length(8),
            Constraint::Min(5),
        ])
        .split(cols[0]);

    // Right column: signals, graph
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
        .split(cols[1]);

    draw_prices(frame, left[0], state);
    draw_chart(frame, left[1], state);
    draw_news(frame, left[2], state);
    draw_signals(frame, right[0], state);
    draw_graph(frame, right[1], state);
    draw_status(frame, main[1], state);

    if state.news_detail {
        draw_news_detail(frame, area, state);
    }
    if state.signal_detail {
        draw_signal_detail(frame, area, state);
    }
}

fn focused_border(panel: Panel, current: Panel) -> Style {
    if panel == current {
        Style::default()
            .fg(panel_color(panel))
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

fn panel_color(panel: Panel) -> Color {
    match panel {
        Panel::Prices => Color::Cyan,
        Panel::News => Color::Yellow,
        Panel::Signals => Color::Green,
        Panel::Graph => Color::Magenta,
    }
}

const CHART_COLORS: [Color; 6] = [
    Color::Green,
    Color::Cyan,
    Color::Yellow,
    Color::Magenta,
    Color::Blue,
    Color::Red,
];

fn format_usd(n: f64) -> String {
    if n >= 1000.0 {
        format!("${:.0}", n)
    } else if n >= 1.0 {
        format!("${:.2}", n)
    } else {
        format!("${:.4}", n)
    }
}

fn format_pct(n: Option<f64>) -> (String, Color) {
    match n {
        Some(v) => {
            let color = if v >= 0.0 { Color::Green } else { Color::Red };
            let sign = if v >= 0.0 { "+" } else { "" };
            (format!("{}{:.1}%", sign, v), color)
        }
        None => ("  --".into(), Color::DarkGray),
    }
}

fn format_volume(n: Option<f64>) -> String {
    match n {
        Some(v) if v >= 1e12 => format!("${:.1}T", v / 1e12),
        Some(v) if v >= 1e9 => format!("${:.1}B", v / 1e9),
        Some(v) if v >= 1e6 => format!("${:.1}M", v / 1e6),
        Some(v) => format!("${:.0}", v),
        None => "--".into(),
    }
}

fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn time_ago(iso: &str) -> String {
    let parsed = NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S%.fZ")
        .or_else(|_| NaiveDateTime::parse_from_str(iso, "%Y-%m-%d %H:%M:%S"))
        .unwrap_or_default();
    let diff = Utc::now().naive_utc() - parsed;
    let mins = diff.num_minutes();
    if mins < 60 {
        format!("{}m", mins)
    } else if mins < 1440 {
        format!("{}h", mins / 60)
    } else {
        format!("{}d", mins / 1440)
    }
}

fn draw_prices(frame: &mut Frame, area: Rect, state: &AppState) {
    let header = Row::new(["Symbol", "Price", "24h", "7d", "Volume"])
        .style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD));

    let rows: Vec<Row> = state
        .prices
        .iter()
        .map(|p| {
            let (pct24, c24) = format_pct(p.change_24h);
            let (pct7d, c7d) = format_pct(p.change_7d);
            Row::new([
                Cell::from(p.symbol.clone()).style(Style::default().bold()),
                Cell::from(format_usd(p.price_usd)),
                Cell::from(pct24).style(Style::default().fg(c24)),
                Cell::from(pct7d).style(Style::default().fg(c7d)),
                Cell::from(format_volume(p.volume_24h)).style(Style::default().fg(Color::DarkGray)),
            ])
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(8),
            Constraint::Length(12),
            Constraint::Length(8),
            Constraint::Length(8),
            Constraint::Length(10),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(focused_border(Panel::Prices, state.focused))
            .title(" Prices "),
    );

    frame.render_widget(table, area);
}

fn draw_chart(frame: &mut Frame, area: Rect, state: &AppState) {
    if state.chart_data.is_empty() {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .title(" Price History (24h) ");
        let empty = Paragraph::new("No price data")
            .style(Style::default().fg(Color::DarkGray))
            .block(block);
        frame.render_widget(empty, area);
        return;
    }

    let idx = state.chart_index.min(state.chart_data.len() - 1);
    let (sym, data) = &state.chart_data[idx];
    let token_count = state.chart_data.len();

    let title = if token_count > 1 {
        format!(" {} 24h [{}/{}] c:cycle ", sym, idx + 1, token_count)
    } else {
        format!(" {} 24h ", sym)
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(title);

    let max_x = data.points.last().map(|&(x, _)| x).unwrap_or(1.0);

    // Padding so the line doesn't touch top/bottom
    let y_pad = (data.max_price - data.min_price) * 0.05;
    let y_min = data.min_price - y_pad;
    let y_max = data.max_price + y_pad;

    let color = CHART_COLORS[idx % CHART_COLORS.len()];
    let dataset = Dataset::default()
        .name(sym.as_str())
        .marker(symbols::Marker::Braille)
        .graph_type(GraphType::Line)
        .style(Style::default().fg(color))
        .data(&data.points);

    let chart = Chart::new(vec![dataset])
        .block(block)
        .x_axis(
            Axis::default()
                .bounds([0.0, max_x])
                .style(Style::default().fg(Color::DarkGray)),
        )
        .y_axis(
            Axis::default()
                .bounds([y_min, y_max])
                .labels::<Vec<Line>>(vec![
                    format_usd(data.min_price).into(),
                    format_usd(data.max_price).into(),
                ])
                .style(Style::default().fg(Color::DarkGray)),
        );

    frame.render_widget(chart, area);
}

fn draw_news(frame: &mut Frame, area: Rect, state: &AppState) {
    let is_focused = state.focused == Panel::News;
    // Compute viewport: keep cursor visible
    let inner_height = area.height.saturating_sub(2) as usize; // borders
    let viewport_start = if state.news_cursor >= inner_height {
        state.news_cursor - inner_height + 1
    } else {
        0
    };

    let items: Vec<ListItem> = state
        .news
        .iter()
        .enumerate()
        .skip(viewport_start)
        .map(|(i, n)| {
            let linked = if n.memory_id.is_some() { "●" } else { " " };
            let src = n.source.replace("rss:", "").replace("cryptocompare:", "");
            let tokens = n
                .tokens_mentioned
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .map(|t| format!(" [{}]", t.join(",")))
                .unwrap_or_default();

            let is_selected = is_focused && i == state.news_cursor;
            let cursor = if is_selected { "▸" } else { " " };

            let line = Line::from(vec![
                Span::styled(
                    format!("{} ", cursor),
                    Style::default().fg(Color::Yellow),
                ),
                Span::styled(
                    format!("{:>4} ", time_ago(&n.published_at)),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(format!("{} ", linked), Style::default().fg(Color::Blue)),
                Span::raw(truncate_str(&n.title, 50)),
                Span::styled(tokens, Style::default().fg(Color::Cyan)),
                Span::styled(format!(" ({})", src), Style::default().fg(Color::DarkGray)),
            ]);

            if is_selected {
                ListItem::new(line).style(Style::default().bg(Color::Rgb(30, 30, 50)))
            } else {
                ListItem::new(line)
            }
        })
        .collect();

    let title = if is_focused {
        " News Feed (Enter:detail) "
    } else {
        " News Feed "
    };
    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(focused_border(Panel::News, state.focused))
            .title(title),
    );
    frame.render_widget(list, area);
}

fn draw_news_detail(frame: &mut Frame, area: Rect, state: &AppState) {
    let n = match state.selected_news() {
        Some(n) => n,
        None => return,
    };

    // Centered popup: 70% width, up to 14 rows
    let popup_w = (area.width as f32 * 0.7) as u16;
    let popup_h = 14u16.min(area.height - 4);
    let x = (area.width - popup_w) / 2;
    let y = (area.height - popup_h) / 2;
    let popup_area = Rect::new(x, y, popup_w, popup_h);

    // Clear background
    frame.render_widget(Clear, popup_area);

    let src = n.source.replace("rss:", "").replace("cryptocompare:", "");
    let tokens = n
        .tokens_mentioned
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .map(|t| t.join(", "))
        .unwrap_or_else(|| "none".into());
    let linked = if n.memory_id.is_some() {
        "yes"
    } else {
        "no"
    };
    let url_display = n.url.as_deref().unwrap_or("no url");

    let text = vec![
        Line::from(Span::styled(
            &n.title,
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled("Source:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(&src, Style::default().fg(Color::Yellow)),
        ]),
        Line::from(vec![
            Span::styled("Time:    ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{} ({})", &n.published_at, time_ago(&n.published_at)),
                Style::default().fg(Color::White),
            ),
        ]),
        Line::from(vec![
            Span::styled("Tokens:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(tokens, Style::default().fg(Color::Cyan)),
        ]),
        Line::from(vec![
            Span::styled("Memory:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(linked, Style::default().fg(Color::Blue)),
        ]),
        Line::from(vec![
            Span::styled("URL:     ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                truncate_str(url_display, (popup_w as usize).saturating_sub(12)),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::from(""),
        Line::from(Span::styled(
            "o:open in browser  Esc/Enter:close",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let popup = Paragraph::new(text).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
            .title(" Article Detail "),
    );
    frame.render_widget(popup, popup_area);
}

fn draw_signals(frame: &mut Frame, area: Rect, state: &AppState) {
    let is_focused = state.focused == Panel::Signals;
    let inner_height = area.height.saturating_sub(2) as usize;
    let viewport_start = if state.signal_cursor >= inner_height {
        state.signal_cursor - inner_height + 1
    } else {
        0
    };
    // cursor "▸ " (2) + "5m " (5) + "BTC   " (6) + "24h " (4) + "HOLD " (5) + " 85% " (5) = 27 + 2 border
    let reasoning_width = (area.width as usize).saturating_sub(29);
    let items: Vec<ListItem> = state
        .signals
        .iter()
        .enumerate()
        .skip(viewport_start)
        .map(|(i, s)| {
            let color = match s.signal_type.as_str() {
                "buy" => Color::Green,
                "sell" => Color::Red,
                _ => Color::Yellow,
            };
            let is_selected = is_focused && i == state.signal_cursor;
            let cursor = if is_selected { "▸" } else { " " };
            let pct = format!("{:.0}%", s.confidence * 100.0);
            let tf_label = if s.timeframe == "long" { " 4w" } else { "24h" };
            let tf_color = if s.timeframe == "long" { Color::Magenta } else { Color::Cyan };
            let line = Line::from(vec![
                Span::styled(
                    format!("{} ", cursor),
                    Style::default().fg(Color::Green),
                ),
                Span::styled(
                    format!("{:>4} ", time_ago(&s.created_at)),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(format!("{:<5}", s.symbol), Style::default().bold()),
                Span::styled(
                    format!("{} ", tf_label),
                    Style::default().fg(tf_color),
                ),
                Span::styled(
                    format!("{:<5}", s.signal_type.to_uppercase()),
                    Style::default().fg(color).bold(),
                ),
                Span::styled(format!("{:>4} ", pct), Style::default().fg(color)),
                Span::styled(
                    truncate_str(&s.reasoning, reasoning_width).to_string(),
                    Style::default().fg(Color::DarkGray),
                ),
            ]);
            if is_selected {
                ListItem::new(line).style(Style::default().bg(Color::Rgb(30, 30, 50)))
            } else {
                ListItem::new(line)
            }
        })
        .collect();

    let title = if is_focused {
        " Signals (Enter:detail) "
    } else {
        " Signals "
    };
    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(focused_border(Panel::Signals, state.focused))
            .title(title),
    );
    frame.render_widget(list, area);
}

fn draw_signal_detail(frame: &mut Frame, area: Rect, state: &AppState) {
    let s = match state.selected_signal() {
        Some(s) => s,
        None => return,
    };

    let popup_w = (area.width as f32 * 0.7) as u16;
    let popup_h = 16u16.min(area.height - 4);
    let x = (area.width - popup_w) / 2;
    let y = (area.height - popup_h) / 2;
    let popup_area = Rect::new(x, y, popup_w, popup_h);

    frame.render_widget(Clear, popup_area);

    let color = match s.signal_type.as_str() {
        "buy" => Color::Green,
        "sell" => Color::Red,
        _ => Color::Yellow,
    };

    let tf_label = if s.timeframe == "long" { "Long-term (1-4 weeks)" } else { "Short-term (24-48h)" };
    let tf_color = if s.timeframe == "long" { Color::Magenta } else { Color::Cyan };

    let text = vec![
        Line::from(vec![
            Span::styled(&s.symbol, Style::default().bold().fg(Color::White)),
            Span::styled("  ", Style::default()),
            Span::styled(
                s.signal_type.to_uppercase(),
                Style::default().bold().fg(color),
            ),
            Span::styled(
                format!("  {:.0}% confidence", s.confidence * 100.0),
                Style::default().fg(color),
            ),
        ]),
        Line::from(""),
        Line::from(vec![
            Span::styled("Timeframe: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                tf_label,
                Style::default().fg(tf_color).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(vec![
            Span::styled("Time:      ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{} ({})", &s.created_at, time_ago(&s.created_at)),
                Style::default().fg(Color::White),
            ),
        ]),
        Line::from(""),
        Line::from(Span::styled(
            "Reasoning:",
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            &s.reasoning,
            Style::default().fg(Color::White),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "Esc/Enter:close",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let popup = Paragraph::new(text).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
            .title(" Signal Detail "),
    );
    frame.render_widget(popup, popup_area);
}

fn draw_graph(frame: &mut Frame, area: Rect, state: &AppState) {
    let offset = state.scroll_offsets[Panel::Graph as usize];
    let items: Vec<ListItem> = state
        .graph
        .iter()
        .skip(offset)
        .map(|e| {
            // Format as: "3h  Bitcoin decreased during week of 2026-01-04  ×2"
            let line = Line::from(vec![
                Span::styled(
                    format!("{:>4} ", time_ago(&e.updated_at)),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(&e.source_label, Style::default().bold()),
                Span::styled(
                    format!(" {} ", e.relation),
                    Style::default().fg(Color::Cyan),
                ),
                Span::styled(&e.target_label, Style::default().fg(Color::White)),
                if e.weight > 1.0 {
                    Span::styled(
                        format!("  x{:.0}", e.weight),
                        Style::default().fg(Color::DarkGray),
                    )
                } else {
                    Span::raw("")
                },
            ]);
            ListItem::new(line)
        })
        .collect();

    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(focused_border(Panel::Graph, state.focused))
            .title(" Knowledge Graph "),
    );
    frame.render_widget(list, area);
}

fn draw_status(frame: &mut Frame, area: Rect, state: &AppState) {
    let s = &state.stats;

    let mut spans = vec![
        Span::styled(
            format!(" {} ", state.last_refresh),
            Style::default().fg(Color::White),
        ),
        Span::styled("| ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            format!(
                "mem:{} nodes:{} edges:{} sig:{} news:{}",
                s.memories, s.nodes, s.edges, s.signals, s.news
            ),
            Style::default().fg(Color::DarkGray),
        ),
    ];

    // Show command status if any
    if let Some((msg, color)) = state.command_status() {
        spans.push(Span::styled(" | ", Style::default().fg(Color::DarkGray)));
        spans.push(Span::styled(msg, Style::default().fg(color)));
    }

    spans.push(Span::styled(
        " | q:quit r:refresh Tab:focus j/k:scroll c:chart a:analyze",
        Style::default().fg(Color::DarkGray),
    ));

    let bar = Paragraph::new(Line::from(spans)).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray)),
    );
    frame.render_widget(bar, area);
}
