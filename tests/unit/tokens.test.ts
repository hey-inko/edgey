import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the generated theme stylesheet matches the design pack", () => {
  const generator = fileURLToPath(new URL("../../scripts/build-tokens.mjs", import.meta.url));
  expect(() => execFileSync(process.execPath, [generator, "--check"])).not.toThrow();
});
