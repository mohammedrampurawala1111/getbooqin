import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useClerk, useReverification, useSession, useUser } from "@clerk/react-router";
import { isClerkAPIResponseError, isReverificationCancelledError } from "@clerk/react-router/errors";
import type { Route } from "./+types/dashboard.account";
import { prisma } from "getbooqin-core";
import { requireUserSession } from "~/session.server";
import { AccountShell, AlertError, PageHeader, Field, Input, Toggle } from "~/components/ui";
import { AuthMethodRow, GoogleGlyph, PasswordField, SessionRow } from "~/components/account";
import { PHONE_PATTERN, isValidPhone } from "~/lib/validation";

export const meta: Route.MetaFunction = () => [{ title: "Account · GetBooqin" }];

// Structural types pulled off the hooks themselves — @clerk/react-router's
// public entry re-exports the hooks but not their resource types by name.
type ClerkUser = NonNullable<ReturnType<typeof useUser>["user"]>;
type ClerkSession = Awaited<ReturnType<ClerkUser["getSessions"]>>[number];

function clerkMessage(err: unknown): string | undefined {
  return isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
}

// Profile/security are per-user, not per-store, so this route sits at the
// top level (not nested under :connectionId like the rest of the
// dashboard) — see README's "Account, auth and template config" note.
export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUserSession(request);
  const dbUser = await prisma.user.findUnique({ where: { id: session.userId } });
  return { phone: dbUser?.phone ?? "" };
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "security" ? "security" : "profile";

  return (
    <AccountShell>
      <div className="flex flex-col gap-[18px]">
        <PageHeader title="Account" />

        <div className="card">
          <div className="flex border-b border-line px-[6px]">
            <a href="?tab=profile" className={`tab ${tab === "profile" ? "tab-active" : ""}`}>Profile</a>
            <a href="?tab=security" className={`tab ${tab === "security" ? "tab-active" : ""}`}>Password &amp; security</a>
          </div>
        </div>

        {tab === "profile" ? (
          <ProfileTab phone={loaderData.phone} />
        ) : (
          <SecurityTab />
        )}
      </div>
    </AccountShell>
  );
}

/* ==================================================================
   Profile
   ================================================================== */
function ProfileTab({ phone }: { phone: string }) {
  const { isLoaded, user } = useUser();
  if (!isLoaded || !user) {
    return <div className="card px-[18px] py-6 text-body text-muted">Loading…</div>;
  }
  return (
    <div className="flex flex-col gap-[14px]">
      <ProfileCard user={user} />
      <EmailCard user={user} />
      <PhoneCard initialPhone={phone} />
    </div>
  );
}

