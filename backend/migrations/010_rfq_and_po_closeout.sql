-- =========================================================================
-- 010 — Request for quotation, and purchase-order close-out
--
-- Two gaps this closes.
--
-- 1. WHEN NOTHING MATCHES, THE RUN DIED.
--    budget_filter escalating with no qualifying vendor was a terminal state:
--    the workflow said "No supplier in the catalog matches this request" and
--    stopped. There was no way to ask a supplier. A quote request is that
--    ask — the buyer invites vendors, each replies with a price, and the
--    reply is written into that vendor's catalog so the ordinary
--    catalog_query path picks it up on a re-run.
--
--    Deliberately NOT a change to the agent. `POST /workflows/{id}/run`
--    already accepts a workflow in `escalated`, and the agent still only ever
--    READS the catalog — which is what keeps a run deterministic and
--    replayable. The vendor writes; the agent reads; nothing new happens
--    inside the graph.
--
-- 2. NOBODY COULD CLOSE A PURCHASE ORDER.
--    delivery_status was driven solely by the vendor, through
--    PATCH /vendors/me/purchase-orders/{id}/delivery. The buyer who raised
--    the order had no way to record that the goods actually arrived, or to
--    close it with a note. That also left reliability scoring resting on the
--    supplier's own account of its performance.
--
-- Everything here is additive and idempotent: new tables, new nullable
-- columns, and widened CHECK constraints. No existing row changes meaning,
-- and re-running the file is a no-op.
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1. Quote requests
-- -------------------------------------------------------------------------
create table if not exists quote_requests (
    id            uuid primary key default gen_random_uuid(),
    workflow_id   uuid        not null references workflows (id) on delete cascade,
    org_id        uuid        references orgs (id) on delete cascade,
    requested_by  uuid        references users (id) on delete set null,

    -- Why the buyer had to ask: carried from workflows.escalation_reason so
    -- the vendor sees the actual problem ("nothing in the catalog matches"
    -- reads very differently from "everyone was over budget").
    reason        text,
    note          text,

    -- The line items being asked about, copied from the workflow's entities
    -- at request time. A snapshot, for the same reason quotes snapshot price:
    -- the request the vendor answered must not change under them.
    items_json    jsonb       not null default '[]'::jsonb,

    currency      char(3)     not null default 'PKR',
    budget        numeric(14, 2),

    status        text        not null default 'open'
                  check (status in ('open', 'closed', 'cancelled', 'expired')),

    -- After this, responses are refused. Without a deadline an escalated
    -- workflow parks forever waiting on a vendor who is never coming.
    closes_at     timestamptz,

    created_at    timestamptz not null default now(),
    closed_at     timestamptz
);

create index if not exists idx_quote_requests_workflow
    on quote_requests (workflow_id);

-- The vendor portal's only question: what is open for me right now.
create index if not exists idx_quote_requests_open
    on quote_requests (org_id, created_at desc)
    where status = 'open';


-- -------------------------------------------------------------------------
-- 2. Who was invited, and what they said
--
-- One row per (request, vendor) — created at invite time so the buyer can see
-- "asked 4, heard from 2" rather than only the replies. That is the whole
-- point of the screen: silence is information.
-- -------------------------------------------------------------------------
create table if not exists quote_request_responses (
    id                uuid        primary key default gen_random_uuid(),
    quote_request_id  uuid        not null references quote_requests (id) on delete cascade,
    vendor_id         uuid        not null references vendors (id) on delete cascade,

    status            text        not null default 'invited'
                      check (status in ('invited', 'responded', 'declined')),

    -- What the vendor offered, one entry per requested line:
    --   {request_item_name, sku, title, unit_price, quantity,
    --    delivery_days, warranty_months, available}
    -- Validated by Pydantic on the way in; stored as a document because the
    -- shape follows the request's line items, not a fixed column set.
    lines_json        jsonb       not null default '[]'::jsonb,

    total_amount      numeric(14, 2),
    currency          char(3),
    delivery_days     integer,
    warranty_months   integer,
    note              text,
    decline_reason    text,

    -- True once the response has been written into the vendor's catalog. That
    -- write is what makes the offer visible to catalog_query, and therefore
    -- to the agent on the next run.
    published_to_catalog boolean  not null default false,

    invited_at        timestamptz not null default now(),
    responded_at      timestamptz,

    -- A vendor answers a given request once. A correction is an update, not a
    -- second row, so the buyer never has to work out which reply is current.
    unique (quote_request_id, vendor_id)
);

