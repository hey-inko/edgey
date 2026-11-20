import { requireStaff } from "@/lib/admin/auth";
import { listAdminCatalogue, variantReviewStatus } from "@/lib/admin/catalogue";
import { displayState } from "@/lib/admin/format";
import { AdminHeading, AdminLink, AdminNotice, AdminTable } from "@/app/admin/ui";

export default async function CataloguePage() {
  await requireStaff("catalogue");
  const variants = await listAdminCatalogue();

  return (
    <>
      <AdminHeading title="Catalogue" description="Review blade variants, record verified fit and control what appears in the storefront." />
      {variants.length === 0 ? <AdminNotice>No catalogue variants have been imported.</AdminNotice> : (
        <AdminTable label="Catalogue variants" headers={["Edgey SKU", "Product family", "Variant", "Review", "Publication"]}>
          {variants.map((variant) => (
            <tr key={variant.id}>
              <th scope="row" className="admin-mono"><AdminLink href={`/admin/catalogue/${variant.id}`}>{variant.sku}</AdminLink></th>
              <td>{variant.products?.name}</td>
              <td>{variant.option_label ?? "—"}</td>
              <td>{variantReviewStatus(variant)}</td>
              <td>{displayState(variant.publication_status)}</td>
            </tr>
          ))}
        </AdminTable>
      )}
    </>
  );
}
