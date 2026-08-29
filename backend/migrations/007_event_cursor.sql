-- =========================================================================
-- AgentFlow -- use the row id as the replay cursor
--
-- workflow_events.seq was computed as MAX(seq)+1 per insert. That was two
-- problems in one:
--
--   1. Every event cost an extra round trip to read the maximum, and there are
--      ~20 events per workflow.
--   2. Two concurrent inserts could read the same maximum and then collide on
--      unique (workflow_id, seq). Moving event writes off the critical path
--      made that race actually fire:
--        duplicate key value violates unique constraint on (workflow_id, seq)
--
-- The table already has a bigserial id, which is monotonic and assigned by the
-- database with no read and no possibility of collision. Replay now uses it as
-- the cursor, so `last_seq` on the WebSocket keeps identical semantics -- an
-- integer high-water mark the client sends back -- while the insert becomes a
-- single statement with no subquery.
--
-- seq is retained (nullable) so historic rows stay readable; nothing writes it.
-- =========================================================================

alter table workflow_events
    drop constraint if exists workflow_events_seq_unique;

alter table workflow_events
    alter column seq drop not null;

-- Replay reads (workflow_id, id > cursor) in id order.
create index if not exists idx_workflow_events_cursor
    on workflow_events (workflow_id, id);

drop index if exists idx_workflow_events_replay;

comment on column workflow_events.seq is
    'Legacy per-workflow counter. Replay uses id; nothing writes this.';
