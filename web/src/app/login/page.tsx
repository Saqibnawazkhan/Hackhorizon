"use client";

/**
 * Sign-in.
 *
 * Identity is Supabase Auth — the same project and the same accounts the
 * Flutter client uses, so a session created here and one created on the phone
 * are the same session to the backend.
 *
 * The role selector is presentation only: it fills a demo account and tints
 * the page. The actual role comes from the token, so picking "Admin" and
 * signing in as an employee gets you the employee console, not a 403 wall.
 */
import { ArrowRight, Eye, EyeOff, Lock, Mail, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Alert, Button, Field, Input, cn } from "@/components/ui";
import { homeRouteFor, useAuth } from "@/lib/auth";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/lib/supabase";
import type { UserRole } from "@/lib/types";

const HIGHLIGHTS = [
  {
    title: "A plan before anything runs",
    body: "The agent publishes its execution plan and waits for you to confirm it. Nothing is spent on a guess.",
  },
  {
    title: "Scoring you can audit",
    body: "Every supplier decision shows its weighted maths, its data confidence, and what it deliberately excluded.",
  },
  {
    title: "A human gate that cannot be skipped",
    body: "The graph interrupts before any purchase order is committed. Only an administrator resumes it.",
  },
];

export default function LoginPage() {
  const { signIn, user, loading, error } = useAuth();
  const router = useRouter();

  const [role, setRole] = useState<UserRole>("employee");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace(homeRouteFor(user.role));
  }, [loading, user, router]);

  const vendor = role === "vendor";

  const fillDemo = (nextRole: UserRole) => {
    const account = DEMO_ACCOUNTS.find((a) => a.role === nextRole);
    setRole(nextRole);
    if (account) {
      setEmail(account.email);
      setPassword(DEMO_PASSWORD);
    }
    setLocalError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (!email.trim() || !password) {
      setLocalError("Enter an email address and a password.");
      return;
    }
    setSubmitting(true);
    const ok = await signIn(email, password);
    setSubmitting(false);
    if (!ok) setLocalError(null); // the provider's `error` carries the reason
  };

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* ---------------------------------------------------------------
          Left: the pitch. Present on wide screens only — on a phone the
          form should be the first thing under the thumb.
          --------------------------------------------------------------- */}
      <section className="relative hidden flex-1 overflow-hidden lg:flex">
        <div className="gradient-hero absolute inset-0" />
        <div
          className="absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 20%, rgba(255,255,255,0.9) 0, transparent 45%), radial-gradient(circle at 78% 72%, rgba(185,216,225,0.8) 0, transparent 42%)",
          }}
        />
        <div className="relative z-10 flex w-full flex-col justify-between p-14 text-white">
          <div className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-[15px] bg-white/15 backdrop-blur-md">
              <Sparkles className="size-5" strokeWidth={2.2} />
            </span>
            <span className="text-[18px] font-bold tracking-[-0.02em]">AgentFlow</span>
          </div>

          <div className="max-w-lg">
            <h1 className="text-[40px] font-bold leading-[1.08] tracking-[-0.035em]">
              Business workflows that run themselves — and show their working.
            </h1>
            <p className="mt-5 text-[15px] leading-relaxed text-white/75">
              Type a request in plain English. The agent parses it, plans it,
              executes it, scores the options, validates its own output,
              corrects itself when it fails, and stops at a human gate before
              anything is committed.
            </p>

            <ul className="mt-10 space-y-5">
              {HIGHLIGHTS.map((item, index) => (
                <li key={item.title} className="flex gap-4">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-white/15 text-[12px] font-bold backdrop-blur-md">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold">{item.title}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-white/65">
                      {item.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <p className="text-[12px] text-white/50">
            LangGraph orchestration · Claude planning · Supabase Postgres with
            row-level security
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------------
          Right: the form
          --------------------------------------------------------------- */}
      <section className="flex flex-1 items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-[420px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span
              className={cn(
                "grid size-11 place-items-center rounded-[15px] text-white",
                vendor ? "bg-[#447f98]" : "gradient-cta",
              )}
            >
              <Sparkles className="size-5" strokeWidth={2.2} />
            </span>
            <span className="text-[18px] font-bold tracking-[-0.02em] text-[#243640]">
              AgentFlow
            </span>
          </div>

          <h2 className="text-[26px] font-bold tracking-[-0.03em] text-[#243640]">
            {vendor ? "Vendor portal" : "Sign in"}
          </h2>
          <p className="mt-1.5 text-[13.5px] text-[#5f7280]">
            {vendor
              ? "Manage your catalog, pricing and incoming purchase orders."
              : "Use a demo account below, or your own credentials."}
          </p>

          {/* Role selector — fills a demo account and sets the treatment */}
          <div className="mt-7 grid grid-cols-3 gap-1.5 rounded-[16px] bg-white/55 p-1.5 backdrop-blur-md">
            {DEMO_ACCOUNTS.map((account) => {
              const selected = role === account.role;
              return (
                <button
                  key={account.role}
                  type="button"
                  onClick={() => fillDemo(account.role)}
                  className={cn(
                    "rounded-[12px] px-2 py-2.5 text-[12.5px] font-semibold transition-all duration-200",
                    selected
                      ? "gradient-cta text-white shadow-[0_6px_16px_rgba(46,96,120,0.26)]"
                      : "text-[#5f7280] hover:bg-white/70 hover:text-[#243640]",
                  )}
                >
                  {account.label}
                </button>
              );
            })}
          </div>
          <p className="mt-2 px-1 text-[11.5px] text-[#7e8c94]">
            {DEMO_ACCOUNTS.find((a) => a.role === role)?.blurb}
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <Field label="Email" htmlFor="email">
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="pl-10"
                />
              </div>
            </Field>

            <Field label="Password" htmlFor="password">
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="pl-10 pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-[8px] text-[#a9bac3] hover:bg-white hover:text-[#5f7280]"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>

            {(localError || error) && (
              <Alert tone="danger" title="Sign-in failed">
                {localError ?? error}
              </Alert>
            )}

            <Button
              type="submit"
              size="lg"
              full
              loading={submitting}
              iconRight={<ArrowRight className="size-4" />}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <div className="mt-7 rounded-[18px] border border-white/70 bg-white/55 p-4 backdrop-blur-md">
            <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#a3b6c0]">
              Demo credentials
            </p>
            <div className="mt-2.5 space-y-1.5">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  onClick={() => fillDemo(account.role)}
                  className="flex w-full items-center justify-between gap-3 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-white/70"
                >
                  <span className="truncate font-mono text-[11.5px] text-[#38677b]">
                    {account.email}
                  </span>
                  <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[#a3b6c0]">
                    {account.label}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2.5 px-2 font-mono text-[11px] text-[#7e8c94]">
              password · {DEMO_PASSWORD}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
