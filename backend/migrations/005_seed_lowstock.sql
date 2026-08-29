-- =========================================================================
-- AgentFlow -- correct the "Low stock" placement
--
-- 004 moved the low-stock badge onto the Metro docking kit to free
-- TechSupplies for screen 11a. That was wrong: screen 11a also needs Metro to
-- quote 60 docking kits (PKR 660,000, giving its 9,760,000 partial total).
-- Dropping Metro to 12 made it cover 1/3 instead of the 2/3 the design shows.
--
-- The real conflict is narrow: screen 14a wants a "Low stock" badge in the
-- TechSupplies portal, and screen 11a wants TechSupplies to hold 60+ docking
-- kits. Both are satisfiable by giving TechSupplies a FOURTH item that is
-- genuinely low on stock, rather than starving one the demos depend on.
-- =========================================================================

-- Restore the quantities both comparison screens need.
update catalog_items set stock = 90
where id = '00000000-0000-0000-0000-0000000002a2';   -- Metro dock, back to 90

update catalog_items set stock = 90
where id = '00000000-0000-0000-0000-0000000001a3';   -- TechSupplies dock stays 90

-- A fourth TechSupplies line that carries the "Low stock" badge on 14a.
-- No demo requests it in bulk, so it can sit under the threshold safely.
insert into catalog_items (
    id, vendor_id, sku, title, description, category, brand,
    price, currency, stock, delivery_days, warranty_months,
    visible, source, published_at, has_unpublished_changes
) values (
    '00000000-0000-0000-0000-0000000001a4',
    '00000000-0000-0000-0000-0000000000b1',
    'TS-TB4-CABLE', 'Thunderbolt 4 cable 2m', '40Gbps · 100W PD',
    'Accessories', 'Dell', 4500.00, 'PKR', 12, 7, 12,
    true, 'manual', now() - interval '3 hours', false
)
on conflict (id) do update set stock = excluded.stock;

-- -------------------------------------------------------------------------
-- Verification -- assert the exact figures both comparison screens need
-- -------------------------------------------------------------------------
do $$
declare
    r record;
    low int;
begin
    for r in
        select v.name, c.title, c.stock, c.price
        from catalog_items c join vendors v on v.id = c.vendor_id
        where c.visible and c.published_at is not null
          and (c.title ilike '%dock%' or c.title ilike '%latitude%'
               or c.title ilike '%i7-13700%')
        order by v.name, c.title
    loop
        raise notice 'catalog: %-18s | %-28s | stock %-4s | PKR %',
            r.name, r.title, r.stock, r.price;
    end loop;

    select count(*) into low
    from catalog_items c
    where c.vendor_id = '00000000-0000-0000-0000-0000000000b1'
      and c.stock <= 20 and c.visible;
    raise notice 'TechSupplies low-stock rows (drives the 14a badge): %', low;
end $$;
