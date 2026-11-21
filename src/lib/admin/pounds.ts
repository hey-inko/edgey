export const POUNDS_INPUT_PATTERN = "[0-9]{1,8}([.][0-9]{1,2})?";

const poundsPattern = new RegExp(`^${POUNDS_INPUT_PATTERN}$`);

export function parsePoundsToPence(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const amount = value.trim();
  if (!poundsPattern.test(amount)) return null;
  const [pounds, pennies = ""] = amount.split(".");
  const pence = Number(pounds) * 100 + Number(pennies.padEnd(2, "0"));
  return pence <= 2_147_483_647 ? pence : null;
}

export function formatPoundsInput(pence: number | null | undefined): string {
  return pence == null ? "" : (pence / 100).toFixed(2);
}
