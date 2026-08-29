-- =========================================================================
-- AgentFlow -- Row Level Security
--
-- Three isolation rules, enforced by the database and not merely by the API:
--   (a) a vendor can NEVER read a competitor's pricing
--   (b) an employee sees only their own workflows
--   (c) an admin sees everything within their own org
--
-- HOW ROLE REACHES POSTGRES
-- Reading role/org straight from public.users inside a users policy would
-- recurse (the policy queries the table the policy guards). The standard fix
-- is a SECURITY DEFINER helper: it runs as the function owner, bypasses RLS
-- on its own read, and is therefore safe to call from any policy.
-- These are marked STABLE so the planner caches them per statement.
--
-- THE BACKEND CONNECTS AS service_role, WHICH BYPASSES RLS BY DESIGN.
-- That is required: the agent writes steps, quotes and POs on behalf of a
-- user who must not be able to write them directly. Every service-role query
-- is therefore scoped in the repository layer instead. RLS is the safety net
-- for anything reaching Postgres with a user JWT -- notably the Flutter app's
-- direct supabase_flutter reads and any future web dashboard.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Claim helpers
-- -------------------------------------------------------------------------
create or replace function auth_role() returns text
language sql stable security definer set search_path = public as $$
    select coalesce(
        (select role from public.users where id = auth.uid()),
        'anonymous'
    );
$$;

create or replace function auth_org_id() returns uuid
language sql stable security definer set search_path = public as $$
    select org_id from public.users where id = auth.uid();
$$;

-- The vendor profile owned by the current user. Null for non-vendor roles.
create or replace function auth_vendor_id() returns uuid
language sql stable security definer set search_path = public as $$
    select id from public.vendors where user_id = auth.uid();
$$;

create or replace function is_admin() returns boolean
language sql stable as $$ select auth_role() = 'admin'; $$;

create or replace function is_vendor() returns boolean
language sql stable as $$ select auth_role() = 'vendor'; $$;

create or replace function is_employee() returns boolean
language sql stable as $$ select auth_role() = 'employee'; $$;

-- Buyer-side = employee or admin. Vendors are deliberately excluded.
create or replace function is_buyer_side() returns boolean
language sql stable as $$ select auth_role() in ('employee', 'admin'); $$;

revoke all on function auth_role, auth_org_id, auth_vendor_id from public;
grant execute on function auth_role, auth_org_id, auth_vendor_id,
                          is_admin, is_vendor, is_employee, is_buyer_side
                to authenticated;

-- -------------------------------------------------------------------------
-- Enable RLS on every table, and drop any previously created policies so
-- this migration is safely re-runnable (Postgres has no
-- CREATE POLICY IF NOT EXISTS).
-- -------------------------------------------------------------------------
do $$
declare
    t text;
    p record;
    guarded text[] := array[
        'orgs', 'users', 'vendors', 'vendor_flags', 'catalog_items',
        'workflows', 'workflow_items', 'steps', 'tool_calls',
        'workflow_events', 'quotes', 'quote_lines', 'purchase_orders',
        'po_line_items', 'po_fulfilment_events', 'validation_reports',
        'approvals', 'policy_rules', 'scoring_weights', 'import_jobs',
        'import_job_rows', 'catalog_connections', 'fcm_tokens'
    ];
begin
    foreach t in array guarded
    loop
        execute format('alter table %I enable row level security;', t);
        -- FORCE makes the policies apply to the table owner too, so a
        -- mistake in a migration cannot silently expose data.
        execute format('alter table %I force row level security;', t);
    end loop;

    for p in
        select schemaname, tablename, policyname
        from pg_policies
        where schemaname = 'public' and tablename = any (guarded)
    loop
        execute format('drop policy if exists %I on %I.%I;',
                       p.policyname, p.schemaname, p.tablename);
    end loop;
end $$;

-- =========================================================================
-- orgs / users
-- =========================================================================
create policy orgs_read on orgs for select to authenticated
    using (id = auth_org_id());

create policy users_read_self on users for select to authenticated
    using (id = auth.uid());

create policy users_read_org_admin on users for select to authenticated
    using (is_admin() and org_id = auth_org_id());

create policy users_update_self on users for update to authenticated
    using (id = auth.uid()) with check (id = auth.uid());

-- =========================================================================
-- vendors
-- Buyers browse verified vendors. A vendor sees only its OWN profile row.
-- =========================================================================
create policy vendors_read_buyer on vendors for select to authenticated
    using (is_buyer_side() and org_id = auth_org_id());

create policy vendors_read_own on vendors for select to authenticated
    using (is_vendor() and user_id = auth.uid());

