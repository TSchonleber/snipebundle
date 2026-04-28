# snipebundle

Pump.fun launch sniper. Rust workspace, ratatui TUI, Tauri GUI (planned).

## Status

Milestones 1 + 2 shipped. Working CLI:

```
cargo run -- init                      # generate master + N snipers, encrypt
cargo run -- list                      # print pubkeys
cargo run -- reveal                    # print private keys (with confirmation)
cargo run -- listen                    # stream new pump.fun mints from WS
cargo run -- listen --limit 20         # stream 20 then exit
cargo run -- snipe <MINT> --sol 0.1    # build → sign → submit Jito buy bundle
cargo run -- snipe <MINT> --wallets 0,1,2 --sol 0.05
cargo run -- dump <MINT>               # exit positions on this mint via Jito
```

`run` (live TUI w/ auto-snipe) lands in M3 along with filter & targeted-dev triggers and the 60s exit watcher.

## Trigger modes

- **Auto** — listens to every new pump.fun mint, snipes when filters pass
  (`min_dev_buy_pct`, `require_socials`, `max_entry_mc_sol`, funder blacklist).
- **Targeted Dev** — watchlist of dev wallet addresses; the moment any of them
  creates a token, the bundle ships. Bypasses auto filters by default.

Both feed the same execute pipeline: build bundle → sign → submit Jito → exit watcher.

## Limits

- 1–10 sniper wallets per session
- 5 SOL per wallet hard cap
- 60s default max hold (capped at 600)
- 5 transactions per Jito bundle (Pumpportal API ceiling)

## Funding

Direct fan-out from master wallet. No mixer. Fund the master with SOL,
the app splits to snipers in one batch tx with a configurable reserve.

## Hot path

```
pumpportal WS  →  filter / watchlist match  →  POST /api/trade-local
              →  sign N txs locally
              →  Jito sendBundle
              →  per-position exit watcher (TP / SL / 60s)
```

Jito tip rides on `priorityFee` of tx[0]; subsequent priorityFees are ignored
by Pumpportal per their docs.

## Roadmap

- [x] M1 — scaffold, keystore, wallet gen
- [x] M2 — listener, bundler, Jito submit, manual snipe/dump CLI
- [ ] M3 — filter/targeted-dev triggers, exit watcher, ratatui TUI
- [ ] M4 — fund-fanout from master, balance polling
- [ ] M5 — Tauri GUI

## Security

- Keystore at `~/Library/Application Support/snipebundle/keystore.bin` (macOS)
  encrypted with argon2id-derived key + chacha20-poly1305.
- Secrets shown once at init, never logged, zeroized on drop.
- `config.toml` and `keystore.bin` are gitignored.
