# snipebundle — user guide

## What this is

Pump.fun launch sniper. Watches new token launches, fires Jito bundles to buy
the moment a dev mints, exits in 60 seconds.

It runs **on your machine**. Your keys stay on your disk, encrypted. No server,
no custody, no account. The website (snipebundle.app) is just the storefront +
a live feed you can watch without installing.

## Install

1. Go to [snipebundle.app/download](https://snipebundle.app/download)
2. Click the button for your OS (Windows / macOS / Linux)
3. Run the installer

That's it. There's no account to create, nothing to sign up for.

## First run

The app walks you through it. Five screens:

### 1. Welcome
A brief safety read. Click **Get started**.

### 2. Set passphrase + generate wallets
- Pick a passphrase (≥12 chars). This encrypts your keys on disk.
- Pick how many sniper wallets you want (1–10, default 5).
- Click **Generate wallets**.
- The app shows you all the keys, **once**. Copy them somewhere safe.
- Check **I have saved these keys** and click **Continue**.

### 3. Fund
- The app shows your **master wallet** address.
- Send SOL to it from any source — Coinbase, Kraken, Phantom, your hardware
  wallet, whatever. Recommended: ~0.55 SOL per sniper wallet (0.5 to spend +
  0.05 for fees).
- Click **I've sent it**.

### 4. Pick a mode
- **Both** (recommended): Auto-snipes everything matching your filters AND
  instantly fires when a tracked dev wallet mints.
- **Targeted only**: Only fires for dev wallets on your list. Quietest.
- **Auto only**: Fires on every mint that passes filters. Loudest.

For Auto, pick a preset — Conservative, Standard, Aggressive. Standard is fine
for most people.

For Targeted, paste dev wallet addresses, one per line.

### 5. Dashboard
Big **GO LIVE** button. Click it. Watch the feed. Snipes happen automatically.

You can pause anytime, change settings, dump positions manually.

## What to expect

- Most pump.fun launches fail. Most snipes lose money. **Size accordingly.**
- Average snipe holds for 60 seconds, then auto-sells regardless of price.
- Configurable: take-profit %, stop-loss %, hold time, dev-buy %, social
  filter, market cap cap, dev wallet blacklist/watchlist.

## Safety

- Your keys are encrypted on disk with argon2id + chacha20-poly1305.
- We never see them. There's no server. The website doesn't have a database.
- If your computer is compromised, your keys are at risk like any local
  software wallet. Use it on a clean machine if you can.
- If you forget your passphrase, your wallets are gone. There is no recovery.

## Updating

The app checks for updates on launch. Click **Update** when prompted.

## Uninstall

- **Windows**: Settings → Apps → snipebundle → Uninstall
- **macOS**: Move snipebundle.app to the Trash
- **Linux**: Delete the AppImage

To wipe your keystore too:
- **Windows**: delete `%APPDATA%\snipebundle\`
- **macOS**: delete `~/Library/Application Support/snipebundle/`
- **Linux**: delete `~/.local/share/snipebundle/`

## Disclaimer

This is automated trading software for pump.fun memecoins. You can lose all
your money. We don't operate the trading. You operate it. We just shipped the
code.
