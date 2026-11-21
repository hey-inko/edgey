"use client";

import { useServerInsertedHTML } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import tokens from "../../design-tokens.json";

const colors = { dark: tokens.themes.dark.page, light: tokens.themes.light.page };
const defaultTheme = tokens.defaultState.theme === "light" ? "light" : "dark";

function applyTheme(theme: "dark" | "light", colors: Record<"dark" | "light", string>) {
  try { if (localStorage.getItem("edgey-theme") === "light") theme = "light"; } catch {}
  document.documentElement.dataset.theme = theme;
  let color = document.head.querySelector('meta[name="theme-color"]');
  if (!color) {
    color = document.createElement("meta");
    color.setAttribute("name", "theme-color");
    document.head.append(color);
  }
  color.setAttribute("content", colors[theme]);
}

const script = `(${applyTheme})(${JSON.stringify(defaultTheme)}, ${JSON.stringify(colors)});`;

export function ThemeBootstrap() {
  const inserted = useRef(false);
  useServerInsertedHTML(() => {
    if (inserted.current) return null;
    inserted.current = true;
    return (
      <>
        <meta name="theme-color" content={colors[defaultTheme]} />
        <style media="screen">{`html,body{background-color:var(--edgey-page,${colors.dark})}html[data-theme="light"],html[data-theme="light"] body{background-color:var(--edgey-page,${colors.light})}`}</style>
        <script dangerouslySetInnerHTML={{ __html: script }} />
      </>
    );
  });
  useLayoutEffect(() => applyTheme(defaultTheme, colors), []);
  return null;
}
