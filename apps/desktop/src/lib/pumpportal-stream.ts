/**
 * Single shared WebSocket connection to PumpPortal's streaming API
 * (`wss://pumpportal.fun/api/data`). Used by Trenches + future pages so we
 * don't open one socket per subscription per component.
 *
 * Subscriptions exposed:
 *   - subscribeNewToken     → fired for every new pump.fun token created
 *   - subscribeMigration    → fired when a token graduates to Raydium
 *   - subscribeTokenTrade   → trades for specific mints (used by chart)
 *
 * Components register listeners; the manager handles the underlying WS
 * lifecycle, reconnects on close with backoff, and re-issues subscriptions
 * after a reconnect.
 */

const URL = "wss://pumpportal.fun/api/data";
const RECONNECT_MS = 1500;

export type StreamEventKind = "new_token" | "migration" | "token_trade";

export interface NewTokenEvent {
  kind: "new_token";
  mint: string;
  name?: string;
  symbol?: string;
  image_uri?: string;
  description?: string;
  creator?: string;
  initial_buy_sol?: number;
  pool?: string;
  v_sol_in_curve?: number;
  v_tokens_in_curve?: number;
  market_cap_sol?: number;
  uri?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  // Wall-clock timestamp when our client received the event.
  received_at_ms: number;
  raw: any;
}

export interface MigrationEvent {
  kind: "migration";
  mint: string;
  pool?: string;
  signature?: string;
  received_at_ms: number;
  raw: any;
}

export interface TokenTradeEvent {
  kind: "token_trade";
  mint: string;
  trader?: string;
  tx_type: "buy" | "sell";
  sol_amount: number;
  token_amount: number;
  v_sol_in_curve?: number;
  v_tokens_in_curve?: number;
  market_cap_sol?: number;
  received_at_ms: number;
  raw: any;
}

export type StreamEvent = NewTokenEvent | MigrationEvent | TokenTradeEvent;

type Listener = (ev: StreamEvent) => void;

interface State {
  ws: WebSocket | null;
  open: boolean;
  // Refcounted subscriptions so multiple components can subscribe to the
  // same channel without the first unmount killing it for everyone else.
  newTokenRefs: number;
  migrationRefs: number;
  tradeRefs: Map<string, number>;
  listeners: Set<Listener>;
  // Tracks how many opens we've signalled — used to detect reconnects.
  generation: number;
  reconnectTimer?: number;
}

const state: State = {
  ws: null,
  open: false,
  newTokenRefs: 0,
  migrationRefs: 0,
  tradeRefs: new Map(),
  listeners: new Set(),
  generation: 0,
};

function ensureSocket() {
  if (state.ws) return;
  try {
    state.ws = new WebSocket(URL);
  } catch (e) {
    console.warn("pumpportal ws construct failed", e);
    return;
  }
  state.ws.addEventListener("open", () => {
    state.open = true;
    state.generation++;
    notifyConnectivity();
    // Re-issue current subscriptions on (re)connect.
    if (state.newTokenRefs > 0) send({ method: "subscribeNewToken" });
    if (state.migrationRefs > 0) send({ method: "subscribeMigration" });
    const mints = Array.from(state.tradeRefs.keys());
    if (mints.length > 0)
      send({ method: "subscribeTokenTrade", keys: mints });
  });
  state.ws.addEventListener("message", (ev) => handleMessage(ev.data));
  state.ws.addEventListener("close", () => {
    state.open = false;
    state.ws = null;
    notifyConnectivity();
    if (totalRefs() > 0) {
      state.reconnectTimer = window.setTimeout(ensureSocket, RECONNECT_MS);
    }
  });
  state.ws.addEventListener("error", () => {
    // Let close handler drive reconnect.
  });
}

function totalRefs(): number {
  let trades = 0;
  for (const n of state.tradeRefs.values()) trades += n;
  return state.newTokenRefs + state.migrationRefs + trades;
}

function send(payload: object) {
  if (!state.ws || !state.open) return;
  try {
    state.ws.send(JSON.stringify(payload));
  } catch (e) {
    console.warn("pumpportal ws send failed", e);
  }
}

