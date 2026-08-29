import { useState, type FormEvent } from "react";
import { redirect, useNavigate } from "react-router";
import { useSignIn } from "@clerk/react-router/legacy";
import { isClerkAPIResponseError } from "@clerk/react-router/errors";
import type { Route } from "./+types/login";
import { getUserSession } from "~/session.server";
import { AlertError, Field, Input, GoogleIcon } from "~/components/ui";
import { LoginOptions } from "~/components/account";

export const meta: Route.MetaFunction = () => [{ title: "Log in · GetBooqin" }];

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getUserSession(request);
  if (session) throw redirect("/dashboard");
  return null;
}

// One message for "no such account" and "wrong password" alike — Clerk's
// own error codes distinguish them (form_identifier_not_found vs
// form_password_incorrect), which is exactly the free account-enumeration
// oracle the UX audit's V6 finding flagged: an attacker with a list of
// emails can tell which ones have GetBooqin accounts just by watching
// which message comes back.
const ENUMERATION_CODES = new Set(["form_identifier_not_found", "form_password_incorrect"]);

function loginErrorMessage(err: unknown): string {
  if (!isClerkAPIResponseError(err)) return "Incorrect email or password.";
  const clerkErr = err.errors[0];
  if (clerkErr && ENUMERATION_CODES.has(clerkErr.code)) return "Incorrect email or password.";
  return clerkErr?.longMessage ?? clerkErr?.message ?? "Incorrect email or password.";
}

export default function Login() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set once Clerk comes back with needs_second_factor/needs_client_trust —
  // found by testing this flow end-to-end: a first-ever sign-in from a new
  // browser/device hits Clerk's Device Trust check, and without handling
  // it the app fell through to "Couldn't log in — check your email and
  // password," a dead end with correct credentials and no way forward.
  const [needsVerification, setNeedsVerification] = useState(false);

  async function handleGoogle() {
    if (!isLoaded || submitting) return;
    setError(null);
    try {
      // Full-page redirect to Google — the browser leaves this page, so
      // there's no session/navigate call here; sso-callback.tsx handles
      // completion when Google redirects back.
      await signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/dashboard",
      });
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "Couldn't start Google sign-in — try again.");
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isLoaded || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await signIn.create({ strategy: "password", identifier: email, password });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        navigate("/dashboard");
      } else if (result.status === "needs_second_factor" || result.status === "needs_client_trust") {
        const strategy = result.supportedSecondFactors?.[0]?.strategy;
        if (strategy === "email_code") {
          await signIn.prepareSecondFactor({ strategy: "email_code" });
          setNeedsVerification(true);
        } else {
          setError("This account needs a verification step this page doesn't support yet — contact support.");
        }
      } else {
        setError("Couldn't log in — check your email and password.");
      }
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(event: FormEvent) {
    event.preventDefault();
    if (!isLoaded || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await signIn.attemptSecondFactor({ strategy: "email_code", code });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        navigate("/dashboard");
      } else {
        setError("That code didn't work — check it and try again.");
      }
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen grid-cols-1 md:h-screen md:grid-cols-2">
      <div className="flex items-center justify-center bg-canvas px-8 py-10 md:overflow-y-auto">
        <div className="card w-full max-w-[372px] p-[26px]">
          <a href="/" className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
            <span className="h-[6px] rounded-[2px] bg-brand-500" />
            <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
          </a>
          {!needsVerification ? (
            <>
              <h1 className="page-title mt-4">Log in</h1>
              {error && <AlertError className="mt-3">{error}</AlertError>}
              <button type="button" onClick={handleGoogle} className="btn-sec mt-5 w-full justify-center gap-2 py-[10px]">
                <GoogleIcon />
                Continue with Google
              </button>
              <div className="my-4 flex items-center gap-3 text-meta text-muted">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
              <form onSubmit={handleSubmit} className="flex flex-col gap-[14px]">
                <Field label="Email">
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                </Field>
                <LoginOptions />
                <button type="submit" className="btn-pri mt-1 w-full justify-center" disabled={submitting}>
                  {submitting ? "Logging in…" : "Log in"}
                </button>
              </form>
              <p className="mt-4 text-body text-muted">
                Need an account? <a href="/signup">Sign up</a>
              </p>
            </>
          ) : (
            <>
              <h1 className="page-title mt-4">Verify it's you</h1>
              <p className="mt-2 text-body text-muted">
                New device — we sent a code to {email} to confirm it's really you.
              </p>
              {error && <AlertError className="mt-3">{error}</AlertError>}
              <form onSubmit={handleVerify} className="mt-5 flex flex-col gap-[14px]">
                <Field label="Verification code">
                  <Input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                </Field>
                <button type="submit" className="btn-pri mt-1 w-full justify-center" disabled={submitting}>
                  {submitting ? "Verifying…" : "Verify"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
      <div className="side-dark hidden flex-col items-center justify-center gap-3 px-12 text-center md:flex">
        <span className="flex h-[44px] w-[44px] shrink-0 flex-col justify-center gap-[4px] rounded-[10px] bg-brand-950 p-[8px]">
          <span className="h-[7px] rounded-[2px] bg-brand-500" />
          <span className="h-[7px] rounded-[2px] border-[1.5px] border-brand-500" />
        </span>
        <h2 className="m-0 text-[20px] font-semibold">GetBooqin Cloud</h2>
        <p className="m-0 max-w-[320px] text-[13.5px] text-[#a49caf]">
          Manage bookings, staff schedules, and services for every store you connect — all from one dashboard.
        </p>
      </div>
    </div>
  );
}