-- Employees may add a vendor, but only in PENDING state: verification is an
-- admin act, so the status value is pinned in the WITH CHECK.
create policy vendors_insert_employee on vendors for insert to authenticated
    with check (
        is_buyer_side()
        and org_id = auth_org_id()
        and status = 'pending'
        and created_by = auth.uid()
    );

create policy vendors_update_admin on vendors for update to authenticated
    using (is_admin() and org_id = auth_org_id())
    with check (is_admin() and org_id = auth_org_id());

create policy vendors_update_own on vendors for update to authenticated
    using (is_vendor() and user_id = auth.uid())
    with check (is_vendor() and user_id = auth.uid());

create policy vendors_delete_admin on vendors for delete to authenticated
    using (is_admin() and org_id = auth_org_id());

create policy vendor_flags_read on vendor_flags for select to authenticated
    using (
        is_admin()
        or exists (
            select 1 from vendors v
            where v.id = vendor_flags.vendor_id and v.user_id = auth.uid()
        )
    );

-- =========================================================================
-- catalog_items -- RULE (a): NO CROSS-VENDOR PRICING
--
-- A vendor's SELECT is restricted to rows whose vendor_id is the vendor
-- profile they own. There is no policy granting a vendor sight of any other
-- vendor_id, so a competitor's price is unreachable however the query is
-- phrased -- direct select, join, aggregate or subquery.
--
-- Buyers see only PUBLISHED and VISIBLE rows, so a vendor's unpublished
-- drafts stay private until they choose to publish.
-- =========================================================================
create policy catalog_read_own_vendor on catalog_items for select to authenticated
    using (is_vendor() and vendor_id = auth_vendor_id());

create policy catalog_read_buyers on catalog_items for select to authenticated
    using (
        is_buyer_side()
        and visible = true
        and published_at is not null
        and exists (
            select 1 from vendors v
            where v.id = catalog_items.vendor_id
              and v.org_id = auth_org_id()
              and v.status in ('verified', 'flagged')
        )
    );

create policy catalog_write_own on catalog_items for insert to authenticated
    with check (is_vendor() and vendor_id = auth_vendor_id());

create policy catalog_update_own on catalog_items for update to authenticated
    using (is_vendor() and vendor_id = auth_vendor_id())
    with check (is_vendor() and vendor_id = auth_vendor_id());

create policy catalog_delete_own on catalog_items for delete to authenticated
    using (is_vendor() and vendor_id = auth_vendor_id());

-- =========================================================================
-- workflows -- RULE (b) and (c)
-- Vendors get NO policy here at all: buyer workflows are invisible to them.
-- =========================================================================
create policy workflows_read_own on workflows for select to authenticated
    using (is_employee() and requester_id = auth.uid());

create policy workflows_read_admin on workflows for select to authenticated
    using (is_admin() and org_id = auth_org_id());

create policy workflows_insert_own on workflows for insert to authenticated
    with check (is_buyer_side() and requester_id = auth.uid()
                and org_id = auth_org_id());

-- Child tables inherit their parent's visibility through one EXISTS check.
do $$
declare t text;
begin
    foreach t in array array['workflow_items', 'steps', 'tool_calls',
                             'workflow_events', 'validation_reports']
    loop
        execute format($f$
            create policy %1$s_read_via_workflow on %1$I
            for select to authenticated
            using (exists (
                select 1 from workflows w
                where w.id = %1$I.workflow_id
                  and (
                      (is_employee() and w.requester_id = auth.uid())
                      or (is_admin() and w.org_id = auth_org_id())
                  )
            ));
        $f$, t);
    end loop;
end $$;

-- =========================================================================
-- quotes / quote_lines -- the subtlest cross-vendor leak
--
-- A quote row names a competitor and its price. Vendors get NO read policy on
-- quotes at all: a vendor has no legitimate reason to see that it was
-- compared against anyone, let alone at what price. Buyers see quotes for
-- workflows they can already see.
-- =========================================================================
create policy quotes_read_buyer on quotes for select to authenticated
    using (exists (
        select 1 from workflows w
        where w.id = quotes.workflow_id
          and (
              (is_employee() and w.requester_id = auth.uid())
              or (is_admin() and w.org_id = auth_org_id())
          )
    ));

create policy quote_lines_read_buyer on quote_lines for select to authenticated
    using (exists (
        select 1 from quotes q join workflows w on w.id = q.workflow_id
        where q.id = quote_lines.quote_id
          and (
              (is_employee() and w.requester_id = auth.uid())
              or (is_admin() and w.org_id = auth_org_id())
          )
    ));

-- =========================================================================
-- purchase_orders
-- A vendor sees POs addressed to IT -- and nothing else. That is the only
-- buyer-side artefact a vendor is ever allowed to read.
-- =========================================================================
create policy po_read_buyer on purchase_orders for select to authenticated
    using (exists (
        select 1 from workflows w
        where w.id = purchase_orders.workflow_id
          and (
              (is_employee() and w.requester_id = auth.uid())
              or (is_admin() and w.org_id = auth_org_id())
          )
    ));

