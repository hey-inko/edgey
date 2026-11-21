"use client";

import { useState } from "react";

export function RequestTextarea({ name, rows, initial = "" }: {
  name: string; rows: number; initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return <textarea name={name} value={value} onChange={(event) => setValue(event.target.value)}
    rows={rows} maxLength={2000} required />;
}
