-- =========================================================================
-- AgentFlow -- narrow the expense-policy rule scope
--
-- Found by running a real claim: "Hotel nightly cap" was scoped to category
-- 'travel', so it also fired on the flights line and excluded PKR 32,000 of a
-- legitimate claim. The engine behaved exactly as configured -- the rule was
-- wrong, not the code.
--
-- policy_rules.text_value now carries an item-name filter. A rule applies when
-- its category matches AND, if text_value is set, the claim line's name
-- contains it. Flights are therefore governed by a flight rule, not a hotel
-- rule.
--
-- Idempotent; safe to re-run.
-- =========================================================================

update policy_rules
set text_value = 'hotel',
    name = 'Hotel nightly cap',
    message = 'Hotel claims are capped at PKR 25,000 per night.'
where id = '00000000-0000-0000-0000-0000000000d1';

update policy_rules
set text_value = 'meal',
    message = 'Meal claims are capped at PKR 6,000 per day.'
where id = '00000000-0000-0000-0000-0000000000d2';

-- A flight cap that actually names flights, so the travel category is fully
-- covered rather than borrowing the hotel rule.
insert into policy_rules (
    id, org_id, name, rule_type, workflow_type, category,
    numeric_value, currency, text_value, message, active
) values (
    '00000000-0000-0000-0000-0000000000d4',
    '00000000-0000-0000-0000-0000000000a1',
    'Domestic flight cap', 'max_amount', 'reimbursement', 'travel',
    40000.00, 'PKR', 'flight',
    'Domestic flights are capped at PKR 40,000 per trip.', true
)
on conflict (id) do update set
    numeric_value = excluded.numeric_value,
    text_value = excluded.text_value,
    message = excluded.message;

-- The receipt rule is deliberately left unscoped: it applies to every line
-- above its threshold regardless of category.

do $$
declare r record;
begin
    for r in
        select name, category, coalesce(text_value, '(any item)') as applies_to,
               numeric_value
        from policy_rules
        where active and workflow_type = 'reimbursement'
        order by name
    loop
        raise notice 'policy: % | category=% | item~% | limit=%',
            r.name, coalesce(r.category, '(any)'), r.applies_to, r.numeric_value;
    end loop;
end $$;
