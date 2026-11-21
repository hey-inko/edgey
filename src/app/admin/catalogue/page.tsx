import { requireStaff } from "@/lib/admin/auth";
import { listAdminCatalogue, variantReviewStatus } from "@/lib/admin/catalogue";
import { displayState } from "@/lib/admin/format";
import { adminPage, adminPageSize } from "@/lib/admin/pagination";
import { AdminPagination } from "@/app/admin/pagination";
import { AdminHeading, AdminLink, AdminNotice, AdminTable } from "@/app/admin/ui";

export default async function CataloguePage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const { roles } = await requireStaff("catalogue", "finance");
  const canEdit = roles.includes("catalogue");
  const query = await searchParams;
  const page = adminPage(query.page);
  const variants = await listAdminCatalogue(page);

  return (
    <>
      <AdminHeading title="Catalogue" description={canEdit
        ? "Manage blade variants, prices, costs and publication."
        : "Review blade prices and manage supplier cost estimates."} />
      {canEdit && <AdminLink href="/admin/catalogue/new">Add draft variant</AdminLink>}
      {variants.length === 0 ? <AdminNotice>No catalogue variants on this page.</AdminNotice> : (
        <AdminTable label="Catalogue variants" headers={["Edgey SKU", "Product family", "Variant", "Review", "Publication"]}>
          {variants.slice(0, adminPageSize).map((variant) => (
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
      <AdminPagination pathname="/admin/catalogue" query={query} parameter="page" page={page} length={variants.length} />
    </>
  );
}
