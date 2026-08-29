"use client";

/**
 * Warm a route's data before the click lands.
 *
 * The backend is not slow because of its code — a route that touches no
 * database answers in ~1.5ms. It is slow because the Supabase project is in
 * another region: one round trip is ~300ms, and a listing that needs a count
 * plus a page of rows costs two. Deploying the API into Supabase's region is
 * the real fix and nothing here substitutes for it.
 *
 * What this DOES fix is the part the user actually experiences. Hovering a nav
 * item is a reliable ~200-400ms of warning before the click, and moving the
 * pointer to a link costs nothing if the click never comes. By the time the
 * route mounts, TanStack Query already holds the data and the page renders
 * from cache instead of from a spinner.
 *
 * THE KEYS BELOW MUST MATCH THE PAGES EXACTLY. A prefetch under a key no page
 * reads is invisible waste — it fetches, fills the cache, and the page misses
 * it. Each entry names the file it mirrors so the two stay together; if you
 * change a page's queryKey or its default filter state, change it here too.
 */
import type { QueryClient } from "@tanstack/react-query";

import { api } from "./api";
import type { UserRole } from "./types";

/** Matches the `staleTime` the pages inherit from Providers. */
const PREFETCH_STALE = 15_000;

type Prefetcher = (client: QueryClient) => void;

function warm(
  client: QueryClient,
  queryKey: readonly unknown[],
  queryFn: () => Promise<unknown>,
) {
  // prefetchQuery is a no-op when a fresh entry already exists, so hovering
  // the same link repeatedly costs one request, not one per hover.
  void client.prefetchQuery({ queryKey, queryFn, staleTime: PREFETCH_STALE });
}

/**
 * Route → the queries that route mounts with.
 *
 * Only the FIRST screenful is warmed. Prefetching a page's every tab would
 * spend the user's bandwidth on screens they may never open.
 */
const ROUTES: Record<string, Prefetcher> = {
  // src/app/(app)/dashboard/page.tsx
  "/dashboard": (c) => {
    warm(c, ["dashboard", "recent-workflows"], () =>
      api.listWorkflows({ limit: 8 }),
    );
    warm(c, ["dashboard", "count", "running"], () =>
      api.listWorkflows({ status: "running", limit: 1 }),
    );
    warm(c, ["dashboard", "count", "awaiting_approval"], () =>
      api.listWorkflows({ status: "awaiting_approval", limit: 1 }),
    );
    warm(c, ["dashboard", "count", "vendors"], () =>
      api.listVendors({ limit: 1 }),
    );
  },

  // src/app/(app)/workflows/page.tsx — PAGE_SIZE 20, all filters at default
  "/workflows": (c) =>
    warm(
      c,
      ["workflows", { status: "all", type: "all", search: "", offset: 0 }],
      () =>
        api.listWorkflows({
          status: undefined,
          workflow_type: undefined,
          search: undefined,
          limit: 20,
          offset: 0,
        }),
    ),

  // src/app/(app)/vendors/page.tsx — PAGE_SIZE 24
  "/vendors": (c) =>
    warm(c, ["vendors", { status: "all", search: "", offset: 0 }], () =>
      api.listVendors({
        status: undefined,
        search: undefined,
        limit: 24,
        offset: 0,
      }),
    ),

  // src/app/(app)/catalog/page.tsx
  "/catalog": (c) =>
    warm(
      c,
      ["catalog", "browse", { search: "", vendorId: "", offset: 0 }],
      () =>
        api.browseCatalog({
          search: undefined,
          vendor_id: undefined,
          limit: 24,
          offset: 0,
        }),
    ),

  // src/app/(app)/admin/page.tsx
  "/admin": (c) => {
    warm(c, ["admin", "dashboard"], () => api.getDashboard());
    warm(c, ["admin", "approvals", "preview"], () =>
      api.listApprovals({ limit: 5 }),
    );
    warm(c, ["admin", "flagged-vendors"], () => api.flaggedVendors());
    warm(c, ["admin", "workflows", "recent"], () =>
      api.listWorkflows({ limit: 6 }),
    );
  },

  // src/app/(app)/admin/approvals/page.tsx — PAGE_SIZE 10
  "/admin/approvals": (c) =>
    warm(c, ["approvals", { limit: 10, offset: 0 }], () =>
      api.listApprovals({ limit: 10, offset: 0 }),
    ),

  // src/app/(app)/admin/vendors/page.tsx
  "/admin/vendors": (c) => {
    warm(c, ["admin", "flagged-vendors"], () => api.flaggedVendors());
    warm(c, ["admin", "vendors", "all", "", 0], () =>
      api.listVendors({ limit: 50, offset: 0 }),
    );
  },

  "/admin/scoring": (c) =>
    warm(c, ["admin", "scoring-weights"], () => api.getScoringWeights()),

  "/admin/policies": (c) =>
    warm(c, ["admin", "policy-rules", "reimbursement"], () =>
      api.listPolicyRules("reimbursement"),
    ),

  "/admin/spend": (c) =>
    warm(c, ["admin", "spend", 30], () => api.getSpendReport(30)),

  // src/app/(app)/portal/page.tsx
  "/portal": (c) => warm(c, ["catalog", "me", 0], () => api.myCatalog()),

  "/portal/orders": (c) =>
    warm(c, ["vendor", "purchase-orders", "all", 0], () =>
      api.myPurchaseOrders({ limit: 20, offset: 0 }),
    ),

  // src/app/(app)/portal/quotes/page.tsx
  "/portal/quotes": (c) =>
    warm(c, ["vendor", "quote-requests", false], () =>
      api.myQuoteRequests(false),
    ),

  "/portal/connections": (c) =>
    warm(c, ["catalog", "connections"], () => api.listConnections()),

  "/portal/imports": (c) => {
    warm(c, ["imports"], () => api.listImports());
    warm(c, ["import-template"], () => api.importTemplate());
  },

  // src/app/(app)/system/page.tsx
  "/system": (c) => {
    warm(c, ["health"], () => api.health());
    warm(c, ["meta", "workflow-types"], () => api.workflowTypes());
    warm(c, ["meta", "tools"], () => api.tools());
  },
};

/** Warm whatever `href` will need. Safe to call on every hover. */
export function prefetchRoute(client: QueryClient, href: string): void {
  ROUTES[href]?.(client);
}

/**
 * Warm one workflow's detail view — used when hovering a row in a list, where
 * the href carries an id and so cannot be looked up in the static table above.
 */
export function prefetchWorkflow(client: QueryClient, id: string): void {
  warm(client, ["workflow", id], () => api.getWorkflow(id));
}

/** Warm one vendor's record, for hovering a name in the directory. */
export function prefetchVendor(client: QueryClient, id: string): void {
  warm(client, ["vendor", id], () => api.getVendor(id));
}

/**
 * The route a role lands on after signing in.
 *
 * Called once the session resolves, so the first screen is already warm by the
 * time the shell has rendered — the slowest single moment in the app, because
 * nothing is cached yet.
 */
export function prefetchHome(client: QueryClient, role: UserRole): void {
  if (role === "admin") ROUTES["/admin"]?.(client);
  else if (role === "vendor") ROUTES["/portal"]?.(client);
  else ROUTES["/dashboard"]?.(client);
}
