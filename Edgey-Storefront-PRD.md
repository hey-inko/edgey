# Edgey storefront
## Product requirements for the UK trade launch

**Revision 2 · 20 November 2026 · Staging build specification**

A print production manager has a cutter waiting and a part number on an old packet. Edgey should let them identify the exact replacement, see which tool or holder it fits, order the right quantity and know when it will leave the warehouse. A buyer who is unsure of the fit should be able to ask a person or request two trial blades before committing to a pack.

The first release proves that journey from search to a pickable order. Approved trade buyers will also be able to order against a purchase order on 30-day terms. Card checkout and trade credit have separate release criteria.

## 1. Release scope

| Release | What ships | What demonstrates completion |
| --- | --- | --- |
| Weekend staging | Blade Finder, catalogue and product pages, basket, hosted Stripe test checkout, free trial request, staff picking and dispatch queue | A buyer finds the exact variant from its packet, orders it and receives confirmation. A member of staff can pick that same variant and record dispatch. Two buyers competing for the last blade cannot both buy it. |
| First live release | Verified variants with opening stock, guest card and eligible wallet payments, trial requests, operational email, order handling and approved delivery coverage. Trade applications can be collected for review. | The owners in §8 have completed the applicable launch checks. Authorised staff complete one controlled live-mode purchase, check the pick list, then cancel and reconcile the refund before dispatch. |
| Trade credit release | Approved-account checkout, required PO number, Stripe Net 30 invoices, credit control, account history, invoice downloads and reorder | Finance can trace a PO from authorisation through dispatch and settlement. The credit, cancellation and access scenarios in §7 pass. |

**Commercial measures.** Record exact, suggested and unmatched searches, the share of exact matches that reach a paid or authorised order, sample dispatches that lead to a first purchase, and orders dispatched by the promised date. Record wrong-fit returns against the variant and the lookup code. Review these measures after the pilot to set targets and choose the next range. Keep personally identifying details out of analytics events.

## 2. Catalogue and Blade Finder

The buying matrix in Appendix A contains **23 proposed product families**. A family has a product page. A **variant** is one purchasable physical blade with its own permanent SKU, stock count and picking label. A single-variant family may reuse its family code as its SKU. Multi-variant families require distinct SKUs for each stocked angle, shank or holder combination. Five and ten are quantities of the same blade.

For each launch variant the catalogue owner records its supplier part number, Edgey SKU, OEM reference and brand, tool or holder, any necessary adapter or machine restriction, verified dimensions, applicable substrates, source and approval date. Distinguish the manufacturer’s description of the original from the supplier’s evidence that the Edgey replacement fits it. Record material and carbide-grade claims only where supported. A family can go live as soon as it has one approved variant with complete selling data. JWEI and iEcho can be selected on an enquiry from day one. Publish brand landing pages and compatibility claims when a verified mapping exists.

**Finder behaviour**

1. Trim and normalise case, spaces and hyphens for code lookup. Preserve the original printed codes for display. A verified exact Edgey or OEM code ranks first and identifies the matching variant and tool. Where an exact code has multiple valid configurations, show the choices and require a selection.
2. Brand, substrate and fuzzy text searches return labelled suggestions. Show the machine, holder, angle or shank that distinguishes similar results. A search such as “Foamex” may help someone browse. It cannot establish which holder they own.
3. An unmatched code shows **“Ask us to match this blade”** and carries the query into the enquiry. Staff receive the query and the buyer’s reply address. Private candidate aliases must never surface in public search, filters, structured data or SEO titles.
4. Index approved records only. Test the search RPC against seeded staging data at p95 under 50 ms over 100 representative warm queries. Measure page-to-results latency separately on mobile. Show stock status on the product page and recheck availability at checkout.

Keep the industrial visual treatment from the brief. Use charcoal, white specification panels and electric lime for the primary action. Put the OEM code, tool fit, variant and both prices above the fold. Support keyboard search, labelled inputs, visible focus and text equivalents for colour-coded availability.

