-- =========================================================================
-- AgentFlow -- schema
-- Target: Supabase Postgres 15+
-- Apply with:  psql "$DATABASE_URL" -f migrations/001_schema.sql
--          or: supabase db push
--
-- Conventions
--   * uuid primary keys, gen_random_uuid() (pgcrypto ships with Supabase)
--   * money as numeric(16,2) ALWAYS paired with a currency column
--   * timestamptz everywhere; never a bare timestamp
--   * enumerated values as text + CHECK, not pg enums -- adding a value is an
--     ALTER of one constraint instead of a type migration, and the values stay
--     readable in jsonb exports. The lists mirror app/schemas/enums.py exactly.
-- =========================================================================

create extension if not exists pgcrypto;

-- =========================================================================
-- Organisations and users
-- =========================================================================
create table if not exists orgs (
    id           uuid primary key default gen_random_uuid(),
    name         text        not null,
    currency     text        not null default 'PKR' check (char_length(currency) = 3),
    created_at   timestamptz not null default now()
);

-- Mirrors auth.users. The row is created by a trigger on signup so that role
-- and org_id are queryable in RLS policies without touching the auth schema.
create table if not exists users (
    id           uuid primary key references auth.users (id) on delete cascade,
    org_id       uuid        references orgs (id) on delete set null,
    email        text        not null,
    full_name    text,
    role         text        not null default 'employee'
                 check (role in ('employee', 'admin', 'vendor')),
    avatar_initials text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz
);
create index if not exists idx_users_org  on users (org_id);
create index if not exists idx_users_role on users (role);

-- =========================================================================
-- Vendors
-- =========================================================================
create table if not exists vendors (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid        references orgs (id) on delete cascade,
    -- Owning vendor-portal account. Null until the vendor claims the profile,
    -- which is why employees can add a vendor before it can log in.
    user_id      uuid        unique references users (id) on delete set null,
    created_by   uuid        references users (id) on delete set null,

    name         text        not null,
    legal_name   text,
    email        text,
    phone        text,
    address      text,
    category     text,

    status       text        not null default 'pending'
                 check (status in ('pending', 'verified', 'suspended', 'flagged')),
    verified_at  timestamptz,
    verified_by  uuid        references users (id) on delete set null,
    suspended_reason text,

    -- Profile defaults that new catalog items inherit and may override (14b).
    default_delivery_days   integer check (default_delivery_days >= 0),
    default_warranty_months integer check (default_warranty_months >= 0),

    -- Derived from po_fulfilment_events by the monitoring job. Materialised
    -- because every comparison reads it; recomputed, never hand-edited.
    reliability_score       numeric(3,2) check (reliability_score between 0 and 5),
    orders_fulfilled        integer not null default 0 check (orders_fulfilled >= 0),
    on_time_rate            numeric(5,4) check (on_time_rate between 0 and 1),
    quantity_accuracy       numeric(5,4) check (quantity_accuracy between 0 and 1),
    cancellations           integer not null default 0 check (cancellations >= 0),
    late_deliveries         integer not null default 0 check (late_deliveries >= 0),
    reliability_computed_at timestamptz,

    last_published_at timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz,

    constraint vendors_verified_consistency
        check ((status = 'verified') = (verified_at is not null))
);
create index if not exists idx_vendors_org     on vendors (org_id);
create index if not exists idx_vendors_status  on vendors (status);
create index if not exists idx_vendors_user    on vendors (user_id);

-- Auto-flags raised by the vendor performance monitor (design 18a).
create table if not exists vendor_flags (
    id           uuid primary key default gen_random_uuid(),
    vendor_id    uuid        not null references vendors (id) on delete cascade,
    reason       text        not null
                 check (reason in ('late_deliveries', 'low_on_time_rate',
                                   'cancellations', 'quantity_shortfall')),
    detail       text        not null,
    threshold    text        not null,
    raised_at    timestamptz not null default now(),
    resolved_at  timestamptz,
    resolved_by  uuid        references users (id) on delete set null
);
create index if not exists idx_vendor_flags_open
    on vendor_flags (vendor_id) where resolved_at is null;

