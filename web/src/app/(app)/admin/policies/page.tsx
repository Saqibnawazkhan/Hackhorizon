"use client";

/**
 * Expense policy rules.
 *
 * These are what the reimbursement workflow's policy engine tests each claim
 * line against, and the reason a breach is reported rather than fatal: a
 * PKR 8,000 meal claim against a PKR 6,000 daily cap is excluded from the
 * payable total and named in the exclusion list — the rest of the claim still
 * pays. The engine is deterministic; a breach is a fact, not a judgement, and
 * the human sees exactly which rule produced it.
 *
 * The list endpoint returns ACTIVE rules only, which is why an inactive rule
 * created here will not reappear in the table.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Button,
  ChipGroup,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  Modal,
  Panel,
  Select,
  StatusPill,
  Switch,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
} from "@/components/ui";
import { api } from "@/lib/api";
import {
  humanise,
  money,
  number as formatNumber,
  shortDateTime,
} from "@/lib/format";
import type { PolicyRule, PolicyRuleType, WorkflowType } from "@/lib/types";

const WORKFLOW_OPTIONS: { value: WorkflowType; label: string }[] = [
  { value: "reimbursement", label: "Reimbursement" },
  { value: "procurement", label: "Procurement" },
];

/** Prose for the toast, so no enum value reaches the screen verbatim. */
const WORKFLOW_LABEL: Record<WorkflowType, string> = {
  reimbursement: "reimbursement claim",
  procurement: "procurement request",
};

const RULE_TYPES: PolicyRuleType[] = [
  "max_amount",
  "max_per_day",
  "receipt_required",
  "category_allowed",
  "advance_notice_days",
];

/**
 * The prose name for each type.
 *
 * The union in types.ts is the Postgres CHECK constraint, so every value that
 * can reach this screen has a row here — `humanise` stays the last resort it
 * is documented to be, used only for the free-text category.
 */
const RULE_TYPE_LABEL: Record<PolicyRuleType, string> = {
  max_amount: "Maximum amount",
  max_per_day: "Daily maximum",
  receipt_required: "Receipt required",
  category_allowed: "Category allowed",
  advance_notice_days: "Advance notice",
};

/** What each type does once the engine reads it. */
const RULE_TYPE_NOTE: Record<PolicyRuleType, string> = {
  max_amount:
    "A cap per unit claimed. The engine multiplies the amount by the line's quantity, so a per-night cap governs a three-night stay correctly.",
  max_per_day: "A daily ceiling, recorded for the approver's judgement.",
  receipt_required:
    "Bites only above the stated amount. A line with no stated receipt is unknown, not a breach — the human decides.",
  category_allowed:
    "Names a category as claimable, recorded for the approver's judgement.",
  advance_notice_days:
    "How many days ahead the request should have been made, recorded for the approver's judgement.",
};

/** The two the deterministic engine evaluates line by line today. */
const ENFORCED: PolicyRuleType[] = ["max_amount", "receipt_required"];

interface RuleDraft {
  name: string;
  rule_type: PolicyRuleType;
  workflow_type: WorkflowType;
  category: string;
  numeric_value: string;
  currency: string;
  text_value: string;
  message: string;
  active: boolean;
}

function emptyDraft(workflowType: WorkflowType, currency: string): RuleDraft {
  return {
    name: "",
    rule_type: "max_amount",
    workflow_type: workflowType,
    category: "",
    numeric_value: "",
    currency,
    text_value: "",
    message: "",
    active: true,
  };
}

function RuleValue({ rule }: { rule: PolicyRule }) {
  if (rule.numeric_value === null || rule.numeric_value === undefined) {
    return <span className="text-[#b3c4cc]">—</span>;
  }
  if (rule.rule_type === "advance_notice_days") {
    return <>{formatNumber(rule.numeric_value)} days</>;
  }
  if (rule.currency) {
    return <>{money(rule.numeric_value, rule.currency)}</>;
  }
  return <>{formatNumber(rule.numeric_value)}</>;
}

