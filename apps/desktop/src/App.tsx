import { Outlet, useLocation } from "react-router-dom";

const APP_NAV_ROUTES = new Set(["/dashboard", "/trade", "/launch"]);

export default function App() {
  const loc = useLocation();
  const inApp = APP_NAV_ROUTES.has(loc.pathname);
  return (
    <div className="min-h-screen bg-bg text-fg">
      {!inApp && (
        <header className="border-b border-border/60 bg-bg/80 backdrop-blur-xl">
          <div className="mx-auto flex h-12 max-w-4xl items-center px-6">
            <span className="font-mono text-sm font-bold tracking-wider">
              ▶ snipebundle
            </span>
          </div>
        </header>
      )}
      <Outlet />
    </div>
  );
}