function ProfileCard({ user }: { user: ClerkUser }) {
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [jobTitle, setJobTitle] = useState((user.unsafeMetadata?.jobTitle as string | undefined) ?? "");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setAvatarBusy(true);
    setError(null);
    try {
      await user.setProfileImage({ file });
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't update your photo.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!firstName.trim() && !lastName.trim()) {
      setSaved(false);
      setError("Enter at least a first name — the account has no display name otherwise.");
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await user.update({ firstName, lastName });
      await user.updateMetadata({ unsafeMetadata: { jobTitle } });
      setSaved(true);
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't save your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header"><h2 className="card-title">Profile</h2></div>
      <form onSubmit={handleSave}>
        <div className="card-body flex flex-col gap-[14px]">
          {error && <AlertError>{error}</AlertError>}
          <div className="flex items-center gap-4">
            <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-row text-[16px] font-semibold text-ink-2">
              {user.imageUrl ? (
                <img src={user.imageUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                (firstName || user.primaryEmailAddress?.emailAddress || "U").slice(0, 1).toUpperCase()
              )}
            </span>
            <label className="btn-sec cursor-pointer">
              {avatarBusy ? "Uploading…" : "Change photo"}
              <input type="file" accept="image/*" className="sr-only" onChange={handleAvatar} disabled={avatarBusy} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-[14px]">
            <Field label="First name">
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </Field>
            <Field label="Last name">
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </Field>
            <div className="col-span-2">
              <Field label="Job title">
                <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Owner" />
              </Field>
            </div>
          </div>
        </div>
        <div className="card-footer">
          {saved && <span className="alert-success">Saved.</span>}
          <button type="submit" className="btn-pri ml-auto" disabled={saving}>
            {saving ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EmailCard({ user }: { user: ClerkUser }) {
  const [mode, setMode] = useState<"view" | "enter" | "verify">("view");
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const emailResource = await user.createEmailAddress({ email: newEmail });
      await emailResource.prepareVerification({ strategy: "email_code" });
      setPendingId(emailResource.id);
      setMode("verify");
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't send a code to that address.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(event: FormEvent) {
    event.preventDefault();
    if (!pendingId) return;
    setBusy(true);
    setError(null);
    try {
      const pending = user.emailAddresses.find((e) => e.id === pendingId);
      await pending?.attemptVerification({ code });
      await user.update({ primaryEmailAddressId: pendingId });
      setMode("view");
      setNewEmail("");
      setCode("");
    } catch (err) {
      setError(clerkMessage(err) ?? "That code didn't work — check it and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header"><h2 className="card-title">Email</h2></div>
      <div className="card-body flex flex-col gap-[14px]">
        {error && <AlertError>{error}</AlertError>}

        {mode === "view" && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-[3px]">
              <span className="text-body font-medium">{user.primaryEmailAddress?.emailAddress}</span>
              <span className="text-meta text-muted">Changing this sends a confirmation code to the new address.</span>
            </div>
            <button type="button" className="btn-sec" onClick={() => setMode("enter")}>Change email</button>
          </div>
        )}

        {mode === "enter" && (
          <form onSubmit={handleSendCode} className="flex flex-col gap-[14px]">
            <Field label="New email">
              <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
            </Field>
            <div className="flex gap-2">
              <button type="submit" className="btn-pri" disabled={busy}>{busy ? "Sending…" : "Send code"}</button>
              <button type="button" className="btn-sec" onClick={() => setMode("view")}>Cancel</button>
            </div>
          </form>
        )}

        {mode === "verify" && (
          <form onSubmit={handleVerify} className="flex flex-col gap-[14px]">
            <p className="m-0 text-body text-muted">We sent a code to {newEmail}.</p>
            <Field label="Verification code">
              <Input value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
            <div className="flex gap-2">
              <button type="submit" className="btn-pri" disabled={busy}>{busy ? "Confirming…" : "Confirm"}</button>
              <button type="button" className="btn-sec" onClick={() => setMode("view")}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// Phone deliberately isn't a Clerk field — see core/prisma/schema.prisma's
// User.phone comment (Clerk's SMS allowlist rejects some country codes
// regardless of whether phone sign-in is even enabled). Saved through the
// same resource route signup.tsx already posts to.
function PhoneCard({ initialPhone }: { initialPhone: string }) {
  const [phone, setPhone] = useState(initialPhone);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!phone) {
      setError("Enter a phone number to save.");
      return;
    }
    if (!isValidPhone(phone)) {
      setError("Enter a valid phone number.");
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/dashboard/profile-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) throw new Error("request failed");
      setSaved(true);
    } catch {
      setError("Couldn't save your phone number — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header"><h2 className="card-title">Phone</h2></div>
      <form onSubmit={handleSave}>
        <div className="card-body max-w-[320px]">
          {error && <AlertError className="mb-3">{error}</AlertError>}
          <Field label="Phone number" hint="For us to reach you — not used for sign-in.">
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 0100"
              pattern={PHONE_PATTERN}
              autoComplete="tel"
            />
          </Field>
        </div>
        <div className="card-footer">
          {saved && <span className="alert-success">Saved.</span>}
          <button type="submit" className="btn-pri ml-auto" disabled={saving}>
            {saving ? "Saving…" : "Save phone"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ==================================================================
   Password & security
   ================================================================== */
function SecurityTab() {
  const { isLoaded, user } = useUser();
  const { session: currentSession } = useSession();
  const clerk = useClerk();
  const navigate = useNavigate();

  if (!isLoaded || !user) {
    return <div className="card px-[18px] py-6 text-body text-muted">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-[14px]">
      <PasswordCard user={user} />
      <LinkedAccountsCard user={user} />
      <SessionsCard user={user} currentSessionId={currentSession?.id} onSignOutEverywhere={() => clerk.signOut(() => navigate("/logout"))} />
      <div className="card">
        <div className="card-body flex items-center justify-between gap-3">
          <div className="flex flex-col gap-[3px]">
            <span className="text-body font-medium">Two-step verification</span>
            <span className="text-meta text-muted">Add an authenticator app or backup codes for a second sign-in step.</span>
          </div>
          {/* Deep-links straight to the security page instead of landing on
              Clerk's own "Profile details" tab — a second, out-of-sync
              profile/email/phone UI behind this one (UX audit's R3
              finding). Still Clerk's modal chrome (2FA enrollment isn't
              exposed by the client SDK outside it), but at least it opens
              where the merchant actually clicked. */}
          <button
            type="button"
            className="btn-sec"
            onClick={() => clerk.openUserProfile({ __experimental_startPath: "/security" })}
          >
            Manage
          </button>
        </div>
      </div>
    </div>
  );
}

function PasswordCard({ user }: { user: ClerkUser }) {
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PasswordField tracks its own strength-meter state internally; formEl.
  // reset() below clears the input's DOM value but fires no React onChange,
  // so the meter used to keep reading "Strong" for a password that was no
  // longer in the (now-empty) box (UX audit's N8 finding). Bumping this key
  // after a successful save remounts both PasswordFields fresh.
  const [resetKey, setResetKey] = useState(0);

  // Clerk requires a fresh sign-in ("reverification") before it'll let a
  // change-password request through — without this, that request just
  // 403s with a session_reverification_required error and there's no UI
  // anywhere to complete it (UX audit's R2 finding). useReverification
  // handles the whole round trip: it shows Clerk's own re-auth modal when
  // needed, then retries updatePassword() automatically.
  const updatePassword = useReverification((args: Parameters<ClerkUser["updatePassword"]>[0]) =>
    user.updatePassword(args)
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("password") ?? "");
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updatePassword({
        ...(user.passwordEnabled ? { currentPassword } : {}),
        newPassword,
        signOutOfOtherSessions: signOutOthers,
      });
      setSaved(true);
      formEl.reset();
      setResetKey((k) => k + 1);
    } catch (err) {
      if (!isReverificationCancelledError(err)) {
        setError(clerkMessage(err) ?? "Couldn't update your password.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header"><h2 className="card-title">Password</h2></div>
      <form onSubmit={handleSubmit}>
        <div className="card-body flex max-w-[360px] flex-col gap-[14px]">
          {error && <AlertError>{error}</AlertError>}
          {!user.passwordEnabled && (
            <p className="m-0 text-meta text-muted">
              You signed up with Google, so there's no password yet — set one below to also be able to log in with email and password.
            </p>
          )}
          {user.passwordEnabled && (
            <PasswordField key={`current-${resetKey}`} name="currentPassword" label="Current password" autoComplete="current-password" showMeter={false} />
          )}
          <PasswordField key={`new-${resetKey}`} name="password" label={user.passwordEnabled ? "New password" : "Password"} hint="At least 15 characters." />
          <Toggle name="signOutOthers" defaultChecked={signOutOthers} onChange={setSignOutOthers} label="Sign out of other sessions" />
        </div>
        <div className="card-footer">
          {saved && <span className="alert-success">Saved.</span>}
          <button type="submit" className="btn-pri ml-auto" disabled={saving}>
            {saving ? "Saving…" : "Update password"}
          </button>
        </div>
      </form>
    </div>
  );
}

function LinkedAccountsCard({ user }: { user: ClerkUser }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const google = user.externalAccounts.find((a) => a.provider === "google");

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const account = await user.createExternalAccount({ strategy: "oauth_google", redirectUrl: "/sso-callback" });
      const url = account.verification?.externalVerificationRedirectURL;
      if (url) window.location.href = url.toString();
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't connect Google.");
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!google) return;
    if (!user.passwordEnabled) {
      setError("Set a password first — disconnecting Google would lock you out of your account.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await google.destroy();
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't disconnect Google.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header"><h2 className="card-title">Linked sign-in methods</h2></div>
      {error && <AlertError className="mx-[18px] mt-3">{error}</AlertError>}
      <AuthMethodRow
        glyph={<GoogleGlyph />}
        name="Google"
        detail={google ? google.emailAddress : "Not connected"}
        connected={!!google}
        onAction={google ? handleDisconnect : handleConnect}
        busy={busy}
      />
    </div>
  );
}

function SessionsCard({
  user, currentSessionId, onSignOutEverywhere,
}: { user: ClerkUser; currentSessionId?: string; onSignOutEverywhere: () => void }) {
  const [sessions, setSessions] = useState<ClerkSession[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [signingOutAll, setSigningOutAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    user.getSessions().then((list) => {
      if (!cancelled) setSessions(list);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function handleRevoke(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const target = sessions?.find((s) => s.id === id);
      await target?.revoke();
      setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null);
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't sign out that device.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSignOutEverywhere() {
    setSigningOutAll(true);
    setError(null);
    try {
      const others = (sessions ?? []).filter((s) => s.id !== currentSessionId);
      await Promise.all(others.map((s) => s.revoke()));
      onSignOutEverywhere();
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't sign out every device.");
      setSigningOutAll(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header"><h2 className="card-title">Active sessions</h2></div>
      {error && <AlertError className="mx-[18px] mt-3">{error}</AlertError>}
      {sessions === null ? (
        <p className="px-[18px] py-4 text-body text-muted">Loading…</p>
      ) : (
        sessions.map((s) => (
          <SessionRow
            key={s.id}
            device={[s.latestActivity.browserName, s.latestActivity.deviceType].filter(Boolean).join(" on ") || "Unknown device"}
            where={[s.latestActivity.city, s.latestActivity.country].filter(Boolean).join(", ") || s.latestActivity.ipAddress || "Unknown location"}
            current={s.id === currentSessionId}
            onRevoke={() => handleRevoke(s.id)}
            busy={busyId === s.id}
          />
        ))
      )}
      <div className="card-footer">
        <button type="button" className="btn-del ml-auto" onClick={handleSignOutEverywhere} disabled={signingOutAll || !sessions}>
          {signingOutAll ? "Signing out…" : "Sign out everywhere"}
        </button>
      </div>
    </div>
  );
}
