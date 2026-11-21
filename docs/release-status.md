# Edgey release status

Weekend staging and trade-credit code are in place, but hosted acceptance is still pending. First live sales and Net 30 aren't ready to enable.

| Release | Built | Evidence and remaining work |
| --- | --- | --- |
| **Weekend staging** | Blade Finder, catalogue and product pages, selection and guest Stripe test checkout, sample intake, and staff picking and dispatch. The app has Stripe reconciliation and queued confirmation/request email. | Local tests use Supabase and simulated provider responses or a local inbox, not hosted providers. A real staging test must show one exact packet-to-dispatch journey, including a Stripe sandbox invoice and one Resend confirmation, and that two buyers cannot buy the last blade. Hosted Auth, workers, wallets and email delivery still need checking. Follow the [staging checklist](staging.md#6-run-the-weekend-staging-checklist-on-the-deployed-site). |
| **First live release** | Guest checkout and fulfilment code, request and trade application intake, stock management, cancellation and returns records. Staff can review, approve and dispatch trials; the request worker sends trial notices and staff replies. | Test-only Stripe keys and placeholder delivery coverage are not live sales. Request and confirmation delivery was exercised without hosted Resend; verify it on staging. Refunds are handled in Stripe. An authorised operator still needs to complete one controlled live-mode purchase, check the pick list, then cancel and reconcile the refund before dispatch. Replace all staging stock and mappings with approved records in a separate live environment. |
| **Trade credit** | Signed-in card orders appear in the buyer portal, and approved buyers can place Net 30 orders with a PO. Finance can review applications, change limits, suspend or reinstate accounts, follow up overdue invoices and resolve payment exceptions. The buyer portal shows credit, balance, order history and linked Net 30 invoices. | Local Supabase and a simulated Stripe API cover concurrent checkout, lost responses, dispatch and settlement. Keep `NET30_CHECKOUT_ENABLED=false` until finance traces a real sandbox invoice through the [Net 30 sign-off](net30-sandbox.md), including PDF, VAT, partial payment, void and refund. |

## Decisions before opening up

- **Catalogue:** Approve supplier fit and evidence for each published variant and alias, confirm its physical pick label and enter actual opening stock. Leave unverified variants in draft.
- **Commercial and Finance:** Approve the price matrix, all-units discounts and margin after delivery, VAT status and invoice details, customer terms and returns. Check a real sandbox invoice before enabling live payments; a test invoice does not establish statutory compliance.
- **Fulfilment:** Confirm the carrier, cut-off, coverage and services by postcode, holiday calendar, packaging and sample eligibility. Have a qualified adviser or Trading Standards confirm any remote-sale, age and delivery checks for the actual products and destinations before offering them.
- **Operations:** Name the people who pick, answer enquiries, approve samples and handle failed or returned orders. Publish contact and privacy information and agree and schedule retention before accepting public submissions.
- **Finance (credit):** Approve initial limits, approval and suspension rules, ownership of overdue invoices and how to reconcile them. Run the full 30-day invoice lifecycle in staging before enabling Net 30.

Use the [design acceptance pass](../design.md#visual-acceptance-pass) to review extension screens in both themes before the first live release.

## Acceptance evidence

- `pnpm test:acceptance` covers the card, trial and Net 30 acceptance scenarios in PRD §7 and the §1 weekend journey. Net 30 runs the concurrent checkout and timeout cases against local Supabase, then drives finance approval, checkout, dispatch, partial payment and settlement through the production build in Chromium. All provider responses are simulated; webhook verification uses signed request bytes. The visual checklist uses separate Chromium captures.
- The staff enquiry page shows reply delivery state. Trial notice failures aren't listed in the staff desk yet; operations can check them in the staging Supabase outbox.