-- =========================================================================
-- Catalog
-- =========================================================================
create table if not exists catalog_items (
    id           uuid primary key default gen_random_uuid(),
    vendor_id    uuid        not null references vendors (id) on delete cascade,

    sku          text        not null,
    title        text        not null,
    description  text,
    category     text,
    brand        text,

    price        numeric(16,2) not null check (price >= 0),
    sale_price   numeric(16,2) check (sale_price >= 0),
    currency     text        not null default 'PKR' check (char_length(currency) = 3),
    stock        integer     not null default 0 check (stock >= 0),

    -- Nullable on purpose: a CSV import may legitimately arrive without them.
    -- The scorer then imputes a neutral value and lowers data confidence
    -- rather than excluding the vendor. The portal prompts the vendor to fill
    -- them in afterwards.
    delivery_days   integer check (delivery_days >= 0),
    warranty_months integer check (warranty_months >= 0),

    visible      boolean     not null default true,
    source       text        not null default 'manual'
                 check (source in ('manual', 'csv_import', 'api_sync')),

    -- Draft/publish model (14a). has_unpublished_changes drives the
    -- "2 unsaved changes" counter.
    published_at timestamptz,
    has_unpublished_changes boolean not null default true,

    created_at   timestamptz not null default now(),
    updated_at   timestamptz,

    constraint catalog_items_sale_price_below_price
        check (sale_price is null or sale_price <= price),
    constraint catalog_items_vendor_sku_unique unique (vendor_id, sku)
);
create index if not exists idx_catalog_vendor_visible
    on catalog_items (vendor_id, visible);
-- The agent's hot path: find published, in-stock items by category/title.
create index if not exists idx_catalog_lookup
    on catalog_items (visible, category)
    where visible = true and published_at is not null;
create index if not exists idx_catalog_title_trgm on catalog_items (lower(title));

-- =========================================================================
-- Workflows
-- =========================================================================
create table if not exists workflows (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid        references orgs (id) on delete cascade,
    requester_id uuid        not null references users (id) on delete cascade,

    title        text        not null,
    request_text text        not null,
    workflow_type text       not null
                 check (workflow_type in ('procurement', 'reimbursement')),
    entities_json jsonb,
    plan_json    jsonb,
    summary      text,

    status       text        not null default 'draft'
                 check (status in ('draft', 'running', 'awaiting_approval',
                                   'approved', 'rejected', 'completed',
                                   'failed', 'escalated')),

    currency     text        not null default 'PKR' check (char_length(currency) = 3),
    budget       numeric(16,2) check (budget > 0),
    total_amount numeric(16,2) check (total_amount >= 0),

    current_step_order       integer check (current_step_order >= 1),
    self_correction_attempts integer not null default 0
                             check (self_correction_attempts >= 0),
    planner_attempts         integer not null default 0,
    escalation_reason        text,

    -- LangGraph checkpoint thread. One thread per workflow so interrupt() can
    -- be resumed by id after an arbitrary delay.
    checkpoint_thread_id text unique,
    idempotency_key      text,

    created_at   timestamptz not null default now(),
    started_at   timestamptz,
    completed_at timestamptz,
    duration_ms  integer check (duration_ms >= 0),

    constraint workflows_completed_consistency
        check (completed_at is null or completed_at >= created_at)
);
create index if not exists idx_workflows_requester
    on workflows (requester_id, created_at desc);
create index if not exists idx_workflows_org_status
    on workflows (org_id, status, created_at desc);
create index if not exists idx_workflows_type on workflows (workflow_type);
create unique index if not exists idx_workflows_idempotency
    on workflows (requester_id, idempotency_key)
    where idempotency_key is not null;

-- One row per requested line item (the chips on screen 11a).
create table if not exists workflow_items (
    id           uuid primary key default gen_random_uuid(),
    workflow_id  uuid        not null references workflows (id) on delete cascade,
    position     integer     not null check (position >= 1),
    name         text        not null,
    quantity     integer     not null check (quantity > 0),
    unit         text,
    specification text,
    category_hint text,
    constraint workflow_items_position_unique unique (workflow_id, position)
);
create index if not exists idx_workflow_items_wf on workflow_items (workflow_id);

