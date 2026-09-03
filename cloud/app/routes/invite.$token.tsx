import { useEffect, useState, type FormEvent } from "react";
import { data, useNavigate, useParams } from "react-router";
import { useClerk } from "@clerk/react-router";
import { useSignUp, useSignIn } from "@clerk/react-router/legacy";
import { isClerkAPIResponseError } from "@clerk/react-router/errors";
import type { Route } from "./+types/invite.$token";
import { Team, Settings, isGetBooqinError } from "getbooqin-core";
import { getUserSession, getClerkClient, ensureUserRow } from "~/session.server";
import { AlertError, Field, Input, GoogleIcon } from "~/components/ui";
import { RoleBadge, InviteStatusCard, type Role } from "~/components/settings";

export const meta: Route.MetaFunction = () => [{ title: "You're invited · GetBooqin" }];

// Same minimum as signup.tsx — Clerk's own floor, kept in sync so the hint
// here never undersells what Clerk will actually accept.
const MIN_PASSWORD_LENGTH = 15;

type LoaderResult =
  | { screen: "invalid" }
  | { screen: "expired"; businessName: string }
  | { screen: "revoked"; businessName: string }
  | { screen: "used"; businessName: string }
  | { screen: "wrong-account"; businessName: string; invitedEmail: string; currentEmail: string }
  | { screen: "signed-out"; businessName: string; invitedEmail: string; role: Role }
  | { screen: "accepted"; businessName: string; role: Role; connectionId: string };

async function resolveBusinessName(shop: string, platform: string): Promise<string> {
  const settings = await Settings.getSettings(shop, platform);
  return settings.business_name && settings.business_name !== shop ? settings.business_name : shop;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const token = params.token ?? "";
  // Looked up by the presented token string itself (Team.getInviteByToken
  // -> ConnectionInvite.findUnique on `token`) — a resend rotates this
  // column, so a stale, previously-emailed link simply matches no row
  // anymore. No signature/payload decoding involved (see team.ts).
  const invite = token ? await Team.getInviteByToken(token) : null;
  if (!invite) {
    return data<LoaderResult>({ screen: "invalid" }, { status: 404 });
  }

  const state = Team.inviteState(invite);
  if (state !== "pending") {
    const businessName = await resolveBusinessName(invite.connection.shop, invite.connection.platform);
    if (state === "revoked") return data<LoaderResult>({ screen: "revoked", businessName }, { status: 410 });
    if (state === "accepted") return data<LoaderResult>({ screen: "used", businessName }, { status: 410 });
    return data<LoaderResult>({ screen: "expired", businessName }, { status: 410 });
  }

  const businessName = await resolveBusinessName(invite.connection.shop, invite.connection.platform);
  const role = invite.role as Role;

  const session = await getUserSession(request);
  if (!session) {
    return data<LoaderResult>({ screen: "signed-out", businessName, invitedEmail: invite.email, role });
  }

  const clerkUser = await getClerkClient().users.getUser(session.userId);
  const currentEmail =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";

  // BA edge case 3.5 — never auto-accept using whoever happens to be
  // signed in; only a session whose own email matches the invite. Checked
  // after authentication completes (this loader runs fresh on every visit,
  // including the post-auth redirect back to this same URL), not assumed
  // from which button was clicked.
  if (Team.normalizeEmail(currentEmail) !== Team.normalizeEmail(invite.email)) {
    return data<LoaderResult>({ screen: "wrong-account", businessName, invitedEmail: invite.email, currentEmail });
  }

  try {
    // Connection.create()'s own FK on User can race a fresh Clerk signup
    // whose user.created webhook hasn't landed yet — same ordering
    // onboarding.tsx already uses before its own Connection.create().
    await ensureUserRow(session.userId);
    const member = await Team.acceptInvite({ token, userId: session.userId });
    return data<LoaderResult>({ screen: "accepted", businessName, role: member.role as Role, connectionId: invite.connectionId });
  } catch (err) {
    // Narrow race: the invite flipped state (revoked/expired/already
    // accepted elsewhere) between the state check above and this call.
    if (isGetBooqinError(err)) {
      if (err.code === "getbooqin_invite_revoked") return data<LoaderResult>({ screen: "revoked", businessName }, { status: 410 });
      if (err.code === "getbooqin_invite_already_accepted") return data<LoaderResult>({ screen: "used", businessName }, { status: 410 });
      return data<LoaderResult>({ screen: "expired", businessName }, { status: 410 });
    }
    throw err;
  }
}

