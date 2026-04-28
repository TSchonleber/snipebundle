import { NavLink } from "react-router-dom";
import { cn, StatusBadge } from "@snipebundle/ui";

interface AppNavProps {
  status: "live" | "paused" | "stopped";
}

const TABS = [
  { to: "/dashboard", label: "Sniper" },
  { to: "/trade", label: "Trade" },
  { to: "/launch", label: "Launch" },
];

export function AppNav({ status }: AppNavProps) {
  return (
    <header className="border-b border-border/60 bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <span className="font-mono text-sm font-bold tracking-wider">
            ▶ snipebundle
          </span>
          <nav className="flex items-center gap-1">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-bg-raised text-fg"
                      : "text-fg-muted hover:text-fg hover:bg-bg-raised",
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
