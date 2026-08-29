# AgentFlow — web console

A desktop-first console for the AgentFlow agent, talking to the **same
FastAPI backend and the same Supabase project** as the Flutter app. No
endpoint was added, no schema was changed, no migration was run. The backend
already said it: *"a clean REST + WebSocket surface with no Flutter-specific
logic: the mobile app and the future web dashboard are both just clients."*
This is that dashboard.

```
Flutter app ─┐
             ├─→ FastAPI (REST + WS) ─→ Supabase Postgres (23 tables, 43 RLS policies)
Web console ─┘         ▲
                       └─ Supabase Auth (ES256 via JWKS) issues the token both clients carry
```

---

## Running it

The backend must be up first — see `../backend`, then `python run_local.py`.

```bash
cd web
npm install
cp .env.local.example .env.local     # defaults already point at the local API
npm run dev                          # http://localhost:3000
```

Sign in with any demo account; password `AgentFlow!2026`.

| Role | Email | Lands on |
|---|---|---|
| Employee | `sara@agentflow.demo` | `/dashboard` |
| Admin | `admin@agentflow.demo` | `/admin` |
| Vendor | `vendor@techsupplies.demo` | `/portal` |

`.env.local` needs three values, none of them secret:

| Key | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `http://127.0.0.1:8000` | `127.0.0.1`, not `localhost` — on Windows `localhost` can resolve to `::1` while uvicorn binds IPv4. |
| `NEXT_PUBLIC_SUPABASE_URL` | the project URL | Same project as the Flutter client. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable key | Designed to ship in a browser; grants nothing beyond RLS. The **secret** key stays in `backend/.env`. |

---

## Stack

| Choice | Why |
|---|---|
| Next.js 15 (App Router) + React 19 | File routing matches the screen map; route groups give one authenticated shell for free. |
| TypeScript, `strict` | The API contract is transcribed into types, so a renamed field is a build error rather than an `undefined` in production. |
| Tailwind CSS v4 | `@theme` holds the design tokens as real CSS variables; the glass and clay treatments are `@utility` rules, not copy-pasted class soup. |
| TanStack Query v5 | Caching, retry policy and invalidation in one place. 401/403/404 are never retried — they will not become true by asking again. |
| `@supabase/supabase-js` | Auth only. Every read and write goes through the API. |
| Native `WebSocket` | The live feed needs a socket, not a framework. |

No component kit. Every primitive in `src/components/ui.tsx` is written
against the design tokens, because the point was to match a specific visual
language rather than to look like everyone else's admin panel.

---

## Design

Tokens are lifted verbatim from `app/lib/theme/tokens.dart`, which the Flutter
team extracted from `AgentFlow.dc.html` by frequency analysis. Turquoise
`#447f98`, ink `#243640`, the 28px card radius, and shadows tinted
`rgb(46,96,120)` rather than neutral black — that tint is what makes a screen
read as one material instead of a stack of grey rectangles.

Two surface treatments, kept unnormalised exactly as the design has them:

- **Liquid glass** — translucent white gradient, `blur(26px) saturate(1.7)`, a
  1px white border, a large tinted drop shadow, and two inset highlights.
  Used across the employee and admin console.
- **Claymorphism** — opaque, no blur, extruded with a soft outer shadow plus
  strong inset shading. Used in the vendor portal, matching screen 14d.

What is **not** carried over is the layout scale. A phone screen and a 1440px
console are different instruments playing the same score, so spacing, density
and type sizes are re-derived for the desktop: a persistent rail, two- and
three-up grids, detail panes beside lists rather than under them. Every colour,
radius, blur and shadow is unchanged.

Instrument Sans is the design's typeface, loaded from Google Fonts.

---

## Screens

**Employee**

