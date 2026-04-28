# snipebundle

Pump.fun launch sniper. Desktop app + marketing/live-feed site.

## Repo layout

```
snipebundle/
├── apps/
│   ├── desktop/              # Tauri 2 desktop app — the actual product
│   │   ├── src/              # React + Vite frontend
│   │   └── src-tauri/        # Rust IPC layer (workspace member)
│   └── web/                  # Next.js 15 site, deploys to Vercel
│       ├── app/              # landing, /live, /demo, /download
│       └── ...
├── packages/
│   └── ui/                   # shared React components + Tailwind preset + TS types
├── crates/
│   ├── core/                 # Rust core: keystore, listener, bundler, engine, exit
│   └── tui/                  # ratatui dev/admin TUI
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
└── Cargo.toml                # Rust workspace
```

## Quickstart (developers)

Prereqs: Node ≥20, pnpm ≥9, Rust ≥1.80, on macOS optionally Xcode CLT.
For Tauri builds: see <https://v2.tauri.app/start/prerequisites/>.

```bash
# install npm packages
pnpm install

# run the marketing site (http://localhost:3000)
pnpm dev:web

# run the desktop app in Tauri dev mode (auto-spins Vite at :5173)
pnpm tauri:dev

# rust-only TUI for hot-path development
cargo run -p snipebundle-tui -- --config config.toml run
```

## Building installers

Cross-platform builds run automatically via GitHub Actions when you push a tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
# → CI builds .msi (Windows), .dmg (macOS universal), .AppImage + .deb (Linux)
# → uploads them to a fresh GitHub Release named "snipebundle v0.1.0"
```

For local builds:

```bash
# regenerate placeholder icons (one-time after fresh clone)
python3 tools/gen_icons.py

# build for your current platform
pnpm tauri:build
```

Outputs go to `apps/desktop/src-tauri/target/release/bundle/`. Cross-compiling
to other platforms locally is fragile; just use the GitHub Actions workflow.

### Icons

`tools/gen_icons.py` produces a placeholder logo (dark bg + accent triangle).
When you have real brand art, replace by running:

```bash
cargo install tauri-cli --version "^2"
cargo tauri icon path/to/real-logo.png
```

That regenerates every required size + format including macOS `.icns`.

## Deploying the site

The site lives at `apps/web` and deploys to Vercel. Point Vercel at the repo,
set **Root Directory** = `apps/web`, framework = Next.js. The included
`vercel.json` handles the monorepo build (`pnpm install` at the workspace root,
then `pnpm --filter snipebundle-web build`).

## Architecture decisions

- **No custody, ever.** The site is marketing + a public live-feed; the actual
  sniper is a desktop app with keys on the user's disk. Going custodial would
  pull us into MSB / broker-dealer regulation territory. Decision logged to
  brainctl id 142.
- **Same React component library powers both.** `packages/ui` is consumed by
  `apps/web` (Next.js) and `apps/desktop` (Vite + Tauri). Marketing previews
  look 1:1 with the real product.
- **Rust core is reusable.** `crates/core` powers the Tauri backend, the
  ratatui dev TUI, and CI tools. WebSocket listener, Jito bundler, encrypted
  keystore, engine — all in one place.

## Status

- [x] M1 — Rust scaffold, encrypted keystore, wallet generation
- [x] M2 — Pumpportal WS listener, Jito bundler, manual snipe/dump CLI
- [x] M3 — Engine, auto + targeted-dev triggers, time-based 60s exit, ratatui
- [x] M5a — Tauri 2 GUI scaffold + IPC commands wrapping core
- [x] M5b — pnpm/turbo monorepo, Next.js web (landing, /live, /demo, /download),
       desktop frontend wizard (welcome → wallets → funding → mode → dashboard),
       shared `@snipebundle/ui` component library
- [x] M5c — placeholder icons (`tools/gen_icons.py`), Tauri capabilities,
       GitHub Actions release + CI workflows
- [x] M6  — atomic legit launch bundle (create + dev buy)
- [x] M6.5 — manual buy/sell with wallet picker (Trade page)
- [x] M7  — TP/SL via per-position price polling (PumpPortal subscribeTokenTrade
       per active mint), live unrealized P&L in dashboard
- [x] M8  — wallet funding UX (user-driven, no fan-out): live SOL balance
       polling per wallet, copy address + QR, status indicators on the Wallets
       and onboarding Funding pages. snipebundle never moves SOL on the user's
       behalf — funding source is the user's choice.
- [ ] M9 — code-signed installers, Apple notarization, in-app updater wiring

## Repos / hosting

- **Source** (private): <https://github.com/TSchonleber/snipebundle>
- **Public installers**: <https://github.com/TSchonleber/snipebundle-releases>
  — auto-published from CI on every tag push. Apache-2.0 licensed.
- **Web** (Vercel): deploys from this repo's workspace root with `vercel.json`
  pointing the build at `apps/web`.
- **R2 mirror** (optional): set `R2_ACCOUNT_ID`, `R2_BUCKET`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` GitHub Actions secrets, plus a
  `NEXT_PUBLIC_DL_BASE` env var on Vercel pointing at the R2 custom domain
  (e.g. `https://dl.snipebundle.app/latest`). Download buttons auto-switch.

## Required CI secrets

Set these in <https://github.com/TSchonleber/snipebundle/settings/secrets/actions>:

| Secret | Purpose | Required? |
|---|---|---|
| `RELEASES_REPO_PAT` | Fine-scoped PAT with `contents:write` on `TSchonleber/snipebundle-releases`. Used by the publish job to push installers to the public repo. | **yes for releases** |
| `R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare R2 mirror. | optional |

Without `RELEASES_REPO_PAT`, the build job still runs but the publish job fails
with a clear error. Tag pushes that should produce releases need the PAT set.

See [USER_GUIDE.md](USER_GUIDE.md) for the non-technical install + use guide.
