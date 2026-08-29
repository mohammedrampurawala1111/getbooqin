import type { ActionFunctionArgs } from "react-router";
import { verifyWebhook } from "@clerk/react-router/webhooks";
import { prisma } from "getbooqin-core";

// Keeps the local User row (id + email) that Connection.userId points at in
// sync with Clerk, which now owns identity — User.id is Clerk's own user id
// (see core/prisma/schema.prisma), created here rather than at signup time
// since the signup flow itself talks to Clerk directly from the browser.
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

  return new Response(null, { status: 200 });
}
