import type { ActionFunctionArgs } from "react-router";
import { prisma, emailKey } from "getbooqin-core";
import { getUserSession, getClerkClient } from "~/session.server";
import { canonicalPhone, isValidPhone } from "~/lib/validation";

// Resource route only — no UI. Called from signup.tsx right after a session
// goes active, and from the account page's PhoneCard, to record the phone
// number the user typed in without ever sending it to Clerk (see
// core/prisma/schema.prisma's User.phone comment for why). Upserts rather
// than updates because webhooks.clerk.tsx's user.created row may not have
// landed yet by the time this fires.
//
// This is the only copy of the number. Clerk never sees it, so there is no
// second place to recover it from if this write is lost — which is why
// signup.tsx now reports a failure here instead of discarding it.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const session = await getUserSession(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { phone } = await request.json();
  // The client already validates (signup.tsx, dashboard.account.tsx's
  // PhoneCard), but this is the only server-side write path for the field —
  // relying solely on client-side `pattern` let "abcdefg" save cleanly with
  // a 200 (UX audit's V2 finding).
  if (typeof phone !== "string" || !phone || !isValidPhone(phone)) {
    return new Response("Bad Request", { status: 400 });
  }

  const clerkUser = await getClerkClient().users.getUser(session.userId);
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";

  // Stored in one canonical shape rather than however it was typed, so
  // "+91 93257 05315" and "+919325705315" are not two records of one
  // merchant. No country code is inferred — see canonicalPhone().
  const stored = canonicalPhone(phone);

  await prisma.user.upsert({
    where: { id: session.userId },
    create: { id: session.userId, email, emailKey: emailKey(email), phone: stored },
    update: { phone: stored },
  });

  return new Response(null, { status: 204 });
}
