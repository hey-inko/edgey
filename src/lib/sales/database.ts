import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { DateRange, SalesGrain, SalesReport } from "./report";

type Public = Database["public"];
type SalesDatabase = {
  public: Omit<Public, "Functions"> & {
    Functions: Public["Functions"] & {
      admin_sales_report: { Args: { p_from: string; p_to: string; p_grain: SalesGrain }; Returns: SalesReport };
    };
  };
};

export function readSalesReport(db: SupabaseClient<Database>, range: DateRange, grain: SalesGrain) {
  return (db as unknown as SupabaseClient<SalesDatabase>).rpc("admin_sales_report", {
    p_from: range.from, p_to: range.to, p_grain: grain,
  });
}

export const missingSalesMigration = (code?: string) => code === "PGRST202";
