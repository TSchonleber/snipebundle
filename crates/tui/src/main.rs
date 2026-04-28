use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use snipebundle_core::{
    bundler,
    keystore::{self, Keystore, StoredKeypair},
    listener,
    types::MintEvent,
    wallet, Config,
};
use std::path::PathBuf;
use tokio::sync::mpsc;
use tracing::{info, warn};

#[derive(Parser)]
#[command(name = "snipebundle", version, about = "pump.fun launch sniper")]
struct Cli {
    #[arg(long, default_value = "config.toml")]
    config: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Initialize encrypted keystore and generate sniper wallets
    Init {
        #[arg(long)]
        wallets: Option<u32>,
    },
    /// List wallets in the keystore (does NOT print secrets)
    List,
    /// Reveal secret keys for sniper wallets (prints once, requires confirmation)
    Reveal,
    /// Stream new pump.fun mints from the WS feed and print them
    Listen {
        #[arg(long, default_value_t = 0)]
        limit: u32,
    },
    /// Manually fire a buy bundle for a given mint address (testing M2 hot path)
    Snipe {
        mint: String,
        #[arg(long)]
        sol: Option<f64>,
        /// comma-separated sniper indices, or "all"
        #[arg(long, default_value = "all")]
        wallets: String,
    },
    /// Manually fire a sell bundle to dump positions on a given mint
    Dump {
        mint: String,
        #[arg(long, default_value = "all")]
        wallets: String,
    },
    /// Run the live sniper TUI (placeholder until milestone 3)
    Run,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,snipebundle=debug")),
        )
        .init();

    let cli = Cli::parse();
    let cfg = Config::load(&cli.config)
        .with_context(|| format!("loading config from {}", cli.config.display()))?;

    match cli.cmd {
        Cmd::Init { wallets } => init(&cfg, wallets),
        Cmd::List => list(),
        Cmd::Reveal => reveal(),
        Cmd::Listen { limit } => listen(&cfg, limit).await,
        Cmd::Snipe { mint, sol, wallets } => snipe(&cfg, &mint, sol, &wallets).await,
        Cmd::Dump { mint, wallets } => dump(&cfg, &mint, &wallets).await,
        Cmd::Run => run_tui(&cfg).await,
    }
}

fn init(cfg: &Config, override_count: Option<u32>) -> Result<()> {
    let n = override_count.unwrap_or(cfg.wallets.count);
    anyhow::ensure!(n >= 1 && n <= 10, "wallet count must be 1..=10");

    let path = keystore::keystore_path()?;
    if path.exists() {
        anyhow::bail!(
            "keystore already exists at {}; delete it manually if you want to reinit",
            path.display()
        );
    }

    let pass = prompt_new_passphrase()?;
    let master = wallet::generate("master");
    let snipers = wallet::generate_snipers(n);

    println!("\n=== KEYSTORE CREATED — WRITE THESE DOWN NOW ===\n");
    println!("MASTER WALLET");
    println!("  pubkey:  {}", master.pubkey);
    println!("  secret:  {}", master.secret_b58);
    println!();
    println!("SNIPER WALLETS ({n})");
    for s in &snipers {
        println!("  [{}] pub: {}", s.label, s.pubkey);
        println!("       sec: {}", s.secret_b58);
    }
    println!();
    println!("These secrets are encrypted at rest with your passphrase.");
    println!("They will NOT be shown again unless you run `snipebundle reveal`.");
    println!();
    confirm("Have you saved these securely? type YES to continue: ", "YES")?;

    let ks = Keystore { master: Some(master), snipers };
    keystore::save(&path, &ks, &pass)?;
    println!("\nkeystore written to {}", path.display());
    Ok(())
}

fn list() -> Result<()> {
    let path = keystore::keystore_path()?;
    let pass = rpassword::prompt_password("keystore passphrase: ")?;
    let ks = keystore::load(&path, &pass)?;
    if let Some(m) = &ks.master {
        println!("master  {}  {}", m.label, m.pubkey);
    }
    for s in &ks.snipers {
        println!("sniper  {}  {}", s.label, s.pubkey);
    }
    Ok(())
}

fn reveal() -> Result<()> {
    let path = keystore::keystore_path()?;
    let pass = rpassword::prompt_password("keystore passphrase: ")?;
    let ks = keystore::load(&path, &pass)?;
    confirm(
        "this prints private keys to stdout. shoulder-surf check. type REVEAL: ",
        "REVEAL",
    )?;
    if let Some(m) = &ks.master {
        println!("MASTER  {}  sec={}", m.pubkey, m.secret_b58);
    }
    for s in &ks.snipers {
        println!("{}  {}  sec={}", s.label, s.pubkey, s.secret_b58);
    }
    Ok(())
}

