const maxCreditLimitPence = 2_147_483_647;

export function parseCreditLimit(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return null;
  const amount = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!amount) return null;
  const pence = Number(amount[1]) * 100 + Number((amount[2] ?? "").padEnd(2, "0"));
  return pence <= maxCreditLimitPence ? pence : null;
}
