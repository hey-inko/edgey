import { notFound } from "next/navigation";
import { AdminField, AdminForm, AdminHeading, AdminLink, AdminNotice, AdminSection } from "@/app/admin/ui";
import { requireStaff } from "@/lib/admin/auth";
import { catalogueId, getAdminCataloguePricing, getAdminCatalogueVariant, variantReviewStatus } from "@/lib/admin/catalogue";
import { displayState, displayTimestamp } from "@/lib/admin/format";
import { getCurrentStaffCost } from "@/lib/admin/stock-cost-data";
import { editCatalogueVariant } from "./actions";
import { archiveVariant } from "./cost-actions";
import { VariantCost } from "./variant-cost";
import { PriceTierFields } from "../price-tier-fields";

function ReviewFields() {
  return (
    <>
      <AdminField label="Review decision">
        <select name="operation" required defaultValue="">
          <option value="" disabled>Select</option>
          <option value="approve">Approve</option>
          <option value="reject">Reject</option>
        </select>
      </AdminField>
      <AdminField label="Evidence source">
        <input name="source" required maxLength={240} />
      </AdminField>
      <AdminField label="Evidence note">
        <textarea name="note" required maxLength={2000} rows={3} />
      </AdminField>
    </>
  );
}

function ReviewRecord({
  state, source, note, url, date, reviewer,
}: {
  state: string;
  source: string | null;
  note: string | null;
  url?: string | null;
  date: string | null;
  reviewer: string | null;
}) {
  return (
    <dl className="admin-spec">
      <dt>Status</dt><dd>{state}</dd>
      {source && <><dt>Recorded source</dt><dd>{source}</dd></>}
      {note && <><dt>Recorded note</dt><dd>{note}</dd></>}
      {url && <><dt>Recorded evidence URL</dt><dd>{url}</dd></>}
      {date && <><dt>Reviewed</dt><dd><time dateTime={date}>{displayTimestamp(date)}</time></dd></>}
      {reviewer && <><dt>Reviewer</dt><dd className="admin-mono">{reviewer}</dd></>}
    </dl>
  );
}

