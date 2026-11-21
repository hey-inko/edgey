import { variantLabel, type RequestVariantLabel } from "@/lib/admin/requests";
import { AdminField } from "../ui";

type Variant = RequestVariantLabel & { id: string; availability: string | null };

export function VariantSelect({ label, name, variants, selected = "", stock = false }: {
  label: string; name: string; variants: Variant[]; selected?: string; stock?: boolean;
}) {
  return <AdminField label={label}>
    <select name={name} defaultValue={selected} required>
      <option value="" disabled>Choose a variant</option>
      {variants.map((variant) => <option key={variant.id} value={variant.id} disabled={stock && variant.availability !== "in_stock"}>
        {variantLabel(variant)}{stock && variant.availability !== "in_stock" ? " · Out of stock" : ""}
      </option>)}
    </select>
  </AdminField>;
}
