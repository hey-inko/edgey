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
The storefront uses the anonymous/publishable key only. Supplier data, stock
counts and unpublished mappings stay behind the database grants and RLS.
