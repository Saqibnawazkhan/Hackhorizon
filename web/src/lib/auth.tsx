"use client";

/**
 * Session and role.
 *
 * The role is read from the Supabase JWT's `app_metadata.role` claim, which is
 * what the backend's `_resolve_user` also reads before falling back to the
 * `public.users` row. Reading the same claim keeps the console's navigation
 * and the API's 403s in agreement — a vendor never sees a buyer route in the
 * sidebar AND is refused by the API if they force the URL.
 */
import type { Session, User } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { configureApi } from "./api";
import { getSupabase } from "./supabase";
import type { UserRole } from "./types";

export interface AuthUser {
  id: string;
  email: string | null;
  role: UserRole;
  fullName: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  accessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function decodeRole(session: Session | null): UserRole {
  const claim =
    (session?.user?.app_metadata as Record<string, unknown> | undefined)?.role ??
    (session?.user?.user_metadata as Record<string, unknown> | undefined)?.role;
  if (claim === "admin" || claim === "vendor" || claim === "employee") {
    return claim;
  }
  return "employee";
}

function toAuthUser(session: Session | null): AuthUser | null {
  const supabaseUser: User | undefined = session?.user;
  if (!supabaseUser) return null;
  const meta = supabaseUser.user_metadata as Record<string, unknown> | undefined;
  return {
    id: supabaseUser.id,
    email: supabaseUser.email ?? null,
    role: decodeRole(session),
    fullName:
      (typeof meta?.full_name === "string" && meta.full_name) ||
      (typeof meta?.name === "string" && meta.name) ||
      null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = getSupabase();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The API client reads the token through a ref so `configureApi` is
  // installed exactly once — re-installing on every render would race with
  // in-flight requests.
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  const accessToken = useCallback(async () => {
    // getSession() refreshes an expired token transparently; reading
    // sessionRef alone would hand the API a stale one after an hour idle.
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, [supabase]);

  useEffect(() => {
    configureApi({
      tokenProvider: accessToken,
      onUnauthorised: () => {
        void supabase.auth.signOut();
      },
    });
  }, [accessToken, supabase]);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, next) => {
        setSession(next);
        setLoading(false);
      },
    );

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [supabase]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setLoading(true);
      const { data, error: signInError } = await supabase.auth.signInWithPassword(
        { email: email.trim(), password },
      );
      setLoading(false);
      if (signInError) {
        setError(signInError.message);
        return false;
      }
      setSession(data.session);
      return true;
    },
    [supabase],
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    router.replace("/login");
  }, [supabase, router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: toAuthUser(session),
      session,
      loading,
      error,
      signIn,
      signOut,
      accessToken,
    }),
    [session, loading, error, signIn, signOut, accessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** The landing route for a role — also the redirect target after sign-in. */
export function homeRouteFor(role: UserRole): string {
  switch (role) {
    case "admin":
      return "/admin";
    case "vendor":
      return "/portal";
    default:
      return "/dashboard";
  }
}
