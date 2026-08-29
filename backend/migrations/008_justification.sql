-- =========================================================================
-- AgentFlow -- persist the agent's justification
--
-- Every autonomous decision has to carry a justification. The agent produces
-- one when it selects a vendor, and it reached the phone over the WebSocket
-- and inside the approval push -- but it was never written to a column, so
-- nothing could read it back.
--
-- That made design screens 8a and 12a impossible to build honestly: the
-- approver was asked to sign off on a decision without being shown the
-- reasoning behind it, and the comparison screen fabricated a sentence
-- client-side instead of showing what the agent actually said.
--
-- One column on workflows, because there is one vendor selection per run.
-- =========================================================================

alter table workflows
    add column if not exists justification text;

comment on column workflows.justification is
    'The agent''s stated reason for the vendor it selected. Written by the '
    'select_best node, shown on the approval and comparison screens.';
