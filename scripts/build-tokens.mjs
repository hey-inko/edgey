// Turns design-tokens.json into app/tokens.css, the storefront's theme.
// Run `pnpm tokens` after the design pack changes; a test fails if they drift.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const tokens = JSON.parse(readFileSync(new URL("design-tokens.json", root), "utf8"));

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
const stack = (families) => families.map((family) => (/\s/.test(family) ? JSON.stringify(family) : family)).join(", ");
const block = (selector, pairs) =>
  selector + " {\n" + pairs.map(([name, value]) => "  --edgey-" + name + ": " + value + ";").join("\n") + "\n}\n";

export function buildTokensCss() {
  const theme = (name) => Object.entries(tokens.themes[name]).map(([key, value]) => [kebab(key), value.toLowerCase()]);
  const { type, layout, controls, texturePlacement, wordmark } = tokens;
  const shared = [
    ["font-sans", stack(type.sans)],
    ["font-mono", stack(type.mono)],
    ["body-size", type.body.fontSize],
    ["body-leading", type.body.lineHeight],
    ["h1-size", type.h1.fontSize],
    ["h1-compact-size", type.h1.compactSize],
    ["h1-weight", type.h1.weight],
    ["h1-leading", type.h1.lineHeight],
    ["h1-tracking", type.h1.tracking],
    ["h2-size", type.h2.fontSize],
    ["h2-weight", type.h2.weight],
    ["h2-leading", type.h2.lineHeight],
    ["h2-tracking", type.h2.tracking],
    ["overline-size", type.overline.fontSize],
    ["overline-weight", type.overline.weight],
    ["overline-leading", type.overline.lineHeight],
    ["overline-tracking", type.overline.tracking],
    ["frame-max", layout.frameMax],
    ["gutter-total", layout.desktopGutterTotal],
    ["hero-columns", layout.heroColumns.map((column) => "minmax(0, " + column + ")").join(" ")],
    ["hero-gap", layout.heroGap],
    ["card-plate-ratio", layout.cardPlateAspectRatio],
    ["radius", layout.baseRadius],
    ["border-width", layout.baseBorderWidth],
    ["primary-min-height", controls.primaryMinHeight],
    ["field-height", controls.fieldHeight],
    ["hatch-angle", controls.hatchAngle],
    ["hatch-pitch", controls.primaryHatchPitch],
    ["hatch-stripe", controls.primaryHatchStripe],
    ["end-cap", controls.primaryEndCapRest],
    ["end-cap-hover", controls.primaryEndCapHoverDesktop],
    ["end-cap-compact", controls.primaryEndCapRestAt370],
    ["focus-width", controls.focusRingWidth],
    ["card-lift", controls.cardLift],
    ["card-transition", controls.cardTransition],
    ["card-clip", texturePlacement.productCardClip],
    ["footer-citron-clip", texturePlacement.footerCitronClip],
    ["wordmark-header-width", wordmark.headerWidth],
    ["wordmark-footer-width", wordmark.footerWidth],
  ];
  const proofs = tokens.proofs.map((proof) => [
    "proof-" + proof.key,
    'url("/' + proof.asset.replace("assets/", "proofs/") + '")',
  ]);
  return (
    "/* Generated from design-tokens.json by scripts/build-tokens.mjs. Do not edit by hand. */\n" +
    block(':root,\n[data-theme="' + tokens.defaultState.theme + '"]', theme(tokens.defaultState.theme)) +
    block('[data-theme="light"]', theme("light")) +
    block(":root", [...shared, ...proofs])
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("src/app/tokens.css", root), buildTokensCss());
  console.log("Wrote app/tokens.css");
}
