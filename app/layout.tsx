import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Research Agent Demo",
  description: "An observable research workflow from question to cited report.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
