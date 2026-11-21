import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Masthead } from "@/components/masthead";
import { SearchShortcut } from "@/components/search-shortcut";
import { SelectionDialog } from "@/components/selection-dialog";
import { SelectionProvider } from "@/components/selection-provider";
import { SiteFooter } from "@/components/site-footer";
import { SkipLink } from "@/components/skip-link";
import { WordmarkSprite } from "@/components/wordmark";
import { indexableSiteOrigin } from "@/lib/catalogue/indexable-site";
import tokens from "../../design-tokens.json";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Edgey — The cutting room", template: "%s | Edgey" },
  description:
    "Edgey’s digital cutting room. Explore replacement blades for print, packaging and display by tool type, material or part number.",
  robots: indexableSiteOrigin() ? undefined : { index: false, follow: false },
};

const themeScript = `{
  let theme = ${JSON.stringify(tokens.defaultState.theme)};
  try { if (localStorage.getItem('edgey-theme') === 'light') theme = 'light'; } catch {}
  document.documentElement.dataset.theme = theme;
  const color = document.createElement('meta');
  color.name = 'theme-color';
  color.content = theme === 'light' ? ${JSON.stringify(tokens.themes.light.page)} : ${JSON.stringify(tokens.themes.dark.page)};
  document.head.append(color);
}`;

export default function RootLayout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  return (
    <html lang="en-GB" data-theme={tokens.defaultState.theme} suppressHydrationWarning>
      <head>
        <noscript dangerouslySetInnerHTML={{ __html: `<meta name="theme-color" content="${tokens.themes.dark.page}">` }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body id="top">
        <WordmarkSprite />
        <SkipLink />
        <SelectionProvider>
          <Masthead />
          {children}
          {modal}
          <SelectionDialog />
        </SelectionProvider>
        <SiteFooter />
        <SearchShortcut />
      </body>
    </html>
  );
}
