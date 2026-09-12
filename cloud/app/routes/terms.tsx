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
    <LegalShell title="Terms of Service" updated="2026-09-12">
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

      <h2>Plans, trials and billing</h2>
      <p>
        New accounts start on a free trial of a paid plan. No payment details are required to begin, and the
        trial length and end date are shown in your dashboard under Settings → Billing from the day you sign
        up.
      </p>
      <p>
        When a trial ends without an upgrade, the account moves to the Free plan. <strong>Nothing is
        deleted.</strong> Your bookings, customers and settings all remain, and your public booking page keeps
        working; what changes is that the Free plan's limits apply, so you may not be able to add new items
        above them until you upgrade. If you were already above a limit when your plan changed, existing
        items keep working — only creating new ones is blocked.
      </p>
      <p>
        Paid plans are billed in advance, monthly or yearly, in the currency shown at checkout, and renew
        automatically at the end of each period until cancelled. Payments are processed by Razorpay; we don't
        store your card or mandate details.
      </p>

      <h2>Tax</h2>
      <p>
        GetBooqin is sold by a company registered in India. Prices shown include any tax that applies.
      </p>
      <p>
        <strong>If your business is in India</strong>, Indian GST applies. You can add your GSTIN at checkout
        if you want to claim input credit; it's optional, and you don't need one to subscribe.
      </p>
      <p>
        <strong>If your business is outside India</strong>, the sale is a zero-rated export of services. We
        sell only to registered businesses outside India, so we ask for your VAT or business tax number at
        checkout and can't complete a subscription without one. If you're in the EU, the reverse charge
        applies and the VAT is yours to account for, not ours — your tax number is what evidences that.
      </p>
      <p>
        We'll give at least 30 days' notice before increasing the price of a plan you're already on. A price
        increase takes effect at your next renewal, and you can cancel before then.
      </p>

      <h2>Cancelling, and refunds</h2>
      <p>
        You can cancel at any time from Settings → Billing. Cancellation stops the next renewal; it does not
        end your plan immediately. <strong>You keep the plan you've paid for until the end of the period
        you've already paid for</strong>, after which the account moves to Free on the same terms as a trial
        ending.
      </p>
      <p>
        Because access continues for the full period already paid for, part-used periods are not refunded by
        default. If something has gone wrong — you were charged after cancelling, charged twice, or the
        service was materially unavailable for a sustained period — contact us and we'll put it right. Nothing
        here limits any refund or cancellation right you have under consumer law in your country, which
        applies regardless of this section.
      </p>
      <p>
        If a renewal payment fails, we'll email you and your plan stays fully active for a short grace period
        while the payment is retried. If it hasn't succeeded by the end of that period, the account moves to
        Free — again, without anything being deleted. Paying at any point restores the plan immediately.
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

      <h2>Closing your account, and deleting your data</h2>
      <p>
        You can delete your account at any time from Settings → Account. Deleting it cancels any active
        subscription first, then permanently removes every business you own and the data in it — your
        bookings, your customers' records, your services, staff and schedules, and your settings. This is
        immediate and cannot be undone; we don't keep a copy for you to restore.
      </p>
      <p>
        Two things deliberately survive: records of payments actually taken, which we're required to retain
        for tax and dispute purposes and which no longer identify you, and our internal log of any
        administrative action taken on the account. Neither contains your bookings or your customers' details.
      </p>
      <p>
        If a business you own still has other team members on it, you'll be asked to remove them or hand the
        business over before your account can be deleted, so that deleting your account never destroys a
        working business someone else is relying on.
      </p>
      <p>
        We may suspend or terminate an account that violates these terms or risks other accounts' data or the
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
