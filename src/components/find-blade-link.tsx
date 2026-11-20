"use client";

import { focusCatalogueSearch } from "./search-shortcut";

// The hero action jumps to the catalogue and focuses its search field.
export function FindBladeLink() {
  return (
    <a
      href="#catalogue"
      className="primary"
      onClick={(event) => {
        event.preventDefault();
        history.replaceState(null, "", "#catalogue");
        focusCatalogueSearch();
      }}
    >
      <span className="hatch-icon" aria-hidden="true" />
      Find a blade
    </a>
  );
}
