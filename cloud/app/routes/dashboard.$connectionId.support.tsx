import type { Route } from "./+types/dashboard.$connectionId.support";
import { PageHeader } from "~/components/ui";

// The public /support (LegalShell, no auth) stays as the marketing-footer /
// terms-and-privacy-cross-link version for signed-out visitors. This is the
// same content re-homed for someone already inside the dashboard — clicking
// "Help & support" in the sidebar used to drop you onto that public,
// unauthenticated-looking page (same "different view" bug Account had), and
// its copy pointed you to log in when you're already signed in and its
// links weren't aware of which store you were looking at.
export const meta: Route.MetaFunction = () => [{ title: "Support · GetBooqin" }];

export async function loader({}: Route.LoaderArgs) {
  return {
    supportEmail: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM_EMAIL || "",
  };
}

export default function Support({ loaderData, params }: Route.ComponentProps) {
  const { supportEmail } = loaderData;
  const base = `/dashboard/${params.connectionId}`;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Help & support" />
      <div className="card">
        <div className="card-body flex flex-col gap-4 text-body text-ink-3">
          <p className="m-0">
            Need help with your GetBooqin Cloud account, this store, or billing? We're happy to help.
          </p>

          {supportEmail ? (
            <p className="m-0">
              Email us at <a href={`mailto:${supportEmail}`}>{supportEmail}</a> and we'll get back to you.
            </p>
          ) : (
            <p className="m-0">Reach us through the contact details on your account confirmation email.</p>
          )}

          <div>
            <h2 className="mb-2 mt-0 text-card font-semibold text-ink">Common questions</h2>
            <ul className="m-0 flex flex-col gap-3 pl-5">
              <li>
                <strong className="text-ink">Need to connect or disconnect a Shopify store?</strong>{" "}
                That lives under <a href={`${base}/settings?page=integrations`}>Settings → Integrations</a>.
              </li>
              <li>
                <strong className="text-ink">Want to switch your industry template?</strong>{" "}
                <a href={`${base}/account`}>Account → Profile</a> shows your current one with a link to
                change it.
              </li>
              <li>
                <strong className="text-ink">Want to change your password?</strong>{" "}
                <a href={`${base}/account?tab=security`}>Account → Password &amp; security</a> handles that,
                plus your linked sign-in methods and active sessions.
              </li>
            </ul>
          </div>

          <p className="m-0">
            For anything else, or if something looks broken, email us and describe what you were trying to
            do — that's the fastest way for us to help.
          </p>
        </div>
      </div>
    </div>
  );
}
