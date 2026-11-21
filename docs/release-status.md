# Edgey release status

The weekend staging code is in place, but hosted acceptance is still pending. First live sales and Net 30 are not ready. The [staff trial and enquiry workflows](https://github.com/hey-inko/edgey/pull/13) and [trade-credit database](https://github.com/hey-inko/edgey/pull/11) are on main.

| Release | Built | Evidence and remaining work |
| --- | --- | --- |
| **Weekend staging** | Blade Finder, catalogue and product pages, selection and guest Stripe test checkout, sample intake, and staff picking and dispatch. The app has Stripe reconciliation and queued confirmation/request email. | Local tests use Supabase and simulated provider responses or a local inbox, not hosted providers. A real staging test must show one exact packet-to-dispatch journey, including a Stripe sandbox invoice and one Resend confirmation, and that two buyers cannot buy the last blade. Hosted Auth, workers, wallets and email delivery still need checking. Follow the [staging checklist](staging.md#6-run-the-weekend-staging-checklist-on-the-deployed-site). |
| **First live release** | Guest checkout and fulfilment code, request and trade application intake, stock management, cancellation and returns records. Staff can review, approve and dispatch trials; the request worker sends trial notices and staff replies. | Test-only Stripe keys and placeholder delivery coverage are not live sales. Request and confirmation delivery was exercised without hosted Resend; verify it on staging. Refunds are handled in Stripe. An authorised operator still needs to complete one controlled live-mode purchase, check the pick list, then cancel and reconcile the refund before dispatch. Replace all staging stock and mappings with approved records in a separate live environment. |
| **Trade credit** | The buyer portal shows linked orders, dispatch status and reorder. The database supports finance-controlled credit limits, gross credit holds, PO-linked invoices, settlement and buyer-only invoice access. | Card checkout is still guest-scoped; it doesn't attach signed-in orders or fill the portal's invoice link. Buyers can't yet order on account, submit a PO at checkout or receive a Net 30 Stripe invoice. Finance has tested the database rules locally, not the full provider lifecycle. Keep terms disabled until Finance can trace a PO through dispatch and settlement in staging. |

## Decisions before opening up

- **Catalogue:** Approve supplier fit and evidence for each published variant and alias, confirm its physical pick label and enter actual opening stock. Leave unverified variants in draft.
- **Commercial and Finance:** Approve the price matrix, all-units discounts and margin after delivery, VAT status and invoice details, customer terms and returns. Check a real sandbox invoice before enabling live payments; a test invoice does not establish statutory compliance.
- **Fulfilment:** Confirm the carrier, cut-off, coverage and services by postcode, holiday calendar, packaging and sample eligibility. Have a qualified adviser or Trading Standards confirm any remote-sale, age and delivery checks for the actual products and destinations before offering them.
- **Operations:** Name the people who pick, answer enquiries, approve samples and handle failed or returned orders. Publish contact and privacy information and agree and schedule retention before accepting public submissions.
- **Finance (credit):** Approve initial limits, approval and suspension rules, ownership of overdue invoices and how to reconcile them. Run the full 30-day invoice lifecycle in staging before enabling Net 30.

Use the [design acceptance pass](../design.md#visual-acceptance-pass) to review extension screens in both themes before the first live release.

## Acceptance evidence

- `pnpm test:acceptance` covers the seven card/trial scenarios in PRD §7 and the §1 weekend journey. It uses the production build and local Supabase, with simulated Stripe and a local email outbox. The visual checklist uses separate Chromium contact sheets and the browser suite checks the two visual regressions.
- The credit database suite covers limit permissions, concurrent holds and dispatch followed by settlement. It doesn't prove concurrent Stripe invoice creation, retries or settlement in the storefront. Those are trade-credit release gates.
- The staff enquiry page shows reply delivery state. Trial notice failures aren't listed in the staff desk yet; operations can check them in the staging Supabase outbox.