| Route | Design | What it does |
|---|---|---|
| `/dashboard` | 1a | Greeting, live counts, recent runs, example prompts |
| `/requests/new` | 2a → 3a | Compose in plain English → review the inferred plan → confirm |
| `/workflows` | 10a | Filterable history |
| `/workflows/[id]` | 4a / 4b | Live execution over WebSocket, tool log, retry and escalation states |
| `…/comparison` | 5a / 11a | Scored supplier comparison, data confidence, coverage matrix |
| `…/validation` | 6a / 6b | The five checks, and the self-correction explainer |
| `…/purchase-order` | 7a | The PO as a printable document |
| `…/report` | 9a | Plain-language completion report |
| `…/audit` | 10b | Timeline union over steps, tool calls and approvals |
| `/vendors` | 13a | Directory; add a vendor for admin verification |
| `/vendors/[id]` | 18a detail | Full record: the reliability history the scorer reads, open flags, published catalog, admin actions |
| `/catalog` | 15a | Browse published catalogs |
| `/system` | — | Live introspection: health, compiled graphs, tool registry |

**Admin**

| Route | Design | What it does |
|---|---|---|
| `/admin` | 17a | Dashboard; the approval queue is the visual centre |
| `/admin/approvals` | 8a | Everything blocked on a human |
| `/admin/approvals/[id]` | 12a / 8b | Full PO review, then approve or reject |
| `/admin/vendors` | 18a | Verify, suspend, reinstate, delete; agent-raised flags |
| `/admin/scoring` | — | Live criterion weights, enforced to sum to 1.0 |
| `/admin/policies` | — | Expense policy rules driving the reimbursement engine |
| `/admin/spend` | — | Spend by vendor |

**Vendor portal** (clay treatment)

| Route | Design | What it does |
|---|---|---|
| `/portal` | 14a–14d | Inline-editable catalog, draft state, publish |
| `/portal/quotes` | — | Buyer quote requests: price them, or decline |
| `/portal/orders` | — | Incoming POs; delivery status feeds reliability scoring |
| `/portal/imports` | — | CSV upload → column mapping → row-level preview → commit |
| `/portal/connections` | — | Simulated catalog sources behind the `CatalogSource` interface |

`/portal/imports` is new. The backend's import schema, adapter interface and
endpoints already existed, but the column-mapping and preview UI was listed
under "Not finished" in the root README and no client had ever shipped it.

A notification bell sits in the top bar on every screen, reading
`/me/notifications`. That endpoint also predated any client.

---

## Quote requests — the way out of a dead end

A procurement run escalates when nothing in the catalog matches, or nothing
comes in under budget. That used to be terminal: the catalog held no answer
and there was no way to ask for one.

```
escalated  ──▶  buyer raises a quote request   (every verified vendor invited + notified)
                        │
                        ▼
                vendor replies with a price per line
                        │
                        ▼
                reply is written into THAT VENDOR'S CATALOG   (source 'rfq', published)
                        │
                        ▼
                buyer re-runs  ──▶  agent reads the catalog as it always did  ──▶  human gate
```

**The agent did not change.** No node, no edge, no new tool. It still only
ever *reads* the catalog, which is what keeps a run fast, deterministic and
replayable — and `POST /workflows/{id}/run` already accepted a workflow in
`escalated`. The vendor writes on its own schedule, exactly as the portal
already did. Everything new is a table, an endpoint and a screen.

Two things the UI is careful to say, because both are load-bearing:

- **An unpublished reply is invisible to the agent.** It reads the catalog and
  nothing else, so `published_to_catalog` is the difference between being
  considered and not. The vendor's publish toggle explains this in those words.
- **Silence is information.** A response row is created at *invite* time, not
  at reply time, so the buyer sees "Asked 5 suppliers · 1 replied" rather than
  a list of one. Declining is offered for the same reason: *"cannot supply
  this"* is a real answer, and a buyer staring at silence cannot tell it apart
  from a vendor who has not looked yet.

Verified end to end against the live backend: a workflow escalated at *"No
supplier in the catalog matches this request"*, one vendor quoted PKR 165,000
a unit, the re-run scored it 100 and selected it over the previous best of PKR
8,700,000, producing PO-2026-0025 at **PKR 8,250,000** — a 450,000 saving that
was previously unreachable, because the run simply died.

