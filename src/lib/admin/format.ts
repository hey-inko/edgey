const london = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London",
});

export function displayTimestamp(value: string) {
  return london.format(new Date(value));
}

export function displayState(value: string) {
  return value[0]?.toUpperCase() + value.slice(1).replaceAll("_", " ");
}
