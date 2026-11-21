import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { catalogueDefinition, normaliseCode } from "./catalogue-definition.mjs";

const lookups = {
  tool_categories: "Tool category",
  substrates: "Material",
  brands: "Brand",
};
const history = {
  "public.stock_movements": "stock movements",
  "public.order_items": "order lines",
  "public.trial_allocations": "trial allocations",
  "public.staff_variant_costs": "staff cost estimates",
  "public.staff_receipt_costs": "staff receipt costs",
  "public.staff_variant_cost_audit": "staff cost history",
  "private.variant_price_changes": "staff price history",
  "public.enquiries": "a staff-matched enquiry",
  "private.finder_exact_matches": "published Finder history",
};

const mappingKind = ({ code_kind }) => ({ alias: "Alias", item_number: "OEM reference", model: "Compatibility model" })[code_kind];
const by = (rows, key) => Map.groupBy(rows, key);
const index = (rows, key) => new Map(rows.map((row) => [key(row), row]));
const lookupKey = ({ slug }) => slug;
const skuKey = ({ sku }) => sku;
const familyKey = ({ family_code }) => family_code;
const materialKey = ({ substrate }) => substrate;
const known = (map, key) => map.get(key) ?? [];

async function readVariants(db, ids = null) {
  const { rows } = await db.query(`
    select v.id, jsonb_build_object(
      'variant', to_jsonb(v),
      'mappings', coalesce((select jsonb_agg(to_jsonb(c) order by c.id)
        from public.compatibility c where c.variant_id = v.id), '[]'),
      'materials', array(select s.substrate from public.variant_substrates s
        where s.variant_id = v.id order by s.substrate)
    ) as snapshot,
    b.snapshot as baseline,
    array_remove(array[${Object.entries(history).map(([table, reason]) => `
      case when exists (select 1 from ${table} h where
        h.${table === "public.enquiries" ? "matched_variant_id" : "variant_id"} = v.id
        ${table === "private.variant_price_changes" ? "and h.actor_id is not null" : ""})
      then '${reason}' end`).join(",")}], null) as history
    from public.variants v
    left join private.catalogue_sync_baselines b on b.kind = 'variant' and b.row_id = v.id
    where $1::uuid[] is null or v.id = any($1)
    order by v.sku
  `, [ids]);
  return rows;
}

function protection({ snapshot, baseline, history }) {
  const { variant: v, mappings } = snapshot;
  const reasons = [...history];
  if (v.publication_status !== "draft") reasons.push(v.publication_status);
  if (v.stock_on_hand !== 0 || v.stock_reserved !== 0) reasons.push("stock on hand or reserved");
  if (v.is_staging_fixture) reasons.push("demo fixture");
  if (v.approved_at || v.approved_by || v.rejected_at || v.rejected_by ||
      mappings.some((m) => m.verification_state !== "candidate" ||
        m.approved_at || m.approved_by || m.rejected_at || m.rejected_by)) reasons.push("approval or rejection history");
  if (v.supplier_name !== null || v.supplier_part_number !== null) reasons.push("supplier details recorded");
  if (!baseline) reasons.push("not created by catalogue sync");
  else if (!isDeepStrictEqual(snapshot, baseline)) reasons.push("changed since last sync");
  return reasons;
}

