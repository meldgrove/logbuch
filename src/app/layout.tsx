import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Logbuch", template: "%s · Logbuch" },
  description: "Decisions, updates, and learnings of your organization in one place.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request: the CSP nonce is new for each response,
  // and almost every page depends on the session.
  await connection();
  return (
    <html lang="en-US">
      <body>{children}</body>
    </html>
  );
}
