import { NavLink } from "react-router-dom";
import { cn, StatusBadge } from "@snipebundle/ui";

interface AppNavProps {
  status: "live" | "paused" | "stopped";
}

const TABS = [
  { to: "/dashboard", label: "sniper" },
  { to: "/trenches", label: "trenches" },
  { to: "/chart", label: "chart" },
  { to: "/trade", label: "trade" },
  { to: "/launch", label: "launch" },
  { to: "/trending", label: "trending" },
  { to: "/wallets", label: "wallets" },
];

export function AppNav({ status }: AppNavProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-bg/95 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between px-5">
        <div className="flex items-center gap-7">
          <BrandMark />
          <nav className="flex items-center">
            {TABS.map((t, i) => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  cn(
                    "relative font-mono text-[12px] transition-colors px-3 py-2",
                    "after:absolute after:left-2 after:right-2 after:bottom-0 after:h-px after:bg-accent after:transition-opacity",
                    isActive
                      ? "text-fg after:opacity-100"
                      : "text-fg-subtle hover:text-fg-muted after:opacity-0",
                    i > 0 && "ml-0.5",
                  )
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <StatusBadge status={status} />
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <a
      href="/"
      className="group flex items-baseline gap-0 font-mono text-[13px] text-fg select-none"
    >
      <span className="text-accent">$</span>
      <span className="ml-1.5 tracking-tight2">snipebundle</span>
      <span className="ml-0.5 text-accent caret-blink">_</span>
    </a>
  );
}
