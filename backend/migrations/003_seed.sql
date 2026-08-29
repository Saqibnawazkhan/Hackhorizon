-- =========================================================================
-- AgentFlow -- demo seed data
--
-- Every price, delivery time, warranty and stock level below is taken from
-- the design file, so screens 5a, 11a, 13a, 14a, 15a and 18a render with the
-- exact figures they were drawn with.
--
-- Idempotent: safe to re-run. Apply AFTER 001_schema.sql and 002_rls.sql.
--   psql "$DATABASE_URL" -f migrations/003_seed.sql
--
-- NOTE ON USERS: auth.users rows are created through Supabase Auth, not SQL.
-- Run scripts/seed_users.py after this file to create the demo accounts and
-- link the vendor profiles to them.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Organisation
-- -------------------------------------------------------------------------
insert into orgs (id, name, currency)
values ('00000000-0000-0000-0000-0000000000a1', 'AgentFlow Demo Co', 'PKR')
on conflict (id) do nothing;

-- -------------------------------------------------------------------------
-- Scoring weights -- matches the design's "Price 50% · Delivery 30% · Warranty 20%"
-- -------------------------------------------------------------------------
insert into scoring_weights (org_id, weight_price, weight_delivery, weight_warranty, weight_reliability)
values ('00000000-0000-0000-0000-0000000000a1', 0.500, 0.300, 0.200, 0.000)
on conflict (org_id) do update set
    weight_price = excluded.weight_price,
    weight_delivery = excluded.weight_delivery,
    weight_warranty = excluded.weight_warranty,
    weight_reliability = excluded.weight_reliability;

-- -------------------------------------------------------------------------
-- Vendors
--
-- Reliability figures are seeded as if derived from fulfilment history, and
-- po_fulfilment_events rows below back them up so the monitoring job
-- recomputes the same values rather than trusting these columns.
--
-- Fresh Imports has NO history on purpose: it exercises the "New vendor --
-- no fulfilment history" caveat and neutral scoring.
-- -------------------------------------------------------------------------
insert into vendors (
    id, org_id, name, legal_name, email, phone, category, status, verified_at,
    default_delivery_days, default_warranty_months,
    reliability_score, orders_fulfilled, on_time_rate, quantity_accuracy,
    cancellations, late_deliveries, reliability_computed_at, last_published_at
) values
    ('00000000-0000-0000-0000-0000000000b1',
     '00000000-0000-0000-0000-0000000000a1',
     'TechSupplies Ltd', 'TechSupplies Private Limited',
     'sales@techsupplies.example', '+92 42 111 222 333', 'IT hardware',
     'verified', now() - interval '120 days',
     7, 24,
     4.80, 24, 0.9800, 0.9900, 0, 1, now(), now() - interval '3 hours'),

    ('00000000-0000-0000-0000-0000000000b2',
     '00000000-0000-0000-0000-0000000000a1',
     'Metro Computers', 'Metro Computers (Pvt) Ltd',
     'orders@metrocomputers.example', '+92 21 555 666 777', 'IT hardware',
     'verified', now() - interval '90 days',
     10, 12,
     4.50, 17, 0.9200, 0.9600, 1, 2, now(), now() - interval '1 day'),

    ('00000000-0000-0000-0000-0000000000b3',
     '00000000-0000-0000-0000-0000000000a1',
     'Alpha Traders', 'Alpha Trading Company',
     'info@alphatraders.example', '+92 51 888 999 000', 'IT hardware',
     'verified', now() - interval '200 days',
     12, 12,
     4.20, 11, 0.8500, 0.9400, 2, 3, now(), now() - interval '2 days'),

    -- New vendor: no history. Scored neutrally, flagged in the justification.
    ('00000000-0000-0000-0000-0000000000b4',
     '00000000-0000-0000-0000-0000000000a1',
     'Fresh Imports', 'Fresh Imports Trading',
     'hello@freshimports.example', '+92 42 300 400 500', 'IT hardware',
     'verified', now() - interval '5 days',
     9, 18,
     null, 0, null, null, 0, 0, null, now() - interval '4 hours')
on conflict (id) do nothing;

-- Metro breaches the late-delivery threshold: design 18a shows
-- "2 late deliveries · flagged by agent".
insert into vendor_flags (id, vendor_id, reason, detail, threshold, raised_at)
values (
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b2',
    'late_deliveries',
    '2 late deliveries · flagged by agent',
    'VENDOR_FLAG_AFTER_LATE_DELIVERIES = 2',
    now() - interval '2 days'
)
on conflict (id) do nothing;