-- =========================================================================
-- Execution trace
-- =========================================================================
create table if not exists steps (
    id           uuid primary key default gen_random_uuid(),
    workflow_id  uuid        not null references workflows (id) on delete cascade,
    step_order   integer     not null check (step_order >= 1),
    name         text        not null,
    title        text        not null,
    description  text,
    tool_name    text,

    status       text        not null default 'pending'
                 check (status in ('pending', 'running', 'retrying',
                                   'completed', 'failed', 'skipped')),
    retry_count  integer     not null default 0 check (retry_count >= 0),
    max_retries  integer     not null default 3 check (max_retries >= 0),

    input_json   jsonb,
    output_json  jsonb,
    error        text,

    started_at   timestamptz,
    completed_at timestamptz,
    duration_ms  integer check (duration_ms >= 0),

    constraint steps_retry_within_limit check (retry_count <= max_retries),
    constraint steps_order_unique unique (workflow_id, step_order)
);
create index if not exists idx_steps_workflow on steps (workflow_id, step_order);

create table if not exists tool_calls (
    id           uuid primary key default gen_random_uuid(),
    workflow_id  uuid        not null references workflows (id) on delete cascade,
    step_id      uuid        not null references steps (id) on delete cascade,

    tool_name    text        not null,
    status       text        not null
                 check (status in ('success', 'failed', 'retried', 'timeout')),
    attempt      integer     not null default 1 check (attempt >= 1),
    retry_count  integer     not null default 0 check (retry_count >= 0),
    duration_ms  integer     not null default 0 check (duration_ms >= 0),

    input_json   jsonb,
    output_json  jsonb,
    error        text,

    started_at   timestamptz not null default now(),
    completed_at timestamptz
);
create index if not exists idx_tool_calls_step on tool_calls (step_id, started_at);
create index if not exists idx_tool_calls_wf   on tool_calls (workflow_id, started_at);

-- Durable WebSocket event log. Lets a phone that reconnects mid-run replay
-- everything after its last sequence number, and survives a server restart.
-- The id is the replay cursor a reconnecting client sends back. It is
-- assigned by the database, so appending an event is one statement with no
-- read, and two concurrent writers cannot be handed the same value.
-- seq is a legacy per-workflow counter kept only so historic rows still read.
create table if not exists workflow_events (
    id           bigserial primary key,
    workflow_id  uuid        not null references workflows (id) on delete cascade,
    seq          integer     check (seq >= 0),
    type         text        not null,
    payload      jsonb       not null,
    created_at   timestamptz not null default now()
);
create index if not exists idx_workflow_events_cursor
    on workflow_events (workflow_id, id);

-- =========================================================================
-- Quotes -- PRICE SNAPSHOT INTEGRITY
-- Every commercial term is copied onto the quote at quote time. Downstream
-- (scoring, PO, validation) reads ONLY these columns. catalog_items may
-- change freely afterwards without corrupting an in-flight workflow.
-- =========================================================================
create table if not exists quotes (
    id           uuid primary key default gen_random_uuid(),
    workflow_id  uuid        not null references workflows (id) on delete cascade,
    -- restrict: a vendor with quotes on record cannot be hard-deleted, or the
    -- audit trail would lose the counterparty. Admin "delete" suspends.
    vendor_id    uuid        not null references vendors (id) on delete restrict,
    vendor_name  text        not null,   -- denormalised: name at quote time

    status       text        not null default 'quoted'
                 check (status in ('quoted', 'excluded_budget',
                                   'excluded_coverage', 'excluded_stock',
                                   'selected')),
    exclusion_reason text,

    -- snapshot aggregates
    total_amount    numeric(16,2) check (total_amount >= 0),
    currency        text        not null default 'PKR',
    delivery_days   integer     check (delivery_days >= 0),
    warranty_months integer     check (warranty_months >= 0),

    items_covered   integer     not null default 0 check (items_covered >= 0),
    items_requested integer     not null check (items_requested > 0),

    -- scoring output, stored so the comparison screen is reproducible later
    score_total     numeric(6,2) check (score_total between 0 and 100),
    score_json      jsonb,
    confidence_percent integer check (confidence_percent between 0 and 100),
    missing_fields  text[] not null default '{}',

    -- reliability as it stood at quote time
    reliability_score numeric(3,2),
    reliability_has_history boolean not null default false,

    snapshot_taken_at timestamptz not null default now(),
    created_at   timestamptz not null default now(),

    constraint quotes_coverage_sane check (items_covered <= items_requested),
    constraint quotes_workflow_vendor_unique unique (workflow_id, vendor_id)
);
create index if not exists idx_quotes_workflow on quotes (workflow_id, score_total desc);

