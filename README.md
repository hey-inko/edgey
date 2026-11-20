# Edgey

Design handoff for the Edgey storefront, version 3. Edgey sells replacement tooling for digital cutting tables and plotters.

Start with [design.md](design.md) and open [Edgey-preview.html](Edgey-preview.html) in a browser beside it.

| Path | Use it for |
| --- | --- |
| `design.md` | Design intent, exact values, interaction rules and review criteria. |
| `Edgey-preview.html` | A working visual reference with embedded assets. |
| `design-tokens.json` | Reusable values for colour roles, type, proof names, responsive thresholds and characteristic angles. |
| `assets/` | The master wordmark, favicon, editable board study, five proof textures and four catalogue drawings. |
| `figures/` | Wordmark construction, paired drawing states, proof families and card composition. |

## Local storefront

Use Node 24, the pnpm version in `package.json` and a running Docker engine. No
hosted project or credentials are needed.

```sh
pnpm install --frozen-lockfile
pnpm db:start       # Start local Supabase and apply the migrations and draft seed
pnpm db:env         # Write local settings to the ignored .env.local
pnpm db:fixture     # Published test catalogue for development and database/browser tests
pnpm dev
```

The app runs at http://localhost:3000. `pnpm db:reset` resets the **local**
database and reloads the 23 draft families with zero stock. Run
`pnpm db:fixture` again after a reset if you want published test data. Those
approvals, stock and fit are fabricated for development; never use the fixture
as catalogue evidence or apply it to a live project. `pnpm db:stop` stops
local Supabase.

### Staff desk

Start and seed local Supabase as above, then create one account per staff role:

```sh
read -rsp 'Disposable local staff password (12+ chars): ' EDGEY_LOCAL_STAFF_PASSWORD
echo
export EDGEY_LOCAL_STAFF_PASSWORD
node scripts/seed-admin.ts
unset EDGEY_LOCAL_STAFF_PASSWORD
```

Open `/admin` and sign in with one of the printed test emails. The script
refuses non-local Supabase URLs and never prints the password. Each run creates
new users; a local database reset removes them. Playwright provisions separate
test users and a paid fixture order without touching any external provider.
In a deployed environment, issue verified Supabase Auth accounts separately
and assign the minimum required role in `staff_members`; do not run this seed.
Hosted staff sign-in uses the existing request hashing key and trusted Vercel
client address to enforce password-attempt limits per IP and per IP/email pair. It fails closed if
those inputs are missing. Configure Supabase Auth rate limits as well, because
the application limiter cannot cover requests sent directly to Supabase.

Finance replay controls record retry requests but cannot process them until the
provider worker is connected. A request is keyed by target and its latest
failure timestamp, without resetting the provider event or email state.

### Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:db                       # With local Supabase and the staging fixture
pnpm bench:search                  # 100 warm calls to the anonymous HTTP RPC
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e                       # Uses the fixture and starts the production build on port 3100
```

Run `pnpm tokens` to regenerate `src/app/tokens.css` from the design pack.
Public catalogue reads use the publishable key. Supplier data, stock counts
and unpublished mappings stay behind database grants and RLS. Request
submissions and Finder analytics use service-only RPCs from the server.

### Enquiries, trials and trade applications

The delivery enquiry link is `/enquiry?postcode=<encoded postcode>`. For
local trade sign-in, request the link in the browser and open it in the same
browser from the [local mail inbox](http://127.0.0.1:54324). If upgrading an
already-running local stack, restart it to pick up the local mail settings.
`pnpm test:e2e` uses that inbox and the default port 3100 for its auth callback.

On Vercel, set `NEXT_PUBLIC_SITE_URL` to the HTTPS storefront origin and
allow that origin’s exact `/auth/confirm` URL in Supabase Auth. Enable email
confirmation and configure the Supabase Auth sender and provider-side abuse
limits. Open the link in the browser that requested it. Set the server-only
`SUPABASE_SERVICE_ROLE_KEY` and `EDGEY_REQUEST_HASH_KEY` (at least 32 random
bytes). Rate limits trust Vercel’s client IP header and do not accept hosted
submissions when it’s missing; the local stack uses a shared IP bucket.
Finder telemetry ignores prefetch and recognised crawlers and caps writes
per IP and globally. The outbox records request confirmations and staff
notifications; a later worker sends them. Trial requests make no delivery
promise, and an approved application does not grant credit.

Before accepting public submissions, supply the HTTPS privacy notice URL as
`EDGEY_PRIVACY_NOTICE_URL` and have operations approve retention periods.
Set `EDGEY_PUBLIC_REQUESTS_ENABLED=true` only after scheduling the service-only
`purge_request_data(p_enquiry_age, p_trial_age, p_trade_age, p_search_age)`
RPC with explicit positive PostgreSQL intervals (for example, `90 days`).
It removes expired rate windows, old Finder events and eligible requests
with their outbox messages. An in-review enquiry or trial is kept if it was
updated within its retention period. Converted enquiries and approved trial and trade
records are preserved for operational and audit use; operations must set
their separate retention policy. Finder analytics keep published terms in
normalised form and use keyed fingerprints for other code-like input only.
Unrecognised free text and input resembling an email, phone or postcode
are counted by outcome without keeping the query.

### Make a test payment locally

1. Run the local setup above. In the Stripe dashboard select a **sandbox**,
   enable cards in its payment method settings, and copy the sandbox secret
   key into the ignored `.env.local` as `STRIPE_SECRET_KEY`. Set
   `NEXT_PUBLIC_SITE_URL=http://localhost:3000` and a random `CRON_SECRET`.
   For email without sending externally, set `EMAIL_PROVIDER=file`,
   `EMAIL_FROM="Edgey <orders@example.test>"`, and `EMAIL_OUTBOX_DIR` to an
   absolute directory outside the repository and under your control.
   Run `pnpm db:env` before adding these entries; it overwrites the file.
