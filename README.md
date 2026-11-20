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
confirmation and configure the Supabase Auth sender. Set the server-only
`SUPABASE_SERVICE_ROLE_KEY` and `EDGEY_REQUEST_HASH_KEY` (at least 32 random
bytes). Rate limits trust Vercel’s client IP header; requests without a trusted
IP share an IP bucket. The outbox records request confirmations and staff
notifications; a later worker sends them. Trial requests make no delivery
promise, and an approved application does not grant credit.

Before accepting public submissions, publish the privacy notice and have
operations approve retention periods. Schedule the service-only
`purge_request_data(p_enquiry_age, p_trial_age, p_trade_age, p_search_age)`
RPC with explicit positive PostgreSQL intervals (for example, `90 days`).
It removes expired rate windows, old Finder events and eligible requests
with their outbox messages. Converted enquiries and approved trial and trade
records are preserved for operational and audit use; operations must set
their separate retention policy. Finder analytics keep published terms in
normalised form and use keyed fingerprints for other code-like input only.
Unrecognised free text and input resembling an email, phone or postcode
are counted by outcome without keeping the query.
