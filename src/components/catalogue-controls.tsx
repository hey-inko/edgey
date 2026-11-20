"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { CatalogueFilters } from "@/lib/catalogue";

type Option = { slug: string; name: string };

function filterQuery(filters: CatalogueFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  return params.toString();
}

// Search and filters. State lives in the address (?q=&type=&machine=&material=)
// so results are server-rendered, shareable and work without JavaScript.
export function CatalogueControls({
  filters,
  toolTypes,
  machines,
}: {
  filters: CatalogueFilters;
  toolTypes: Option[];
  machines: Option[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [values, setValues] = useState(filters);
  const [requested, setRequested] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const received = filterQuery(filters);
  const [rendered, setRendered] = useState(received);
  if (received !== rendered) {
    setRendered(received);
    const index = requested.indexOf(received);
    if (index === -1) setValues(filters);
    setRequested(index === -1 ? [] : requested.slice(index + 1));
  }

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [pathname]);

  function push(next: CatalogueFilters, delay: number) {
    setValues(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const query = filterQuery(next);
      setRequested((pending) => [...pending.filter((prior) => prior !== query).slice(-7), query]);
      startTransition(() => router.replace(pathname + (query ? "?" + query : ""), { scroll: false }));
    }, delay);
  }

  return (
    <form
      className="controls"
      id="catalogue-controls"
      role="search"
      action={pathname + "#catalogue"}
      method="get"
      aria-busy={isPending}
      onReset={(event) => {
        event.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setRequested([]);
        setValues({ q: "", type: "", machine: "", material: "" });
      }}
      onSubmit={(event) => {
        event.preventDefault();
        push(values, 0);
      }}
    >
      <label className="search-field">
        <span className="search-icon" aria-hidden="true" />
        <span className="sr">Search by part number, machine or material</span>
        <input
          id="finder"
          name="q"
          type="search"
          placeholder="Search blades"
          autoComplete="off"
          maxLength={80}
          value={values.q}
          onChange={(event) => push({ ...values, q: event.target.value }, 160)}
        />
        <kbd aria-hidden="true">/</kbd>
      </label>
      <label className="select-field">
        <span className="sr">Tool type</span>
        <select name="type" value={values.type} onChange={(event) => push({ ...values, type: event.target.value }, 0)}>
          <option value="">All tool types</option>
          {toolTypes.map((option) => (
            <option key={option.slug} value={option.slug}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      <label className="select-field">
        <span className="sr">Machine</span>
        <select name="machine" value={values.machine} onChange={(event) => push({ ...values, machine: event.target.value }, 0)}>
          <option value="">All machines</option>
          {machines.map((option) => (
            <option key={option.slug} value={option.slug}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      {values.material && <input type="hidden" name="material" value={values.material} />}
      <noscript>
        <button className="secondary" type="submit">
          Search
        </button>
      </noscript>
    </form>
  );
}
