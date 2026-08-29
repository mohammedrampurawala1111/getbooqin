import { useEffect, useState, type FormEvent } from "react";
import { redirect, useNavigate, useSearchParams } from "react-router";
import { useSignUp } from "@clerk/react-router/legacy";
import { isClerkAPIResponseError } from "@clerk/react-router/errors";
import type { Route } from "./+types/signup";
import { getUserSession } from "~/session.server";
import { AlertError, Field, Input, GoogleIcon } from "~/components/ui";
import { PresetSelect } from "~/components/onboarding";
import { PHONE_PATTERN } from "~/lib/validation";
import type { PresetId } from "~/lib/presets";

export const meta: Route.MetaFunction = () => [
  { title: "Sign up · GetBooqin" },
  { name: "description", content: "Create your GetBooqin account and start taking bookings in minutes." },
];

// Clerk's own minimum — the "At least 8 characters" hint below used to
// undersell this, so a 12-character password would pass client-side and
// then bounce with a 422 from Clerk (UX audit's B4 finding).
const MIN_PASSWORD_LENGTH = 15;

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
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

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
    if (!email || password.length < MIN_PASSWORD_LENGTH) {
      setError(`Enter an email and a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!agreed) {
      setError("Agree to the Terms of Service and Privacy Policy to continue.");
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

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  // No way back from the code screen used to exist at all (UX audit's P5
  // finding) — a code that never arrives, or a typo'd email, meant
  // starting over from scratch.
  async function handleResend() {
    if (!isLoaded || resendCooldown > 0) return;
    setError(null);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setResendCooldown(30);
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "Couldn't resend the code — try again.");
    }
  }

  function handleChangeEmail() {
    setPendingVerification(false);
    setError(null);
    setCode("");
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
    <div className="grid min-h-screen grid-cols-1 md:h-screen md:grid-cols-2">
      <div className="flex items-center justify-center bg-canvas px-8 py-10 md:overflow-y-auto">
        <div className="card w-full max-w-[372px] p-[26px]">
          <a href="/" className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
            <span className="h-[6px] rounded-[2px] bg-brand-500" />
            <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
          </a>

          {!pendingVerification ? (
            <>
              <h1 className="page-title mt-4">Sign up</h1>
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
              <form onSubmit={handleSignup} className="flex flex-col gap-[14px]">
                <Field label="Business name">
                  <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required autoComplete="organization" />
                </Field>
                <PresetSelect defaultValue={preset} onChange={setPreset} />
                <Field label="Email">
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
                </Field>
                <Field label="Phone number (optional)" hint="For us to reach you — not verified.">
                  <Input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 555 0100"
                    pattern={PHONE_PATTERN}
                    autoComplete="tel"
                  />
                </Field>
                <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={MIN_PASSWORD_LENGTH}
                      autoComplete="new-password"
                      className="pr-[64px]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="btn-link absolute right-[10px] top-1/2 -translate-y-1/2"
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </Field>
                <label className="flex cursor-pointer items-start gap-[8px] text-meta text-ink-2">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-[2px] h-[14px] w-[14px] accent-brand-600"
                    required
                  />
                  <span>
                    I agree to the <a href="/legal/terms" target="_blank" rel="noreferrer">Terms of Service</a> and{" "}
                    <a href="/legal/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
                  </span>
                </label>
                <div id="clerk-captcha" />
                <button type="submit" className="btn-pri mt-1 w-full justify-center" disabled={submitting}>
                  {submitting ? "Creating account…" : "Create account"}
                </button>
              </form>
              <p className="mt-4 text-body text-muted">
                Already have an account? <a href="/login">Log in</a>
              </p>
            </>
          ) : (
            <>
              <h1 className="page-title mt-4">Check your email</h1>
              <p className="mt-2 text-body text-muted">
                We sent a verification code to {email}.{" "}
                <button type="button" onClick={handleChangeEmail} className="btn-link">Wrong address?</button>
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
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resendCooldown > 0}
                  className="btn-link self-center"
                >
                  {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
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
