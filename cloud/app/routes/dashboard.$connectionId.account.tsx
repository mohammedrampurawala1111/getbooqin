import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useClerk, useReverification, useSession, useUser } from "@clerk/react-router";
import { isClerkAPIResponseError, isReverificationCancelledError } from "@clerk/react-router/errors";
import type { Route } from "./+types/dashboard.$connectionId.account";
import { prisma, Settings } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, Badge, Field, Input, Toggle } from "~/components/ui";
import { AuthMethodRow, GoogleGlyph, PasswordField, SessionRow } from "~/components/account";
import { SettingsShell, SettingsCard, Row, RowInput } from "~/components/settings";
import { getPreset, vocabFor } from "~/lib/presets";
import { PHONE_PATTERN, isValidPhone } from "~/lib/validation";

export const meta: Route.MetaFunction = () => [{ title: "Account · GetBooqin" }];

// Structural types pulled off the hooks themselves — @clerk/react-router's
// public entry re-exports the hooks but not their resource types by name.
type ClerkUser = NonNullable<ReturnType<typeof useUser>["user"]>;
type ClerkSession = Awaited<ReturnType<ClerkUser["getSessions"]>>[number];

function clerkMessage(err: unknown): string | undefined {
  return isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
}

// Account's own data (name, email, password, sessions) is identity-scoped —
// one user, potentially many stores — but the route lives here, nested
// under the current connection like every other dashboard screen, so it
// renders inside the same sidebar shell instead of dropping to a bare
// topbar the moment a merchant clicks over to it (that was the actual
// "why does this open a separate view" bug: it used to be a standalone
// top-level route). Nothing loaded below is filtered by connectionId
// except the Business template summary, which is inherently per-store.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { userId, connection } = await requireTenant(request, params.connectionId);
  const [dbUser, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    Settings.getSettings(connection.shop, connection.platform),
  ]);

  return {
    phone: dbUser?.phone ?? "",
    template: { presetId: settings.preset, href: `/dashboard/${connection.id}/settings?page=template` },
  };
}

export default function Account({ loaderData, params }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "security" ? "security" : "profile";
  const base = `/dashboard/${params.connectionId}`;

  return (
    <SettingsShell active={tab} base={base}>
      {tab === "profile" ? (
        <ProfileTab phone={loaderData.phone} template={loaderData.template} />
      ) : (
        <SecurityTab />
      )}
    </SettingsShell>
  );
}

/* ==================================================================
   Profile — one row-based card (photo, name, job title, email, phone)
   plus a separate Business template summary, matching the rest of
   Settings' rail+row layout instead of the old per-field card stack.
   ================================================================== */
function ProfileTab({
  phone, template,
}: { phone: string; template: { presetId: string; href: string } }) {
  const { isLoaded, user } = useUser();
  if (!isLoaded || !user) {
    return <div className="card px-[18px] py-6 text-body text-muted">Loading…</div>;
  }
  return (
    <div className="flex flex-col gap-[14px]">
      <ProfileCard user={user} initialPhone={phone} />
      <TemplateCard template={template} />
    </div>
  );
}

