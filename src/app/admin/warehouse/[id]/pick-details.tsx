import { AdminSection, AdminTable } from "@/app/admin/ui";
import type { WarehouseItem, WarehouseOrder } from "@/lib/admin/warehouse";
import { dispatchDate } from "@/lib/admin/warehouse-format";

export function PickDetails({ order, items }: { order: WarehouseOrder; items: WarehouseItem[] }) {
  return (
    <>
      <AdminSection title="Delivery">
        <dl className="admin-spec">
          <dt>Recipient</dt><dd>{order.recipient_name}</dd>
          <dt>Business</dt><dd>{order.business_name}</dd>
          <dt>Delivery address</dt>
          <dd>
            {[
              order.address_line1, order.address_line2, order.address_town, order.address_region,
              order.address_postcode, order.address_country === "GB" ? "United Kingdom" : order.address_country,
            ].filter(Boolean).map((line, index) => <div key={index}>{line}</div>)}
          </dd>
          <dt>Service</dt><dd>{order.delivery_service}</dd>
          <dt>Promised dispatch</dt>
          <dd className="admin-mono"><time dateTime={order.promised_dispatch_date}>{dispatchDate(order.promised_dispatch_date)}</time></dd>
          <dt>Estimated delivery</dt>
          <dd className="admin-mono"><time dateTime={order.estimated_delivery_date}>{dispatchDate(order.estimated_delivery_date)}</time></dd>
        </dl>
      </AdminSection>
      <AdminSection title="Pick lines">
        <AdminTable label="Pick lines" headers={["Variant SKU", "Option", "Pick reference", "Quantity"]}>
          {items.map((item) => (
            <tr key={item.variant_id}>
              <td className="admin-mono">{item.sku}</td>
              <td>{item.option_label}</td>
              <td className="admin-mono">{item.sku}</td>
              <td className="admin-mono">{item.quantity}</td>
            </tr>
          ))}
        </AdminTable>
      </AdminSection>
    </>
  );
}