create table if not exists quote_lines (
    id           uuid primary key default gen_random_uuid(),
    quote_id     uuid        not null references quotes (id) on delete cascade,
    workflow_item_id uuid    references workflow_items (id) on delete set null,
    -- Reference only. Never read for pricing -- the snapshot below wins.
    catalog_item_id  uuid    references catalog_items (id) on delete set null,

    request_item_name text   not null,
    matched_title     text,
    sku               text,
    quantity          integer not null check (quantity > 0),
    available         boolean not null default true,
    stock_on_hand     integer check (stock_on_hand >= 0),

    -- snapshot
    unit_price      numeric(16,2) check (unit_price >= 0),
    line_total      numeric(16,2) check (line_total >= 0),
    delivery_days   integer check (delivery_days >= 0),
    warranty_months integer check (warranty_months >= 0),

    constraint quote_lines_priced_when_available
        check (not available or unit_price is not null)
);
create index if not exists idx_quote_lines_quote on quote_lines (quote_id);

-- =========================================================================
-- Purchase orders
-- =========================================================================
create table if not exists purchase_orders (
    id           uuid primary key default gen_random_uuid(),
    po_number    text        not null unique,
    workflow_id  uuid        not null references workflows (id) on delete cascade,
    vendor_id    uuid        not null references vendors (id) on delete restrict,
    -- NOT NULL: a PO must always be traceable to the snapshot it was priced
    -- from. This is the structural half of price-snapshot integrity.
    quote_id     uuid        not null references quotes (id) on delete restrict,

    subtotal     numeric(16,2) not null check (subtotal >= 0),
    tax          numeric(16,2) not null default 0 check (tax >= 0),
    total_amount numeric(16,2) not null check (total_amount >= 0),
    currency     text        not null default 'PKR',

    delivery_days   integer check (delivery_days >= 0),
    expected_delivery_date date,
    warranty_months integer check (warranty_months >= 0),
    payment_terms   text,
    delivery_address text,
    notes           text,

    delivery_status text      not null default 'issued'
                 check (delivery_status in ('issued', 'acknowledged',
                                            'in_transit', 'delivered',
                                            'cancelled')),
    delivered_at      timestamptz,
    quantity_delivered integer check (quantity_delivered >= 0),

    pdf_path     text,        -- Supabase Storage object path, never local disk
    generation_attempt integer not null default 1 check (generation_attempt >= 1),

    created_at   timestamptz not null default now(),
    updated_at   timestamptz,

    constraint po_total_is_subtotal_plus_tax
        check (total_amount = subtotal + tax),
    constraint po_delivered_consistency
        check ((delivery_status = 'delivered') = (delivered_at is not null))
);
create index if not exists idx_po_workflow on purchase_orders (workflow_id);
create index if not exists idx_po_vendor_status
    on purchase_orders (vendor_id, delivery_status, created_at desc);

create table if not exists po_line_items (
    id           uuid primary key default gen_random_uuid(),
    purchase_order_id uuid   not null references purchase_orders (id) on delete cascade,
    quote_line_id uuid       references quote_lines (id) on delete set null,
    catalog_item_id uuid     references catalog_items (id) on delete set null,

    line_number  integer     not null check (line_number >= 1),
    description  text        not null,
    sku          text,
    quantity     integer     not null check (quantity > 0),
    unit_price   numeric(16,2) not null check (unit_price >= 0),
    line_total   numeric(16,2) not null check (line_total >= 0),
    delivery_days   integer check (delivery_days >= 0),
    warranty_months integer check (warranty_months >= 0),

    constraint po_line_total_matches
        check (line_total = unit_price * quantity),
    constraint po_line_number_unique unique (purchase_order_id, line_number)
);
create index if not exists idx_po_lines_po on po_line_items (purchase_order_id);

