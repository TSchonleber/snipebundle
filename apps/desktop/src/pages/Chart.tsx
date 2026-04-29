import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { cn } from "@snipebundle/ui";
import { AppNav } from "../components/AppNav";
import { MintChart } from "../components/MintChart";
import { ipc } from "../lib/ipc";

const RECENT_KEY = "snipebundle:recent_mints";
const ACTIVE_KEY = "snipebundle:active_mint";
const MAX_RECENT = 8;

export function Chart() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const urlMint = params.get("mint") ?? "";
  const [mint, setMint] = useState(urlMint || readActive() || "");
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  const [feed, setFeed] = useState<{ mint: string; symbol?: string }[]>([]);

  // Sync URL ←→ local state. URL is the source of truth so back/forward and
  // deep-linking from Trending work. When the input changes we push the new
  // mint into ?mint=, and remember it so other pages can pick it up.
  useEffect(() => {
    if (urlMint && urlMint !== mint) setMint(urlMint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlMint]);

  useEffect(() => {
    if (mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      writeActive(mint);
      setRecents((r) => bumpRecent(r, mint));
    }
  }, [mint]);

  // Pull live mint feed from the engine so the user can pivot from anything
  // currently being watched without copy-pasting. Polls cheaply (1s) — same
  // cadence as Sniper dashboard — and skips silently if the engine is off.
  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    async function tick() {
      try {
        const s = await ipc.getState();
        if (mounted && s) {
          setFeed(
            (s.feed ?? [])
              .slice(0, 12)
              .map((e) => ({
                mint: e.mint,
                symbol: e.symbol ?? undefined,
              })),
          );
        }
      } catch {
        /* engine probably stopped — ignore */
      }
      if (mounted) timer = window.setTimeout(tick, 1500);
    }
    tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  function commitMint(next: string) {
    const v = next.trim();
    setMint(v);
    if (v) {
      setParams({ mint: v }, { replace: true });
    } else {
      setParams({}, { replace: true });
    }
  }

  function clearRecents() {
    writeRecents([]);
    setRecents([]);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <AppNav status="stopped" />
      <div className="mx-auto w-full max-w-6xl px-5 py-4 flex flex-col flex-1">
        {/* Big input row */}
        <div className="flex items-center gap-3 border-b border-border pb-3">
          <span className="font-mono text-2xs text-fg-subtle shrink-0">
            mint &gt;
          </span>
          <input
            value={mint}
            onChange={(e) => commitMint(e.target.value)}
            placeholder="paste pump.fun mint address — or click any recent / live mint below"
            spellCheck={false}
            autoFocus
            className="flex-1 border-b border-transparent bg-transparent px-1 py-1 font-mono text-sm focus:outline-none focus:border-accent placeholder:text-fg-subtle/60"
          />
          {mint && (
            <button
              type="button"
              onClick={() => commitMint("")}
              className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
              title="clear"
            >
              clear
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate(`/trade?mint=${encodeURIComponent(mint)}`)}
            disabled={!mint}
            className="font-mono text-2xs px-2.5 py-1 border border-accent/40 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="open in trade page"
          >
            trade →
          </button>
        </div>

        {/* Suggestion strip: recent + live feed */}
        <div className="flex flex-wrap items-center gap-3 mt-2 mb-3">
          {recents.length > 0 && (
            <SuggestionGroup
              label="recent"
              items={recents.map((m) => ({ mint: m }))}
              activeMint={mint}
              onPick={commitMint}
              onClear={clearRecents}
            />
          )}
          {feed.length > 0 && (
            <SuggestionGroup
              label="live"
              items={feed}
              activeMint={mint}
              onPick={(m) => commitMint(m)}
            />
          )}
        </div>

        {/* Chart fills the rest of the screen */}
        <div className="flex-1 min-h-[420px]">
          <MintChart mint={mint} height={undefined as unknown as number} />
        </div>
      </div>
    </div>
  );
}

function SuggestionGroup({
  label,
  items,
  activeMint,
  onPick,
  onClear,
}: {
  label: string;
  items: { mint: string; symbol?: string }[];
  activeMint: string;
  onPick: (mint: string) => void;
  onClear?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="font-mono text-2xs text-fg-subtle">{label}</span>
      {items.map((it) => {
        const active = it.mint === activeMint;
        return (
          <button
            key={it.mint}
            type="button"
            onClick={() => onPick(it.mint)}
            title={it.mint}
            className={cn(
              "font-mono text-2xs px-2 py-0.5 border transition-colors",
              active
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {it.symbol ?? `${it.mint.slice(0, 4)}..${it.mint.slice(-4)}`}
          </button>
        );
      })}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="font-mono text-2xs text-fg-subtle hover:text-danger px-1"
          title="clear recents"
        >
          ×
        </button>
      )}
    </div>
  );
}

function readActive(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeActive(v: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, v);
  } catch {
    /* ignore */
  }
}
function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}
function writeRecents(v: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
function bumpRecent(curr: string[], v: string): string[] {
  const next = [v, ...curr.filter((x) => x !== v)].slice(0, MAX_RECENT);
  writeRecents(next);
  return next;
}
