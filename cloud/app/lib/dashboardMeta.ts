import type { Terms } from "getbooqin-core/booking/presets";

// Every dashboard.$connectionId.* route's meta() can reach the layout
// route's own loader data (terms, connection, ...) through `matches` — RR7
// passes the whole match chain, not just this route's own data. Pulled out
// once so <title> tags across list/detail routes read the same vocabulary
// the sidebar and page body already use, instead of the hardcoded English
// noun each route's <title> shipped with (UX audit's #5 finding).
export function dashboardTerms(
  matches: ({ id: string; data: unknown } | undefined)[]
): Partial<Terms> | null {
  const match = matches.find((m) => m?.id === "routes/dashboard.$connectionId");
  return (match?.data as { terms?: Partial<Terms> | null } | undefined)?.terms ?? null;
}
