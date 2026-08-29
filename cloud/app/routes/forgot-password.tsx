import { useState, type FormEvent } from "react";
import { redirect, useNavigate } from "react-router";
import { useSignIn } from "@clerk/react-router/legacy";
import { isClerkAPIResponseError } from "@clerk/react-router/errors";
import type { Route } from "./+types/forgot-password";
import { getUserSession } from "~/session.server";
import { AlertError, Field, Input } from "~/components/ui";
import { PasswordField } from "~/components/account";

export const meta: Route.MetaFunction = () => [{ title: "Reset your password · GetBooqin" }];

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getUserSession(request);
  if (session) throw redirect("/dashboard");
  return null;
}

// Same account-enumeration concern as login.tsx's V6 fix — "we couldn't
// find that account" vs a generic "check your email" tells an attacker
// which addresses are registered.
function neutralRequestError(err: unknown): string {
  if (!isClerkAPIResponseError(err)) return "If an account exists for that email, we've sent a code.";
  const code = err.errors[0]?.code;
  if (code === "form_identifier_not_found") return "If an account exists for that email, we've sent a code.";
  return err.errors[0]?.longMessage ?? err.errors[0]?.message ?? "Couldn't send a reset code — try again.";
}

// Single centred card, both steps on the same route (never a redirect) so
// step two's copy can name the address the code went to. Uses Clerk's
// reset_password_email_code strategy — an in-page code, like signup.tsx's
// verification step, not the "confirmation link" the design copy called
// for, to keep the same pattern as the rest of this app's Clerk flows.
export default function ForgotPassword() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"request" | "reset">("request");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleRequest(event: FormEvent) {
    event.preventDefault();
    if (!isLoaded || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn.create({ strategy: "reset_password_email_code", identifier: email });
      setStep("reset");
    } catch (err) {
      // An unknown email used to surface its own error and stay on this
      // screen, while a known one moved on to the code step — that
      // difference is itself an account-enumeration oracle even with a
      // neutral message (UX audit's V6 finding), so route both cases the
      // same way: advance to "reset" regardless. A code was never sent for
      // an unknown address, so any code entered there fails exactly like a
      // mistyped one — no new information leaks.
      const code = isClerkAPIResponseError(err) ? err.errors[0]?.code : undefined;
      if (code === "form_identifier_not_found") {
        setStep("reset");
      } else {
        setError(neutralRequestError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  // "wrong address" here quietly retries handleRequest (rather than just
  // clearing state) since form_identifier_not_found is now routed to this
  // same step (see handleRequest's comment) — going back to "request"
  // wouldn't recreate the sent code for a real fix-a-typo case.
  function handleChangeEmail() {
    setStep("request");
    setError(null);
  }

  async function handleReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || submitting) return;
    const form = new FormData(event.currentTarget);
    const code = String(form.get("code") ?? "");
    const password = String(form.get("password") ?? "");
    setSubmitting(true);
    setError(null);
    try {
      await signIn.attemptFirstFactor({ strategy: "reset_password_email_code", code });
      const result = await signIn.resetPassword({ password, signOutOfOtherSessions: true });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        navigate("/dashboard");
      } else {
        setError("That code didn't work — check it and try again.");
      }
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "That code didn't work — check it and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-8">
      <div className="card w-full max-w-[372px] p-[26px]">
        <a href="/" className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
          <span className="h-[6px] rounded-[2px] bg-brand-500" />
          <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
        </a>

        {step === "request" ? (
          <>
            <h1 className="page-title mt-4">Reset your password</h1>
            <p className="mt-2 text-body text-muted">Enter your email and we'll send you a code to reset it.</p>
            {error && <AlertError className="mt-3">{error}</AlertError>}
            <form onSubmit={handleRequest} className="mt-5 flex flex-col gap-[14px]">
              <Field label="Email">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              </Field>
              <button type="submit" className="btn-pri w-full justify-center" disabled={submitting}>
                {submitting ? "Sending…" : "Send reset code"}
              </button>
            </form>
            <p className="mt-4 text-body text-muted">
              Signed up with Google? Google accounts don't have a GetBooqin password — use{" "}
              <a href="/login">Continue with Google</a> on the login page instead.
            </p>
          </>
        ) : (
          <>
            <h1 className="page-title mt-4">Check your email</h1>
            <p className="mt-2 text-body text-muted">
              If an account exists for {email}, we've sent it a reset code.{" "}
              <button type="button" onClick={handleChangeEmail} className="btn-link">Wrong address?</button>
            </p>
            {error && <AlertError className="mt-3">{error}</AlertError>}
            <form onSubmit={handleReset} className="mt-5 flex flex-col gap-[14px]">
              <Field label="Reset code">
                <Input name="code" required inputMode="numeric" maxLength={6} />
              </Field>
              <PasswordField name="password" label="New password" hint="At least 15 characters." minLength={15} autoComplete="new-password" />
              <button type="submit" className="btn-pri w-full justify-center" disabled={submitting}>
                {submitting ? "Resetting…" : "Reset password"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