const ROLE_GLOSS: Record<Role, string> = {
  owner: "you'll have full access to everything, including settings and the team.",
  admin: "you'll be able to manage settings, the team, and everything operational.",
  write: "you'll be able to create and edit bookings, services, and customers, but not change settings or the team.",
  read: "you'll be able to view bookings, services, and customers, but not make changes.",
};

function LogoMark() {
  return (
    <span className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
      <span className="h-[6px] rounded-[2px] bg-brand-500" />
      <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
    </span>
  );
}

function Shell({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 md:h-dvh md:grid-cols-2">
      <div className="flex items-center justify-center bg-canvas px-8 py-10 md:overflow-y-auto">{left}</div>
      <div className="side-dark hidden flex-col items-center justify-center gap-3 px-12 text-center md:flex">{right}</div>
    </div>
  );
}

function DefaultRightPanel({ role, businessName }: { role: Role; businessName: string }) {
  return (
    <>
      <span className="flex h-[44px] w-[44px] shrink-0 flex-col justify-center gap-[4px] rounded-[10px] bg-brand-950 p-[8px]">
        <span className="h-[7px] rounded-[2px] bg-brand-500" />
        <span className="h-[7px] rounded-[2px] border-[1.5px] border-brand-500" />
      </span>
      <h2 className="m-0 text-[20px] font-semibold">You've been invited</h2>
      <p className="m-0 max-w-[320px] text-[13.5px] text-[#a49caf]">
        Once you join, you'll have your own sign-in with {ROLE_LABEL(role)} access to {businessName}'s dashboard.
      </p>
    </>
  );
}

