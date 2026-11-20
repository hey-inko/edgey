import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.mjs";

const client = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  { auth: { persistSession: false } },
);

const exact = [
  "3910301", "  3910-301", "eDg - Z10", "z10", "3910306", "EDG Z16",
  "42437293", "bld-sr6223", "3910335", "edg-z50", "5006045", "Z71", "3910105",
  "391-360", "391 231", "390.534", "spb-0030", "spb 0030", "EDG-MIM-A45", "EDG-MIM-45",
];
const suggestions = [
  "foamex", "corrugated board", "correx", "vinyl", "textile", "soft signage",
  "zünd", "Zund oscilating", "kongsberg", "summa", "mimaki", "roll plotter",
  "tangential", "round shank", "drag", "rotary", "laminate", "V-cut",
];
const unknown = [
  "00000000", "5201345", "SPB-0000", "EDG-Z11", "EDG-MIM-A30", "500-9802", "PRIV-Z10-ALIAS",
];

async function call(query) {
  const start = performance.now();
  const { data, error } = await client.rpc("search_blades", { query_text: query });
  if (error) throw new Error(query + ": " + error.message);
  return { elapsed: performance.now() - start, data };
}

const guard = await call(exact[0]);
if (guard.data[0]?.sku !== "EDG-Z10") throw new Error("Load the staging fixture before benchmarking.");

const queries = [...exact, ...suggestions, ...unknown];
for (const query of queries) await call(query);
const samples = [];
for (let i = 0; i < 100; i++) samples.push((await call(queries[(i * 17) % queries.length])).elapsed);
samples.sort((a, b) => a - b);
const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
console.log(`Anonymous local HTTP RPC: p95 ${p95.toFixed(2)} ms over ${samples.length} warm queries (target <50 ms)`);
if (p95 >= 50) process.exitCode = 1;
