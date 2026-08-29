import type { Route } from "./+types/privacy";
import { LegalShell } from "~/components/ui";

export const meta: Route.MetaFunction = () => [
  { title: "Privacy Policy · GetBooqin" },
  { name: "description", content: "How GetBooqin Cloud collects, stores and uses your account data." },
];

// Public, unauthenticated page — covers the Cloud *account* surface (Clerk
// login, connected-store credentials, dashboard usage). Distinct in scope
// from shopify-openslot's /privacy, which covers the booking widget's
// end-customer data on a merchant's storefront; the two link to each other
// below rather than duplicating content.
export async function loader({}: Route.LoaderArgs) {
  return {
    supportEmail: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM_EMAIL || "",
  };
}

export default function Privacy({ loaderData }: Route.ComponentProps) {
  const { supportEmail } = loaderData;

  return (
    <LegalShell title="Privacy Policy" updated="2026-08-29">
      <p>
        This policy covers GetBooqin Cloud — the account dashboard at this site, where a business signs up,
        connects a Shopify store, and manages bookings across it. If you're a customer booking an appointment
        through a merchant's storefront, that data is covered by the merchant's own booking widget policy
        instead — see <a href="/privacy">the storefront privacy policy</a>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account data:</strong> name, email address, and (if you set one) job title and phone number.
          Sign-in itself — password, or your linked Google account — is handled by our identity provider,
          Clerk; we never see or store your password.
        </li>
        <li>
          <strong>Connected store data:</strong> when you connect a Shopify store, we store an encrypted
          access token for that store, its domain, and the booking configuration (services, staff, schedules,
          settings) you manage from this dashboard.
        </li>
        <li>
          <strong>Usage data:</strong> basic activity needed to run the dashboard itself — session activity,
          and which industry template and Overview cards you've chosen.
        </li>
      </ul>

      <h2>Why we collect it</h2>
      <p>
        Solely to run the account and dashboard: authenticate you, keep your connected store(s) in sync, and
        show you the booking activity happening on them.
      </p>

      <h2>Where it's stored and who can see it</h2>
      <p>
        Account data is stored with Clerk, our identity provider, under their own privacy policy. Everything
        else lives in our database, scoped to your account — never visible to another business's account. We
        share data only with what's required to deliver the service: Clerk (identity), Shopify (the store
        connection itself), and your chosen payment gateway if you enable online payments. We do not sell or
        share your data for advertising.
      </p>

      <h2>How long we keep it</h2>
      <p>
        For as long as your account exists. Disconnecting a store deletes that store's encrypted credentials;
        deleting your account removes your account data and disconnects every store still linked to it.
      </p>

      <h2>Your rights</h2>
      <p>
        You can update or remove most of this yourself from Account → Profile, or request a copy or full
        deletion by contacting us below.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: {" "}
        {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : "use the Support page"}.{" "}
        See also our <a href="/legal/terms">Terms of Service</a>.
      </p>
    </LegalShell>
  );
}
