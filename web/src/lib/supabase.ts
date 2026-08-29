"use client";

/**
 * The same Supabase project the Flutter app signs into.
 *
 * Identity is Supabase Auth; the FastAPI backend verifies the resulting
 * access token via JWKS (ES256). Nothing here talks to Postgres directly —
 * every read and write goes through the API, which holds the service-role key
 * and is the only thing allowed to bypass RLS.
 *
 * The publishable (anon) key is designed to be shipped in a client: it grants
 * nothing beyond what RLS allows. The SECRET key never appears in this app.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://jbdrqulyenfwzouoktxu.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_VX9zf91woOUl6Wk_hTbfPA_g495DDwi";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Persist across reloads and refresh silently, so a returning user
      // lands on their dashboard rather than the sign-in screen.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "agentflow-web-auth",
    },
  });
  return client;
}

/** Demo accounts, so the console is usable without hunting for credentials. */
export const DEMO_ACCOUNTS = [
  {
    role: "employee" as const,
    email: "sara@agentflow.demo",
    label: "Employee",
    blurb: "Submit requests, watch the agent work",
  },
  {
    role: "admin" as const,
    email: "admin@agentflow.demo",
    label: "Admin",
    blurb: "Approve spend, tune scoring, manage vendors",
  },
  {
    role: "vendor" as const,
    email: "vendor@techsupplies.demo",
    label: "Vendor",
    blurb: "Maintain a catalog, fulfil purchase orders",
  },
];

export const DEMO_PASSWORD = "AgentFlow!2026";