create policy po_read_own_vendor on purchase_orders for select to authenticated
    using (is_vendor() and vendor_id = auth_vendor_id());

-- The vendor may update delivery status only. Column-level restriction is
-- enforced by a trigger, since Postgres policies cannot scope to columns.
create policy po_update_own_vendor on purchase_orders for update to authenticated
    using (is_vendor() and vendor_id = auth_vendor_id())
    with check (is_vendor() and vendor_id = auth_vendor_id());

create or replace function guard_vendor_po_update() returns trigger
language plpgsql as $$
begin
    if auth_role() = 'vendor' then
        if new.total_amount is distinct from old.total_amount
           or new.subtotal   is distinct from old.subtotal
           or new.tax        is distinct from old.tax
           or new.quote_id   is distinct from old.quote_id
           or new.vendor_id  is distinct from old.vendor_id
           or new.workflow_id is distinct from old.workflow_id
           or new.po_number  is distinct from old.po_number
        then
            raise exception
                'vendors may update delivery status only, not commercial terms';
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_guard_vendor_po on purchase_orders;
create trigger trg_guard_vendor_po before update on purchase_orders
for each row execute function guard_vendor_po_update();

create policy po_lines_read on po_line_items for select to authenticated
    using (exists (
        select 1 from purchase_orders p
        where p.id = po_line_items.purchase_order_id
          and (
              (is_vendor() and p.vendor_id = auth_vendor_id())
              or exists (
                  select 1 from workflows w
                  where w.id = p.workflow_id
                    and (
                        (is_employee() and w.requester_id = auth.uid())
                        or (is_admin() and w.org_id = auth_org_id())
                    )
              )
          )
    ));

create policy fulfilment_read on po_fulfilment_events for select to authenticated
    using (
        is_admin()
        or (is_vendor() and vendor_id = auth_vendor_id())
    );

create policy fulfilment_insert_vendor on po_fulfilment_events
    for insert to authenticated
    with check (is_vendor() and vendor_id = auth_vendor_id());

-- =========================================================================
-- approvals -- vendors have no policy, so the queue is invisible to them
-- =========================================================================
create policy approvals_read_requester on approvals for select to authenticated
    using (exists (
        select 1 from workflows w
        where w.id = approvals.workflow_id and w.requester_id = auth.uid()
    ));

create policy approvals_read_admin on approvals for select to authenticated
    using (is_admin() and org_id = auth_org_id());

-- ONLY an admin may decide. Combined with the CHECK constraint requiring
-- decided_by on any non-pending row, there is no path by which the agent --
-- or a requester -- can approve their own spend.
create policy approvals_decide_admin on approvals for update to authenticated
    using (is_admin() and org_id = auth_org_id())
    with check (is_admin() and org_id = auth_org_id()
                and decided_by = auth.uid());

-- =========================================================================
-- policy_rules / scoring_weights -- admin writes, buyers read
-- =========================================================================
create policy policy_rules_read on policy_rules for select to authenticated
    using (is_buyer_side() and org_id = auth_org_id());

create policy policy_rules_write on policy_rules for all to authenticated
    using (is_admin() and org_id = auth_org_id())
    with check (is_admin() and org_id = auth_org_id());

create policy weights_read on scoring_weights for select to authenticated
    using (is_buyer_side() and org_id = auth_org_id());

create policy weights_write on scoring_weights for all to authenticated
    using (is_admin() and org_id = auth_org_id())
    with check (is_admin() and org_id = auth_org_id());

-- =========================================================================
-- Vendor portal: imports and connections -- strictly own-vendor
-- =========================================================================
create policy import_jobs_own on import_jobs for all to authenticated
    using (is_vendor() and vendor_id = auth_vendor_id())
    with check (is_vendor() and vendor_id = auth_vendor_id());

create policy import_rows_own on import_job_rows for all to authenticated
    using (exists (
        select 1 from import_jobs j
        where j.id = import_job_rows.import_job_id
          and j.vendor_id = auth_vendor_id()
    ))
    with check (exists (
        select 1 from import_jobs j
        where j.id = import_job_rows.import_job_id
          and j.vendor_id = auth_vendor_id()
    ));

create policy connections_own on catalog_connections for all to authenticated
    using (is_vendor() and vendor_id = auth_vendor_id())
    with check (is_vendor() and vendor_id = auth_vendor_id());

-- =========================================================================
-- fcm_tokens -- strictly own-user
-- =========================================================================
create policy fcm_own on fcm_tokens for all to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());
