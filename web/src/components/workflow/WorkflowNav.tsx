"use client";

/**
 * The sub-navigation shared by every `/workflows/[id]/…` screen.
 *
 * A tab is only offered once its artefact exists — there is no comparison
 * before quotes are fetched, no PO before one is generated. Offering a tab
 * that can only 404 is worse than not offering it, so `available` gates them.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui";

export interface WorkflowTab {
  href: string;
  label: string;
  available?: boolean;
  badge?: string | number;
}

export function WorkflowNav({
  workflowId,
  available = {},
  className,
}: {
  workflowId: string;
  available?: Partial<
    Record<"comparison" | "validation" | "purchaseOrder" | "report" | "audit", boolean>
  >;
  className?: string;
}) {
  const pathname = usePathname();
  const base = `/workflows/${workflowId}`;

  const tabs: WorkflowTab[] = [
    { href: base, label: "Execution", available: true },
    {
      href: `${base}/comparison`,
      label: "Comparison",
      available: available.comparison ?? true,
    },
    {
      href: `${base}/validation`,
      label: "Validation",
      available: available.validation ?? true,
    },
    {
      href: `${base}/purchase-order`,
      label: "Purchase order",
      available: available.purchaseOrder ?? true,
    },
    { href: `${base}/report`, label: "Report", available: available.report ?? true },
    { href: `${base}/audit`, label: "Audit trail", available: available.audit ?? true },
  ];

  return (
    <div
      className={cn(
        "no-print -mx-1 flex gap-1 overflow-x-auto rounded-[16px] bg-white/50 p-1.5 backdrop-blur-md",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        const disabled = tab.available === false;
        if (disabled) {
          return (
            <span
              key={tab.href}
              title="Not available for this workflow yet"
              className="cursor-not-allowed whitespace-nowrap rounded-[12px] px-3.5 py-2 text-[12.5px] font-semibold text-[#bccdd5]"
            >
              {tab.label}
            </span>
          );
        }
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "whitespace-nowrap rounded-[12px] px-3.5 py-2 text-[12.5px] font-semibold transition-all duration-200",
              active
                ? "gradient-cta text-white shadow-[0_6px_16px_rgba(46,96,120,0.24)]"
                : "text-[#5f7280] hover:bg-white/80 hover:text-[#243640]",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
