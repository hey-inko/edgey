const london = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London",
});

export function displayTimestamp(value: string) {
  return london.format(new Date(value));
}

export function displayState(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
}
