import Link from "next/link";
import { MastNav } from "./mast-nav";
import { SelectionTrigger } from "./selection-dialog";
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
          <SelectionTrigger />
        </div>
      </div>
    </header>
  );
}