export default function PolicyRulesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [workflowType, setWorkflowType] = useState<WorkflowType>("reimbursement");
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>(() =>
    emptyDraft("reimbursement", ""),
  );
  const [errors, setErrors] = useState<Partial<Record<keyof RuleDraft, string>>>({});
  const [toDelete, setToDelete] = useState<PolicyRule | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "policy-rules", workflowType],
    queryFn: () => api.listPolicyRules(workflowType),
  });

  const rules = useMemo(() => data ?? [], [data]);

  /** Use a currency the organisation already writes rather than assuming one. */
  const exampleCurrency = useMemo(
    () => rules.find((rule) => rule.currency)?.currency ?? undefined,
    [rules],
  );

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["admin", "policy-rules"] });

  const createMutation = useMutation({
    mutationFn: (input: RuleDraft) =>
      api.createPolicyRule({
        name: input.name.trim(),
        rule_type: input.rule_type,
        workflow_type: input.workflow_type,
        category: input.category.trim() || null,
        numeric_value:
          input.numeric_value.trim() === "" ? null : Number(input.numeric_value),
        currency: input.currency.trim()
          ? input.currency.trim().toUpperCase()
          : null,
        text_value: input.text_value.trim() || null,
        message: input.message.trim(),
        active: input.active,
      }),
    onSuccess: (_created, input) => {
      invalidate();
      setWorkflowType(input.workflow_type);
      setAddOpen(false);
      toast(
        input.active
          ? `“${input.name.trim()}” is live for the next ${WORKFLOW_LABEL[input.workflow_type]}.`
          : `“${input.name.trim()}” saved as inactive — inactive rules are not listed here.`,
        input.active ? "positive" : "warning",
      );
    },
    onError: (failure: unknown) => {
      toast(
        failure instanceof Error ? failure.message : "Could not create that rule.",
        "danger",
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePolicyRule(id),
    onSuccess: () => {
      const name = toDelete?.name ?? "Rule";
      invalidate();
      setToDelete(null);
      toast(`“${name}” deleted. Runs already assessed keep their result.`, "positive");
    },
    onError: (failure: unknown) => {
      toast(
        failure instanceof Error ? failure.message : "Could not delete that rule.",
        "danger",
      );
    },
  });

  const openAdd = () => {
    setDraft(emptyDraft(workflowType, exampleCurrency ?? ""));
    setErrors({});
    setAddOpen(true);
  };

  const submit = () => {
    const next: Partial<Record<keyof RuleDraft, string>> = {};
    if (!draft.name.trim()) next.name = "Give the rule a name the approver will recognise.";
    if (!draft.message.trim()) {
      next.message = "Required — this text is shown verbatim on the policy result.";
    }
    const amount = Number(draft.numeric_value);
    if (draft.numeric_value.trim() && !Number.isFinite(amount)) {
      next.numeric_value = "Enter a number, or leave it blank.";
    } else if (draft.numeric_value.trim() && amount < 0) {
      // The schema declares numeric_value ge=0; a negative would come back 422.
      next.numeric_value = "A cap cannot be negative — enter zero or more.";
    } else if (draft.numeric_value.trim() === "" && draft.rule_type === "max_amount") {
      next.numeric_value = "A cap with no amount is skipped by the engine.";
    }
    if (draft.currency.trim() && !/^[A-Za-z]{3}$/.test(draft.currency.trim())) {
      next.currency = "Three letters, or blank.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    createMutation.mutate(draft);
  };

  const update = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  return (
    <>
      <PageHeader
        title="Policy rules"
        description="The caps and conditions the agent checks a claim against before it computes what is payable. Deterministic by design — the same claim and the same rules always produce the same exclusions."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={openAdd}>
            Add rule
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ChipGroup
          options={WORKFLOW_OPTIONS}
          value={workflowType}
          onChange={setWorkflowType}
        />
        <p className="text-[12px] text-[#7e8c94]">
          Active rules only — the endpoint filters inactive ones out.
        </p>
      </div>

      {/* ------------------------------------------------------------------
          What these actually drive
          ------------------------------------------------------------------ */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Panel
          className="animate-fade-up lg:col-span-2"
          icon={<ScrollText className="size-4" />}
          title="What these drive"
          description="The reimbursement graph runs policy_check before compute_total, line by line."
        >
          <p className="text-[13px] leading-relaxed text-[#5f7280]">
            A breach removes one line from the payable total and is reported —
            it does not reject the claim. That distinction is the whole point:
            an employee who overspends on dinner still gets reimbursed for the
            flight, and the approver sees precisely which line was excluded and
            under which rule.
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-stretch">
            <div className="glass-flat rounded-[18px] p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                Claim line
              </p>
              <p className="mt-1.5 text-[13.5px] font-semibold text-[#243640]">
                Team dinner
              </p>
              <p className="mt-0.5 text-[13px] text-[#5f7280] tnum">
                1 × {money(8000, exampleCurrency)}
              </p>
            </div>
            <div className="hidden place-items-center text-[#a9bac3] sm:grid">
              <ArrowRight className="size-4" />
            </div>
            <div className="glass-flat rounded-[18px] p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                Rule applied
              </p>
              <p className="mt-1.5 text-[13.5px] font-semibold text-[#243640]">
                Meal daily cap
              </p>
              <p className="mt-0.5 text-[13px] text-[#5f7280] tnum">
                {RULE_TYPE_LABEL.max_amount} · {money(6000, exampleCurrency)}
              </p>
            </div>
            <div className="hidden place-items-center text-[#a9bac3] sm:grid">
              <ArrowRight className="size-4" />
            </div>
            <div className="rounded-[18px] border border-[#fedf89] bg-[#fffaeb] p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#b54708]">
                Outcome
              </p>
              <p className="mt-1.5 text-[13.5px] font-semibold text-[#b54708]">
                Line excluded
              </p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-[#b54708]/90">
                Dropped from the payable total, named in the exclusions. Every
                other line still pays.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 border-t border-[#e7eff3] pt-4 sm:grid-cols-2">
            <div>
              <p className="text-[12.5px] font-semibold text-[#243640]">
                Scope by category
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[#7e8c94]">
                A rule with a category applies only to claim lines in that
                category. Leave it blank and the rule governs every line.
              </p>
            </div>
            <div>
              <p className="text-[12.5px] font-semibold text-[#243640]">
                Narrow with text
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[#7e8c94]">
                A text value narrows the rule further to lines whose name
                contains it — so a hotel cap scoped to travel does not also
                govern flights.
              </p>
            </div>
          </div>
        </Panel>

        <Panel
          className="animate-fade-up"
          icon={<BookOpen className="size-4" />}
          title="Rule types"
          description="Two are evaluated per line; the rest are recorded for the approver."
        >
          <ul className="space-y-3">
            {RULE_TYPES.map((type) => (
              <li key={type}>
                <div className="flex items-center gap-2">
                  <p className="text-[12.5px] font-semibold text-[#243640]">
                    {RULE_TYPE_LABEL[type]}
                  </p>
                  {ENFORCED.includes(type) && (
                    <StatusPill size="sm" tone="brand" dot={false} label="Enforced" />
                  )}
                </div>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
                  {RULE_TYPE_NOTE[type]}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {workflowType === "procurement" && (
        <Alert tone="neutral" className="mb-4" title="Procurement is gated differently">
          The procurement graph does not run a policy check — its constraint is
          the budget filter, applied in <strong>budget_filter</strong> before
          scoring, and then the human approval gate. Rules stored against
          procurement are kept for reference and shown to the approver.
        </Alert>
      )}

      {/* ------------------------------------------------------------------
          The rules
          ------------------------------------------------------------------ */}
      <Panel
        className="animate-fade-up"
        title={
          <span className="flex items-center gap-2">
            {workflowType === "reimbursement" ? "Reimbursement" : "Procurement"} rules
            {rules.length > 0 && (
              <span className="text-[12px] font-medium text-[#7e8c94] tnum">
                {formatNumber(rules.length)}
              </span>
            )}
          </span>
        }
        description="Deleting a rule affects future runs only — an assessment already recorded keeps the result it was given."
      >
        {isLoading ? (
          <LoadingBlock rows={4} />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : rules.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="size-6" />}
            title="No active rules for this workflow type"
            description={
              workflowType === "reimbursement"
                ? "With no rules, every claim line passes the policy check and the full claimed amount reaches the approver. Add a cap to start excluding over-limit lines."
                : "Procurement runs on the budget filter and the approval gate rather than on policy rules, so this list is usually empty."
            }
            action={
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={openAdd}>
                Add rule
              </Button>
            }
          />
        ) : (
          <Table minWidth={1040}>
            <thead>
              <tr>
                <Th>Rule</Th>
                <Th>Type</Th>
                <Th>Category</Th>
                <Th align="right">Value</Th>
                <Th>Message shown to the approver</Th>
                <Th>Active</Th>
                <Th align="right">Created</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <Tr key={rule.id}>
                  <Td>
                    <p className="font-semibold text-[#243640]">{rule.name}</p>
                    {rule.text_value && (
                      <p className="mt-0.5 text-[11.5px] text-[#7e8c94]">
                        Lines matching “{rule.text_value}”
                      </p>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[#5f7280]">{RULE_TYPE_LABEL[rule.rule_type]}</span>
                  </Td>
                  <Td className="text-[#5f7280]">
                    {rule.category ? humanise(rule.category) : "All categories"}
                  </Td>
                  <Td align="right" className="font-semibold">
                    <RuleValue rule={rule} />
                  </Td>
                  <Td className="max-w-[320px] text-[12.5px] leading-relaxed text-[#5f7280]">
                    {rule.message ?? "—"}
                  </Td>
                  <Td>
                    <StatusPill
                      size="sm"
                      tone={rule.active ? "positive" : "muted"}
                      label={rule.active ? "Active" : "Inactive"}
                    />
                  </Td>
                  <Td align="right" className="text-[12px] text-[#7e8c94]">
                    {shortDateTime(rule.created_at)}
                  </Td>
                  <Td align="right">
                    <IconButton
                      label={`Delete ${rule.name}`}
                      icon={<Trash2 className="size-4" />}
                      className="text-[#b42318] hover:bg-[#fef3f2] hover:text-[#b42318]"
                      onClick={() => setToDelete(rule)}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      {/* ------------------------------------------------------------------
          Add a rule
          ------------------------------------------------------------------ */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        width={660}
        title="Add a policy rule"
        description="It takes effect on the next run of the workflow type you choose. Nothing already assessed is re-evaluated."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              icon={<Plus className="size-4" />}
              loading={createMutation.isPending}
              onClick={submit}
            >
              Create rule
            </Button>
          </>
        }
      >
        <div className="space-y-4 pb-2">
          <Field
            label="Name"
            required
            htmlFor="rule-name"
            error={errors.name}
            hint="How this rule is identified in the assessment — e.g. “Meal daily cap”."
          >
            <Input
              id="rule-name"
              value={draft.name}
              maxLength={140}
              invalid={Boolean(errors.name)}
              onChange={(event) => update("name", event.target.value)}
              placeholder="Meal daily cap"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rule type" htmlFor="rule-type" hint={RULE_TYPE_NOTE[draft.rule_type]}>
              <Select
                id="rule-type"
                value={draft.rule_type}
                onChange={(event) =>
                  update("rule_type", event.target.value as PolicyRuleType)
                }
              >
                {RULE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {RULE_TYPE_LABEL[type]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Workflow type"
              htmlFor="rule-workflow"
              hint="The policy engine runs on reimbursement claims."
            >
              <Select
                id="rule-workflow"
                value={draft.workflow_type}
                onChange={(event) =>
                  update("workflow_type", event.target.value as WorkflowType)
                }
              >
                {WORKFLOW_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Category"
              htmlFor="rule-category"
              hint="Blank applies the rule to every claim line."
            >
              <Input
                id="rule-category"
                value={draft.category}
                maxLength={100}
                onChange={(event) => update("category", event.target.value)}
                placeholder="meals"
              />
            </Field>

            <Field
              label="Narrow to lines containing"
              htmlFor="rule-text"
              hint="Optional. Keeps a hotel cap from governing a flight."
            >
              <Input
                id="rule-text"
                value={draft.text_value}
                maxLength={500}
                onChange={(event) => update("text_value", event.target.value)}
                placeholder="hotel"
              />
            </Field>

            <Field
              label="Amount"
              htmlFor="rule-value"
              error={errors.numeric_value}
              hint="A cap is applied per unit claimed — quantity multiplies it."
            >
              <Input
                id="rule-value"
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={draft.numeric_value}
                invalid={Boolean(errors.numeric_value)}
                onChange={(event) => update("numeric_value", event.target.value)}
                placeholder="6000"
                className="tnum"
              />
            </Field>

            <Field
              label="Currency"
              htmlFor="rule-currency"
              error={errors.currency}
              hint="Three-letter code. Leave blank for a value that is not money."
            >
              <Input
                id="rule-currency"
                value={draft.currency}
                maxLength={3}
                invalid={Boolean(errors.currency)}
                onChange={(event) =>
                  update("currency", event.target.value.toUpperCase())
                }
                placeholder="Currency code"
                className="uppercase"
              />
            </Field>
          </div>

          <Field
            label="Message"
            required
            htmlFor="rule-message"
            error={errors.message}
            hint="Shown verbatim wherever this rule excludes a line, so write it for the person reading the result."
          >
            <Textarea
              id="rule-message"
              value={draft.message}
              maxLength={300}
              invalid={Boolean(errors.message)}
              onChange={(event) => update("message", event.target.value)}
              placeholder="Meal claims are capped at 6,000 per day."
              className="min-h-[88px]"
            />
          </Field>

          <div className="rounded-[16px] border border-white/70 bg-white/55 p-3.5">
            <Switch
              checked={draft.active}
              onChange={(next) => update("active", next)}
              label={draft.active ? "Active" : "Inactive"}
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
              Only active rules are read by the engine — and only active rules
              come back from the list endpoint, so an inactive rule will not
              appear in the table above.
            </p>
          </div>
        </div>
      </Modal>

      {/* ------------------------------------------------------------------
          Delete
          ------------------------------------------------------------------ */}
      <Modal
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title={`Delete “${toDelete?.name ?? "rule"}”?`}
        description="The rule stops applying from the next run. Claims already assessed keep the result they were given, so the audit trail stays readable."
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deleteMutation.isPending}
              icon={<Trash2 className="size-4" />}
              onClick={() => {
                if (toDelete) deleteMutation.mutate(toDelete.id);
              }}
            >
              Delete rule
            </Button>
          </>
        }
      >
        {toDelete && (
          <Alert tone="neutral" title={RULE_TYPE_LABEL[toDelete.rule_type]}>
            {toDelete.message ??
              "This rule has no approver-facing message recorded."}
          </Alert>
        )}
      </Modal>
    </>
  );
}
