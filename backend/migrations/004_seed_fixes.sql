-- =========================================================================
-- AgentFlow -- seed corrections
--
-- Three fixes, each found by running the real engine against the seeded
-- catalog rather than by reading the design. Idempotent; safe to re-run.
-- =========================================================================

-- -------------------------------------------------------------------------
-- FIX 1 -- TechSupplies docking-kit stock
--
-- The design contradicts itself: screen 14a shows the USB-C docking kit at
-- stock 12 with a "Low stock" badge, while screen 11a shows TechSupplies
-- supplying 60 of them for PKR 690,000. Both cannot be true.
--
-- Screen 11a is the flagship multi-item demo, so stock wins there: raised to
-- 90. The "Low stock" badge on 14a is preserved by moving it to the Metro
-- docking kit, which no demo needs in bulk.
-- -------------------------------------------------------------------------
update catalog_items
set stock = 90
where id = '00000000-0000-0000-0000-0000000001a3';   -- TS-DOCK-USBC

update catalog_items
set stock = 12
where id = '00000000-0000-0000-0000-0000000002a2';   -- MC-DOCK-USBC

-- -------------------------------------------------------------------------
-- FIX 2 -- keep screen 5a to exactly three suppliers
--
-- Fresh Imports was seeded with a laptop, which made the single-item
-- comparison render four cards where the design shows three. Its laptop is
-- withdrawn from the published catalog; the monitor stays, so the vendor is
-- still available to demonstrate "New vendor -- no fulfilment history" and
-- the reduced data-confidence path on a different request.
-- -------------------------------------------------------------------------
update catalog_items
set visible = false,
    published_at = null
where id = '00000000-0000-0000-0000-0000000004a1';   -- FI-LAT-5550

-- Leave the monitor without a warranty so data confidence is still
-- demonstrable: a request for monitors scores it on price and delivery only.
update catalog_items
set warranty_months = null
where id = '00000000-0000-0000-0000-0000000004a2';   -- FI-MON-27

-- -------------------------------------------------------------------------
-- FIX 3 -- make the computed star rating equal the design's
--
-- Reliability is DERIVED, never stored as an opinion:
--     star = (on_time * 0.6 + accuracy * 0.4 - 0.05 per cancellation) * 5
--
-- The originally seeded on-time/accuracy figures produced 4.9 / 4.4 / 3.9
-- against the design's 4.8 / 4.5 / 4.2. These values make the formula land
-- exactly on the design's numbers, so the seed and the derivation agree
-- instead of the column merely asserting a value.
-- -------------------------------------------------------------------------
update vendors set
    on_time_rate = 0.9600, quantity_accuracy = 0.9600,
    cancellations = 0, reliability_score = 4.80
where id = '00000000-0000-0000-0000-0000000000b1';   -- TechSupplies -> 4.8

update vendors set
    on_time_rate = 0.9500, quantity_accuracy = 0.9500,
    cancellations = 1, reliability_score = 4.50
where id = '00000000-0000-0000-0000-0000000000b2';   -- Metro -> 4.5

update vendors set
    on_time_rate = 0.9400, quantity_accuracy = 0.9400,
    cancellations = 2, reliability_score = 4.20
where id = '00000000-0000-0000-0000-0000000000b3';   -- Alpha -> 4.2

-- -------------------------------------------------------------------------
-- Verification
-- -------------------------------------------------------------------------
do $$
declare
    r record;
begin
    for r in
        select name,
               round((on_time_rate * 0.6 + quantity_accuracy * 0.4
                      - least(cancellations * 0.05, 0.25)) * 5, 1) as computed_star,
               reliability_score
        from vendors
        where on_time_rate is not null
        order by name
    loop
        raise notice 'reliability: % -> computed % (stored %)',
            r.name, r.computed_star, r.reliability_score;
    end loop;

    for r in
        select v.name, c.title, c.stock, c.visible
        from catalog_items c join vendors v on v.id = c.vendor_id
        where c.title ilike '%dock%' or c.title ilike '%latitude%'
        order by v.name, c.title
    loop
        raise notice 'catalog: % | % | stock % | visible %',
            r.name, r.title, r.stock, r.visible;
    end loop;
end $$;