## 3. Prices, delivery and samples

| Rule | Required behaviour |
| --- | --- |
| Buyer and currency | UK business purchases in GBP. Guest checkout asks for business name and confirmation of buying for work. Label the business price clearly, show the 20% rate and the VAT-inclusive figure beside it. Keep the gross total visible before payment. Finance confirms VAT registration, invoice details and applicable rate before enabling live sales. [ASA pricing guidance](https://www.asa.org.uk/advice-online/compulsory-costs-and-charges-vat.html) · [HMRC VAT guidance](https://www.gov.uk/charge-reclaim-record-vat) |
| Quantity tiers | Combine basket lines for the **same variant**. Apply the 1–4, 5–9 or 10+ unit rate to every blade on that line. Different angles, holders and variants have independent breaks. Show the unit price, line total and any saving. A reorder uses current stock and prices and asks the buyer to confirm. |
| Delivery price | Charge £6.95 ex VAT below £150.00 of goods ex VAT. Delivery is free from £150.00 inclusive of the threshold. Evaluate the threshold after quantity pricing, before VAT and delivery. Display progress in the same ex-VAT basis. |
| Delivery coverage | Store the carrier’s supported UK postcode areas and service levels. Check the full delivery postcode before payment. For an unsupported address, offer a delivery enquiry. Where next working day is unavailable, display the agreed service and charge for that destination, or offer an enquiry if terms are missing. |
| Dispatch | Use Europe/London time and the warehouse working-day calendar, including closures and bank holidays. An in-stock order paid or authorised on account **before 15:30** on a working day qualifies for same-day dispatch. At 15:30 or later use the next working day. Display the dispatch date separately from estimated delivery. A qualifying Friday order normally dispatches Friday for Monday delivery where both are working days and the carrier offers that service. |
| Commercial claims | Position Edgey as a precision replacement-blade supplier. The 12–18% undercut is an internal buying target. Compare equivalent variants, pack sizes and ex-VAT prices against dated evidence before publishing any competitor, quality or savings claim. |
| Two-blade trial | Ask initially for machine brand, OEM code or “unknown”, work email, company and postcode. Confirm receipt on screen and by email. Staff check fit, duplicates, eligibility and delivery coverage, then collect recipient name and full address and approve two specific blade units. Record their stock movements, dispatch and tracking. Link a subsequent purchase to the request when identified. A request alone makes no delivery promise. |

Use integer pence throughout. The server prices every basket from current variant records. For the proposed standard-rated range, use an exclusive 20% VAT rate on each goods line and on charged delivery. Calculate tax on the net line total, round half up to the nearest penny and sum the rounded amounts. Configure card checkout and invoices to agree with that rule. Finance verifies this against Stripe test invoices before launch. Save the applied rate, unit and line amounts, net delivery, tax and gross total on the order. A mismatch between Stripe’s final amount and the order goes to staff review before dispatch.

**Pricing examples.** Five Z10s are £99.75 ex VAT. With £6.95 delivery, VAT is £21.34 and the order total is **£128.04**. Nine Z10s cost £179.55 ex VAT and ten cost £175.00. In that nine-blade basket, show **“Add one blade and save £4.55 before VAT”** when a tenth is available. This is an intentional consequence of the proposed all-units pricing.

## 4. Storefront and staff journeys

| Route | What the user must be able to do |
| --- | --- |
| `/`, `/blades` | Search by printed part number or Edgey SKU, browse verified machine brands, and filter by tool category and substrate. An empty result offers a compatibility enquiry. |
| `/blades/[slug]` | Inspect fit, technical specifications, availability and price breaks. Choose the specific variant and quantity. Use verified variant data for page metadata and Product structured data. |
| `/checkout` | Review the priced basket and dispatch estimate. Enter the business, contact email, recipient and full UK delivery address once in Edgey. Use address autocomplete where available. Amend the address or basket before starting payment. |
| `/checkout/success` | Show a scoped confirmation for this checkout. Display “Confirming payment” if confirmation is still pending. A repeated visit is read-only. Send guests their confirmation and invoice access by email. |
| `/sample-pack`, `/trade` | Submit the short trial request or apply for an account using a verified login, company and billing details. Applications start pending. Tell the applicant how they will hear back. |
| `/account` | See the signed-in buyer’s orders, invoices and dispatch status. Approved trade buyers also see available credit, outstanding balance and PO references. Reorder into a fresh basket and highlight unavailable items. |
| `/admin` | Manage catalogue approvals and stock receipts, respond to enquiries, review trial requests, and pick and dispatch eligible orders. Show the exact variant, bin or picking reference, quantity, delivery address, service and promised dispatch date. Record carrier and tracking. Finance staff handle credit approvals, invoice exceptions and refunds. |

At launch one named buyer owns each trade account, with one credit limit and Stripe customer. Record that limitation in the application flow. Guest email alone never grants access to an existing account or its order history.

## 5. Order, stock and credit rules

**Order creation.** On checkout, validate the submitted variant IDs and positive whole quantities, recalculate prices and delivery, and require complete contact and shipping details. Create the pending order, its immutable line snapshots and stock reservations together in one database transaction. Repeated submission of the same checkout attempt returns the same order. A material basket or address change starts a repriced attempt after the old payable attempt is closed. The server associates the chosen payment method and Stripe object IDs with that order.

| Flow | Sequence and recovery |
| --- | --- |
| Guest card or wallet | Create a hosted Stripe Checkout Session for the reserved order using a stable idempotency key. Offer card and eligible Apple Pay or Google Pay wallets. Use the delivery address already validated by Edgey. Carry the Edgey order ID into Stripe and enable invoice creation. When Stripe confirms payment, reconcile amount and currency, record the invoice reference when available and release the order to the picking queue. |
| Abandoned or interrupted checkout | Align the reservation expiry with the Checkout Session expiry. Confirm the session has expired or has been explicitly closed before releasing stock. If creation times out or payment and expiry events cross, retrieve the provider state and resolve the existing attempt. Route unresolved cases to staff. |
| Approved Net 30 | Require an authenticated approved account, billing and delivery details, a non-empty PO and available credit for the **gross** total. Reserve stock and credit together before calling Stripe. Create a `send_invoice` invoice due in 30 days using the order ID and PO. Finalise and send it once. On confirmed issue, convert the credit hold to outstanding debt and authorise dispatch. On an ambiguous result, reconcile the same invoice before retrying. Release unused holds once the provider confirms no collectible invoice remains. |
| Settlement and recovery | Apply each payment, partial payment, credit note, void or refund to the matching order and invoice. Reconcile outstanding exposure against the invoice amount remaining. Overdue balances enter a finance follow-up queue. Keep card invoices out of the trade-credit ledger. Finance sets the policy for suspending overdue accounts. |
| Cancellation and returns | Before dispatch, cancel picking, release allocations and reconcile the refund or invoice void. After dispatch, record a return against the original lines. Staff inspect received units and explicitly restore saleable stock. A refund alone never adds physical stock. |

**Three quantities have different meanings.** On-hand stock counts physical blades. Reserved stock includes units held for an open checkout or allocated to an accepted order. Available stock is on-hand less reserved. Payment or trade authorisation retains the allocation. Dispatch reduces on-hand and the allocation together, once. The same rules apply to approved trial packs. Reserving, cancelling and dispatching must enforce non-negative availability under concurrent use.

**Payment and fulfilment are independent.** Keep payment states for pending, invoiced, partially paid, paid, voided, partially refunded and refunded. Track fulfilment separately through awaiting authorisation, ready to pick, picking, dispatched and cancelled, with returns recorded against dispatched lines. A Net 30 order can be dispatched and unpaid for 30 days. Recording payment later must preserve its tracking and dispatch date.

**Ownership of updates.** Verified Stripe webhooks and a server-side reconciliation job using Stripe’s API confirm financial facts. Warehouse actions own picking and physical stock movements. Persist incoming events, apply each financial effect once per order/provider operation and make retries safe even when separate events describe the same outcome. Send confirmations from a durable queue with a unique order/message key. Staff can see and replay failed operations. [Stripe event delivery](https://docs.stripe.com/webhooks) · [Stripe request idempotency](https://docs.stripe.com/api/idempotent_requests)

## 6. Engineering contract

Use Next.js App Router with strict TypeScript, Tailwind, Lucide, Supabase Postgres/Auth and Vercel. Use Stripe-hosted Checkout and Stripe Invoicing. Pin supported package and Stripe API versions in the implementation. Serve indexable product content with revalidation on publication changes. Recheck live prices, publication and stock on every checkout.

| Data or endpoint | Minimum contract |
| --- | --- |
| Catalogue | Products contain the family ID, slug, category, description and media. Variants have unique SKU, supplier identifier, verified specifications, pricing tiers, opening stock and publication status. Compatibility records link variant, OEM code, brand, machine, tool and adapter with evidence and verification state. |
| Search | `search_blades(query_text)` uses a normalised exact-code index, then ranked text matching with `pg_trgm`. Public reads return approved records for published variants only. |
| Orders | Orders record the buyer or guest, contact and validated address snapshot, payment method and status, fulfilment status, totals and tax, promises, provider IDs, PO and tracking. Order items snapshot variant SKU, fit or option label, quantity and unit price. Preserve historical details when the catalogue changes. |
| Stock and credit | Store reservations and auditable stock movements per variant. Track credit limits, temporary holds and outstanding invoices per trade account. Apply stock and credit changes transactionally with unique operation keys. Keep invoice, credit and movement history for reconciliation. |
| Requests and access | Store trial requests separately from approved fulfilment details. A validated server action creates a new request from permitted fields and rate-limits submissions. Enforce row-level security on all exposed tables, including order items through their parent order. Public users see published catalogue data. Authenticated buyers see their own orders, invoices and account. Staff roles are assigned server-side. Approval, credit and service-role credentials remain server-only. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) |
| Checkout endpoints | `POST /api/checkout/session` and `POST /api/checkout/net30` share the pricing, availability and delivery rules. The request carries variant IDs, quantities, contact/delivery data and an attempt token. Net 30 also requires a PO. Prices, permissions, balances and approval come from the server. |
| Stripe and operations | `POST /api/webhooks/stripe` verifies the signature against the raw body. Persist event identity before acknowledging durable receipt. Reconcile pending orders and invoices after interruptions, and surface mismatches, unsent confirmations and overdue accounts to staff. |
| Environments | Local and staging use test Stripe credentials, isolated Supabase data and test email recipients. Production has separate DB, webhook secret, tax rate, email sender and carrier settings. Store secrets in deployment configuration. Supply versioned migrations, a repeatable seed and a documented command for the acceptance suite. |

## 7. Acceptance tests

Use these as release evidence alongside typecheck and build. The product owner supplies representative OEM packets. The fulfilment owner checks what appears on the picking screen.

| Scenario | Pass condition |
| --- | --- |
| Exact, ambiguous and unknown searches | A verified code returns the right variant first across case and punctuation. Shared configurations require a choice. An unknown code opens a prefilled enquiry. Searching `5201345` never labels it as Z71. |
| Variant isolation | Sell out of one plotter angle or shank. The correct variant becomes unavailable, its sibling remains available, and a stale basket is corrected before payment. Mixed variants never share a quantity discount. |
| Price and tax | Test quantities 1, 4, 5, 9 and 10, including duplicate lines for one variant. The Z10 examples in §3 match basket, Stripe and invoice. A £149.99 goods subtotal incurs £6.95 delivery and £150.00 qualifies for free delivery in the standard service area. |
| Guest purchase | A guest supplies a valid address, pays by card and receives one confirmation and invoice. The pick list shows the paid SKU, quantity, recipient and service. Refreshing the success page has no side effects. Test eligible wallets on supported devices and the card fallback. |
| Concurrent stock and provider retries | With one blade available, two buyers start checkout. Only one gets a payable reservation. After confirmed expiry it becomes available again. Repeated submissions, duplicate events and events received out of order produce one order, one allocation and one confirmation. |
| Concurrent trade orders | With £200 of credit available, submit two £120 gross orders together. At most one is authorised. Simulate a timeout after invoice creation and retry. One invoice, one PO-linked order and one £120 exposure remain. Unapproved and over-limit buyers cannot use account terms. |
| Dispatch then settlement | Dispatch a Net 30 order, then partially pay and settle its invoice. Tracking and dispatch history persist. The outstanding balance reduces by the amounts actually settled. Cancelling an undispatched order or refunding a dispatched one follows the stock rules in §5. |
| Isolation and trials | A buyer cannot read another buyer’s order lines or invoice or change their credit limit. A trial can be requested with five fields, dispatched only with two allocated units and a complete deliverable address, and linked to a subsequent order. |
| Delivery promises | Exercise 15:29 and 15:30 in UK local time, a Friday, a bank holiday and an unsupported postcode. Checkout, confirmation and picking show the same dispatch date and agreed service. |

## 8. Release decisions and build order

| Owner | Decision or evidence required | When |
| --- | --- | --- |
| Catalogue owner | Approve supplier evidence for every published variant and alias, enter opening stock, and confirm the physical pick label. Keep additional variants in draft as they are verified. | Before publishing each variant |
| Commercial and finance owners | Confirm the ex-VAT matrix, all-units discounts, supplier margin after free delivery, VAT status and invoice details. Approve customer-facing terms and returns process. | Before live payment |
| Fulfilment owner | Confirm the courier contract, cut-off, postcode coverage, holiday calendar, packaging and trial eligibility. Confirm applicable remote-sale, age and delivery requirements for the actual products and destinations with Trading Standards or a qualified adviser, and implement any required checks for orders and samples. [Government guidance](https://www.gov.uk/government/publications/the-offensive-weapons-act-2019) · [2026 Act factsheet](https://www.gov.uk/government/publications/crime-and-policing-act-2026-factsheets/crime-and-policing-act-2026-knife-crime-and-crossbows-factsheet) | Before opening the affected sale or dispatch route |
| Operations owner | Confirm who picks, replies to unmatched searches, approves samples and handles failed or returned orders. Publish business contact details and privacy information, and set retention periods for enquiries and applications. | Before accepting public submissions |
| Finance owner | Set initial credit limits, account approval and suspension rules, and responsibility for overdue invoices and reconciliation. Test a complete 30-day invoice lifecycle in staging. | Before enabling Net 30 |

Build the catalogue and database permissions first, then the Finder and product pages. Add the basket, shared pricing and test-mode card payment before connecting picking and dispatch. Complete the two enquiry flows, trial fulfilment and trade application for the first live release. Deliver the trade account portal and credit checkout once finance has exercised the invoice lifecycle.

## Appendix A. Proposed range and price book

GBP per blade, excluding VAT. The last three price columns set the rates at quantities 1–4, 5–9 and 10+. The benchmark column retains the initial buying estimates for research against Bit & Blade, Victory Design and Wideformat Solutions. Treat each as unverified until a like-for-like listing, pack size and observation date are recorded. Family codes carry forward the proposed assortment. The references and applications below are the buying team’s working list. Import them into staging as **draft**, with zero available stock. Use a separate staging-only test fixture with positive stock to exercise checkout and contention. Production publishes only the specific mappings approved under §2. A listed OEM identity tells the catalogue owner which original to check. It does not establish an Edgey fit.

### Zünd and proposed Summa F-Series cross-references

| Family code | Reference model and options | Reference codes to review | Application to verify | Prior UK benchmark (internal) | 1–4 | 5–9 | 10+ |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| `EDG-Z10` | Zünd Z10 | `500-9802`, `3910301` | Drag (UCT) 50°. Foamex, Correx, PVC, vinyl, banner | £28.00 / ea | £22.50 | £19.95 | £17.50 |
| `EDG-Z11` | Zünd Z11 | `500-9803`, `3910309` | Drag (UCT) 60°. Folding carton, thin plastics, tight corners | £28.00 / ea | £22.50 | £19.95 | £17.50 |
| `EDG-Z46` | Zünd Z46 | `500-9807`, `4800073` | Heavy Drag 45° (20 mm). Thick Foamex, tough plastics, high-speed runs | £43.00 / ea | £36.50 | £32.50 | £28.50 |
| `EDG-Z16` | Zünd Z16 | `3910306`, `SEF-16` | Oscillating (EOT). Corrugated board, foam board, Correx | £24.00–£27.50 / ea | £21.50 | £18.50 | £15.95 |
| `EDG-Z17` | Zünd Z17 | `3910307`, `SEF-17` | Oscillating (EOT). Corrugated board, foam board, tight radii | £24.00–£27.50 / ea | £21.50 | £18.50 | £15.95 |
| `EDG-Z20` | Zünd Z20 | `500-9811`, `3910313` | Oscillating 0.63 mm (14 mm). Detailed corrugated, display board | £27.50 / ea (£55/2pk) | £23.50 | £20.50 | £18.00 |
| `EDG-Z21` | Zünd Z21 | `500-9812`, `3910314` | Oscillating 0.63 mm (17 mm). Double-wall corrugated, fluted board | £29.00 / ea (£58/2pk) | £24.50 | £21.50 | £18.95 |
| `EDG-Z28` | Zünd Z28 | `500-9814`, `3910318` | Long Oscillating (26 mm). Thick foam, Re-board, honeycomb | £36.50 / ea (£73/2pk) | £31.50 | £27.50 | £24.50 |
| `EDG-Z71` | Zünd Z71 | `500-9826`, `5006045` | V-Cut (VCT). Re-board, Xanita, honeycomb POS displays | £41.00 / ea | £34.50 | £30.50 | £27.00 |
| `EDG-Z50` | Zünd Z50 | `500-9860`, `RC110`, `3910335` | Rotary 25 mm Decagonal. Tension fabrics, textiles, soft signage | £45.00 / ea | £38.00 | £34.00 | £30.00 |
| `EDG-Z52` | Zünd Z52 | `500-9862`, `3910337` | Rotary 32 mm Decagonal. Heavy textiles, carbon/aramid, banners | £52.00 / ea | £44.00 | £39.00 | £35.00 |
| `EDG-Z1` | Zünd Z1 | `SEK-01`, `KC101`, `3910105` | Kiss-Cut (KCT) 45°. Self-adhesive vinyl, decals | £11.50 / ea (£23/2pk) | £9.95 | £8.50 | £7.50 |
| `EDG-Z2` | Zünd Z2 | `SEK-02`, `KC102`, `3910110` | Kiss-Cut (KCT) 60°. Thick vinyl, reflective films, small lettering | £11.50 / ea (£23/2pk) | £9.95 | £8.50 | £7.50 |

### Kongsberg

| Family code | Reference model and options | Reference codes to review | Application to verify | Prior UK benchmark (internal) | 1–4 | 5–9 | 10+ |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| `EDG-SR6223` | BLD-SR6223 | `42437293`, `SER-23` | 6 mm Oscillating (12 mm). Single/double corrugated, Correx, <5 mm Foamex | £30.00 / ea | £25.50 | £22.50 | £19.95 |
| `EDG-SR6224` | BLD-SR6224 | `42438135`, `SER-24` | 6 mm Reinforced Osc (12 mm). High-recycled corrugated, heavy display board | £30.00–£32.00 / ea | £26.50 | £23.50 | £20.95 |
| `EDG-SR6310` | BLD-SR6310 | `42441626`, `SER-310` | 6 mm oscillating, 20 mm OEM maximum in cited configuration. Triple-wall corrugated, honeycomb, Re-board | £36.00 / ea | £30.50 | £27.00 | £24.00 |
| `EDG-SR6315` | BLD-SR6315 | `42449504`, `SER-315` | 6 mm Slender Osc (14 mm). Soft foam board, tight curves, low overcut | £32.00–£35.00 / ea | £28.50 | £25.00 | £22.00 |

### DYSS and roll plotters

| Family code | Reference model and options | Reference codes to review | Application to verify | Prior UK benchmark (internal) | 1–4 | 5–9 | 10+ |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| `EDG-HTR040` | DYSS HTR-040 | `DYSS-40MM` | 40 mm Circular Rotary. Textiles, flag fabric, soft signage | £45.00–£55.00 / ea | £39.50 | £35.00 | £31.00 |
| `EDG-MIM-45` | Mimaki 30°/45°/60° | `SPB-0030`, `MD300V` | Roll plotter. Cast/calendered vinyl, reflective, flock | £13.55–£22.90 / ea | £11.95 | £9.00 | £7.50 |
| `EDG-ROL-45` | Roland 30°/45°/60° | `ZEC-U1005`, `ZEC-U5025` | Roll plotter. Standard vinyl, sandblast, heat transfer | £13.55–£23.99 / ea | £11.50 | £8.50 | £7.00 |
| `EDG-SUM-DRG` | Summa Roll Drag | `391-360` (36°), `391-231` (60°) | Summa D/S-Class Drag. Vinyl, thick laminate, reflective | £13.55–£20.83 / ea | £11.95 | £9.00 | £7.50 |
| `EDG-SUM-TAN` | Summa Tangential | `390-534` (36°), `390-560` (45°) | Summa S-Class Tangential. Heavy vinyl, high-speed lettering | £22.60–£36.00 / ea | £19.50 | £17.00 | £14.95 |
| `EDG-GRP-CB` | Graphtec CB09/CB15 | `CB09UB`, `CB15U` (45°/60°) | Roll plotter, confirm holder and angle separately. Vinyl, stencil film, flock | £13.55–£25.12 / ea | £11.95 | £9.00 | £7.50 |

### Catalogue evidence and corrections

| Family | Evidence to carry into catalogue review |
| --- | --- |
| Zünd Z71 | The Z71 OEM item is `5006045`. Item `5201345` belongs to the Z60 oscillating blade. Remove that association from Z71, including aliases and redirects. [Zünd consumables catalogue](https://books.zund.com/catalog-en) |
| Kongsberg SR6224 and SR6315 | Kongsberg lists `42438135` for BLD-SR6224 and `42449504` for BLD-SR6315. Exclude the former brief’s unsubstantiated codes `42442525` and `42443366` from those mappings. [Kongsberg tool and blade catalogue](https://store.kongsbergsystems.com/cms/delivery/media/MCT7MYITJDOZE3ZEZAE73L6V3OYU) |
| Kongsberg SR6310 | Kongsberg lists `42441626` and a 20 mm maximum for the configuration cited. Publish dimensions for the supplied replacement and its verified tool configuration. [Kongsberg tool and blade catalogue](https://store.kongsbergsystems.com/cms/delivery/media/MCT7MYITJDOZE3ZEZAE73L6V3OYU) |
| Zünd and Summa | Zünd’s item numbers include `3910105` for Z1, `3910110` for Z2 and `3910335` for Z50. Check Summa equivalents against the specific tool and document the Edgey fit separately. [Zünd catalogue](https://books.zund.com/catalog-en) · [Zünd Z50](https://my.zund.com/en/shop/product/3910335) · [Summa F-Series consumables](https://www.summa.com/media/jrujznt0/f_series_optionsconsumablesaccessories_eu_rev001_en.pdf) |

For the plotter families, map each code to the actual angle and holder on the supplier’s packet. In particular, keep CB09 and CB15 stock separate. A family label listing several angles gives the buyer choices only after each option is verified. Additional brand aliases and benchmark prices need dated evidence before they can support a public claim.
