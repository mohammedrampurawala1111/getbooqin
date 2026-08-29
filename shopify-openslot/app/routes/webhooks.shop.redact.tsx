import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

/**
 * Mandatory GDPR webhook, sent ~48h after uninstall. Wipe everything
 * GetBooqin holds for this shop. Order matters: children before parents, so
 * required FKs (Booking -> ServiceConfig/Resource/Customer, ServiceResource ->
 * ServiceConfig/Resource, etc.) never get orphaned mid-transaction.
 * ProductCache has no dependents, so its position in the list doesn't matter.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  await prisma.$transaction([
    prisma.payment.deleteMany({ where: { shop } }),
    prisma.bookingAddon.deleteMany({ where: { shop } }),
    prisma.booking.deleteMany({ where: { shop } }),
    prisma.chatMessage.deleteMany({ where: { conversation: { shop } } }),
    prisma.chatConversation.deleteMany({ where: { shop } }),
    prisma.customer.deleteMany({ where: { shop } }),
    prisma.serviceAddon.deleteMany({ where: { shop } }),
    prisma.serviceResource.deleteMany({ where: { shop } }),
    prisma.addon.deleteMany({ where: { shop } }),
    prisma.serviceConfig.deleteMany({ where: { shop } }),
    prisma.productCache.deleteMany({ where: { shop } }),
    prisma.resource.deleteMany({ where: { shop } }),
    prisma.schedule.deleteMany({ where: { shop } }),
    prisma.timeOff.deleteMany({ where: { shop } }),
    prisma.faq.deleteMany({ where: { shop } }),
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
