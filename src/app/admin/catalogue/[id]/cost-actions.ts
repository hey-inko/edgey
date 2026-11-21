"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/admin/auth";
import { catalogueId } from "@/lib/admin/catalogue";
import { parseStaffCost } from "@/lib/admin/stock-cost";
import { stockSchemaUnavailable } from "@/lib/admin/stock-cost-data";

type State = { ok: boolean; message: string };

export async function saveVariantCost(id: string, _previous: State | null, form: FormData): Promise<State> {
  const { db } = await requireStaff("catalogue", "finance");
  if (!catalogueId.test(id)) return { ok: false, message: "This variant does not exist." };
  const parsed = parseStaffCost(form);
  if (!parsed.ok || !parsed.value) {
    return { ok: false, message: "Choose a supplier currency and enter the supplier and landed unit amounts with up to two decimal places. If you enter an exchange rate, it must be positive and have at most eight decimal places." };
  }
  const { error } = await db.rpc("set_staff_variant_cost", { p_variant_id: id, p_cost: parsed.value });
  if (error) return { ok: false, message: stockSchemaUnavailable(error)
    ? "Cost management is not available until the database update is applied." : "Could not save the cost estimate." };
  revalidatePath(`/admin/catalogue/${id}`);
  return { ok: true, message: "Cost estimate saved." };
}

export async function archiveVariant(id: string, _previous: State | null, form: FormData): Promise<State> {
  const { db } = await requireStaff("catalogue");
  const version = form.get("version");
  if (!catalogueId.test(id) || typeof version !== "string" || version.length > 60 || !Number.isFinite(Date.parse(version))) {
    return { ok: false, message: "Reload the page before archiving this variant." };
  }
  if (form.get("confirmArchive") !== "yes") return { ok: false, message: "Confirm retirement before continuing." };
  const { data: slug, error } = await db.rpc("archive_staff_variant", { p_variant_id: id, p_expected_updated_at: version });
  if (error || !slug) return { ok: false, message: error?.message === "catalogue_stale"
    ? "This record changed since you opened it. Reload the page before trying again."
    : error && stockSchemaUnavailable(error)
      ? "Archiving is not available until the database update is applied." : "Could not archive this variant." };
  for (const path of ["/", "/blades", `/blades/${slug}`, "/admin/catalogue", `/admin/catalogue/${id}`, "/admin/stock", `/admin/stock/${id}`]) {
    revalidatePath(path);
  }
  return { ok: true, message: "Variant archived." };
}
