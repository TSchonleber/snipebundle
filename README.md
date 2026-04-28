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

The desktop app produces native installers:

```bash
pnpm tauri:build
```

Outputs go to `apps/desktop/src-tauri/target/release/bundle/`:
- macOS: `.dmg` and `.app`
- Windows: `.msi` (WiX) and `.exe` (NSIS) — only when built on Windows
- Linux: `.AppImage` and `.deb` — only when built on Linux

Cross-platform builds run via GitHub Actions on tag push (see
`.github/workflows/release.yml` once added).

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
- [ ] M5c — wire actual installer artifacts (icons, GitHub Actions release)
- [ ] M6 — TP/SL via per-position price polling
- [ ] M7 — fund-fanout from master, balance polling, in-app updater

## Repos / hosting

- Source: <https://github.com/TSchonleber/snipebundle> (private)
- Web: deploys to Vercel (point at `apps/web`)
- Desktop installers: GitHub Releases (`apps/desktop/src-tauri/target/release/bundle/`)

See [USER_GUIDE.md](USER_GUIDE.md) for the non-technical install + use guide.