-- -------------------------------------------------------------------------
-- Catalog items
--
-- Prices reproduce the design exactly:
--   Laptops   TechSupplies 174,000 | Metro 182,000 | Alpha 210,000
--   CPU kits  TechSupplies  96,000 | Alpha  87,000 | (Metro: NOT STOCKED)
--   Docks     TechSupplies  11,500 | Metro  11,000 | Alpha  10,000
--
-- Metro deliberately does NOT stock the CPU kit, which is what produces
-- "Covers 2/3 — no CPUs" on screen 11a.
--
-- All rows are published, so the agent can see them.
-- -------------------------------------------------------------------------
insert into catalog_items (
    id, vendor_id, sku, title, description, category, brand,
    price, currency, stock, delivery_days, warranty_months,
    visible, source, published_at, has_unpublished_changes
) values
    -- ---- TechSupplies Ltd ----
    ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000b1',
     'TS-LAT-5550', 'Dell Latitude 5550 laptop', 'i7 · 16GB · 512GB',
     'IT hardware', 'Dell', 174000.00, 'PKR', 240, 7, 24,
     true, 'manual', now() - interval '3 hours', false),
    ('00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-0000000000b1',
     'TS-CPU-13700', 'Intel i7-13700 CPU kit', '16-core · 32GB DDR5',
     'Components', 'Intel', 96000.00, 'PKR', 58, 7, 24,
     true, 'manual', now() - interval '3 hours', false),
    ('00000000-0000-0000-0000-0000000001a3', '00000000-0000-0000-0000-0000000000b1',
     'TS-DOCK-USBC', 'USB-C docking kit', 'Dual-4K · 100W PD',
     'Accessories', 'Dell', 11500.00, 'PKR', 12, 7, 24,
     true, 'manual', now() - interval '3 hours', false),

    -- ---- Metro Computers (no CPU kit -- covers 2/3 on screen 11a) ----
    ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000b2',
     'MC-LAT-5550', 'Dell Latitude 5550 laptop', 'i7 · 16GB · 512GB',
     'IT hardware', 'Dell', 182000.00, 'PKR', 180, 10, 12,
     true, 'manual', now() - interval '1 day', false),
    ('00000000-0000-0000-0000-0000000002a2', '00000000-0000-0000-0000-0000000000b2',
     'MC-DOCK-USBC', 'USB-C docking kit', 'Dual-4K · 100W PD',
     'Accessories', 'Generic', 11000.00, 'PKR', 90, 10, 12,
     true, 'manual', now() - interval '1 day', false),

    -- ---- Alpha Traders (over budget on laptops; cheapest on docks) ----
    ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000000b3',
     'AT-LAT-5550', 'Dell Latitude 5550 laptop', 'i7 · 16GB · 512GB',
     'IT hardware', 'Dell', 210000.00, 'PKR', 300, 12, 12,
     true, 'manual', now() - interval '2 days', false),
    ('00000000-0000-0000-0000-0000000003a2', '00000000-0000-0000-0000-0000000000b3',
     'AT-CPU-13700', 'Intel i7-13700 CPU kit', '16-core · 32GB DDR5',
     'Components', 'Intel', 87000.00, 'PKR', 75, 12, 12,
     true, 'manual', now() - interval '2 days', false),
    ('00000000-0000-0000-0000-0000000003a3', '00000000-0000-0000-0000-0000000000b3',
     'AT-DOCK-USBC', 'USB-C docking kit', 'Dual-4K · 100W PD',
     'Accessories', 'Generic', 10000.00, 'PKR', 150, 12, 12,
     true, 'manual', now() - interval '2 days', false),

    -- ---- Fresh Imports (no history; one row missing warranty on purpose,
    --      which drives the visible data-confidence percentage) ----
    ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000000b4',
     'FI-LAT-5550', 'Dell Latitude 5550 laptop', 'i7 · 16GB · 512GB',
     'IT hardware', 'Dell', 171000.00, 'PKR', 60, 9, null,
     true, 'manual', now() - interval '4 hours', false),
    ('00000000-0000-0000-0000-0000000004a2', '00000000-0000-0000-0000-0000000000b4',
     'FI-MON-27', '27-inch 4K monitor', 'IPS · USB-C 90W',
     'Peripherals', 'Generic', 62000.00, 'PKR', 40, 9, 18,
     true, 'manual', now() - interval '4 hours', false)
on conflict (id) do nothing;

-- -------------------------------------------------------------------------
-- Expense policy rules -- drive the reimbursement workflow
-- -------------------------------------------------------------------------
insert into policy_rules (
    id, org_id, name, rule_type, workflow_type, category,
    numeric_value, currency, message, active
) values
    ('00000000-0000-0000-0000-0000000000d1',
     '00000000-0000-0000-0000-0000000000a1',
     'Hotel nightly cap', 'max_amount', 'reimbursement', 'travel',
     25000.00, 'PKR',
     'Hotel claims are capped at PKR 25,000 per night.', true),

    ('00000000-0000-0000-0000-0000000000d2',
     '00000000-0000-0000-0000-0000000000a1',
     'Meal daily cap', 'max_amount', 'reimbursement', 'meals',
     6000.00, 'PKR',
     'Meal claims are capped at PKR 6,000 per day.', true),

    ('00000000-0000-0000-0000-0000000000d3',
     '00000000-0000-0000-0000-0000000000a1',
     'Receipt required above 5,000', 'receipt_required', 'reimbursement', null,
     5000.00, 'PKR',
     'A receipt is required for any claim line above PKR 5,000.', true)
on conflict (id) do nothing;

-- -------------------------------------------------------------------------
-- Fulfilment history -- the raw facts reliability is DERIVED from.
-- The monitoring job recomputes vendors.on_time_rate etc. from these rows,
-- so the seeded scores above are reproducible rather than asserted.
-- -------------------------------------------------------------------------
-- (Populated by scripts/seed_history.py, which needs purchase_orders to
--  exist first. Left out of pure SQL so the seed stays FK-safe.)

-- -------------------------------------------------------------------------
-- Verification
-- -------------------------------------------------------------------------
do $$
declare
    v_count int;
    i_count int;
    p_count int;
begin
    select count(*) into v_count from vendors;
    select count(*) into i_count from catalog_items where published_at is not null;
    select count(*) into p_count from policy_rules where active;
    raise notice 'AgentFlow seed: % vendors, % published catalog items, % policy rules',
        v_count, i_count, p_count;
end $$;