export default async function CatalogueVariantPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, roles } = await requireStaff("catalogue", "finance");
  const { id } = await params;
  if (!catalogueId.test(id)) notFound();
  if (!roles.includes("catalogue")) {
    const [variant, cost] = await Promise.all([getAdminCataloguePricing(id), getCurrentStaffCost(db, roles, id)]);
    if (!variant?.products) notFound();
    return (
      <>
        <AdminLink href="/admin/catalogue">Back to catalogue</AdminLink>
        <AdminHeading eyebrow={variant.sku} title={variant.products.name} description={variant.option_label ?? undefined} />
        <VariantCost id={id} result={cost} />
        <AdminSection title="Selling prices">
          <PriceTierFields prices={variant} landedUnitPence={cost.cost?.landed_unit_pence} readOnly />
        </AdminSection>
      </>
    );
  }
  const [record, cost] = await Promise.all([getAdminCatalogueVariant(id), getCurrentStaffCost(db, roles, id)]);
  if (!record) notFound();

  const { variant, family, categories, substrates, brands } = record;
  const action = editCatalogueVariant.bind(null, id);
  const selectedSubstrates = new Set(variant.variant_substrates.map(({ substrate }) => substrate));
  const specs = Object.entries(variant.specs ?? {}).map(([label, value]) => `${label}: ${value}`).join("\n");
  const published = variant.publication_status === "published";
  const draft = variant.publication_status === "draft";

  return (
    <>
      <AdminLink href="/admin/catalogue">Back to catalogue</AdminLink>
      <AdminHeading eyebrow={variant.sku} title={family.name} description={variant.option_label ?? undefined} />
      <AdminSection title="Publication">
        <dl className="admin-spec">
          <dt>Family code</dt><dd className="admin-mono">{family.family_code}</dd>
          <dt>Edgey SKU</dt><dd className="admin-mono">{variant.sku}</dd>
          <dt>Publication</dt><dd>{displayState(variant.publication_status)}</dd>
          <dt>Stock status</dt><dd>{variant.availability === "in_stock" ? "In stock" : "Out of stock"}</dd>
        </dl>
        {variant.publication_status !== "archived" ? <>
          <AdminForm action={action} submit={published ? "Unpublish variant" : "Publish variant"}>
            <input type="hidden" name="version" value={variant.catalogue_updated_at} />
            <input type="hidden" name="operation" value={published ? "unpublish" : "publish"} />
            <p>{published
              ? "Unpublishing hides this SKU and its references without changing existing orders or stock."
              : "Publishing requires an approved variant, complete selling data and an approved public OEM reference."}</p>
          </AdminForm>
          {cost.available && <details className="admin-panel">
            <summary>Retire this variant</summary>
            <AdminForm action={archiveVariant.bind(null, id)} submit="Archive variant">
              <input type="hidden" name="version" value={variant.catalogue_updated_at} />
              <p>Archiving removes this SKU and its references from the storefront and Finder. It keeps order history and stock. You can’t publish an archived variant again.</p>
              <label className="admin-check"><input type="checkbox" name="confirmArchive" value="yes" required /> Permanently retire this SKU</label>
            </AdminForm>
          </details>}
        </> : <p className="admin-muted">This variant is retired. Its stock and previous orders are still available to staff.</p>}
      </AdminSection>
      <VariantCost id={id} result={cost} />
      {roles.includes("warehouse") && <AdminLink href={`/admin/stock/${id}`}>View stock and receipts</AdminLink>}
      {variant.publication_status === "archived" ? <AdminSection title="Selling prices">
        <PriceTierFields prices={variant} landedUnitPence={cost.cost?.landed_unit_pence} readOnly />
      </AdminSection> : <>
      <AdminSection title="Selling data">
        <p>Family fields apply to every SKU in this family. Changing this variant’s supplier, configuration, specifications or materials sends it and its approved compatibility references back to review and takes it off the storefront if published.</p>
        <AdminForm action={action} submit="Save selling data">
          <input type="hidden" name="version" value={variant.catalogue_updated_at} />
          <input type="hidden" name="familyVersion" value={family.updated_at} />
          <input type="hidden" name="operation" value="save" />
          <fieldset className="admin-panel min-w-0">
            <legend>Selling prices</legend>
            <p>Enter the price per blade in pounds, excluding VAT.{draft && " You can leave all three prices blank on a draft."}</p>
            <PriceTierFields prices={variant} required={!draft} landedUnitPence={cost.cost?.landed_unit_pence} />
          </fieldset>
          <div className="admin-grid">
            <AdminField label="Family name"><input name="name" defaultValue={family.name} maxLength={160} required /></AdminField>
            <AdminField label="Tool category">
              <select name="tool_category" defaultValue={family.tool_category} required>
                {categories.map(({ slug, name }) => <option key={slug} value={slug}>{name}</option>)}
              </select>
            </AdminField>
          </div>
          <AdminField label="Family description"><textarea name="description" defaultValue={family.description} maxLength={2000} rows={3} required /></AdminField>
          <div className="admin-grid">
            <AdminField label="Variant option label"><input name="option_label" defaultValue={variant.option_label ?? ""} maxLength={160} /></AdminField>
            <AdminField label="Tool or holder"><input name="tool" defaultValue={variant.tool ?? ""} maxLength={160} /></AdminField>
            <AdminField label="Supplier name"><input name="supplier_name" defaultValue={variant.supplier_name ?? ""} maxLength={160} /></AdminField>
            <AdminField label="Supplier part number"><input name="supplier_part_number" defaultValue={variant.supplier_part_number ?? ""} maxLength={160} /></AdminField>
            <AdminField label="Angle (degrees)"><input type="number" name="angle_deg" defaultValue={variant.angle_deg ?? ""} min={0.1} max={179.9} step={0.1} /></AdminField>
            <AdminField label="Shank (mm)"><input type="number" name="shank_mm" defaultValue={variant.shank_mm ?? ""} min={0.01} max={999.99} step={0.01} /></AdminField>
            <AdminField label="Cutting depth (mm)"><input type="number" name="cutting_depth_mm" defaultValue={variant.cutting_depth_mm ?? ""} min={0.01} max={999.99} step={0.01} /></AdminField>
            <AdminField label="Blade thickness (mm)"><input type="number" name="blade_thickness_mm" defaultValue={variant.blade_thickness_mm ?? ""} min={0.01} max={999.99} step={0.01} /></AdminField>
            <AdminField label="Diameter (mm)"><input type="number" name="diameter_mm" defaultValue={variant.diameter_mm ?? ""} min={0.01} max={999.99} step={0.01} /></AdminField>
          </div>
          <AdminField label="Extra specifications (one “Label: value” per line)">
            <textarea name="specs" rows={4} maxLength={4000} defaultValue={specs} />
          </AdminField>
          <fieldset className="admin-panel min-w-0">
            <legend>Verified materials</legend>
            <div className="admin-grid">
              {substrates.map(({ slug, name }) => (
                <label key={slug} className="admin-check">
                  <input type="checkbox" name="substrates" value={slug} defaultChecked={selectedSubstrates.has(slug)} />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </AdminForm>
      </AdminSection>
      <AdminSection title="Variant approval">
        <p>Record supplier evidence for this exact SKU and its selling data. Rejecting a published variant takes it off the storefront.</p>
        <ReviewRecord state={variantReviewStatus(variant)} source={variant.evidence_source} note={variant.evidence_note}
          date={variant.approved_at ?? variant.rejected_at} reviewer={variant.approved_by ?? variant.rejected_by} />
        <AdminForm action={action} submit="Record variant review">
          <input type="hidden" name="version" value={variant.catalogue_updated_at} />
          <ReviewFields />
        </AdminForm>
      </AdminSection>
      <AdminSection title="Compatibility references">
        <p>Record the original OEM reference separately from the supplier’s evidence that the replacement blade fits. Private references stay private after review.</p>
        {variant.compatibility.length === 0 && <AdminNotice>No compatibility references have been imported for this variant.</AdminNotice>}
        {variant.compatibility.map((mapping) => (
          <details key={mapping.id} className="admin-panel">
            <summary><span className="admin-mono">{mapping.code}</span> · {displayState(mapping.verification_state)}{mapping.is_private && " · Staff only"}</summary>
            <ReviewRecord state={displayState(mapping.verification_state)} source={mapping.evidence_source} note={mapping.evidence_note} url={mapping.evidence_url}
              date={mapping.approved_at ?? mapping.rejected_at} reviewer={mapping.approved_by ?? mapping.rejected_by} />
            <AdminForm action={action} submit={`Record review for ${mapping.code}`}>
              <input type="hidden" name="version" value={variant.catalogue_updated_at} />
              <input type="hidden" name="mappingId" value={mapping.id} />
              <input type="hidden" name="mappingVersion" value={mapping.updated_at} />
              <div className="admin-grid">
                <AdminField label="OEM brand">
                  <select name="brand" defaultValue={mapping.brand ?? ""}>
                    <option value="">Not set</option>
                    {brands.map(({ slug, name }) => <option key={slug} value={slug}>{name}</option>)}
                  </select>
                </AdminField>
                <AdminField label="Machine or restriction"><input name="machine" defaultValue={mapping.machine ?? ""} maxLength={160} /></AdminField>
                <AdminField label="Tool or holder"><input name="tool" defaultValue={mapping.tool ?? ""} maxLength={160} /></AdminField>
                <AdminField label="Adapter"><input name="adapter" defaultValue={mapping.adapter ?? ""} maxLength={160} /></AdminField>
              </div>
              <ReviewFields />
              <AdminField label="Evidence URL (optional)"><input name="url" type="url" maxLength={500} /></AdminField>
            </AdminForm>
          </details>
        ))}
      </AdminSection>
      </>}
    </>
  );
}
