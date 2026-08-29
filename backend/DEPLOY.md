# Deploying the backend

The frontend on Vercel is useless without this: `NEXT_PUBLIC_API_BASE_URL`
defaults to `http://127.0.0.1:8000`, which on a deployed site means *the
visitor's own machine*.

## Why not Vercel

Don't put it beside the frontend. Vercel is serverless — functions time out
and don't hold connections open. This backend needs neither of those things
taken away:

- a full agent run takes ~70 s, well past a serverless timeout
- the live execution screen holds a **WebSocket** for the length of a run
- **one instance only**: `app/agent/orchestrator/events.py` keeps subscriber
  queues in process memory, so a client connected to instance A would never
  see events emitted on instance B. `numReplicas` is pinned to 1 in
  `railway.json` for exactly this reason.

## Railway (recommended)

1. New Project → Deploy from GitHub → this repo
2. **Root directory: `backend`**
3. Nixpacks detects Python from `runtime.txt`; the start command comes from
   `railway.json` (and `Procfile` is there as a fallback)
4. Paste the environment below
5. Settings → Networking → **Generate Domain**

Region: pick the one nearest `ap-northeast-1`, which is where the Supabase
project lives. Singapore is the closest Railway offers.

## Fly.io — if you want the latency back

Fly has `nrt` (Tokyo), the same region as Supabase. That is the difference
between ~1 s and ~150 ms on every screen, because essentially all of the
current latency is round trips: a route that touches no database answers in
1.5 ms, and one that does takes 700–1200 ms regardless of how many rows it
reads.

Needs a Dockerfile and a `fly.toml`; ask if you want them written.

## Environment

Copy every value from your local `backend/.env`, with three changes:

| Key | Change |
|---|---|
| `DATABASE_URL` | **Session pooler, port 5432** — not 6543. Transaction mode breaks LangGraph's checkpointer, which needs a session that survives between calls. Percent-encode `@` in the password. |
| `CORS_ORIGINS` | Your Vercel URL, e.g. `https://hackhorizon.vercel.app`. Not `*`. |
| `ENVIRONMENT` | `production` |

Everything else carries over unchanged: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_WORKSPACE_ID`, and any `SCORING_*` / `AGENT_*` / `VENDOR_*`
overrides.

Two worth setting deliberately:

```
DATABASE_POOL_PRE_PING=false      # a SELECT 1 per checkout is a full round trip
AUTH_IDENTITY_CACHE_SECONDS=30    # otherwise every request re-reads public.users
```

Both are measured wins, and both matter more the further the host sits from
Supabase.

`PORT` is supplied by the platform — never set it yourself.

## Migrations

The schema is already applied to the live Supabase project, including
`010_rfq_and_po_closeout.sql`. Nothing to run.

If you ever point at a fresh project, run migrations from your laptop rather
than as a release step — a release command that seeds would overwrite real
data on every deploy:

```bash
python scripts/apply_migrations.py --only 010   # one file
python scripts/apply_migrations.py --no-seed    # schema + RLS, no demo rows
```

## Verify

```bash
curl https://<your-backend>/health
```

Expect `"status": "ok"` with `database.reachable: true` and
`anthropic.configured: true`. Then set `NEXT_PUBLIC_API_BASE_URL` to that
origin in Vercel and redeploy the frontend.

The WebSocket needs no separate configuration — it is the same origin over
`wss://`, and the web client derives that from the base URL.
