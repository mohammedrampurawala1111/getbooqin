import type { Route } from "./+types/support";
import { LegalShell } from "~/components/ui";

export const meta: Route.MetaFunction = () => [
  { title: "Support · GetBooqin" },
  { name: "description", content: "Get help with your GetBooqin Cloud account, connected store, or billing." },
];

export async function loader({}: Route.LoaderArgs) {
  return {
    supportEmail: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM_EMAIL || "",
  };
}

export default function Support({ loaderData }: Route.ComponentProps) {
  const { supportEmail } = loaderData;

  return (
    <LegalShell title="Support">
      <p>
        Need help with your GetBooqin Cloud account, a connected store, or billing? We're happy to help.
      </p>

      {supportEmail ? (
        <p>
          Email us at <a href={`mailto:${supportEmail}`}>{supportEmail}</a> and we'll get back to you.
        </p>
      ) : (
        <p>Reach us through the contact details on your account confirmation email.</p>
      )}

      <h2>Common questions</h2>
      <ul>
        <li>
          <strong>Forgot your password?</strong> Use{" "}
          <a href="/forgot-password">the reset link on the login page</a> — you'll get a one-time code by
          email.
        </li>
        <li>
          <strong>Need to connect or disconnect a Shopify store?</strong> That lives under Settings →
          Integrations once you're{" "}
          <a href="/login">logged in</a>.
        </li>
        <li>
          <strong>Want to switch your industry template?</strong> Account → Profile shows your current one
          with a link to change it.
        </li>
      </ul>

      <p>
        For anything else, or if something looks broken, email us and describe what you were trying to do —
        that's the fastest way for us to help.
      </p>
    </LegalShell>
  );
}
