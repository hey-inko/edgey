import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import tokens from "../../design-tokens.json";

test("the generated stylesheet contains every theme colour from the design pack", () => {
  const css = readFileSync(new URL("../../src/app/tokens.css", import.meta.url), "utf8");
  for (const [theme, roles] of Object.entries(tokens.themes)) {
    const block = css.split(`[data-theme="${theme}"] {`)[1]?.split("}")[0];
    expect(block).toBeDefined();
    for (const [role, value] of Object.entries(roles)) {
      const property = role.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
      expect(block).toContain(`--edgey-${property}: ${value.toLowerCase()};`);
    }
  }
});