function makePlan(source, target) {
  const plan = [];
  const add = (action, kind, key, reason, write) => plan.push({ action, kind, key, reason, write });
  const compare = (table, kind, key, row, data) => {
    if (!row) return add("ADD", kind, key, "", { table, data });
    const fields = Object.keys(data).filter((field) => !isDeepStrictEqual(row[field], data[field]));
    if (!fields.length) return add("KEEP", kind, key, "already matches");
    add("UPDATE", kind, key, fields.join(", "), { table, id: row.id, data: Object.fromEntries(fields.map((f) => [f, data[f]])) });
  };
  const unavailable = {};
  for (const [table, kind] of Object.entries(lookups)) {
    const existing = index(target[table], lookupKey);
    const names = index(target[table], ({ name }) => name);
    unavailable[table] = new Set();
    for (const desired of source[table]) {
      const match = existing.get(desired.slug);
      const other = names.get(desired.name);
      if (match) add("KEEP", kind, desired.slug, "existing shared definition; never overwritten");
      else if (other) {
        unavailable[table].add(desired.slug);
        add("CONFLICT", kind, desired.slug, `name already used by ${other.slug}`);
      } else compare(table, kind, desired.slug, null, desired);
    }
    const desired = index(source[table], lookupKey);
    for (const row of target[table]) if (!desired.has(row.slug)) add("KEEP", kind, row.slug, "not in repository");
  }

  const variants = target.variants.map((v) => ({ ...v.snapshot.variant, reasons: protection(v), ...v }));
  const variantsBySku = index(variants, ({ sku_normalised }) => sku_normalised);
  const siblings = by(variants, ({ product_id }) => product_id);
  const references = variants.flatMap((owner) => owner.snapshot.mappings.map((mapping) => ({ mapping, owner })));
  const registeredCodes = by(references, ({ mapping }) => mapping.code_normalised);
  const targetFamiliesByCode = by(target.products, ({ row }) => normaliseCode(row.family_code));
  const targetFamiliesBySlug = index(target.products, ({ row }) => row.slug);
  const sourceVariants = index(source.variants, skuKey);
  const sourceFamilies = by(source.variants, familyKey);
  const wantedBySku = by(source.compatibility, skuKey);
  const wantedByCode = by(source.compatibility, ({ code }) => normaliseCode(code));
  const wantedSkusByCode = index(source.variants, ({ sku }) => normaliseCode(sku));
  const wantedFamilyMaterials = by(source.family_materials, familyKey);
  const wantedVariantMaterials = by(source.variant_materials, skuKey);

  for (const desired of source.products) {
    const key = desired.family_code;
    const matches = known(targetFamiliesByCode, normaliseCode(key));
    const match = matches.find(({ row }) => row.family_code === key);
    const current = match?.row;
    const other = targetFamiliesBySlug.get(desired.slug)?.row;
    const familyConflict = matches.length > Number(Boolean(match)) ? "normalised family code already used" :
      other && other.id !== current?.id ? `slug already belongs to ${other.family_code}` :
      current && current.slug !== desired.slug ? "existing family uses a different slug" :
      unavailable.tool_categories.has(desired.tool_category) ? "tool category has a conflicting definition" : null;
    const productId = current?.id ?? randomUUID();
    const entries = [];

    for (const { family_code, ...fields } of known(sourceFamilies, key)) {
      const sku = fields.sku;
      const code = normaliseCode(sku);
      const existing = variantsBySku.get(code);
      const mappings = known(wantedBySku, sku);
      const materials = [...new Set([...known(wantedFamilyMaterials, family_code), ...known(wantedVariantMaterials, sku)].map(materialKey))].sort();
      const conflicts = [];
      if (familyConflict) conflicts.push("family: " + familyConflict);
      if (existing && (existing.sku !== sku || existing.product_id !== productId)) {
        conflicts.push(`SKU already belongs to ${existing.sku} in ${existing.family_code}`);
      }
      if (existing?.is_staging_fixture) conflicts.push("SKU already used by the staging demo");
      for (const { row } of known(targetFamiliesByCode, code)) {
        if (row.id !== productId) conflicts.push(`SKU matches the family code ${row.family_code}`);
      }
      for (const { owner } of known(registeredCodes, code)) {
        if (owner.id !== existing?.id) conflicts.push(`SKU matches a code on ${owner.sku}`);
      }
      for (const mapping of mappings) {
        const code = normaliseCode(mapping.code);
        const label = `${mappingKind(mapping)} ${mapping.code}`;
        const skuOwner = variantsBySku.get(code);
        const wantedSku = wantedSkusByCode.get(code);
        if ((skuOwner && skuOwner.id !== existing?.id) || (wantedSku && wantedSku.sku !== sku)) {
          conflicts.push(`${label} matches SKU ${skuOwner?.sku ?? wantedSku.sku}`);
        }
        for (const { row } of known(targetFamiliesByCode, code)) {
          if (row.id !== productId) conflicts.push(`${label} matches the family code ${row.family_code}`);
        }
        for (const { mapping: registered, owner } of known(registeredCodes, code)) {
          if (owner.id === existing?.id) continue;
          const intentionalPeer = mapping.code_kind !== "alias" && known(wantedByCode, code).some((peer) =>
            peer.sku !== sku && peer.sku === owner.sku && peer.code_kind === mapping.code_kind &&
            peer.brand === mapping.brand && sourceVariants.get(peer.sku).family_code === key &&
            owner.product_id === productId && owner.baseline?.mappings.some((m) =>
              m.id === registered.id && m.code_kind === registered.code_kind && m.brand === registered.brand &&
              m.code_normalised === registered.code_normalised));
          if (!intentionalPeer) conflicts.push(`${label} already belongs to ${owner.sku}`);
        }
        if (unavailable.brands.has(mapping.brand)) conflicts.push(`${label} has a conflicting brand definition`);
      }
      for (const material of materials) if (unavailable.substrates.has(material)) conflicts.push(`material ${material} has a conflicting definition`);
      entries.push({ fields, existing, mappings, materials, conflicts });
    }

    if (familyConflict) add("CONFLICT", "Family", key, familyConflict);
    else if (!entries.some(({ conflicts, existing }) => !conflicts.length && !existing?.reasons.length) && !current) {
      add("KEEP", "Family", key, "no eligible variants to add");
    } else if (current && !match.baseline) add("KEEP", "Family", key, "existing family; never overwritten without a sync baseline");
    else if (current && !isDeepStrictEqual(current, match.baseline)) add("KEEP", "Family", key, "changed since last sync");
    else if (current && (known(siblings, productId).some(({ reasons }) => reasons.length) ||
        entries.some(({ conflicts }) => conflicts.length))) {
      add("KEEP", "Family", key, "contains a protected variant or has a variant conflict");
    } else compare("products", "Family", key, current, { ...desired, id: productId });

    for (const { fields, existing, mappings, materials, conflicts } of entries) {
      const sku = fields.sku;
      const id = existing?.id ?? randomUUID();
      const reasons = [...new Set([...conflicts, ...(existing?.reasons ?? [])])];
      if (reasons.length) add(conflicts.length ? "CONFLICT" : "KEEP", "Variant", sku, reasons.join("; "));
      else compare("variants", "Variant", sku, existing, { ...fields, id, product_id: productId });

      const currentMappings = index(existing?.snapshot.mappings ?? [], ({ code_normalised }) => code_normalised);
      for (const { sku, ...mapping } of mappings) {
        const row = currentMappings.get(normaliseCode(mapping.code));
        const key = `${sku} / ${mapping.code}`;
        if (reasons.length) add("KEEP", mappingKind(mapping), key, "variant blocked or protected");
        else compare("compatibility", mappingKind(mapping), key, row, { ...mapping, variant_id: id });
      }
      for (const substrate of materials) {
        if (reasons.length || existing?.snapshot.materials.includes(substrate)) {
          add("KEEP", "Variant material", `${sku} / ${substrate}`, reasons.length ? "variant blocked or protected" : "already matches");
        } else compare("variant_substrates", "Variant material", `${sku} / ${substrate}`, null, { variant_id: id, substrate });
      }
    }
  }

  const wantedProducts = index(source.products, familyKey);
  for (const { row } of target.products) {
    if (!wantedProducts.has(row.family_code)) add("KEEP", "Family", row.family_code, "not in repository");
  }
  for (const { sku, snapshot } of variants) {
    const wanted = sourceVariants.get(sku);
    if (!wanted) add("KEEP", "Variant", sku, "not in repository");
    const codes = new Set(known(wantedBySku, sku).map(({ code }) => normaliseCode(code)));
    for (const mapping of snapshot.mappings) if (!codes.has(mapping.code_normalised)) {
      add("KEEP", mappingKind(mapping), `${sku} / ${mapping.code}`, "not in repository; never removed");
    }
    const materials = new Set([...known(wantedFamilyMaterials, wanted?.family_code), ...known(wantedVariantMaterials, sku)].map(materialKey));
    for (const substrate of snapshot.materials) if (!materials.has(substrate)) {
      add("KEEP", "Variant material", `${sku} / ${substrate}`, "not in repository; never removed");
    }
  }
  return plan;
}

