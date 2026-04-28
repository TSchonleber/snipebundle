use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use snipebundle_core::{
    keystore::{self, Keystore},
    wallet, Config,
};
use std::path::PathBuf;
use tracing::info;

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
    /// Run the live sniper TUI (placeholder until milestone 3)
    Run,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();
    let cfg = Config::load(&cli.config)
        .with_context(|| format!("loading config from {}", cli.config.display()))?;
    info!("config loaded, {} sniper wallets target", cfg.wallets.count);

    match cli.cmd {
        Cmd::Init { wallets } => init(&cfg, wallets),
        Cmd::List => list(),
        Cmd::Reveal => reveal(),
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
    println!("These secrets will be encrypted at rest with your passphrase.");
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

async fn run_tui(_cfg: &Config) -> Result<()> {
    println!("[milestone 3] TUI not yet built. Listener and bundler land in milestones 2-3.");
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
