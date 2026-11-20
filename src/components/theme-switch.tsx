"use client";

import { useEffect, useSyncExternalStore } from "react";
import tokens from "../../design-tokens.json";

type Theme = "dark" | "light";
const getTheme = (): Theme => document.documentElement.dataset.theme === "light" ? "light" : "dark";
const getServerTheme = (): Theme => "dark";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribe, getTheme, getServerTheme);
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tokens.themes[theme].page);
  }, [theme]);

  const target: Theme = theme === "dark" ? "light" : "dark";
  const label = "Switch to " + target + " mode";

  function toggle() {
    document.documentElement.dataset.theme = target;
    try {
      localStorage.setItem("edgey-theme", target);
    } catch {
    }
  }

  return (
    <button type="button" className="theme-switch" aria-label={label} title={label} onClick={toggle}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <g className="sun-symbol">
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
        </g>
        <path className="moon-symbol" d="M19 15a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z" />
      </svg>
      <span className="theme-label">
        <span className="when-dark">Light mode</span>
        <span className="when-light">Dark mode</span>
      </span>
    </button>
  );
}
