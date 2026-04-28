import { Outlet, useLocation } from "react-router-dom";

export default function App() {
  const loc = useLocation();
  const isDashboard = loc.pathname === "/dashboard";
  return (
    <div className="min-h-screen bg-bg text-fg">
      {!isDashboard && (
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
