import { requireStaff, type StaffRole } from "@/lib/admin/auth";
import { requestsDb } from "@/lib/admin/request-schema";
import { AdminHeading, AdminLink } from "./ui";

const areas: { roles?: StaffRole[]; title: string; path: string; description: string }[] = [
  { roles: ["warehouse"], title: "Pick and dispatch", path: "warehouse", description: "Pick the right order lines, record dispatch and handle returns." },
  { roles: ["warehouse"], title: "Stock", path: "stock", description: "Receive stock, adjust counts and review the movement ledger." },
  { roles: ["warehouse"], title: "Delivery settings", path: "delivery", description: "Manage postcode coverage, carrier services and working days." },
  { roles: ["catalogue", "finance"], title: "Catalogue", path: "catalogue", description: "Review blade prices, costs and publication status." },
  { roles: ["finance"], title: "Finance", path: "finance", description: "Check payment status, exceptions and failed processing." },
  { title: "Requests", path: "requests", description: "See enquiries and applications available to your role." },
  { roles: ["warehouse"], title: "Commercial measures", path: "commercial", description: "Review exact Finder matches, trial purchases, dispatch promises and wrong-fit returns." },
];

export default async function AdminPage() {
  const { roles, userId } = await requireStaff();
  const conversion = roles.includes("warehouse")
    ? await requestsDb().rpc("count_admin_trial_first_purchases", { p_actor_id: userId })
    : null;

  return (
    <>
      <AdminHeading title="Staff desk" description="Choose a work area. Access is limited to your assigned roles." />
      <div className="admin-grid">
        {areas.filter(({ roles: allowed }) => !allowed || allowed.some((role) => roles.includes(role))).map(({ path, title, description }) => (
          <section key={path} className="admin-panel admin-area">
            <h2><AdminLink href={`/admin/${path}`}>{title}</AdminLink></h2>
            <p className="admin-muted">{description}</p>
            {path === "requests" && conversion && <p className="mt-2">
              {conversion.error ? "Trial purchase count is unavailable." : <>Trials linked to a first purchase: <span className="admin-mono">{conversion.data}</span></>}
            </p>}
          </section>
        ))}
      </div>
    </>
  );
}
