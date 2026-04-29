/**
 * Primary trade wallet — the wallet used for one-click Buy actions across
 * Trenches / Chart / Trade pages. Persisted to localStorage so it sticks
 * between sessions.
 *
 * Quick-buy SOL amount is also persisted here so the button shows what it's
 * about to spend.
 */

const PRIMARY_KEY = "snipebundle:primary_wallet";
const QUICK_BUY_KEY = "snipebundle:quick_buy_sol";

const DEFAULT_QUICK_BUY = 0.05;

export function getPrimaryWallet(): string {
  try {
    return localStorage.getItem(PRIMARY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setPrimaryWallet(pubkey: string): void {
  try {
    localStorage.setItem(PRIMARY_KEY, pubkey);
    // Notify any listening pages so the header / buttons can re-render.
    window.dispatchEvent(new CustomEvent("snipebundle:primary-wallet"));
  } catch {
    /* ignore */
  }
}

export function getQuickBuySol(): number {
  try {
    const raw = localStorage.getItem(QUICK_BUY_KEY);
    if (!raw) return DEFAULT_QUICK_BUY;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUICK_BUY;
  } catch {
    return DEFAULT_QUICK_BUY;
  }
}

export function setQuickBuySol(sol: number): void {
  try {
    localStorage.setItem(QUICK_BUY_KEY, String(sol));
    window.dispatchEvent(new CustomEvent("snipebundle:quick-buy-sol"));
  } catch {
    /* ignore */
  }
}

/**
 * React hook helper — usage:
 *   const [primary, setPrimary] = useActiveWallet();
 * Re-renders when any other component changes the primary wallet.
 */
export function subscribeActiveWallet(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener("snipebundle:primary-wallet", handler);
  return () => window.removeEventListener("snipebundle:primary-wallet", handler);
}
