import type { Metadata } from "next";
import "@snipebundle/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "snipebundle — pump.fun launch sniper",
  description:
    "Snipe pump.fun token launches the moment a dev mints. Configurable filters, targeted dev tracking, 60-second time exits. Runs on your machine. Never custodial.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
