use anyhow::Result;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table},
    Terminal,
};
use snipebundle_core::EngineState;
use std::io::Stdout;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, RwLock};

pub async fn run(
    state: Arc<RwLock<EngineState>>,
    cancel_tx: watch::Sender<bool>,
    paused_tx: watch::Sender<bool>,
) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut term = Terminal::new(backend)?;

    let result = render_loop(&mut term, state, cancel_tx, paused_tx).await;

    disable_raw_mode()?;
    execute!(
        term.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    term.show_cursor()?;
    result
}

async fn render_loop(
    term: &mut Terminal<CrosstermBackend<Stdout>>,
    state: Arc<RwLock<EngineState>>,
    cancel_tx: watch::Sender<bool>,
    paused_tx: watch::Sender<bool>,
) -> Result<()> {
    let mut paused = false;
    loop {
        let snap = state.read().await;
        let mints = snap.mint_count;
        let matched = snap.matched_count;
        let bundles = snap.bundle_count;
        let running = snap.running;
        let last_msg = snap.last_message.clone();
        let feed: Vec<_> = snap.feed.iter().take(20).cloned().collect();
        let positions = snap.positions.clone();
        drop(snap);

        term.draw(|f| {
            let area = f.area();
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3),
                    Constraint::Percentage(55),
                    Constraint::Percentage(35),
                    Constraint::Length(3),
                ])
                .split(area);

            let header = Paragraph::new(Line::from(vec![
                Span::styled(
                    "snipebundle ",
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!(
                    "  mints={mints}  matched={matched}  bundles={bundles}  ",
                )),
                Span::styled(
                    if running { "● running " } else { "○ stopped " },
                    Style::default().fg(if running { Color::Green } else { Color::DarkGray }),
                ),
                Span::styled(
                    if paused { "[PAUSED] " } else { "        " },
                    Style::default().fg(Color::Yellow),
                ),
            ]))
            .block(Block::default().borders(Borders::ALL).title("status"));
            f.render_widget(header, chunks[0]);

            let feed_rows: Vec<Row> = feed
                .iter()
                .map(|e| {
                    let matched_label = match e.matched {
                        Some(t) => format!("{:?}", t),
                        None => "-".into(),
                    };
                    let style = if e.matched.is_some() {
                        Style::default().fg(Color::Green)
                    } else {
                        Style::default().fg(Color::Gray)
                    };
                    let mc = e
                        .mc_sol
                        .map(|x| format!("{x:.2}"))
                        .unwrap_or_else(|| "?".into());
                    Row::new(vec![
                        Cell::from(short(&e.mint, 12)),
                        Cell::from(e.symbol.clone().unwrap_or_else(|| "-".into())),
                        Cell::from(short(&e.creator, 8)),
                        Cell::from(mc),
                        Cell::from(if e.socials { "yes" } else { "no" }),
                        Cell::from(matched_label),
                    ])
                    .style(style)
                })
                .collect();

            let feed_table = Table::new(
                feed_rows,
                [
                    Constraint::Length(13),
                    Constraint::Length(8),
                    Constraint::Length(10),
                    Constraint::Length(8),
                    Constraint::Length(7),
                    Constraint::Length(14),
                ],
            )
            .header(Row::new(vec![
                "mint", "symbol", "creator", "mc(SOL)", "socials", "matched",
            ]).style(Style::default().add_modifier(Modifier::BOLD)))
            .block(Block::default().borders(Borders::ALL).title("live mint feed"));
            f.render_widget(feed_table, chunks[1]);

            let pos_rows: Vec<Row> = positions
                .iter()
                .map(|p| {
                    let age = (now_ms() - p.opened_at_ms) / 1000;
                    let trig = format!("{:?}", p.trigger);
                    Row::new(vec![
                        Cell::from(short(&p.mint, 12)),
                        Cell::from(trig),
                        Cell::from(format!("{:.3}", p.entry_total_sol)),
                        Cell::from(format!("{}", p.wallet_count)),
                        Cell::from(format!("{age}s")),
                        Cell::from(p.status.clone()),
                    ])
                })
                .collect();

            let pos_table = Table::new(
                pos_rows,
                [
                    Constraint::Length(13),
                    Constraint::Length(14),
                    Constraint::Length(10),
                    Constraint::Length(7),
                    Constraint::Length(6),
                    Constraint::Min(20),
                ],
            )
            .header(Row::new(vec![
                "mint", "trigger", "spend(SOL)", "wallets", "age", "status",
            ]).style(Style::default().add_modifier(Modifier::BOLD)))
            .block(Block::default().borders(Borders::ALL).title("active positions"));
            f.render_widget(pos_table, chunks[2]);

            let footer = Paragraph::new(Line::from(vec![
                Span::styled(
                    "[q]uit  [p]ause  ",
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::raw(last_msg),
            ]))
            .block(Block::default().borders(Borders::ALL));
            f.render_widget(footer, chunks[3]);
        })?;

        if event::poll(Duration::from_millis(150))? {
            if let Event::Key(k) = event::read()? {
                if k.kind != KeyEventKind::Press {
                    continue;
                }
                match k.code {
                    KeyCode::Char('q') | KeyCode::Esc => {
                        cancel_tx.send(true).ok();
                        return Ok(());
                    }
                    KeyCode::Char('p') => {
                        paused = !paused;
                        paused_tx.send(paused).ok();
                    }
                    _ => {}
                }
            }
        }
    }
}

fn short(s: &str, n: usize) -> String {
    s.chars().take(n).collect::<String>() + if s.len() > n { "…" } else { "" }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
