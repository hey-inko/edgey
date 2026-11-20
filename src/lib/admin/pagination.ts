export const adminPageSize = 50;

export function adminPage(value: string | string[] | undefined) {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

export function adminRange(page: number): [number, number] {
  return [(page - 1) * adminPageSize, page * adminPageSize];
}
