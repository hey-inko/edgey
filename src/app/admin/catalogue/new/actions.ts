"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/admin/auth";
import { catalogueId } from "@/lib/admin/catalogue";
import { commercialDb } from "@/lib/commercial/database";

type State = { ok: boolean; message: string };

export async function createDraftVariant(_previous: State | null, form: FormData): Promise<State> {
  const { db } = await requireStaff("catalogue");
  const product = form.get("product");
  const sku = form.get("sku");
  const optionLabel = form.get("optionLabel");
  const pence = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : 0;
  };
  const one = pence("price1"), five = pence("price5"), ten = pence("price10");
  if (typeof product !== "string" || !catalogueId.test(product)) return { ok: false, message: "Choose a product family." };
  if (typeof sku !== "string" || sku.trim().length > 80 || !/^EDG-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(sku.trim().toUpperCase())) {
    return { ok: false, message: "Enter an Edgey SKU such as EDG-MIM-A45, using letters, numbers and hyphens." };
  }
  if (typeof optionLabel !== "string" || optionLabel.trim().length > 160 || /[\p{Cc}]/u.test(optionLabel)) {
    return { ok: false, message: "Use a single line of up to 160 characters for the variant label." };
  }
  if (ten < 1 || one > 2_147_483_647 || five < ten || one < five) {
    return { ok: false, message: "Enter positive whole pence. Prices must stay the same or decrease in higher bands." };
  }
  const { data, error } = await commercialDb(db).rpc("admin_create_draft_variant", {
    p_product_id: product, p_sku: sku.trim().toUpperCase(), p_option_label: optionLabel.trim() || null,
    p_price_1_4: one, p_price_5_9: five, p_price_10_plus: ten,
  });
  if (error || !data) return { ok: false, message: error?.code === "23505"
    ? "That Edgey SKU is already in use." : "Could not create this draft variant." };
  revalidatePath("/admin/catalogue");
  redirect(`/admin/catalogue/${data}`);
}
