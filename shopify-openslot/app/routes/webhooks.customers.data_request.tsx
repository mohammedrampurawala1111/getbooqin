import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { Mailer } from "getbooqin-core";

/**
 * Mandatory GDPR webhook. A shop owner asked Shopify for a copy of a
 * customer's data. There's no self-serve export yet, so this emails the
 * shop's admin everything GetBooqin holds for that customer (matched by
 * shop + email, since that's the only stable link between a Shopify
 * customer and our own Customer row) so it can be forwarded on within
 * Shopify's required window.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const email = typeof payload?.customer?.email === "string" ? payload.customer.email : "";
  if (email) {
    const customer = await prisma.customer.findFirst({
      where: { shop, email },
      include: { bookings: { include: { addons: true, payments: true } } },
    });

    if (customer) {
      await Mailer.sendDataRequestExport(shop, "shopify", email, {
        customer: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          email: customer.email,
          phone: customer.phone,
          notes: customer.notes,
        },
        bookings: customer.bookings.map((b) => ({
          uid: b.uid,
          status: b.status,
          start_utc: b.startUtc,
          end_utc: b.endUtc,
          notes: b.notes,
          custom_fields: b.customFields,
          addons: b.addons.map((a) => ({ name: a.name, price: a.price })),
          payments: b.payments.map((p) => ({ gateway: p.gateway, amount: p.amount, status: p.status })),
        })),
      }).catch((err) => console.error(`[gdpr] data_request email failed for shop=${shop}:`, err));
    }

    console.log(
      `[gdpr] data_request shop=${shop} email=${email} customerFound=${Boolean(customer)} bookings=${customer?.bookings.length ?? 0}`
    );
  }

  return new Response();
};
