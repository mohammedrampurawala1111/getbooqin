import prisma from "./src/db.js";
import { connectShopifyStore } from "./src/connections.js";
import * as Data from "./src/booking/data.js";

// User.id is now Clerk's own user id — pass a real one (from a Clerk test
// account created via /signup, or the Clerk dashboard) as argv[2] to log in
// as this seeded user through the actual app; the placeholder below is only
// good for exercising the Data.* calls directly against the DB.
async function main() {
  const userId = process.argv[2] ?? "user_local_seed_placeholder";
  const user = await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, email: "you@example.com" },
    update: {},
  });
  const connection = await connectShopifyStore({
    userId: user.id,
    shop: "test-shop.myshopify.com",
    accessToken: "fake-token-for-local-testing",
  });
  await Data.upsertProductCache("test-shop.myshopify.com", "shopify", {
    productId: "1",
    productHandle: "haircut",
    title: "Haircut",
    price: 50,
    category: "Service",
  });
  await Data.saveServiceConfig("test-shop.myshopify.com", "shopify", {
    product_id: "1",
    product_handle: "haircut",
    duration_min: 30,
  });
  console.log("Seeded user id:", user.id, "connection id:", connection.id);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
