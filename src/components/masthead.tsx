import Link from "next/link";
import { MastNav } from "./mast-nav";
import { ThemeSwitch } from "./theme-switch";
import { Wordmark } from "./wordmark";

export function Masthead() {
  return (
    <header className="mast">
      <div className="frame nav-inner">
        <Link className="brand" href="/" aria-label="Edgey home">
          <Wordmark />
        </Link>
        <MastNav />
        <div className="nav-tools">
          <ThemeSwitch />
          <button type="button" className="tray-trigger" aria-label="Selection, 0 blades (not available yet)" disabled>
            <span className="case-icon" aria-hidden="true" />
            <span className="tray-label">Selection</span>
            <span className="tray-count" aria-hidden="true">0</span>
          </button>
        </div>
      </div>
    </header>
  );
}