create index if not exists idx_qrr_request
    on quote_request_responses (quote_request_id);

create index if not exists idx_qrr_vendor_open
    on quote_request_responses (vendor_id, invited_at desc);


-- -------------------------------------------------------------------------
-- 3. A catalog row can now come from a quote response
--
-- CatalogSourceKind gains 'rfq'. Widening the CHECK rather than dropping it
-- keeps the column honest: source is still a closed set, and the Python enum
-- in app/schemas/enums.py lists exactly these four values.
-- -------------------------------------------------------------------------
do $$
begin
    alter table catalog_items drop constraint if exists catalog_items_source_check;
    alter table catalog_items
        add constraint catalog_items_source_check
        check (source in ('manual', 'csv_import', 'api_sync', 'rfq'));
exception
    when undefined_table then null;
end $$;


-- -------------------------------------------------------------------------
-- 4. Notification kinds
--
-- 'quote_requested' reaches vendors; 'quote_received' and 'po_closed' reach
-- the buyer side. Mirrors NotificationKind in app/agent/tools/notification.py.
-- -------------------------------------------------------------------------
do $$
begin
    alter table notifications drop constraint if exists notifications_kind_check;
    alter table notifications
        add constraint notifications_kind_check
        check (kind in ('approval_required', 'approval_decided', 'po_issued',
                        'workflow_escalated', 'quote_requested',
                        'quote_received', 'po_closed'));
exception
    when undefined_table then null;
end $$;


-- -------------------------------------------------------------------------
-- 5. Purchase-order close-out
--
-- delivery_status is the SUPPLIER's account of the order. These columns are
-- the BUYER's, and they are deliberately separate: a vendor marking something
-- delivered and a buyer confirming it arrived are different claims, and
-- reliability scoring is only defensible when it can tell them apart.
-- -------------------------------------------------------------------------
alter table purchase_orders
    add column if not exists closed_at        timestamptz,
    add column if not exists closed_by        uuid references users (id) on delete set null,
    add column if not exists closure_outcome  text,
    add column if not exists closure_note     text,
    add column if not exists received_quantity integer;

do $$
begin
    alter table purchase_orders drop constraint if exists purchase_orders_closure_outcome_check;
    alter table purchase_orders
        add constraint purchase_orders_closure_outcome_check
        check (closure_outcome is null or closure_outcome in
               ('completed', 'completed_with_issues', 'cancelled'));
end $$;

-- "What is still open on my desk" — the buyer-side equivalent of the vendor's
-- delivery queue. Partial, because a closed order can never answer it.
create index if not exists idx_po_open
    on purchase_orders (vendor_id, created_at desc)
    where closed_at is null;


-- -------------------------------------------------------------------------
-- 6. Row-level security
--
-- The backend connects as service_role and bypasses RLS, so these policies
-- are the second half of the isolation rules rather than the only half —
-- exactly as in 002_rls.sql. They matter for anything reaching Postgres with
-- a user JWT instead of through the API.
-- -------------------------------------------------------------------------
alter table quote_requests enable row level security;
alter table quote_request_responses enable row level security;

-- Buyers see their organisation's requests.
drop policy if exists quote_requests_org_read on quote_requests;
create policy quote_requests_org_read on quote_requests
    for select
    using (
        org_id in (select org_id from users where id = auth.uid())
    );

-- A vendor sees a request only through an invitation addressed to them, and
-- only ever their own row of it — never a competitor's price.
drop policy if exists quote_requests_vendor_read on quote_requests;
create policy quote_requests_vendor_read on quote_requests
    for select
    using (
        exists (
            select 1
            from quote_request_responses r
            join vendors v on v.id = r.vendor_id
            where r.quote_request_id = quote_requests.id
              and v.user_id = auth.uid()
        )
    );

drop policy if exists qrr_vendor_own on quote_request_responses;
create policy qrr_vendor_own on quote_request_responses
    for all
    using (
        vendor_id in (select id from vendors where user_id = auth.uid())
    )
    with check (
        vendor_id in (select id from vendors where user_id = auth.uid())
    );

-- The buyer side reads every response to its own organisation's requests —
-- that IS the comparison.
drop policy if exists qrr_org_read on quote_request_responses;
create policy qrr_org_read on quote_request_responses
    for select
    using (
        quote_request_id in (
            select id from quote_requests
            where org_id in (select org_id from users where id = auth.uid())
        )
    );