-- Raw fulfilment facts. Reliability is DERIVED from these -- never typed in.
create table if not exists po_fulfilment_events (
    id           uuid primary key default gen_random_uuid(),
    purchase_order_id uuid   not null references purchase_orders (id) on delete cascade,
    vendor_id    uuid        not null references vendors (id) on delete cascade,
    event        text        not null
                 check (event in ('acknowledged', 'shipped', 'delivered',
                                  'cancelled', 'partially_delivered')),
    expected_date date,
    actual_date   date,
    days_late     integer,
    quantity_expected integer check (quantity_expected >= 0),
    quantity_actual   integer check (quantity_actual >= 0),
    note          text,
    created_at    timestamptz not null default now()
);
create index if not exists idx_fulfilment_vendor
    on po_fulfilment_events (vendor_id, created_at desc);

-- =========================================================================
-- Validation, approvals, policy
-- =========================================================================
create table if not exists validation_reports (
    id           uuid primary key default gen_random_uuid(),
    workflow_id  uuid        not null references workflows (id) on delete cascade,
    purchase_order_id uuid   references purchase_orders (id) on delete cascade,
    attempt      integer     not null check (attempt >= 1),
    max_attempts integer     not null check (max_attempts >= 1),
    passed       boolean     not null,
    checks_json  jsonb       not null,
    validated_at timestamptz not null default now(),
    constraint validation_attempt_unique unique (workflow_id, attempt)
);
create index if not exists idx_validation_wf on validation_reports (workflow_id, attempt);

create table if not exists approvals (
    id           uuid primary key default gen_random_uuid(),
    workflow_id  uuid        not null references workflows (id) on delete cascade,
    purchase_order_id uuid   references purchase_orders (id) on delete cascade,
    org_id       uuid        references orgs (id) on delete cascade,

    decision     text        not null default 'pending'
                 check (decision in ('pending', 'approved', 'rejected')),
    approver_role text       not null default 'admin',
    requested_at timestamptz not null default now(),
    decided_at   timestamptz,
    decided_by   uuid        references users (id) on delete set null,
    comment      text,
    idempotency_key text,

    constraint approvals_decision_consistency
        check ((decision = 'pending') = (decided_at is null)),
    constraint approvals_decider_present
        check (decision = 'pending' or decided_by is not null)
);
-- At most one OPEN approval per workflow. Closed ones stay for the audit trail.
create unique index if not exists idx_approvals_one_open
    on approvals (workflow_id) where decision = 'pending';
create index if not exists idx_approvals_queue
    on approvals (org_id, decision, requested_at desc);
create unique index if not exists idx_approvals_idempotency
    on approvals (id, idempotency_key) where idempotency_key is not null;

create table if not exists policy_rules (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid        references orgs (id) on delete cascade,
    name         text        not null,
    rule_type    text        not null
                 check (rule_type in ('max_amount', 'max_per_day',
                                      'receipt_required', 'category_allowed',
                                      'advance_notice_days')),
    workflow_type text       not null default 'reimbursement'
                 check (workflow_type in ('procurement', 'reimbursement')),
    category     text,
    numeric_value numeric(16,2) check (numeric_value >= 0),
    currency     text,
    text_value   text,
    message      text        not null,
    active       boolean     not null default true,
    created_at   timestamptz not null default now(),
    created_by   uuid        references users (id) on delete set null
);
create index if not exists idx_policy_active
    on policy_rules (org_id, workflow_type, active);

-- Admin-configurable scoring weights. Absent row => env defaults apply.
create table if not exists scoring_weights (
    org_id       uuid primary key references orgs (id) on delete cascade,
    weight_price       numeric(4,3) not null check (weight_price between 0 and 1),
    weight_delivery    numeric(4,3) not null check (weight_delivery between 0 and 1),
    weight_warranty    numeric(4,3) not null check (weight_warranty between 0 and 1),
    weight_reliability numeric(4,3) not null default 0
                       check (weight_reliability between 0 and 1),
    updated_at   timestamptz not null default now(),
    updated_by   uuid        references users (id) on delete set null,
    constraint scoring_weights_sum_to_one check (
        abs(weight_price + weight_delivery + weight_warranty
            + weight_reliability - 1) < 0.001
    )
);

