import { adminPageSize } from "@/lib/admin/pagination";
import { AdminLink } from "./ui";

export function AdminPagination({ pathname, query, parameter, page, length }: {
  pathname: string;
  query: Record<string, string | string[] | undefined>;
  parameter: string;
  page: number;
  length: number;
}) {
  function href(next: number) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") params.set(key, value);
    }
    params.set(parameter, String(next));
    return `${pathname}?${params}#${parameter}`;
  }
  if (page === 1 && length <= adminPageSize) return null;
  return (
    <p className="admin-pagination" id={parameter}>
      {page > 1 && <AdminLink href={href(page - 1)}>Previous page</AdminLink>}
      <span className="admin-mono">Page {page}</span>
      {length > adminPageSize && <AdminLink href={href(page + 1)}>Next page</AdminLink>}
    </p>
  );
}
