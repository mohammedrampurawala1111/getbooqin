# GetBooqin for Shopify

Appointments, online payments, video calls and a scripted chat widget — for
any Shopify storefront. This is a Shopify port of the
[GetBooqin WordPress plugin](../getbooqin): same data model, same booking
engine, same payment/video/chat architecture, rebuilt as a Shopify app
(React Router + Prisma, embedded admin, Theme App Extension for the
storefront widgets).

A resource (staff member, room, bay, table…) delivers a service to a
customer inside a booking. An industry preset only changes the words shown
in the interface — it never changes the schema.

## Quick start

```sh
npm install
cp .env.example .env      # fill in DATABASE_URL, CRON_SECRET, SMTP_*
npx prisma migrate dev
npm run dev                # shopify app dev — tunnels + installs on a dev store
```

Then, in the dev store's theme editor: add the **GetBooqin Booking** app block
to a page for a general booking page, and/or link a service to a product
under Services in the embedded admin and either add the **GetBooqin Button**
app block to the product template (e.g. right below Buy it now, exact
placement) or turn on the **GetBooqin Floating Button** app embed (Theme
editor → App embeds, zero per-page setup, always floats) to get a "Book
now" button on that product's page. Configure the app under **Settings** in
the embedded admin. (The chat widget is disabled for the v1 App Store
submission — see `ENABLE_CHAT` below.)

See [DEVELOPERS.md](./DEVELOPERS.md) for the full architecture, the data
model, the event system, the public API, and how to add a payment gateway or
video provider.
