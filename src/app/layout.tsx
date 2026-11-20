import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import tokens from "../../design-tokens.json";
import "./globals.css";

export const metadata: Metadata = {
  title: "Edgey — The cutting room",
  description: "Replacement blades for digital cutters and plotters.",
};

export const viewport: Viewport = { themeColor: tokens.themes.dark.page };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" data-theme={tokens.defaultState.theme}>
      <body>{children}</body>
    </html>
  );
}
