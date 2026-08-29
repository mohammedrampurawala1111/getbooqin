import { useLoaderData } from "react-router";

/**
 * Public, unauthenticated page — this is the URL to paste into the Partner
 * Dashboard listing's "Privacy policy" field. Kept as a plain server-rendered
 * page (same style as _index.tsx) rather than a static file so the contact
 * address stays in sync with SUPPORT_EMAIL instead of being hand-edited in
 * two places.
 */
export async function loader() {
  return {
    supportEmail: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM_EMAIL || "",
  };
}

export default function Privacy() {
  const { supportEmail } = useLoaderData<typeof loader>();

  return (
    <div style={{ fontFamily: "sans-serif", padding: "3rem", maxWidth: 720, margin: "0 auto", lineHeight: 1.6 }}>
      <h1>GetBooqin (GetBooqin) — Privacy Policy</h1>
      <p>Last updated: 2026-08-23</p>

      <h2>What this app does</h2>
      <p>
        GetBooqin is a Shopify app that lets a merchant's customers book appointments through their storefront.
        This policy covers the data GetBooqin collects and stores on the merchant's behalf while providing that
        booking service.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>From customers booking an appointment:</strong> first and last name, email address, phone
          number (where required), any notes or custom fields entered on the booking form, and the details of
          the appointment itself (service, staff member, date/time).
        </li>
        <li>
          <strong>Payment status:</strong> if a merchant enables online payments, we store the payment status,
          amount, currency, and the payment gateway's own transaction ID — never full card numbers, which are
          handled directly by the payment gateway (e.g. Stripe, Razorpay) and never pass through our servers.
        </li>
        <li>
          <strong>From the merchant:</strong> the shop's domain and the store data needed to run the app
          (services, staff, schedules, settings).
        </li>
      </ul>

      <h2>Why we collect it</h2>
      <p>
        Solely to operate the booking feature: to create and manage appointments, send confirmation/reminder
        emails, process payments where enabled, and let a customer look up or cancel their own booking.
      </p>

      <h2>Where it's stored and who can see it</h2>
      <p>
        Data is stored in our own database, scoped to the merchant's shop — one merchant's booking data is
        never visible to another. It is shared only with the services required to deliver the booking itself:
        the merchant's chosen payment gateway (for payment processing) and our transactional email provider
        (to send booking confirmations and reminders). We do not sell or share this data for advertising or
        any other purpose.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Booking and customer data is kept for as long as the app is installed on the merchant's store, so the
        merchant can see their booking history. If the merchant uninstalls the app, all of that shop's data is
        deleted. A customer can also ask the merchant to have their personal data corrected or erased at any
        time — the merchant can action this through Shopify, which we fulfil automatically via Shopify's
        standard customer data-request and redaction webhooks.
      </p>

      <h2>Your rights</h2>
      <p>
        If you're a customer of a store using GetBooqin and want a copy of your data or want it deleted, contact
        that store directly — they control your data as the merchant. If you're unable to reach them, you can
        contact us at the address below and we'll assist.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or how GetBooqin handles data:{" "}
        {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : "contact us via the Shopify App Store listing"}.
      </p>

      <p>See also our <a href="/terms">Terms of Service</a>.</p>
    </div>
  );
}
