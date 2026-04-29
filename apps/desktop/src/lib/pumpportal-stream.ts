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

function handleMessage(raw: any) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  // PumpPortal's messages don't include a `kind` field — we infer from
  // the shape. Trade events have txType + mint; new-token events have
  // mint + name + creator (often) and lack txType; migration events
  // include either `pool` field or a top-level migration marker.
  // Heartbeats / ack messages get filtered out by the lack of mint.
  if (typeof msg !== "object" || !msg) return;
  const mint = msg.mint;
  if (typeof mint !== "string") return;

  const now = Date.now();
  if (msg.txType) {
    const ev: TokenTradeEvent = {
      kind: "token_trade",
      mint,
      trader: msg.traderPublicKey ?? msg.trader ?? undefined,
      tx_type: String(msg.txType).toLowerCase() === "sell" ? "sell" : "buy",
      sol_amount: Number(msg.solAmount) || 0,
      token_amount: Number(msg.tokenAmount) || 0,
      v_sol_in_curve: optNumber(msg.vSolInBondingCurve),
      v_tokens_in_curve: optNumber(msg.vTokensInBondingCurve),
      market_cap_sol: optNumber(msg.marketCapSol),
      received_at_ms: now,
      raw: msg,
    };
    fanout(ev);
    return;
  }
  // Migrations have a `txType=create` or `migration` marker on some
  // schemas; the most reliable signal we've seen is `migration: true` or
  // the message landing on the migration topic. Fall through to new_token
  // otherwise — token-creation events typically include `name` + `symbol`.
  if (msg.migration === true || msg.event === "migration") {
    const ev: MigrationEvent = {
      kind: "migration",
      mint,
      pool: msg.pool,
      signature: msg.signature,
      received_at_ms: now,
      raw: msg,
    };
    fanout(ev);
    return;
  }
  if (msg.name || msg.symbol || msg.creator) {
    const ev: NewTokenEvent = {
      kind: "new_token",
      mint,
      name: msg.name,
      symbol: msg.symbol,
      image_uri: msg.imageUri ?? msg.image_uri ?? msg.image,
      description: msg.description,
      creator: msg.creator ?? msg.traderPublicKey,
      initial_buy_sol: optNumber(msg.initialBuy ?? msg.solAmount),
      pool: msg.pool,
      v_sol_in_curve: optNumber(msg.vSolInBondingCurve),
      v_tokens_in_curve: optNumber(msg.vTokensInBondingCurve),
      market_cap_sol: optNumber(msg.marketCapSol),
      uri: msg.uri,
      twitter: msg.twitter,
      telegram: msg.telegram,
      website: msg.website,
      received_at_ms: now,
      raw: msg,
    };
    fanout(ev);
  }
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
