import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

/**
 * Mandatory GDPR webhook. Erase this customer's personal data. We anonymize
 * rather than delete the Customer row outright — Booking.customerId is a
 * required FK, so dropping the row would either fail the constraint or
 * orphan booking history; overwriting the PII fields in place satisfies the
 * redact request while keeping bookings and payment records intact.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const email = typeof payload?.customer?.email === "string" ? payload.customer.email : "";
  if (!email) return new Response();

  await prisma.customer.updateMany({
    where: { shop, email },
    data: {
      firstName: "",
      lastName: "Redacted",
      email: `redacted+${Date.now()}@example.invalid`,
      phone: "",
      notes: null,
    },
  });

  await prisma.chatConversation.updateMany({
    where: { shop, visitorEmail: email },
    data: { visitorName: "", visitorEmail: "", visitorPhone: "" },
  });

  return new Response();
};
