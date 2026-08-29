import { UserProfile } from "@clerk/react-router";
import type { Route } from "./+types/dashboard.account";
import { requireUserSession } from "~/session.server";

// Self-serve profile + MFA enrollment (TOTP/backup codes) via Clerk's
// prebuilt component — enable MFA under Clerk Dashboard > User &
// Authentication > Multi-factor for this to offer it. `routing="hash"`
// keeps Clerk's internal tab navigation self-contained without registering
// extra React Router routes for it.
export async function loader({ request }: Route.LoaderArgs) {
  await requireUserSession(request);
  return null;
}

export default function Account() {
  return (
    <div className="page flex justify-center">
      <UserProfile routing="hash" />
    </div>
  );
}
