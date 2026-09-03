import { data } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.$";

// Matches any nested path under /dashboard/:connectionId that no other
// route claims. Its only job is to be a real, matched route whose loader
// throws — see routes.ts's own comment on why this has to exist at all for
// the layout's ErrorBoundary to catch a bad nested URL instead of the
// bare root-level one (Defect Dossier's BQ-37 finding).
export async function loader() {
  throw data("Not found", { status: 404 });
}

export default function Splat(_: Route.ComponentProps) {
  return null;
}