-- =========================================================================
-- Vendor portal: imports and catalog connections
-- =========================================================================
create table if not exists import_jobs (
    id           uuid primary key default gen_random_uuid(),
    vendor_id    uuid        not null references vendors (id) on delete cascade,
    created_by   uuid        references users (id) on delete set null,
    filename     text        not null,
    status       text        not null default 'uploaded'
                 check (status in ('uploaded', 'previewed', 'committed',
                                   'partially_committed', 'failed', 'cancelled')),
    mapping_json jsonb,
    total_rows     integer not null default 0 check (total_rows >= 0),
    committed_rows integer not null default 0 check (committed_rows >= 0),
    failed_rows    integer not null default 0 check (failed_rows >= 0),
    created_rows   integer not null default 0 check (created_rows >= 0),
    updated_rows   integer not null default 0 check (updated_rows >= 0),
    rows_missing_terms integer not null default 0,
    error        text,
    created_at   timestamptz not null default now(),
    committed_at timestamptz
);
create index if not exists idx_import_jobs_vendor
    on import_jobs (vendor_id, created_at desc);

create table if not exists import_job_rows (
    id           uuid primary key default gen_random_uuid(),
    import_job_id uuid       not null references import_jobs (id) on delete cascade,
    row_number   integer     not null check (row_number >= 1),
    raw_json     jsonb       not null,
    parsed_json  jsonb,
    errors_json  jsonb       not null default '[]',
    is_duplicate_sku boolean not null default false,
    committed    boolean     not null default false,
    catalog_item_id uuid     references catalog_items (id) on delete set null,
    constraint import_row_unique unique (import_job_id, row_number)
);
create index if not exists idx_import_rows_job on import_job_rows (import_job_id);

create table if not exists catalog_connections (
    id           uuid primary key default gen_random_uuid(),
    vendor_id    uuid        not null references vendors (id) on delete cascade,
    provider     text        not null
                 check (provider in ('shopify', 'woocommerce', 'generic_rest')),
    label        text        not null,
    store_url    text,
    -- Secrets live in Supabase Vault; this column holds only the reference.
    -- No API response ever returns a credential value.
    credentials_ref text,
    status       text        not null default 'disconnected'
                 check (status in ('disconnected', 'connected', 'error', 'syncing')),
    auto_sync_enabled boolean not null default false,
    sync_interval_minutes integer not null default 60
                          check (sync_interval_minutes > 0),
    last_sync_at timestamptz,
    last_sync_item_count integer check (last_sync_item_count >= 0),
    last_error   text,
    created_at   timestamptz not null default now()
);
create index if not exists idx_connections_vendor on catalog_connections (vendor_id);

-- =========================================================================
-- Push notifications
-- =========================================================================
create table if not exists fcm_tokens (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid        not null references users (id) on delete cascade,
    token        text        not null,
    platform     text        not null default 'android',
    device_id    text,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    constraint fcm_token_unique unique (user_id, token)
);
create index if not exists idx_fcm_user on fcm_tokens (user_id);

-- =========================================================================
-- Triggers
-- =========================================================================
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

do $$
declare t text;
begin
    foreach t in array array['users', 'vendors', 'catalog_items', 'purchase_orders']
    loop
        execute format(
            'drop trigger if exists trg_touch_%1$s on %1$I;
             create trigger trg_touch_%1$s before update on %1$I
             for each row execute function touch_updated_at();', t);
    end loop;
end $$;

-- Editing a published catalog item marks it dirty, which is what drives the
-- "N unsaved changes" counter on the vendor portal.
create or replace function mark_catalog_dirty() returns trigger
language plpgsql as $$
begin
    if new.price is distinct from old.price
       or new.sale_price is distinct from old.sale_price
       or new.stock is distinct from old.stock
       or new.title is distinct from old.title
       or new.description is distinct from old.description
       or new.delivery_days is distinct from old.delivery_days
       or new.warranty_months is distinct from old.warranty_months
       or new.visible is distinct from old.visible
    then
        new.has_unpublished_changes := true;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_catalog_dirty on catalog_items;
create trigger trg_catalog_dirty before update on catalog_items
for each row
when (old.published_at is not null and new.published_at = old.published_at)
execute function mark_catalog_dirty();

-- Mirror a new auth user into public.users so RLS can read role/org.
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    insert into public.users (id, email, full_name, role, org_id)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data ->> 'full_name', ''),
        coalesce(new.raw_user_meta_data ->> 'role', 'employee'),
        nullif(new.raw_user_meta_data ->> 'org_id', '')::uuid
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
after insert on auth.users
for each row execute function handle_new_auth_user();