async fn listen(cfg: &Config, limit: u32) -> Result<()> {
    let (tx, mut rx) = mpsc::channel::<MintEvent>(1024);
    let ws = cfg.network.pumpportal_ws.clone();

    let listener_task = tokio::spawn(async move {
        if let Err(e) = listener::run(ws, tx).await {
            warn!(error = %e, "listener exited");
        }
    });

    let mut count = 0u32;
    println!(
        "{:<13} {:<44} {:<10} {:<8} {:<10} socials",
        "ts", "mint", "creator…", "symbol", "mc(SOL)"
    );
    while let Some(ev) = rx.recv().await {
        let creator_short = format!("{}…", &ev.creator.chars().take(8).collect::<String>());
        let mc = ev.market_cap_sol.map(|x| format!("{x:.2}")).unwrap_or_else(|| "?".into());
        let socials = if ev.has_socials() { "yes" } else { "no" };
        println!(
            "{:<13} {:<44} {:<10} {:<8} {:<10} {}",
            ev.received_at,
            ev.mint,
            creator_short,
            ev.symbol.as_deref().unwrap_or("?"),
            mc,
            socials
        );
        count += 1;
        if limit > 0 && count >= limit {
            break;
        }
    }
    listener_task.abort();
    Ok(())
}

async fn snipe(cfg: &Config, mint: &str, sol_override: Option<f64>, wallets: &str) -> Result<()> {
    let (selected, _ks) = load_selected_snipers(wallets)?;

    let sol_per_wallet = sol_override.unwrap_or(cfg.trigger.sol_per_snipe);
    anyhow::ensure!(
        sol_per_wallet <= cfg.wallets.max_sol_per_wallet,
        "sol_per_wallet {} exceeds max_sol_per_wallet {}",
        sol_per_wallet,
        cfg.wallets.max_sol_per_wallet
    );
    anyhow::ensure!(
        selected.len() <= 5,
        "Jito/Pumpportal bundle limit is 5; you selected {}",
        selected.len()
    );

    info!(
        mint,
        wallets = selected.len(),
        sol_per_wallet,
        total_sol = sol_per_wallet * selected.len() as f64,
        "firing buy bundle"
    );

    let bundle_id =
        bundler::execute_buy(&selected, mint, sol_per_wallet, &cfg.network).await?;
    println!("bundle submitted: {bundle_id}");
    println!("track: https://explorer.jito.wtf/bundle/{bundle_id}");
    Ok(())
}

async fn dump(cfg: &Config, mint: &str, wallets: &str) -> Result<()> {
    let (selected, _ks) = load_selected_snipers(wallets)?;
    info!(mint, wallets = selected.len(), "firing sell bundle");
    let bundle_id = bundler::execute_sell(&selected, mint, &cfg.network).await?;
    println!("dump submitted: {bundle_id}");
    println!("track: https://explorer.jito.wtf/bundle/{bundle_id}");
    Ok(())
}

fn load_selected_snipers(spec: &str) -> Result<(Vec<StoredKeypair>, Keystore)> {
    let path = keystore::keystore_path()?;
    let pass = rpassword::prompt_password("keystore passphrase: ")?;
    let ks = keystore::load(&path, &pass)?;

    let selected: Vec<StoredKeypair> = if spec == "all" {
        ks.snipers.clone()
    } else {
        let mut out = Vec::new();
        for tok in spec.split(',') {
            let idx: usize = tok.trim().parse().context("wallet index parse")?;
            let kp = ks
                .snipers
                .get(idx)
                .ok_or_else(|| anyhow::anyhow!("no sniper at index {idx}"))?
                .clone();
            out.push(kp);
        }
        out
    };
    anyhow::ensure!(!selected.is_empty(), "no snipers selected");
    Ok((selected, ks))
}

async fn run_tui(_cfg: &Config) -> Result<()> {
    println!("[milestone 3] live TUI lands next session.");
    println!("today you can: `listen`, `snipe <mint>`, `dump <mint>`.");
    Ok(())
}

fn prompt_new_passphrase() -> Result<String> {
    let p1 = rpassword::prompt_password("set keystore passphrase: ")?;
    anyhow::ensure!(p1.len() >= 12, "passphrase must be >= 12 chars");
    let p2 = rpassword::prompt_password("confirm passphrase: ")?;
    anyhow::ensure!(p1 == p2, "passphrases did not match");
    Ok(p1)
}

fn confirm(prompt: &str, expected: &str) -> Result<()> {
    use std::io::Write;
    print!("{prompt}");
    std::io::stdout().flush().ok();
    let mut s = String::new();
    std::io::stdin().read_line(&mut s)?;
    anyhow::ensure!(s.trim() == expected, "confirmation failed");
    Ok(())
}