/** Notify listeners that the connection state changed. */
function notifyConnectivity() {
  for (const l of connectivityListeners) l(state.open);
}

const connectivityListeners = new Set<(connected: boolean) => void>();

export function onConnectivityChange(
  cb: (connected: boolean) => void,
): () => void {
  connectivityListeners.add(cb);
  cb(state.open);
  return () => {
    connectivityListeners.delete(cb);
  };
}

// Diagnostic: counts of each event kind plus unknown messages, exposed so
// the Trenches header can show 'X new / Y mig / Z trade / U unknown' for
// debugging. Bumps on every parsed message; consumers don't need to read
// these but they're handy when wiring is wrong.
export const streamCounters = {
  new_token: 0,
  migration: 0,
  token_trade: 0,
  unknown: 0,
  total: 0,
  lastUnknown: null as null | { snippet: string; at: number },
};

// Sliding 60s window of timestamps — enables "events / min" displays so we
// can see live throughput in the UI.
const RATE_WINDOW_MS = 60_000;
const rateTimestamps: number[] = [];

// Last 8 raw messages — peeked into via the diagnostic strip's expand button.
const RAW_BUFFER_CAP = 8;
export const recentRaw: { kind: string; snippet: string; at: number }[] = [];

function bumpCounter(kind: keyof typeof streamCounters | "unknown") {
  streamCounters.total++;
  if (kind === "new_token") streamCounters.new_token++;
  else if (kind === "migration") streamCounters.migration++;
  else if (kind === "token_trade") streamCounters.token_trade++;
  else streamCounters.unknown++;
  const now = Date.now();
  rateTimestamps.push(now);
  // Drop entries older than the window.
  while (
    rateTimestamps.length > 0 &&
    rateTimestamps[0] < now - RATE_WINDOW_MS
  ) {
    rateTimestamps.shift();
  }
  for (const cb of counterListeners) cb();
}

export function eventsPerMinute(): number {
  return rateTimestamps.length;
}

function recordRaw(kind: string, snippet: string) {
  recentRaw.unshift({ kind, snippet, at: Date.now() });
  if (recentRaw.length > RAW_BUFFER_CAP) recentRaw.length = RAW_BUFFER_CAP;
}

const counterListeners = new Set<() => void>();
export function onCountersChange(cb: () => void): () => void {
  counterListeners.add(cb);
  return () => {
    counterListeners.delete(cb);
  };
}

