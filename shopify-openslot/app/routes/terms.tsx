import { useLoaderData } from "react-router";

/**
 * Public, unauthenticated page — same rationale as privacy.tsx: server-rendered
 * rather than a static file so the contact address stays in sync with
 * SUPPORT_EMAIL instead of being hand-edited in two places. Not a Shopify
 * App Store hard requirement, but standard practice alongside the privacy
 * page and worth having before launch.
 */
export async function loader() {
  return {
    supportEmail: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM_EMAIL || "",
  };
}

export default function Terms() {
  const { supportEmail } = useLoaderData<typeof loader>();

  return (
    <div style={{ fontFamily: "sans-serif", padding: "3rem", maxWidth: 720, margin: "0 auto", lineHeight: 1.6 }}>
      <h1>GetBooqin — Terms of Service</h1>
      <p>Last updated: 2026-08-23</p>

      <h2>What these terms cover</h2>
      <p>
        GetBooqin is a Shopify app that lets a merchant's customers book appointments through their storefront.
        These terms govern a merchant's use of the app after installing it from the Shopify App Store. They sit
        alongside, not instead of, Shopify's own Merchant Terms of Service and Acceptable Use Policy, which
        continue to apply to the merchant's store.
      </p>

      <h2>The service</h2>
      <p>
        GetBooqin is provided on a Free listing during this launch — see the App Store listing for current
        pricing. We may change what the free plan includes going forward, and we'll give notice before any
        change that affects an installed merchant, including before introducing any paid plan (which requires
        the merchant's approval through Shopify's billing consent flow before any charge takes effect).
      </p>

      <h2>Merchant responsibilities</h2>
      <ul>
        <li>The merchant is responsible for the accuracy of the services, pricing, staff, and schedules they configure in the app.</li>
        <li>The merchant is responsible for their own compliance obligations toward their customers — for example, obtaining any consent required to collect a customer's name, email, or phone number through the booking form.</li>
        <li>Where the merchant enables online payments, the payment itself is processed by the merchant's chosen gateway (e.g. Stripe, Razorpay) under that gateway's own terms — GetBooqin never receives or stores full card details.</li>
      </ul>

      <h2>Data</h2>
      <p>
        How GetBooqin collects, uses, and retains data is described in full in our{" "}
        <a href="/privacy">Privacy Policy</a>. Uninstalling the app deletes the merchant's data as described
        there.
      </p>

      <h2>Availability</h2>
      <p>
        We aim to keep GetBooqin available and reliable, but the service is provided without warranty of
        uninterrupted availability. We are not liable for losses arising from downtime, bugs, or data loss
        beyond what's required by applicable law.
      </p>

      <h2>Termination</h2>
      <p>
        A merchant can stop using GetBooqin at any time by uninstalling it from their Shopify admin. We may
        suspend or terminate access for a store that violates these terms, Shopify's own policies, or uses the
        app in a way that risks other merchants' data or service availability.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms as the app evolves. Material changes will be reflected here with an updated
        "Last updated" date; continued use of the app after a change means the merchant accepts the updated
        terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms:{" "}
        {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : "contact us via the Shopify App Store listing"}.
      </p>
    </div>
  );
}
