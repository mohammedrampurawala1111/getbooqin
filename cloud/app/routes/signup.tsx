import { useState, type FormEvent } from "react";
import { redirect, useNavigate, useSearchParams } from "react-router";
import { useSignUp } from "@clerk/react-router/legacy";
import { isClerkAPIResponseError } from "@clerk/react-router/errors";
import type { Route } from "./+types/signup";
import { getUserSession } from "~/session.server";
import { Field, Input, GoogleIcon } from "~/components/ui";
import { PresetSelect } from "~/components/onboarding";
import type { PresetId } from "~/lib/presets";

// Best-effort handoff into the onboarding wizard (routes/onboarding.tsx) —
// there's no store yet to persist these to, so they ride in sessionStorage
// across both the password flow (this page navigates directly) and the
// Google flow (this page unloads for the OAuth redirect and sso-callback.tsx
// lands the browser back on /onboarding afterward).
const ONBOARDING_STORAGE_KEY = "gb_onboarding";

function stashOnboardingSeed(seed: { businessName: string; preset: PresetId; email: string; phone: string }) {
  try {
    sessionStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(seed));
  } catch {
    // ignored — same "best-effort" reasoning as saveProfilePhone below
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getUserSession(request);
  if (session) throw redirect("/dashboard");
  return null;
}

export default function Signup() {
  const { isLoaded, signUp, setActive } = useSignUp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [businessName, setBusinessName] = useState("");
  const [preset, setPreset] = useState<PresetId>((searchParams.get("preset") as PresetId) || "generic");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Best-effort — phone is a contact convenience for us, not part of the
  // account itself, so a failure here shouldn't block getting into the app.
  async function saveProfilePhone() {
    if (!phone) return;
    try {
      await fetch("/dashboard/profile-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
    } catch {
      // ignored — see comment above
    }
  }

  async function handleGoogle() {
    if (!isLoaded || submitting) return;
    setError(null);
    try {
      stashOnboardingSeed({ businessName, preset, email, phone });
      await signUp.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/onboarding?step=1",
      });
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "Couldn't start Google sign-in — try again.");
    }
  }

  async function handleSignup(event: FormEvent) {
    event.preventDefault();
    if (!isLoaded || submitting) return;
    if (!email || password.length < 8) {
      setError("Enter an email and a password of at least 8 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      stashOnboardingSeed({ businessName, preset, email, phone });
      const result = await signUp.create({ emailAddress: email, password });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        await saveProfilePhone();
        navigate("/onboarding?step=1");
      } else {
        // Clerk's default config requires verifying the email before the
        // account is active — show the code-entry step instead of failing.
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        setPendingVerification(true);
      }
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "That email is already registered.");
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
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        await saveProfilePhone();
        navigate("/onboarding?step=1");
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
    <div className="grid min-h-screen grid-cols-2">
      <div className="flex items-center justify-center bg-canvas px-8">
        <div className="card w-full max-w-[372px] p-[26px]">
          <span className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
            <span className="h-[6px] rounded-[2px] bg-brand-500" />
            <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
          </span>

          {!pendingVerification ? (
            <>
              <h1 className="page-title mt-4">Sign up</h1>
              {error && <div className="alert-error mt-3">{error}</div>}
              <button type="button" onClick={handleGoogle} className="btn-sec mt-5 justify-center gap-2">
                <GoogleIcon />
                Continue with Google
              </button>
              <div className="my-4 flex items-center gap-3 text-meta text-muted">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
              <form onSubmit={handleSignup} className="flex flex-col gap-[14px]">
                <Field label="Business name">
                  <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
                </Field>
                <PresetSelect defaultValue={preset} onChange={setPreset} />
                <Field label="Email">
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </Field>
                <Field label="Phone number (optional)" hint="For us to reach you — not verified.">
                  <Input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+919876543210"
                  />
                </Field>
                <Field label="Password" hint="At least 8 characters.">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </Field>
                <div id="clerk-captcha" />
                <button type="submit" className="btn-pri mt-1 justify-center" disabled={submitting}>
                  Create account
                </button>
              </form>
              <p className="mt-4 text-body text-muted">
                Already have an account? <a href="/login">Log in</a>
              </p>
            </>
          ) : (
            <>
              <h1 className="page-title mt-4">Check your email</h1>
              <p className="mt-2 text-body text-muted">We sent a verification code to {email}.</p>
              {error && <div className="alert-error mt-3">{error}</div>}
              <form onSubmit={handleVerify} className="mt-5 flex flex-col gap-[14px]">
                <Field label="Verification code">
                  <Input type="text" value={code} onChange={(e) => setCode(e.target.value)} required />
                </Field>
                <button type="submit" className="btn-pri mt-1 justify-center" disabled={submitting}>
                  Verify
                </button>
              </form>
            </>
          )}
        </div>
      </div>
      <div className="side-dark flex flex-col items-center justify-center gap-3 px-12 text-center">
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
