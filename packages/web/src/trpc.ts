import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@trove/api";

export const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] });
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 4000 } },
});
