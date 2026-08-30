// Every dashboard.$connectionId.* route's meta() can reach the layout
// route's own loader data (preset, connection, ...) through `matches` — RR7
// passes the whole match chain, not just this route's own data. Pulled out
// once so <title> tags across list/detail routes read the same preset id
// the sidebar and page body already use, instead of the hardcoded English
// noun each route's <title> shipped with (UX audit's #5 finding).
export function dashboardPreset(matches: ({ id: string; data: unknown } | undefined)[]): string | null {
  const match = matches.find((m) => m?.id === "routes/dashboard.$connectionId");
  return (match?.data as { preset?: string | null } | undefined)?.preset ?? null;
}
