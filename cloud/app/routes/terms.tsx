import type { Route } from "./+types/terms";
import { LegalShell } from "~/components/ui";

export const meta: Route.MetaFunction = () => [
  { title: "Terms of Service · GetBooqin" },
  { name: "description", content: "Terms covering your use of the GetBooqin Cloud account dashboard." },
];

// See privacy.tsx's header comment — same scope split from
// shopify-openslot's /terms (the storefront booking widget's terms).
export async function loader({}: Route.LoaderArgs) {
  return {
    supportEmail: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM_EMAIL || "",
  };
}

export default function Terms({ loaderData }: Route.ComponentProps) {
  const { supportEmail } = loaderData;

  return (
    <LegalShell title="Terms of Service" updated="2026-08-29">
      <p>
        These terms cover your use of GetBooqin Cloud — the account dashboard at this site, where you sign up,
        connect a Shopify store, and manage bookings across it. If you're looking for the terms covering a
        merchant's end-customer booking widget, see{" "}
        <a href="/terms">the storefront terms of service</a> instead.
      </p>

      <h2>Your account</h2>
      <p>
        You're responsible for keeping your account credentials secure and for the accuracy of the business
        information, services, staff, and schedules you configure from the dashboard. One account can connect
        more than one store; each connected store remains governed by that store's own Shopify Merchant Terms
        of Service, which continue to apply alongside these.
      </p>

      <h2>The service</h2>
      <p>
        GetBooqin Cloud is offered on the plans described on our pricing page. We'll give notice before any
        change that affects your existing plan, including before introducing a charge where none applied
        before.
      </p>

      <h2>Connected stores</h2>
      <p>
        Connecting a store authorizes GetBooqin to read and write the booking configuration described in our{" "}
        <a href="/legal/privacy">Privacy Policy</a>. Disconnecting a store revokes that access; your account
        and any other connected stores are unaffected.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Don't use the dashboard to access another account's data, disrupt the service, or connect a store you
        don't have authority to manage. We may suspend or terminate an account that does.
      </p>

      <h2>Availability</h2>
      <p>
        We aim to keep GetBooqin Cloud available and reliable, but it's provided without warranty of
        uninterrupted availability. We're not liable for losses arising from downtime, bugs, or data loss
        beyond what's required by applicable law.
      </p>

      <h2>Termination</h2>
      <p>
        You can close your account at any time, which disconnects every store still linked to it. We may
        suspend or terminate an account that violates these terms or risks other accounts' data or the
        service's availability.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms as the product evolves. Material changes will be reflected here with an
        updated "Last updated" date; continued use of the dashboard after a change means you accept the
        updated terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: {" "}
        {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : "use the Support page"}.
      </p>
    </LegalShell>
  );
}
