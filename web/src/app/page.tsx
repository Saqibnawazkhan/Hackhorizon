"use client";

/**
 * The entry point routes by role rather than showing a chooser: an admin's
 * home is the approval-pressure dashboard, an employee's is their own work,
 * a vendor's is their catalog. Landing on the wrong one costs a click every
 * single session.
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Spinner } from "@/components/ui";
import { homeRouteFor, useAuth } from "@/lib/auth";

export default function IndexPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? homeRouteFor(user.role) : "/login");
  }, [loading, user, router]);

  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex items-center gap-3 text-[13px] text-[#5f7280]">
        <Spinner />
        Loading AgentFlow…
      </div>
    </div>
  );
}
