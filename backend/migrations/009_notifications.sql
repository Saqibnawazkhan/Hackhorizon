-- =========================================================================
-- AgentFlow -- the notification inbox behind the bell
--
-- Push already reached the phone, but a push is a moment: dismiss it, or have
-- the phone off, and it is gone. There was nothing to come back to and no
-- notion of "seen", so a bell with an unread count had nothing to count.
--
-- A row is written wherever a push is sent, to the same recipients, so the
-- inbox and the notification agree by construction rather than by discipline.
-- read_at is per user, which is why this cannot be derived from workflows:
-- one purchase order is unread for the vendor and read for the admin.
-- =========================================================================

create table if not exists notifications (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid        not null references users (id) on delete cascade,
    org_id       uuid        references orgs (id) on delete cascade,

    -- Mirrors NotificationKind in app/agent/tools/notification.py.
    kind         text        not null
                 check (kind in ('approval_required', 'approval_decided',
                                 'po_issued', 'workflow_escalated')),
    title        text        not null,
    body         text        not null,

    -- agentflow://approvals/<id> etc. Tapping the row goes where the push went.
    deep_link    text,
    workflow_id  uuid        references workflows (id) on delete cascade,

    read_at      timestamptz,
    created_at   timestamptz not null default now()
);

-- The bell asks one question on every screen: how many are unread for me.
-- Partial index, because read rows are the overwhelming majority over time
-- and none of them can ever answer it.
create index if not exists idx_notifications_unread
    on notifications (user_id)
    where read_at is null;

-- The inbox itself, newest first.
create index if not exists idx_notifications_inbox
    on notifications (user_id, created_at desc);

alter table notifications enable row level security;

-- A notification is addressed to exactly one person.
drop policy if exists notifications_own on notifications;
create policy notifications_own on notifications
    for select using (user_id = auth.uid());

drop policy if exists notifications_mark_own on notifications;
create policy notifications_mark_own on notifications
    for update using (user_id = auth.uid())
    with check (user_id = auth.uid());

comment on table notifications is
    'Durable inbox behind the bell. Written alongside every push, to the same '
    'recipients. read_at is per user.';