## Closing a purchase order

`delivery_status` is the **supplier's** account of an order, moved by the
vendor in their portal. The close-out on the PO screen is the **buyer's**,
recorded against the signed-in user, with an outcome, a received quantity and
a note.

They are deliberately separate columns. A vendor marking something delivered
and a buyer confirming it arrived are different claims — and until this
existed, every vendor reliability score rested on the supplier's own report of
its own performance.

---

## How the live screen works

`GET /workflows/{id}` is the source of truth; the socket is only a change
signal. `useWorkflowStream` connects to
`ws://host/ws/workflows/{id}?access_token=…&last_seq=N`, and every frame
invalidates the query rather than mutating local state, so the screen can
never drift from the database.

Three things follow from that, and all three are deliberate:

- **Catch-up is exact.** The hook tracks the highest `seq` it has rendered and
  reconnects with it. The server replays everything after that cursor before
  live frames resume, so a dropped socket never restarts the stepper or
  double-counts a step.
- **A refused upgrade is not retried.** Close code `1008` means the server
  declined — bad token, workflow not visible, or a vendor reaching for a buyer
  workflow. Reconnecting would just loop.
- **The socket is optional.** Every event has a REST equivalent, so the page
  also polls while a run is non-terminal. When the socket cannot be held open
  the header says *Polling*, not *Error* — because the screen still works.

Auth travels as a query parameter here and nowhere else: browsers cannot set
an `Authorization` header on a WebSocket upgrade. It is verified by the same
code path as every REST route.

---

## Things the console is careful about

- **Nothing runs until you confirm.** `POST /workflows` only plans. Execution
  starts at `POST /workflows/{id}/run`, and the composer says so plainly.
- **The type is inferred, never sent.** The request body carries free text
  only — the API refuses a `workflow_type` hint by design, and the plan screen
  calls out what Claude inferred.
- **No fabricated ratings.** A vendor below the configured minimum order count
  renders `reliability.display` verbatim — *"No history yet"* — and never a
  made-up star score.
- **Missing data is shown, not hidden.** An incomplete quote gets a neutral
  sub-score and a visible *"data confidence 67% (warranty not specified)"*
  caveat. It is never silently penalised and never auto-excluded.
- **Score bars are honest.** Screen 5a's bar widths are not self-consistent —
  Metro's warranty segment is drawn wider than TechSupplies' despite half the
  warranty, and no monotonic formula produces that. Widths here come from the
  real weighted contributions. Ranking and totals match the design; segment
  widths do not, and `ScoreBar.tsx` records why. Imputed segments are hatched.
- **Idempotency is explained.** A double-tap on Approve returns
  `resumed: false`. That is the endpoint working, so it reads as a neutral
  note rather than a failure.
- **Delete-vendor is expected to fail.** The FK from quotes is
  `ON DELETE RESTRICT` so audit history can never lose its counterparty. The
  409 is surfaced with its real message and the suggestion to suspend instead.
- **Connections are simulated, and say so.** No outbound HTTP happens inside a
  run. The vendor portal writes to the database on its own schedule; the agent
  only ever reads — which is what keeps a run fast, deterministic and
  replayable.
- **No silent truncation.** Where a list is capped, the cap is stated.

---

## Notes

- Roles are read from the JWT's `app_metadata.role` claim — the same claim the
  backend's `_resolve_user` reads. The rail and the API's 403s therefore agree:
  a vendor never sees a buyer route, and is also refused if they force the URL.
- Everything is client-rendered. The session lives in the browser and the API
  is a separate origin, so server components would only add token plumbing for
  no benefit here.
- `CORS_ORIGINS=*` in `backend/.env` is fine for local work because requests
  carry a bearer token and `credentials: "omit"`. For a deployment, set it to
  the console's real origin.
- Light-only. The design has no dark variant, and committing to light is more
  honest than inventing one.
