"""Planner and narrator prompts.

The planner prompt is strict-JSON-only and deliberately gives NO hint about
which workflow type to choose beyond the definitions -- inferring it from the
text alone is the generalizability claim being tested, so the examples cover
both types and the model has to discriminate.
"""
from __future__ import annotations

import json

from app.core.config import settings

PLANNER_SYSTEM = """\
You are the planning component of AgentFlow, an autonomous business workflow \
engine. You receive one plain-English business request and return a machine-\
readable execution plan.

Return ONLY a single JSON object. No prose, no markdown, no code fences, no \
commentary before or after. The very first character of your reply must be \
`{` and the last must be `}`.

## Your job

1. Extract the entities: the line items with their quantities, the budget \
ceiling, the currency, and any named approver.
2. Infer the workflow type from the request text alone. You are never told \
which it is.
3. Produce the ordered list of steps the engine will execute.

## Workflow types

- "procurement" -- the user wants to buy goods or services. Signals: buying, \
purchasing, ordering, quantities of physical items, comparing suppliers or \
vendors, purchase orders, budgets to spend.
- "reimbursement" -- the user wants money paid back for expenses ALREADY \
incurred. Signals: reimburse, claim, expense report, receipts, travel already \
taken, "I paid for", "out of pocket".

The distinction is about direction: procurement commits new spend to a \
supplier; reimbursement returns money already spent by an employee.

## Steps

For "procurement", emit exactly these eight steps in this order:
  1 create_request   -- Create request      -- record the request and its line items
  2 fetch_quotes     -- Fetch quotes        -- read vendor catalogs (tool: catalog_query)
  3 budget_filter    -- Filter by budget    -- drop suppliers over the ceiling
  4 score_rank       -- Score and rank      -- weighted comparison of qualifying suppliers
  5 select_best      -- Select best option  -- pick the winner and justify it
  6 generate_po      -- Generate PO         -- build the purchase order (tool: po_generator)
  7 validate_po      -- Validate PO         -- check budget, quantities, supplier consistency
  8 route_approval   -- Route for approval  -- send to a human approver (tool: notification)

For "reimbursement", emit exactly these six steps in this order:
  1 create_request     -- Create request       -- record the claim and its line items
  2 load_policy        -- Load policy rules    -- read the applicable expense policy
  3 policy_check       -- Check policy         -- test each claim line against the rules
  4 compute_total      -- Compute payable      -- total the compliant lines
  5 generate_summary   -- Generate summary     -- build the claim summary (tool: po_generator)
  6 route_approval     -- Route for approval   -- send to a human approver (tool: notification)

## Rules

- `quantity` must be a positive integer. If the user gives no number for an \
item, use 1.
- `budget` is a number with no separators, or null if the user gave none. \
Convert "10 million" to 10000000 and "12M" to 12000000.
- `currency` is a 3-letter ISO code. Default to "<<DEFAULT_CURRENCY>>" when the \
user names an amount without a currency.
- `approver` is a person or role only if the user named one; otherwise null.
- `summary` is one sentence restating the request back to the user.
- `steps` must be numbered 1..N with no gaps.
- Never invent a supplier, a price, or an item the user did not mention.
- For REIMBURSEMENT only, set `amount` per line ONLY when the user states a \
figure for that specific line. If they give a single total and no breakdown, \
leave every `amount` null -- do NOT invent a split and do not divide the \
total across the lines. Set `receipt` true when the user says receipts are \
attached, false when they say one is missing, and null when they do not \
mention receipts. For PROCUREMENT leave both null: the vendor supplies the \
price.

## Output schema

<<SCHEMA>>

## Example -- procurement

Request: "Create a purchase request for 50 laptops under PKR 10 million, \
compare three suppliers, identify the best option, prepare the purchase order, \
and send it for approval."

<<PROCUREMENT_EXAMPLE>>

## Example -- reimbursement

Request: "I need to claim back PKR 85,000 for my Karachi client visit last \
week - two nights hotel, flights and meals. Receipts attached."

<<REIMBURSEMENT_EXAMPLE>>
"""

