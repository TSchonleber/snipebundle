import type { Metadata } from "next";
import "@snipebundle/ui/styles.css";
import "./globals.css";

const TITLE = "snipebundle — pump.fun launch sniper";
const DESCRIPTION =
  "Snipe pump.fun token launches the moment a dev mints. Configurable filters, targeted dev tracking, TP/SL/time exits. Runs on your machine — never custodial, never holds your keys.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "snipebundle",
  authors: [{ name: "snipebundle" }],
  keywords: [
    "pump.fun",
    "solana",
    "sniper",
    "jito",
    "memecoin",
    "trading bot",
    "non-custodial",
  ],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "snipebundle",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
  },
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
