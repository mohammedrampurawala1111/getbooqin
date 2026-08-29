-- The production database predates the core/ split: it was created by
-- shopify-openslot's own (now-retired) prisma/schema.prisma, which has a
-- different shape for every table below (no `platform` column, `Service`
-- instead of `ServiceConfig`, no User/Connection). Confirmed empty/
-- disposable (pre-launch, test data only) by the app owner before this
-- migration was written — this is a clean-slate drop, not a backfill.
-- CASCADE handles FK order between them; IF EXISTS makes this a no-op on
-- a database that never had the legacy schema (e.g. a fresh dev database).
DROP TABLE IF EXISTS "BookingAddon" CASCADE;
DROP TABLE IF EXISTS "Payment" CASCADE;
DROP TABLE IF EXISTS "ChatMessage" CASCADE;
DROP TABLE IF EXISTS "ChatConversation" CASCADE;
DROP TABLE IF EXISTS "Booking" CASCADE;
DROP TABLE IF EXISTS "ServiceAddon" CASCADE;
DROP TABLE IF EXISTS "ServiceResource" CASCADE;
DROP TABLE IF EXISTS "ServiceProduct" CASCADE;
DROP TABLE IF EXISTS "Schedule" CASCADE;
DROP TABLE IF EXISTS "TimeOff" CASCADE;
DROP TABLE IF EXISTS "Customer" CASCADE;
DROP TABLE IF EXISTS "Addon" CASCADE;
DROP TABLE IF EXISTS "Resource" CASCADE;
DROP TABLE IF EXISTS "Service" CASCADE;
DROP TABLE IF EXISTS "Faq" CASCADE;
DROP TABLE IF EXISTS "Session" CASCADE;
DROP TABLE IF EXISTS "ShopSettings" CASCADE;