2. Log the Stripe CLI into that same sandbox. Keep this command running and
   put its signing secret in `.env.local` as `STRIPE_WEBHOOK_SECRET`. Restart
   `pnpm dev` after changing the environment.

   ```sh
   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.refunded,refund.created,refund.updated,refund.failed,invoice.finalized --forward-to http://localhost:3000/api/webhooks/stripe
   ```

3. Open `http://localhost:3000/blades/edg-z10`, add 5 blades and check out with
   a test address in `SW1A 1AA` and an email you control. Use Stripe’s test
   card `4242 4242 4242 4242`, a future expiry and any three-digit CVC. Confirm
   **£128.04** on Checkout, the return page and the Stripe paid invoice. If the
   page is still confirming, check that the CLI shows a 2xx webhook response.
4. Run the protected workers below. If the invoice is still pending, wait at
   least two minutes and run the confirmation worker again. Check that the
   private mail directory has one message containing the order reference,
   amounts, dispatch date and the Stripe invoice link if it was ready.

   ```sh
   # Set CRON_SECRET in your shell to the same value configured for Next.
   curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" http://localhost:3000/api/cron/stripe-reconciliation
   curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" http://localhost:3000/api/cron/order-confirmations
   ```

### Connect staging and operate the queues

- Apply the Supabase migrations to the isolated staging database. Set the
  Supabase variables, Stripe sandbox key and staging HTTPS origin on the
  deployment. In the same Stripe sandbox, add a **snapshot** webhook for
  `https://<staging-host>/api/webhooks/stripe` at API version
  `2026-11-18.endive`, selecting the event types from the CLI command above.
  Set its signing secret as `STRIPE_WEBHOOK_SECRET` and redeploy. If staging
  uses deployment protection, allow Stripe to reach this endpoint. Validate
  card and eligible Apple Pay/Google Pay on supported devices; do not use live
  keys or real buyer details in this build.
- Schedule both GET paths on the staging host every minute using a scheduler
  that sends `Authorization: Bearer $CRON_SECRET`. For Vercel Cron, deploy a
  staging project with staging as its production deployment, a plan that
  supports one-minute schedules, and set `CRON_SECRET` in its production
  environment. Add these entries to its deployment config:

  ```json
  {
    "crons": [
      { "path": "/api/cron/stripe-reconciliation", "schedule": "* * * * *" },
      { "path": "/api/cron/order-confirmations", "schedule": "* * * * *" }
    ]
  }
  ```

- Use `EMAIL_PROVIDER=resend` (the default), `RESEND_API_KEY` from the staging
  Resend account and a verified `EMAIL_FROM`. Use only controlled test
  recipients. Keep the account and sender configuration stable while sends
  are pending. JSON files from the development provider contain buyer details
  and must not be committed or shared.
- A Stripe event is acknowledged after durable storage; an application failure
  remains visible on `provider_events` for the reconciliation job or finance
  replay. Review `orders.stripe_reconciliation_error` and
  `payment_review_reason` for holds needing intervention. Never free a hold
  with an ambiguous provider creation or capture. Use the Stripe order
  metadata and event history to verify the provider outcome first.
- The confirmation worker only claims `order_confirmation` rows. It freezes the
  message before sending and reuses the original provider key on retries. For
  an ambiguous or expired send, look up the order reference in Resend before
  attempting any manual delivery; the worker won't resend beyond the safe
  idempotency window. Don't reset a failed row to force a new send.

Stripe’s line prices are the saved VAT-inclusive totals, with the net and VAT
shown on each paid invoice line and in the footer. Stripe automatic tax and FX
are off so Stripe cannot re-round or convert the amount. The staging invoice
does not certify statutory VAT invoice compliance. Finance must inspect an
actual sandbox invoice, approve statutory details and validate the VAT and
shipping setup before any live release.
