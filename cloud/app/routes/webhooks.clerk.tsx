import type { ActionFunctionArgs } from "react-router";
import { verifyWebhook } from "@clerk/react-router/webhooks";
import { prisma } from "getbooqin-core";

// Keeps the local User row (id + email) that Connection.userId points at in
// sync with Clerk, which now owns identity — User.id is Clerk's own user id
// (see core/prisma/schema.prisma), created here rather than at signup time
// since the signup flow itself talks to Clerk directly from the browser.
//
// `user.deleted` used to be unhandled, so a user removed in Clerk left a
// row here permanently, with no way to notice. That is easy to cause by
// accident: a Clerk *instance* can be shared between environments, so a
// user created anywhere against it lands in every database that has this
// webhook registered.
export async function action({ request }: ActionFunctionArgs) {
  const event = await verifyWebhook(request);

  if (event.type === "user.created" || event.type === "user.updated") {
    const { id, email_addresses, primary_email_address_id } = event.data;
    const email =
      email_addresses.find((e) => e.id === primary_email_address_id)?.email_address ??
      email_addresses[0]?.email_address ??
      "";

    await prisma.user.upsert({
      where: { id },
      create: { id, email },
      update: { email },
    });
  }

  if (event.type === "user.deleted") {
    const { id } = event.data;
    if (!id) return new Response(null, { status: 200 });

    // Only when there is genuinely nothing attached. A User row is the
    // FK target for Connection and ConnectionMember, and cascading from
    // here would delete a live business — and every booking and customer
    // record in it — on the strength of an identity event, which is not
    // a decision a webhook should be making. Deleting someone in Clerk
    // says "this person is gone", not "erase their business"; that is
    // what the account-deletion flow is for, and it cancels their
    // subscription first.
    //
    // A user who still owns something is left in place deliberately, so
    // the business keeps working and the orphan is visible rather than
    // silently destructive.
    const { count } = await prisma.user.deleteMany({
      where: { id, connections: { none: {} }, connectionMembers: { none: {} } },
    });

    if (count === 0) {
      const stillThere = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (stillThere) {
        console.warn(
          `[getbooqin] Clerk user ${id} was deleted but still owns or belongs to a business — leaving the row in place.`
        );
      }
    }
  }

  return new Response(null, { status: 200 });
}