function ROLE_LABEL(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export default function InvitePage({ loaderData }: Route.ComponentProps) {
  if (loaderData.screen === "invalid") {
    return (
      <Shell
        left={
          <InviteStatusCard
            title="This invite link isn't valid"
            body="Double-check the link you were sent, or ask whoever invited you to send a new one."
            action={<a href="/" className="btn-sec no-underline hover:no-underline">Go to homepage</a>}
          />
        }
        right={
          <>
            <LogoMark />
            <h2 className="m-0 text-[20px] font-semibold">GetBooqin Cloud</h2>
          </>
        }
      />
    );
  }

  if (loaderData.screen === "expired") {
    return (
      <Shell
        left={
          <InviteStatusCard
            title="This invite has expired"
            body={<>This invite expired. Ask an admin at <strong>{loaderData.businessName}</strong> to send you a new one.</>}
          />
        }
        right={<><LogoMark /><h2 className="m-0 text-[20px] font-semibold">{loaderData.businessName}</h2></>}
      />
    );
  }

  if (loaderData.screen === "revoked") {
    return (
      <Shell
        left={
          <InviteStatusCard
            title="This invite is no longer valid"
            body={<>It was revoked by an admin at <strong>{loaderData.businessName}</strong>. Ask them if you still need access.</>}
          />
        }
        right={<><LogoMark /><h2 className="m-0 text-[20px] font-semibold">{loaderData.businessName}</h2></>}
      />
    );
  }

  if (loaderData.screen === "used") {
    return (
      <Shell
        left={
          <InviteStatusCard
            title="This invite has already been used"
            body={<>If that was you, sign in below. Otherwise, ask an admin at <strong>{loaderData.businessName}</strong> for a new invite.</>}
            action={<a href="/login" className="btn-pri no-underline hover:no-underline">Sign in</a>}
          />
        }
        right={<><LogoMark /><h2 className="m-0 text-[20px] font-semibold">{loaderData.businessName}</h2></>}
      />
    );
  }

  if (loaderData.screen === "wrong-account") {
    return <WrongAccountScreen {...loaderData} />;
  }

  if (loaderData.screen === "accepted") {
    return <AcceptedScreen {...loaderData} />;
  }

  return <SignedOutForm {...loaderData} />;
}

function WrongAccountScreen({
  businessName, invitedEmail, currentEmail,
}: { businessName: string; invitedEmail: string; currentEmail: string }) {
  // Same useClerk()/signOut() pairing ui.tsx's own LogoutButton already
  // uses — signs out the current Clerk session client-side, then reloads
  // this same /invite/:token URL, whose loader re-runs logged-out and
  // lands on the sign-up/sign-in screen for the invited email.
  const { signOut } = useClerk();
  const [signingOut, setSigningOut] = useState(false);

  function handleSignOutAndContinue() {
    setSigningOut(true);
    signOut(() => window.location.reload());
  }

  return (
    <Shell
      left={
        <div className="card w-full max-w-[372px] p-[26px]">
          <LogoMark />
          <h1 className="page-title mt-4">Wrong account</h1>
          <p className="mt-2 text-body text-muted">
            You're signed in as {currentEmail}. This invite was sent to {invitedEmail}.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button type="button" className="btn-pri w-full justify-center" onClick={handleSignOutAndContinue} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out and continue"}
            </button>
            <a href="/dashboard" className="btn-link self-center">Go to my dashboard instead</a>
          </div>
        </div>
      }
      right={<><LogoMark /><h2 className="m-0 text-[20px] font-semibold">{businessName}</h2></>}
    />
  );
}

function AcceptedScreen({
  businessName, role, connectionId,
}: { businessName: string; role: Role; connectionId: string }) {
  const navigate = useNavigate();
  const dashboardUrl = `/dashboard/${connectionId}`;

  useEffect(() => {
    const t = setTimeout(() => navigate(dashboardUrl), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Shell
      left={
        <div className="card w-full max-w-[372px] p-[26px] text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ok text-[22px] text-white">✓</span>
          <h1 className="page-title mt-4">You're in!</h1>
          <p className="mt-2 text-body text-muted">
            You now have {ROLE_LABEL(role)} access to {businessName}. Taking you to the dashboard…
          </p>
          <a href={dashboardUrl} className="btn-pri mt-5 w-full justify-center no-underline hover:no-underline">
            Continue to dashboard
          </a>
        </div>
      }
      right={<DefaultRightPanel role={role} businessName={businessName} />}
    />
  );
}

function SignedOutForm({
  businessName, invitedEmail, role,
}: { businessName: string; invitedEmail: string; role: Role }) {
  const { token: rawToken } = useParamsToken();
  const { isLoaded: signUpLoaded, signUp, setActive: setActiveFromSignUp } = useSignUp();
  const { isLoaded: signInLoaded, signIn, setActive: setActiveFromSignIn } = useSignIn();
  const navigate = useNavigate();

  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [firstName, setFirstName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const inviteUrl = `/invite/${rawToken}`;

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  async function handleGoogle() {
    const hook = mode === "signup" ? signUp : signIn;
    if (!hook || submitting) return;
    setError(null);
    try {
      await hook.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: inviteUrl,
      });
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "Couldn't start Google sign-in — try again.");
    }
  }

  async function handleSignup(event: FormEvent) {
    event.preventDefault();
    if (!signUpLoaded || submitting) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Enter a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!agreed) {
      setError("Agree to the Terms of Service and Privacy Policy to continue.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await signUp.create({ emailAddress: invitedEmail, password, firstName });
      if (result.status === "complete") {
        await setActiveFromSignUp({ session: result.createdSessionId });
        navigate(inviteUrl);
      } else {
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
    if (!signUpLoaded || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === "complete") {
        await setActiveFromSignUp({ session: result.createdSessionId });
        navigate(inviteUrl);
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

  async function handleResend() {
    if (!signUpLoaded || resendCooldown > 0) return;
    setError(null);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setResendCooldown(30);
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "Couldn't resend the code — try again.");
    }
  }

  const ENUMERATION_CODES = new Set(["form_identifier_not_found", "form_password_incorrect"]);
  function loginErrorMessage(err: unknown): string {
    if (!isClerkAPIResponseError(err)) return "Incorrect email or password.";
    const clerkErr = err.errors[0];
    if (clerkErr && ENUMERATION_CODES.has(clerkErr.code)) return "Incorrect email or password.";
    return clerkErr?.longMessage ?? clerkErr?.message ?? "Incorrect email or password.";
  }

  async function handleSignin(event: FormEvent) {
    event.preventDefault();
    if (!signInLoaded || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await signIn.create({ strategy: "password", identifier: invitedEmail, password });
      if (result.status === "complete") {
        await setActiveFromSignIn({ session: result.createdSessionId });
        navigate(inviteUrl);
      } else if (result.status === "needs_second_factor" || result.status === "needs_client_trust") {
        const strategy = result.supportedSecondFactors?.[0]?.strategy;
        if (strategy === "email_code") {
          await signIn.prepareSecondFactor({ strategy: "email_code" });
          setNeedsSecondFactor(true);
        } else {
          setError("This account needs a verification step this page doesn't support yet — contact support.");
        }
      } else {
        setError("Couldn't sign in — check your password.");
      }
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSigninVerify(event: FormEvent) {
    event.preventDefault();
    if (!signInLoaded || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await signIn.attemptSecondFactor({ strategy: "email_code", code });
      if (result.status === "complete") {
        await setActiveFromSignIn({ session: result.createdSessionId });
        navigate(inviteUrl);
      } else {
        setError("That code didn't work — check it and try again.");
      }
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const showingCodeStep = (mode === "signup" && pendingVerification) || (mode === "signin" && needsSecondFactor);

  return (
    <Shell
      left={
        <div className="card w-full max-w-[372px] p-[26px]">
          <LogoMark />

          {!showingCodeStep ? (
            <>
              <h1 className="page-title mt-4">You're invited</h1>
              <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-body text-muted">
                <strong>{businessName}</strong> invited you to join with <RoleBadge role={role} /> access — {ROLE_GLOSS[role]}
              </p>
              {error && <AlertError className="mt-3">{error}</AlertError>}

              <Field label="Email" hint="This invite was sent to this address.">
                <Input type="email" value={invitedEmail} disabled />
              </Field>

              <button type="button" onClick={handleGoogle} className="btn-sec mt-4 w-full justify-center gap-2 py-[10px]">
                <GoogleIcon />
                Continue with Google
              </button>
              <div className="my-4 flex items-center gap-3 text-meta text-muted">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>

              {mode === "signup" ? (
                <form onSubmit={handleSignup} className="flex flex-col gap-[14px]">
                  <Field label="First name">
                    <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required autoComplete="given-name" />
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
                      <button type="button" onClick={() => setShowPassword((s) => !s)} className="btn-link absolute right-[10px] top-1/2 -translate-y-1/2">
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
                    {submitting ? "Joining…" : `Create account & join ${businessName}`}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleSignin} className="flex flex-col gap-[14px]">
                  <Field label="Password">
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                    />
                  </Field>
                  <button type="submit" className="btn-pri mt-1 w-full justify-center" disabled={submitting}>
                    {submitting ? "Joining…" : `Sign in & join ${businessName}`}
                  </button>
                </form>
              )}

              <p className="mt-4 text-body text-muted">
                {mode === "signup" ? (
                  <button type="button" className="btn-link" onClick={() => { setMode("signin"); setError(null); }}>
                    Already have an account? Sign in instead
                  </button>
                ) : (
                  <button type="button" className="btn-link" onClick={() => { setMode("signup"); setError(null); }}>
                    New here? Create an account instead
                  </button>
                )}
              </p>
            </>
          ) : mode === "signup" ? (
            <>
              <h1 className="page-title mt-4">Check your email</h1>
              <p className="mt-2 text-body text-muted">
                We sent a verification code to {invitedEmail}.{" "}
                <button type="button" onClick={() => { setPendingVerification(false); setError(null); setCode(""); }} className="btn-link">
                  Wrong address?
                </button>
              </p>
              {error && <AlertError className="mt-3">{error}</AlertError>}
              <form onSubmit={handleVerify} className="mt-5 flex flex-col gap-[14px]">
                <Field label="Verification code">
                  <Input type="text" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
                </Field>
                <button type="submit" className="btn-pri mt-1 w-full justify-center" disabled={submitting}>
                  {submitting ? "Verifying…" : "Verify"}
                </button>
                <button type="button" onClick={handleResend} disabled={resendCooldown > 0} className="btn-link self-center">
                  {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="page-title mt-4">Verify it's you</h1>
              <p className="mt-2 text-body text-muted">
                New device — we sent a code to {invitedEmail} to confirm it's really you.
              </p>
              {error && <AlertError className="mt-3">{error}</AlertError>}
              <form onSubmit={handleSigninVerify} className="mt-5 flex flex-col gap-[14px]">
                <Field label="Verification code">
                  <Input type="text" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
                </Field>
                <button type="submit" className="btn-pri mt-1 w-full justify-center" disabled={submitting}>
                  {submitting ? "Verifying…" : "Verify"}
                </button>
              </form>
            </>
          )}
        </div>
      }
      right={<DefaultRightPanel role={role} businessName={businessName} />}
    />
  );
}

// Small helper so SignedOutForm doesn't need react-router's `params` typed
// prop threaded through two extra component layers just for the token —
// this route's own URL segment already carries it, and Route.ComponentProps
// isn't accessible this deep without re-typing every intermediate component.
function useParamsToken() {
  return useParams<{ token: string }>() as { token: string };
}
