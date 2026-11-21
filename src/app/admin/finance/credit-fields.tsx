import { AdminField } from "../ui";

export function CreditLimitField({ label, value }: { label: string; value?: number }) {
  return (
    <AdminField label={label}>
      <input name="limit" defaultValue={value === undefined ? undefined : (value / 100).toFixed(2)}
        inputMode="decimal" maxLength={11} pattern="[0-9]+([.][0-9]{1,2})?" placeholder="0.00" required />
    </AdminField>
  );
}

export function CreditReasonField({ label }: { label: string }) {
  return <AdminField label={label}><textarea name="reason" rows={3} maxLength={500} required /></AdminField>;
}
