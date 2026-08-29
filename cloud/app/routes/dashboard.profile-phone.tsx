import type { ActionFunctionArgs } from "react-router";
import { prisma } from "getbooqin-core";
import { getUserSession, getClerkClient } from "~/session.server";
import { isValidPhone } from "~/lib/validation";

// Resource route only — no UI. Called once from signup.tsx right after a
// session goes active, to record the phone number the user typed in without
// ever sending it to Clerk (see core/prisma/schema.prisma's User.phone
// comment for why). Upserts rather than updates because webhooks.clerk.tsx's
// user.created row may not have landed yet by the time this fires.
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

  await prisma.user.upsert({
    where: { id: session.userId },
    create: { id: session.userId, email, phone },
    update: { phone },
  });

  return new Response(null, { status: 204 });
}
