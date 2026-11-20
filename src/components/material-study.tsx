"use client";

import { useState } from "react";
import tokens from "../../design-tokens.json";
import { BoardDrawing } from "./board-drawing";

export function MaterialStudy() {
  const [view, setView] = useState(tokens.defaultState.drawingView);
  const [proof, setProof] = useState(tokens.defaultState.proof);

  return (
    <figure className="plate study" data-mode={view}>
      <div className="plate-head">
        <span className="plate-kicker">Material study</span>
        <span className="view-tag">Axonometric view</span>
      </div>
      <div className="canvas">
        <i className="corner tl" aria-hidden="true" />
        <i className="corner tr" aria-hidden="true" />
        <i className="corner bl" aria-hidden="true" />
        <i className="corner br" aria-hidden="true" />
        <BoardDrawing texture={"/proofs/proof-" + proof + ".webp"} />
      </div>
      <p className="layer-key">
        Print face <span> / </span> Fluted core <span> / </span> Back liner
      </p>
      <figcaption>
        <span>Printed corrugated board</span>
        <div className="view-switch" role="group" aria-label="Drawing view">
          <button type="button" aria-pressed={view === "ink"} onClick={() => setView("ink")}>
            Ink
          </button>
          <button type="button" aria-pressed={view === "outline"} onClick={() => setView("outline")}>
            Outline
          </button>
        </div>
      </figcaption>
      <div className="proof-options" role="group" aria-label="Print textures">
        {tokens.proofs.map((option) => (
          <button
            key={option.key}
            type="button"
            className="proof-option"
            data-proof={option.key}
            aria-pressed={proof === option.key}
            onClick={() => {
              setProof(option.key);
              setView("ink");
            }}
          >
            <i aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </figure>
  );
}