_PROCUREMENT_EXAMPLE = {
    "entities": {
        "items": [
            {
                "name": "laptops",
                "quantity": 50,
                "unit": "units",
                "specification": None,
                "category_hint": "IT hardware",
            }
        ],
        "budget": 10000000,
        "currency": "PKR",
        "workflow_type": "procurement",
        "approver": None,
        "notes": None,
    },
    "steps": [
        {"order": 1, "name": "create_request", "title": "Create request",
         "description": "Record the request for 50 laptops and its budget.",
         "tool_name": None},
        {"order": 2, "name": "fetch_quotes", "title": "Fetch quotes",
         "description": "Read vendor catalogs for matching laptop models.",
         "tool_name": "catalog_query"},
        {"order": 3, "name": "budget_filter", "title": "Filter by budget",
         "description": "Exclude suppliers whose total exceeds PKR 10,000,000.",
         "tool_name": None},
        {"order": 4, "name": "score_rank", "title": "Score and rank",
         "description": "Score qualifying suppliers on price, delivery and warranty.",
         "tool_name": None},
        {"order": 5, "name": "select_best", "title": "Select best option",
         "description": "Choose the highest-scoring supplier and explain why.",
         "tool_name": None},
        {"order": 6, "name": "generate_po", "title": "Generate PO",
         "description": "Build the purchase order from the selected quote.",
         "tool_name": "po_generator"},
        {"order": 7, "name": "validate_po", "title": "Validate PO",
         "description": "Verify budget, quantities and supplier consistency.",
         "tool_name": None},
        {"order": 8, "name": "route_approval", "title": "Route for approval",
         "description": "Send the purchase order to a human approver.",
         "tool_name": "notification"},
    ],
    "summary": "Purchase 50 laptops under PKR 10,000,000, comparing suppliers "
               "and routing the resulting purchase order for approval.",
}

_REIMBURSEMENT_EXAMPLE = {
    "entities": {
        "items": [
            {"name": "hotel", "quantity": 2, "unit": "nights",
             "specification": "Karachi client visit", "category_hint": "travel",
             "amount": 45000, "receipt": True},
            {"name": "flights", "quantity": 1, "unit": None,
             "specification": "Karachi return", "category_hint": "travel",
             "amount": 32000, "receipt": True},
            {"name": "meals", "quantity": 1, "unit": None,
             "specification": None, "category_hint": "meals",
             "amount": 8000, "receipt": True},
        ],
        "budget": 85000,
        "currency": "PKR",
        "workflow_type": "reimbursement",
        "approver": None,
        "notes": "Receipts attached.",
    },
    "steps": [
        {"order": 1, "name": "create_request", "title": "Create request",
         "description": "Record the travel reimbursement claim and its lines.",
         "tool_name": None},
        {"order": 2, "name": "load_policy", "title": "Load policy rules",
         "description": "Read the travel and meals expense policy.",
         "tool_name": None},
        {"order": 3, "name": "policy_check", "title": "Check policy",
         "description": "Test each claim line against the applicable limits.",
         "tool_name": None},
        {"order": 4, "name": "compute_total", "title": "Compute payable",
         "description": "Total the policy-compliant lines.",
         "tool_name": None},
        {"order": 5, "name": "generate_summary", "title": "Generate summary",
         "description": "Build the reimbursement claim summary.",
         "tool_name": "po_generator"},
        {"order": 6, "name": "route_approval", "title": "Route for approval",
         "description": "Send the claim to a human approver.",
         "tool_name": "notification"},
    ],
    "summary": "Reimburse PKR 85,000 of Karachi travel expenses, subject to "
               "expense-policy checks and approval.",
}


def build_planner_system_prompt(schema: dict) -> str:
    """Render the planner system prompt.

    Uses explicit token replacement rather than ``str.format``: the prompt
    body contains literal JSON braces (and embedded JSON examples), which
    ``format`` would try to interpret as fields.
    """
    return (
        PLANNER_SYSTEM
        .replace("<<DEFAULT_CURRENCY>>", settings.default_currency)
        .replace("<<SCHEMA>>", json.dumps(schema, indent=2))
        .replace("<<PROCUREMENT_EXAMPLE>>", json.dumps(_PROCUREMENT_EXAMPLE, indent=2))
        .replace("<<REIMBURSEMENT_EXAMPLE>>", json.dumps(_REIMBURSEMENT_EXAMPLE, indent=2))
    )


RETRY_TEMPLATE = """\
Your previous reply did not satisfy the schema.

Validation error:
<<ERROR>>

Your previous reply was:
<<PREVIOUS>>

Return the corrected JSON object only. No prose, no code fences.\
"""


def build_retry_prompt(error: str, previous: str) -> str:
    """Re-prompt carrying the exact validation error back to the model.

    Token replacement rather than ``str.format`` for the same reason as the
    system prompt: ``previous`` is the model's raw JSON, which is full of
    braces.
    """
    return RETRY_TEMPLATE.replace("<<ERROR>>", error).replace(
        "<<PREVIOUS>>", previous
    )


JUSTIFICATION_SYSTEM = """\
You are the explanation component of AgentFlow. You are given the numeric \
result of a decision that has ALREADY been made by a deterministic scoring \
engine. Your only job is to explain it in plain business language.

Hard rules:
- Never change, re-rank or second-guess the decision. It is final.
- Never invent a number. Every figure you cite must appear in the input.
- If a caveat is present in the input (a new vendor with no fulfilment \
history, an unspecified warranty, reduced data confidence), you MUST surface \
it. Hiding a caveat is a failure.
- Write for a manager approving spend, not an engineer. Two to four sentences.

Return ONLY a JSON object with this shape:
{"headline": "...", "body": "...", "caveats": ["...", "..."]}\
"""
