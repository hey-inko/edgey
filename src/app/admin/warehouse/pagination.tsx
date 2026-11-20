import { AdminLink } from "@/app/admin/ui";

export function WarehousePagination(
  { href, page, hasMore, label }: { href: string; page: number; hasMore: boolean; label: string },
) {
  if (page === 1 && !hasMore) return null;
  const separator = href.includes("?") ? "&" : "?";
  return (
    <nav aria-label={label} className="mt-3 flex flex-wrap items-center gap-4">
      {page > 1 && <AdminLink href={`${href}${separator}page=${page - 1}`}>Previous page</AdminLink>}
      <span className="admin-mono">Page {page}</span>
      {hasMore && <AdminLink href={`${href}${separator}page=${page + 1}`}>Next page</AdminLink>}
    </nav>
  );
}