function ProfileCard({ user, initialPhone }: { user: ClerkUser; initialPhone: string }) {
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [jobTitle, setJobTitle] = useState((user.unsafeMetadata?.jobTitle as string | undefined) ?? "");
  const [phone, setPhone] = useState(initialPhone);
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

  async function handleRemoveAvatar() {
    setAvatarBusy(true);
    setError(null);
    try {
      await user.setProfileImage({ file: null });
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't remove your photo.");
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
    if (phone && !isValidPhone(phone)) {
      setSaved(false);
      setError("Enter a valid phone number.");
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await user.update({ firstName, lastName });
      await user.updateMetadata({ unsafeMetadata: { jobTitle } });
      if (phone) {
        const res = await fetch("/dashboard/profile-phone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone }),
        });
        if (!res.ok) throw new Error("phone save failed");
      }
      setSaved(true);
    } catch (err) {
      setError(clerkMessage(err) ?? "Couldn't save your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard
      onSubmit={handleSave}
      saveLabel={saving ? "Saving…" : "Save changes"}
      savedAt={saved ? "just now" : undefined}
      error={error ?? undefined}
    >
      <Row label="Photo" hint="PNG or JPG, min 200px">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-50 text-[14px] font-semibold text-brand-600">
            {user.imageUrl ? (
              <img src={user.imageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              (firstName || user.primaryEmailAddress?.emailAddress || "U").slice(0, 1).toUpperCase()
            )}
          </span>
          <label className="btn-sec cursor-pointer">
            {avatarBusy ? "Working…" : "Change"}
            <input type="file" accept="image/*" className="sr-only" onChange={handleAvatar} disabled={avatarBusy} />
          </label>
          {user.imageUrl ? (
            <button type="button" className="btn-link text-muted" onClick={handleRemoveAvatar} disabled={avatarBusy}>
              Remove
            </button>
          ) : null}
        </div>
      </Row>

      <Row label="Name">
        {/* Row's wrapping <label> gives both inputs the same accessible
            name ("Name") by default, which is fine for one control but
            ambiguous for two stacked ones — a screen-reader user can't
            tell first from last apart. aria-label overrides the inherited
            name per-input without needing two separate Rows. */}
        <div className="flex flex-col gap-2">
          <RowInput aria-label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" cap={9999} />
          <RowInput aria-label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" cap={9999} />
        </div>
      </Row>

      <Row label="Job title">
        <RowInput value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Owner" cap={9999} />
      </Row>

      <EmailRow user={user} />

      <Row label="Phone" hint="For urgent booking alerts">
        <RowInput
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 555 0100"
          pattern={PHONE_PATTERN}
          autoComplete="tel"
          cap={9999}
        />
      </Row>
    </SettingsCard>
  );
}

// Its own multi-step flow (enter address → confirm code) can't be a nested
// <form> — this sits inside ProfileCard's outer form, so every button here
// is type="button" with its own click handler instead of a submit.
function EmailRow({ user }: { user: ClerkUser }) {
  const [mode, setMode] = useState<"view" | "enter" | "verify">("view");
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verified = user.primaryEmailAddress?.verification?.status === "verified";

  async function handleSendCode() {
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

  async function handleVerify() {
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

  if (mode === "view") {
    return (
      <Row label="Email" hint="Used to sign in">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 text-body [overflow-wrap:anywhere]">{user.primaryEmailAddress?.emailAddress}</span>
          {verified ? <Badge status="confirmed" label="Verified" /> : null}
          <button type="button" className="btn-link text-brand-600" onClick={() => setMode("enter")}>Change</button>
        </div>
      </Row>
    );
  }

  return (
    <Row label="Email" align="start">
      <div className="flex flex-col gap-[10px]">
        {error && <AlertError>{error}</AlertError>}
        {mode === "enter" ? (
          <>
            <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="New email" />
            <div className="flex gap-2">
              <button type="button" className="btn-pri" disabled={busy || !newEmail} onClick={handleSendCode}>
                {busy ? "Sending…" : "Send code"}
              </button>
              <button type="button" className="btn-sec" onClick={() => setMode("view")}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-meta text-muted">We sent a code to {newEmail}.</p>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Verification code" />
            <div className="flex gap-2">
              <button type="button" className="btn-pri" disabled={busy || !code} onClick={handleVerify}>
                {busy ? "Confirming…" : "Confirm"}
              </button>
              <button type="button" className="btn-sec" onClick={() => setMode("view")}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </Row>
  );
}

function TemplateCard({ template }: { template: { presetId: string; href: string } }) {
  const preset = getPreset(template.presetId);
  const v = vocabFor(template.presetId);
  return (
    <div className="card">
      <div className="card-body flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="h-9 w-9 shrink-0 rounded-[9px]" style={{ background: preset.tint }} />
          <div className="flex flex-col gap-[2px]">
            <span className="text-body font-medium">Business template — {preset.label.split(" / ")[0]}</span>
            <span className="text-meta text-muted">{v.bookingTitle} · {v.customers} · {preset.vocab.resources}</span>
          </div>
        </div>
        <a href={template.href} className="btn-sec no-underline hover:no-underline">Change</a>
      </div>
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
  const { session } = useSession();
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

  // The form already collected currentPassword above — stash it here right
  // before calling updatePassword() so the reverification handler below can
  // reuse it instead of a popup asking the merchant to type the same
  // password again a few seconds later (UX audit's #3 finding, second
  // half). A ref, not state: it only needs to be read once, synchronously,
  // inside the reverification callback that fires during this same submit.
  const pendingCurrentPassword = useRef("");

  // Clerk requires a fresh sign-in ("reverification") before it'll let a
  // change-password request through — without this, that request just
  // 403s with a session_reverification_required error and there's no UI
  // anywhere to complete it (UX audit's R2 finding). For a password-enabled
  // user, the "fresh sign-in" Clerk wants *is* the current password we
  // already collected, so onNeedsReverification verifies it directly
  // against the session and completes silently — no modal, no second
  // prompt. Only wired up when a password exists to reuse; a Google-only
  // user setting their first password has nothing to reuse and keeps
  // Clerk's own default reverification UI (that path was never the "asked
  // twice" complaint, since there's no first password to double-collect).
  const handleNeedsReverification = useCallback(
    async ({ cancel, complete, level }: { cancel: () => void; complete: () => void; level?: string }) => {
      if (!session || !pendingCurrentPassword.current) {
        cancel();
        setError("Re-enter your current password and try again.");
        return;
      }
      try {
        const verification = await session.startVerification({ level: (level as "first_factor") ?? "first_factor" });
        const supportsPassword = verification.supportedFirstFactors?.some((f) => f.strategy === "password");
        if (verification.status !== "needs_first_factor" || !supportsPassword) {
          cancel();
          setError("Couldn't verify your identity for this change — try again.");
          return;
        }
        const attempt = await session.attemptFirstFactorVerification({
          strategy: "password",
          password: pendingCurrentPassword.current,
        });
        if (attempt.status === "complete") {
          complete();
          return;
        }
        cancel();
        setError("Your current password didn't match — re-enter it and try again.");
      } catch (err) {
        cancel();
        setError(clerkMessage(err) ?? "Couldn't verify your identity — try again.");
      }
    },
    [session]
  );

  const updatePassword = useReverification(
    (args: Parameters<ClerkUser["updatePassword"]>[0]) => user.updatePassword(args),
    user.passwordEnabled ? { onNeedsReverification: handleNeedsReverification } : undefined
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("password") ?? "");
    pendingCurrentPassword.current = currentPassword;
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
      pendingCurrentPassword.current = "";
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