export async function runCatalogueSync(db, { apply = false, seed } = {}) {
  await db.query(apply ? "begin isolation level read committed read write" : "begin isolation level repeatable read read only");
  try {
    await db.query(`set local lock_timeout = '3s'; set local statement_timeout = '15s';
      set local idle_in_transaction_session_timeout = '30s'; set local timezone = 'UTC'`);
    const source = await catalogueDefinition(db, seed);
    if (apply) {
      await db.query(`lock table public.tool_categories, public.substrates, public.brands, public.products,
        public.variants, public.compatibility, public.variant_substrates, private.catalogue_sync_baselines
        in exclusive mode nowait`);
      await db.query(`lock table ${Object.keys(history).join(", ")} in share mode nowait`);
    }
    const target = {};
    for (const table of Object.keys(lookups)) {
      target[table] = (await db.query(`select * from public.${table} order by slug`)).rows;
    }
    target.products = (await db.query(`
      select to_jsonb(p) as row, b.snapshot as baseline
      from public.products p left join private.catalogue_sync_baselines b on b.kind = 'family' and b.row_id = p.id
      order by p.family_code
    `)).rows;
    target.variants = await readVariants(db);
    const familyCodesById = index(target.products.map(({ row }) => row), ({ id }) => id);
    for (const v of target.variants) v.family_code = familyCodesById.get(v.snapshot.variant.product_id).family_code;
    const plan = makePlan(source, target);
    const families = new Set();
    const variants = new Set();
    if (apply) {
      for (const { action, write } of plan) {
        if (!write) continue;
        const { table, data, id } = write;
        const values = action === "ADD" && table === "variants"
          ? { ...data, publication_status: "draft", stock_on_hand: 0, stock_reserved: 0 }
          : action === "ADD" && table === "compatibility" ? { ...data, verification_state: "candidate" } : data;
        const columns = Object.keys(values).join(", ");
        const record = `select ${columns} from jsonb_populate_record(null::public.${table}, $1::jsonb)`;
        const result = action === "ADD"
          ? await db.query(`insert into public.${table} (${columns}) ${record}`, [values])
          : await db.query(`update public.${table} set (${columns}) = (${record}) where id = $2`, [values, id]);
        if (result.rowCount !== 1) throw new Error("A planned catalogue write did not affect exactly one row.");
        if (table === "products") families.add(id ?? data.id);
        if (table === "variants") variants.add(id ?? data.id);
        if (table === "compatibility" || table === "variant_substrates") {
          variants.add(data.variant_id ?? (await db.query("select variant_id from public.compatibility where id = $1", [id])).rows[0].variant_id);
        }
      }
      const { rows: productRows } = await db.query("select id, to_jsonb(p) as snapshot from public.products p where id = any($1::uuid[])", [[...families]]);
      const variantRows = variants.size ? await readVariants(db, [...variants]) : [];
      for (const [kind, rows] of [["family", productRows], ["variant", variantRows]]) {
        for (const { id, snapshot } of rows) {
          await db.query(`
            insert into private.catalogue_sync_baselines (kind, row_id, snapshot) values ($1, $2, $3)
            on conflict (kind, row_id) do update set snapshot = excluded.snapshot
          `, [kind, id, snapshot]);
        }
      }
      await db.query("commit");
    } else await db.query("rollback");
    return plan.map(({ action, kind, key, reason }) => ({ action, kind, key, reason }));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}
