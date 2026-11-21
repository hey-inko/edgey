# Stand up and verify Edgey staging

Staging is for controlled testers, fake contact and delivery details, Stripe sandbox payments and test inboxes. It is not the live shop. Use a separate Vercel project, Supabase project, Stripe sandbox and Resend sender/key. Never connect this deployment to live data or publish the fixture as verified supplier stock.

## 1. Create the projects and choose the URL

1. Check out the commit you intend to stage. From the repository root, run `pnpm install --frozen-lockfile` with Node 24.
2. Create a fresh Supabase project for staging, using Postgres 17 to match local development. Record the project ref and database password securely. In Vercel, create a dedicated Edgey staging project on a plan with [one-minute Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) (Pro or above). Use the Next.js preset, Node 24 and the repository root. Install the [Vercel CLI](https://vercel.com/docs/cli), run `vercel login` and link your working directory with `vercel link`; verify the staging project and team when prompted.
3. Choose the fixed HTTPS origin for the staging project, for example `https://edgey-staging.example.com`. Use the **Production** environment of that *staging project*, not a Preview deployment: its fixed origin is needed for callbacks and Vercel only schedules Cron for Production deployments. Set [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection#all-deployments) to **All Deployments** and grant access to the testers. Standard Protection leaves the production domain public. Keep request intake disabled while setting up.

## 2. Apply migrations, then load the test catalogue

Sign in with `pnpm exec supabase login` or inject `SUPABASE_ACCESS_TOKEN` from the operator's secret store. In the commands below, set `STAGING_PROJECT_REF` to the ref copied from the **staging** Supabase dashboard. Use the staging database password if prompted. Confirm the dry run lists the versioned migrations you expect before applying them.

```sh
pnpm exec supabase db push --remote="$STAGING_PROJECT_REF" --skip-vault --dry-run
pnpm exec supabase db push --remote="$STAGING_PROJECT_REF" --skip-vault
pnpm exec supabase migration list --remote="$STAGING_PROJECT_REF"
```

Do not pass `--include-seed`: the guarded import below runs the draft seed and publishes the test subset together. From **Connect → Direct connection**, load the staging Postgres URL with its URL-encoded password, omitting any query string, into `EDGEY_STAGING_DB_URL` using your secret store. Set `EDGEY_STAGING_DB_CA_FILE` to the local path of the [server root certificate](https://supabase.com/docs/guides/database/psql#connecting-with-ssl) downloaded from that project. Run from a network with IPv6 or with Supabase's direct IPv4 add-on. The script does not accept a pooler URL, localhost or unverified TLS.

```sh
pnpm db:fixture:staging --project-ref "$STAGING_PROJECT_REF"
unset EDGEY_STAGING_DB_URL EDGEY_STAGING_DB_CA_FILE
```

The importer requires the explicit ref to match the database hostname. It refuses a database that already has catalogue, customer intake, order or Auth user rows. That makes it a one-time bootstrap for a fresh migrated project, not a way to restore sold stock or rerun fixtures in an existing project. For local development, `pnpm db:reset && pnpm db:env && pnpm db:fixture` is repeatable; `db:reset` wipes local data and `db:fixture` refuses non-local addresses. For subsequent staging sessions, receive stock through the staff desk or use a fresh, isolated project; never reset a hosted database to rerun a test.

The first four design products use Appendix A prices, not the portable demo's data. Check these names and per-unit prices excluding VAT at 1–4 / 5–9 / 10+ units:

| SKU | Name | Prices |
| --- | --- | --- |
| EDG-Z10 | Flat-stock drag blade | £22.50 / £19.95 / £17.50 |
| EDG-Z16 | Oscillating blade | £21.50 / £18.50 / £15.95 |
| EDG-SR6223 | Round-shank blade | £25.50 / £22.50 / £19.95 |
| EDG-Z50 | Decagonal rotary blade | £38.00 / £34.00 / £30.00 |

## 3. Set up Supabase Auth and the test staff

1. Under **Authentication → URL Configuration**, set **Site URL** to the staging origin and add only the exact callback `https://<staging-host>/auth/confirm` to the hosted redirect allowlist. Keep local redirects in the local stack. Enable the Email provider and email confirmation. Keep the Confirm signup and Magic link templates pointing to `{{ .ConfirmationURL }}`; the callback expects a PKCE `code`, not a `token_hash` query parameter. Open the email link in the browser that requested it.
2. Verify a staging sender domain in Resend. In **Authentication → Emails → SMTP Settings**, enable [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp). For [Resend SMTP](https://resend.com/docs/send-with-supabase-smtp), use `smtp.resend.com`, port `465`, username `resend` and a staging Resend API key as the password. Set a verified sender address and disable click tracking on the Auth links. Configure Supabase Auth rate limits for controlled testing. Auth SMTP is separate from the application's Resend HTTP API; do not put the SMTP password into Vercel.
3. After the fixture import, create each staff user under **Authentication → Users → Add user → Create new user**, confirm the controlled email and issue a unique strong password securely. Copy the created user's UUID. In that staging project's SQL Editor, add one role row per user, with only the access needed:

   ```sql
   insert into public.staff_members (user_id, role) values
     ('<warehouse Auth UUID>', 'warehouse'),
     ('<catalogue Auth UUID>', 'catalogue'),
     ('<finance Auth UUID>', 'finance');
   ```

   Enable TOTP enrollment and verification in hosted Supabase Auth. During in-person onboarding, confirm the staff member's identity independently. Observe them enroll their own authenticator at `/admin/sign-in` and verify the code. Copy the exact factor ID shown on their pending-approval screen in person; do not approve a factor based on an email, chat request, friendly name, or the newest record in Supabase. A trusted operator must activate that verified factor using the hosted SQL editor:

   ```sql
   select public.activate_staff_authenticator('<staff Auth UUID>', '<observed factor UUID>');
   ```

   The app and database match the actual GoTrue session's TOTP factor to that approval. A password, magic link, or a verified but unapproved TOTP factor cannot grant staff access. Before making staff access available, confirm this policy on the target Supabase version with a controlled staff account, then verify that each approved staff member reaches only their assigned roles. Migrate existing staff factors through the same check; there is no grandfathering. For lost authenticators, verify identity in person, revoke sessions and remove roles before resetting factors, then restore only the approved role and repeat enrollment and approval. Keep staff accounts separate from buyer accounts. Do not use the local-only `scripts/seed-admin.ts` on hosted staging.

   Before enabling hosted intake, confirm Auth password policy (including leaked-password protection where available), Auth throttles for password/token/OTP/MFA and SMTP send limits. Rate-limit the direct anonymous `search_blades` RPC at the Supabase API boundary; protecting only the Vercel site does not cover it. Exercise the normal Finder, quote, checkout and staff paths after configuring limits. The app limits public selection quotes to 100 lines, 120 priced checks per trusted IP per hour and 10,000 globally. The public quote budget does not gate checkout; payment uses its own limits. Include checkout endpoints in hosted abuse monitoring because initial payment requests may reprice before the reservation limits. Confirm the hosted trusted IP header is present, comes only from the platform and stays correct behind any fronting proxy. Where the deployment permits it, add managed abuse controls for distributed requests, magic-link quota exhaustion and unsolicited receipt emails. Do not treat client-supplied IP or a honeypot as a substitute for hosted limits.

## 4. Set up Stripe, email and the deployment environment

1. In the isolated Stripe sandbox enable cards and allow Apple Pay/Google Pay where eligible. Use that sandbox's `sk_test_…` key. Add a **snapshot** webhook in the same sandbox at `https://<staging-host>/api/webhooks/stripe`, API version **2026-11-18.endive**. Subscribe to:

   - `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
   - `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`
   - `invoice.finalized`, `invoice.sent`, `invoice.paid`, `invoice.payment_succeeded`, `invoice_payment.paid`
   - `invoice.voided`, `invoice.deleted`, `invoice.marked_uncollectible`, `invoice.overdue`, `credit_note.created`, `credit_note.voided`

   Save that endpoint's signing secret, not the secret from a local Stripe CLI listener. If Vercel protects the domain, [configure its automation bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) on the Stripe endpoint URL with the `x-vercel-protection-bypass` query parameter so Stripe can reach it. Keep that endpoint URL with its token private and verify an actual signed delivery; it must not be redirected to a login. Keep the Stripe sandbox fixed while any orders are pending.
2. In the staging Vercel project's **Settings → Environment Variables**, configure the following for **Production**. Generate the hash key and Cron token independently with `openssl rand -hex 32` in a private terminal and store them securely. Enable Vercel's system environment variables so `VERCEL=1` is available and the app uses Vercel's trusted client IP; do not spoof the header or set `VERCEL` yourself.

   | Name | Value and source |
   | --- | --- |
   | `NEXT_PUBLIC_SITE_URL` | Exact staging HTTPS origin, without a path; used by Auth, Stripe and canonical URLs. |
   | `NEXT_PUBLIC_SUPABASE_URL` | Staging Supabase's project API origin, `https://<project-ref>.supabase.co`, from **Connect** or the project's API settings. |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Staging Supabase's public publishable key (or legacy anon key); never the secret key. |
   | `SUPABASE_SERVICE_ROLE_KEY` | Server only: staging Supabase secret key or legacy service-role key. |
   | `EDGEY_REQUEST_HASH_KEY` | Server only: stable random key of at least 32 bytes for checkout, staff sign-in, request limits and Finder fingerprints. |
   | `STRIPE_SECRET_KEY` | Server only: full Stripe sandbox secret key (`sk_test_…`); do not use a live key. |
   | `STRIPE_WEBHOOK_SECRET` | Server only: signing secret (`whsec_…`) for the sandbox snapshot endpoint above. |
   | `NET30_CHECKOUT_ENABLED` | Keep `false` until the [Net 30 sandbox sign-off](net30-sandbox.md). Turn it on only in the isolated staging deployment for that test. |
   | `CRON_SECRET` | Server only: independently generated bearer token of at least 32 bytes that Vercel includes on worker requests. |
   | `EMAIL_PROVIDER` | `resend` (the default). The file outbox is local only. |
   | `RESEND_API_KEY` | Server only: API key with sending permission for the verified staging domain. |
   | `EMAIL_FROM` | Verified staging sender, such as `Edgey <orders@staging.example.com>`. |
   | `REQUEST_STAFF_EMAIL` | One plain email address for the controlled staff requests inbox. |
   | `EDGEY_PRIVACY_NOTICE_URL` | Published HTTPS privacy notice for the hosted forms; include the appropriate test handling. |
   | `EDGEY_PUBLIC_REQUESTS_ENABLED` | `false` during setup. Set `true` only after the privacy and retention steps below; enables enquiries, trial/trade intake and buyer magic links. |

   Use Vercel's Secret type for server-only credentials and tokens. Keep `SUPABASE_DB_URL`, `EDGEY_LOCAL_STAFF_PASSWORD`, `PLAYWRIGHT_PORT` and `EMAIL_OUTBOX_DIR` local. Keep `EDGEY_STAGING_DB_URL`, `EDGEY_STAGING_DB_CA_FILE`, `SUPABASE_ACCESS_TOKEN` and any `VERCEL_TOKEN` in operator tooling only. `NODE_ENV`, `VERCEL` and CI variables are supplied by their runtimes. Do not copy `.env.local` onto Vercel.
3. With intake still off, deploy the pinned commit to the staging project (`vercel --prod` from the linked checkout, or deploy that commit from the project's Production branch). In **Settings → Cron Jobs**, check that `/api/cron/stripe-reconciliation`, `/api/cron/order-confirmations` and `/api/cron/request-emails` are registered to run every minute. Vercel sends `Authorization: Bearer …` automatically when the secret is set. Use the dashboard's run and log views to confirm 2xx runs; a bare request must not execute a worker. If the deployment does not use the committed `vercel.json`, fix the deployment rather than making an unprotected endpoint.
4. Have operations publish the business contact and privacy information and approve explicit positive retention intervals for enquiries, trials, trade applications and Finder events. In the staging Supabase Cron dashboard (enable `pg_cron` if needed), schedule a daily SQL job calling `public.purge_request_data` as a privileged database operator. Replace every placeholder below with an approved PostgreSQL interval before scheduling at an agreed UTC time:

   ```sql
   select public.purge_request_data(
     interval '<enquiry age>', interval '<trial age>',
     interval '<trade application age>', interval '<Finder event age>'
   );
   ```

   Verify a run in the job history and configure failure monitoring. This job preserves approved trial/trade and converted enquiries and does not manage order PII or Auth users. Before opening intake or live sales, the owner must approve separate deletion or minimisation rules for those records, covering statutory invoice retention, active orders and credit, dispute/legal holds, unconfirmed Auth users, and the copies held by email/payment providers and backups. Specify what is removed or retained and when, who may run it, and how the result is audited. Keep intake off until the agreed safeguards are in place, restrict access and use controlled inboxes. A setting change does not update an already-built deployment.

   Keep the Supabase service-role key in server-only configuration, use separate keys and projects per environment, and rotate it on suspected exposure. It bypasses RLS: the staff application verifies the session and derives actor identity before invoking staff service RPCs, and each RPC rechecks the applicable database role. A holder of the master key is not equally constrained. Review Auth logs and the existing per-domain operation/ledger history; confirm production alerting and decide retention for any cross-domain actor audit before adding one.

## 5. Check the selected environment

Run `pnpm staging:check` with only the staging app's variables exported, or pass the exact dotenv snapshot with `pnpm staging:check --from <file>`. For a Vercel snapshot, verify the CLI is linked to the staging project first:

```sh
(
  umask 077
  directory=$(mktemp -d)
  trap 'rm -rf "$directory"' EXIT
  vercel env pull "$directory/staging.env" --environment=production &&
    pnpm staging:check --from "$directory/staging.env"
)
```

Do not commit, upload or log the snapshot. If Vercel withholds sensitive values, validate using the same values from the operator's secret store in a private shell instead; the checker must treat withheld values as missing. It reports missing or invalid settings without printing their values and exits nonzero if staging isn't configured for the full checklist. It does not call providers, inspect a running function, prove that the projects are isolated or verify that the values reached the active deployment. Confirm those in the dashboards and run the checks below against the deployed commit.

## 6. Run the weekend staging checklist on the deployed site

Record the deployed commit, staging URL, time, test order reference and evidence with personal details and secrets removed. Do not ship a parcel or use a real order address.

| Evidence to record | Result |
| --- | --- |
| Deployment URL, commit and time (UTC) | |
| Order reference, invoice and pick-list checks | |
| Last-blade contender and restored availability | |
| Trial, Auth, mail and supported wallets | |
| Visual evidence and any exceptions | |

- [ ] **Find the exact blade.** Use “Find a blade” and search packet code `3910301`. It must select EDG-Z10, the flat-stock drag blade for the UCT. Search `SPB-0030` and confirm the 45° and 60° options require a choice. An unfamiliar code should offer an enquiry, and `5201345` must never match Z71.
- [ ] **Order it and receive confirmation.** In a clean guest session, take five EDG-Z10s through selection and checkout with a controlled mailbox and a supported fictional UK business address. Expect £99.75 goods, £6.95 delivery and £21.34 VAT, for **£128.04** in Edgey and Stripe. Use Stripe test card `4242 4242 4242 4242`, a future expiry and any three-digit CVC. Confirm the Stripe webhook got a 2xx response and the Edgey return page shows the paid order. Wait for the workers, check exactly one Edgey confirmation with the right SKU/quantity and dispatch promise, and check £128.04 on the Stripe paid invoice. Refresh the saved success page and confirm the order, allocation and email do not duplicate. Separately verify eligible Apple Pay and Google Pay on supported devices and record what was available.
- [ ] **Pick that exact variant and record dispatch.** At `/admin/warehouse`, open that order and its printable pick list. Match EDG-Z10, quantity five, the recorded recipient, service and promised dispatch date against checkout and confirmation. Start picking, record a fictional carrier and tracking reference, and confirm it appears as dispatched once in history with the same reference. Do not send any physical goods.
- [ ] **Prove two buyers cannot buy the last blade.** Verify one EDG-MIM-A60 is available in staff stock. In two independent guest browser contexts with distinct controlled emails, submit payment for one 60° unit at the same time. Exactly one may see a payable Stripe session; the other must see an availability correction, not a second payable session. Do not pay for this contention check. With the Stripe CLI authenticated to the same sandbox, run `stripe checkout sessions expire <cs_test_session_id>` using the winning session ID from that sandbox. Verify Stripe reports it expired and reconciliation releases the hold. Close the losing test session after its buyer proves they can now reach payment. Expiry of the old session must not create an order confirmation.
- [ ] **Request a trial without a delivery promise.** Submit `/sample-pack` with a controlled work email, company, machine brand, OEM code or “unknown”, and a test postcode. Check receipt on screen and by email, no promise of dispatch, no stock reservation on intake, and a matching staff request. Confirm a test buyer can open a real Auth magic link in the originating browser and a buyer without a staff role cannot use the staff desk.
- [ ] **Review and fulfil the test trial.** As catalogue staff, check the fit and eligibility, then choose two specific blade units. As warehouse staff, verify the fictional delivery address and service, approve the trial and check that exactly two units are reserved. Record a test dispatch and tracking reference; the allocation should be consumed once. Separately exercise staff trial notifications and an enquiry reply with controlled inboxes. A message queued in the staff desk is not proof of delivery.

Measure Finder latency separately from the journey: point `pnpm bench:search` at the isolated staging Supabase public endpoint for 100 warm RPCs (p95 under 50 ms). On a controlled browser runner with Chromium installed and access to the storefront, run `node scripts/bench-finder-mobile.mjs <storefront-origin>` for the 390 px browser input-to-exact-result latency, including the debounce. The benchmark requires the staging fixture for `3910301` and identifies its browser as a benchmark so it does not add search events. For a protected deployment, use an authorised browser/device and record the same interval; do not pass protection credentials in the URL. Record environment, sample count and network/device conditions with the result.

Keep automated acceptance results separate from this hosted evidence. Review [the design acceptance pass](../design.md#visual-acceptance-pass) on the deployed build; it calls for both themes at 1440, 390 and 320 px, keyboard/focus and reduced-motion checks, and screenshots of deliberate departures.

If a Stripe event stalls, check the sandbox delivery and Finance queue before replaying. Never free a hold when Stripe creation or capture is ambiguous. If email delivery is uncertain, look up the order reference in Resend before any manual send. Do not force a resend by resetting an outbox row. A sandbox invoice is not evidence of statutory VAT compliance.

Trial notice delivery states are not yet displayed in the staff desk. In the staging Supabase SQL Editor, check `message_key`, `state` and `last_error` in `public.order_outbox` for the request's `trial_request_id`. An unsent approval withdrawn on cancellation is intentionally suppressed.

## 7. Run the Net 30 sandbox sign-off

Finance should follow the [Net 30 checklist](net30-sandbox.md) in the isolated staging deployment. Check the request worker's `trade_approved` and `trade_rejected` delivery against a controlled mailbox; approval is not proof that mail was sent. Trade decision delivery state is available in the same outbox by `trade_application_id`. Reset the flag after the exercise if terms are not approved for ongoing use.