function handleMessage(raw: any) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof msg !== "object" || !msg) return;

  // Subscription acks land here without a `mint` — looks like
  // {"message":"Successfully subscribed ..."}. Just ignore.
  const mint = msg.mint;
  if (typeof mint !== "string") return;

  const now = Date.now();
  // Order matters. PumpPortal's NEW TOKEN events have BOTH `txType: "create"`
  // AND a `name`/`symbol` payload. If we routed by `txType` first the
  // creates would land in the trade branch and never reach the new-token
  // listeners. Detect creates explicitly first.
  const txType = String(msg.txType ?? "").toLowerCase();

  if (txType === "create" || msg.name != null || msg.symbol != null) {
    const ev: NewTokenEvent = {
      kind: "new_token",
      mint,
      name: optString(msg.name),
      symbol: optString(msg.symbol),
      image_uri:
        optString(msg.imageUri) ??
        optString(msg.image_uri) ??
        optString(msg.image),
      description: optString(msg.description),
      creator: optString(msg.creator) ?? optString(msg.traderPublicKey),
      initial_buy_sol: optNumber(msg.initialBuy ?? msg.solAmount),
      pool: optString(msg.pool),
      v_sol_in_curve: optNumber(msg.vSolInBondingCurve),
      v_tokens_in_curve: optNumber(msg.vTokensInBondingCurve),
      market_cap_sol: optNumber(msg.marketCapSol),
      uri: optString(msg.uri),
      twitter: optString(msg.twitter),
      telegram: optString(msg.telegram),
      website: optString(msg.website),
      received_at_ms: now,
      raw: msg,
    };
    bumpCounter("new_token");
    recordRaw("new_token", JSON.stringify(msg).slice(0, 220));
    fanout(ev);
    return;
  }

  if (txType === "buy" || txType === "sell") {
    const ev: TokenTradeEvent = {
      kind: "token_trade",
      mint,
      trader: optString(msg.traderPublicKey) ?? optString(msg.trader),
      tx_type: txType === "sell" ? "sell" : "buy",
      sol_amount: Number(msg.solAmount) || 0,
      token_amount: Number(msg.tokenAmount) || 0,
      v_sol_in_curve: optNumber(msg.vSolInBondingCurve),
      v_tokens_in_curve: optNumber(msg.vTokensInBondingCurve),
      market_cap_sol: optNumber(msg.marketCapSol),
      received_at_ms: now,
      raw: msg,
    };
    bumpCounter("token_trade");
    recordRaw("token_trade", JSON.stringify(msg).slice(0, 220));
    fanout(ev);
    return;
  }

  if (
    txType === "migrate" ||
    msg.migration === true ||
    msg.event === "migration" ||
    // Migration topic events occasionally arrive as `{"mint":"…","pool":"pump-amm"}`
    // with no other markers — recognise them by a non-pump pool with no txType.
    (typeof msg.pool === "string" &&
      msg.pool.toLowerCase() !== "pump" &&
      !txType)
  ) {
    const ev: MigrationEvent = {
      kind: "migration",
      mint,
      pool: optString(msg.pool),
      signature: optString(msg.signature),
      received_at_ms: now,
      raw: msg,
    };
    bumpCounter("migration");
    recordRaw("migration", JSON.stringify(msg).slice(0, 220));
    fanout(ev);
    return;
  }

  // Unknown shape. Keep a small breadcrumb for debugging without spamming.
  bumpCounter("unknown");
  const snippet = JSON.stringify(msg).slice(0, 200);
  streamCounters.lastUnknown = { snippet, at: now };
  recordRaw("unknown", snippet);
}

function optString(v: any): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optNumber(v: any): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function fanout(ev: StreamEvent) {
  for (const l of state.listeners) {
    try {
      l(ev);
    } catch (e) {
      console.warn("pumpportal listener threw", e);
    }
  }
}

/** Add a listener for ALL stream events. Returns an unsubscribe fn. */
export function onStreamEvent(cb: Listener): () => void {
  state.listeners.add(cb);
  return () => {
    state.listeners.delete(cb);
  };
}

export function subscribeNewToken(): () => void {
  state.newTokenRefs++;
  ensureSocket();
  if (state.open && state.newTokenRefs === 1) {
    send({ method: "subscribeNewToken" });
  }
  return () => {
    state.newTokenRefs = Math.max(0, state.newTokenRefs - 1);
    if (state.newTokenRefs === 0 && state.open) {
      send({ method: "unsubscribeNewToken" });
    }
  };
}

export function subscribeMigration(): () => void {
  state.migrationRefs++;
  ensureSocket();
  if (state.open && state.migrationRefs === 1) {
    send({ method: "subscribeMigration" });
  }
  return () => {
    state.migrationRefs = Math.max(0, state.migrationRefs - 1);
    if (state.migrationRefs === 0 && state.open) {
      send({ method: "unsubscribeMigration" });
    }
  };
}

export function subscribeTokenTrade(mint: string): () => void {
  const next = (state.tradeRefs.get(mint) ?? 0) + 1;
  state.tradeRefs.set(mint, next);
  ensureSocket();
  if (state.open && next === 1) {
    send({ method: "subscribeTokenTrade", keys: [mint] });
  }
  return () => {
    const cur = (state.tradeRefs.get(mint) ?? 0) - 1;
    if (cur <= 0) {
      state.tradeRefs.delete(mint);
      if (state.open) {
        send({ method: "unsubscribeTokenTrade", keys: [mint] });
      }
    } else {
      state.tradeRefs.set(mint, cur);
    }
  };
}

export function isConnected(): boolean {
  return state.open;
}
