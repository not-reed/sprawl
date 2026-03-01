mod db;
mod ui;

use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::prelude::*;
use std::io;
use std::time::{Duration, Instant};

fn main() -> Result<()> {
    let db_path = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| "./data/cortex.db".into());

    let db = db::CortexDb::open(&db_path)?;
    let mut state = ui::AppState::new();
    state.refresh(&db);

    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = run_app(&mut terminal, &mut state, &db);

    // Restore terminal
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    state: &mut ui::AppState,
    db: &db::CortexDb,
) -> Result<()> {
    let mut last_refresh = Instant::now();
    let refresh_interval = Duration::from_secs(5);

    loop {
        terminal.draw(|frame| ui::draw(frame, state))?;

        // Poll with timeout for auto-refresh
        let timeout = refresh_interval
            .checked_sub(last_refresh.elapsed())
            .unwrap_or(Duration::ZERO);

        if event::poll(timeout)? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                // Modal popups
                if state.has_modal() {
                    match key.code {
                        KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => {
                            state.news_detail = false;
                            state.signal_detail = false;
                        }
                        KeyCode::Char('o') if state.news_detail => {
                            state.open_news_url();
                        }
                        _ => {}
                    }
                    continue;
                }

                match key.code {
                    KeyCode::Char('q') => return Ok(()),
                    KeyCode::Char('r') => {
                        state.refresh(db);
                        last_refresh = Instant::now();
                    }
                    KeyCode::Tab => state.cycle_focus(),
                    KeyCode::Char('j') | KeyCode::Down => state.scroll_down(),
                    KeyCode::Char('k') | KeyCode::Up => state.scroll_up(),
                    KeyCode::Char('c') => state.cycle_chart(),
                    KeyCode::Enter => match state.focused {
                        ui::Panel::News => state.toggle_news_detail(),
                        ui::Panel::Signals => state.toggle_signal_detail(),
                        _ => {}
                    },
                    KeyCode::Char('a') => {
                        if let Err(e) = db.insert_command("analyze") {
                            eprintln!("Failed to queue analyze: {}", e);
                        }
                        // Refresh immediately to show pending status
                        state.refresh(db);
                        last_refresh = Instant::now();
                    }
                    _ => {}
                }
            }
        }

        // Auto-refresh
        if last_refresh.elapsed() >= refresh_interval {
            state.refresh(db);
            last_refresh = Instant::now();
        }
    }
}
