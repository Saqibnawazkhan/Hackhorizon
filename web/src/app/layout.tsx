import type { Metadata, Viewport } from "next";

import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "AgentFlow — Autonomous business workflows",
    template: "%s · AgentFlow",
  },
  description:
    "Agentic AI for autonomous business workflow execution. Plan, execute, " +
    "score, validate and approve — with the reasoning visible at every step.",
  applicationName: "AgentFlow",
};

export const viewport: Viewport = {
  themeColor: "#eef5f9",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Instrument Sans is the design's typeface; the weights below are the
            four the design file loads. Preconnect first so the first paint is
            not held on a cold DNS lookup. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      {/* Browser extensions (Grammarly, ColorZilla, password managers) inject
          attributes onto <body> before React hydrates — data-gr-ext-installed,
          cz-shortcut-listen and friends. React sees the server HTML and the
          client tree disagree and reports a hydration mismatch that is not
          ours and cannot be fixed from here. Suppression is scoped to this one
          element's attributes; it does NOT extend to children, so a real
          mismatch inside the app still reports normally. */}
      <body className="antialiased" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
