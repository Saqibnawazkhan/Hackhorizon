"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ToastProvider } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The Supabase project is in Tokyo (~214 ms a query), so a short
            // stale window saves a lot of visible latency when moving between
            // screens without ever showing genuinely old data.
            staleTime: 15_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // 401/403/404 will not become true by asking again.
              if (error instanceof ApiError) {
                if (
                  error.isUnauthorised ||
                  error.isForbidden ||
                  error.isNotFound
                ) {
                  return false;
                }
              }
              return failureCount < 2;
            },
          },
          mutations: { retry: 0 },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
