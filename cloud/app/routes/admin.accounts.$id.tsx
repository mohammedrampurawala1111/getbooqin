import { Form, Link, data, useNavigation } from "react-router";
import type { Route } from "./+types/admin.accounts.$id";
import { AdminAccounts, AdminActions, AdminAudit, Plans, isGetBooqinError } from "getbooqin-core";
import { requirePlatformAdmin, clientIp } from "~/admin.server";

/**
 * The one screen that does the work: comp an account, extend a trial,
 * grant or revoke a feature.
 *
 * Every action takes a **required reason** and writes an audit row in
 * the same transaction as the change. No danger zone yet — suspend and
 * force-cancel are deliberately absent until there is a real need, since
 * both are far easier to add than to un-fire.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);
  const account = await AdminAccounts.detail(params.id!);
  if (!account) throw data("Not found", { status: 404 });
  const audit = await AdminAudit.list({ targetId: params.id!, limit: 25 });

  return {
    account: {
      ...account,
      entitlements: {
        ...account.entitlements,
        features: [...account.entitlements.features],
        limits: Object.fromEntries(
          Object.entries(account.entitlements.limits).map(([k, v]) => [k, Number.isFinite(v) ? v : null])
        ),
      },
    },
    audit,
    planIds: Plans.PLAN_ORDER,
    featureKeys: Plans.FEATURE_KEYS,
    featureLabels: Plans.FEATURE_LABELS,
    limitKeys: Plans.LIMIT_KEYS,
    limitLabels: Plans.LIMIT_LABELS,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const admin = await requirePlatformAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");
  const ctx = { actorUserId: admin.userId, reason: String(form.get("reason") ?? ""), ip: clientIp(request) };

  try {
    if (intent === "set_plan") {
      const untilRaw = String(form.get("until") ?? "").trim();
      await AdminActions.setPlan(
        params.id!,
        String(form.get("plan") ?? "") as never,
        ctx,
        untilRaw ? new Date(`${untilRaw}T23:59:59Z`) : null
      );
      return { ok: "Plan updated." };
    }
    if (intent === "extend_trial") {
      const until = String(form.get("until") ?? "").trim();
      if (!until) return { error: "Pick a date to extend the trial to." };
      await AdminActions.extendTrialTo(params.id!, new Date(`${until}T23:59:59Z`), ctx);
      return { ok: "Trial extended." };
    }
    if (intent === "grant") {
      const expires = String(form.get("expires_at") ?? "").trim();
      await AdminActions.grantEntitlement(
        params.id!,
        {
          key: String(form.get("key") ?? ""),
          value: String(form.get("value") ?? ""),
          expiresAt: expires ? new Date(`${expires}T23:59:59Z`) : null,
        },
        ctx
      );
      return { ok: "Override applied." };
    }
    if (intent === "revoke") {
      await AdminActions.revokeEntitlement(params.id!, String(form.get("key") ?? ""), ctx);
      return { ok: "Override removed." };
    }
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message };
    throw err;
  }
  return { error: "Unknown action." };
}

function date(value: string | Date | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

/** Reason is required on every form here — it is what makes the log worth keeping. */
function ReasonField() {
  return (
    <input
      name="reason"
      required
      minLength={3}
      placeholder="Reason (goes in the audit log)"
      className="input w-full min-w-0"
    />
  );
}

export default function AdminAccountDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { account, audit, planIds, featureKeys, featureLabels, limitKeys, limitLabels } = loaderData;
  const ent = account.entitlements;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <div className="flex flex-col gap-[14px]">
      <Link to="/admin" className="btn-link">&larr; All accounts</Link>

      {actionData && "error" in actionData && actionData.error && (
        <p className="m-0 rounded-[8px] bg-danger-bg px-3 py-2 text-[12.5px] font-medium text-danger">{actionData.error}</p>
      )}
      {actionData && "ok" in actionData && actionData.ok && (
        <p className="m-0 rounded-[8px] bg-ok-bg px-3 py-2 text-[12.5px] text-ok">{actionData.ok}</p>
      )}

      <div className="card">
        <div className="card-header"><h2 className="card-title">{account.businessName}</h2></div>
        <div className="card-body grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] md:grid-cols-3">
          {[
            ["Owner", account.ownerEmail],
            ["Shop", `${account.platform}/${account.shop}`],
            ["Plan", `${account.planName} (${ent.status})`],
            ["Billing", `${account.currency} via ${account.billingProvider}`],
            ["Trial ends", account.trialEndsAt ? `${date(account.trialEndsAt)} — ${account.trialDaysLeft}d` : "—"],
            ["Renews", date(account.currentPeriodEnd)],
            ["Signed up", date(account.createdAt)],
            ["Bookings this month", String(account.bookingsThisMonth)],
            ["Staff / services / team", `${account.resourceCount} / ${account.serviceCount} / ${account.teamMemberCount}`],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <span className="text-[11.5px] text-muted">{label}</span>
              <span className="truncate">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2">
        <div className="card">
          <div className="card-header">
            <div className="flex flex-col gap-[3px]">
              <h2 className="card-title">Change plan</h2>
              {/* Never touches Razorpay. This is how you comp a beta user
                  or a design partner: no money moves, no payment risk,
                  and it works whatever rail the account is on. */}
              <p className="m-0 text-meta text-muted">Sets the plan directly. No card, no provider — an "until" date makes it a time-boxed comp.</p>
            </div>
          </div>
          <Form method="post" className="card-body flex flex-col gap-2">
            <input type="hidden" name="_intent" value="set_plan" />
            <select name="plan" defaultValue={ent.plan} className="input">
              {planIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              Until (optional)
              <input type="date" name="until" className="input" />
            </label>
            <ReasonField />
            <button type="submit" disabled={busy} className="btn-pri">Set plan</button>
          </Form>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="flex flex-col gap-[3px]">
              <h2 className="card-title">Extend trial</h2>
              <p className="m-0 text-meta text-muted">The most-used support action there is.</p>
            </div>
          </div>
          <Form method="post" className="card-body flex flex-col gap-2">
            <input type="hidden" name="_intent" value="extend_trial" />
            <input type="date" name="until" required className="input" />
            <ReasonField />
            <button type="submit" disabled={busy} className="btn-pri">Extend</button>
          </Form>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="flex flex-col gap-[3px]">
            <h2 className="card-title">Overrides</h2>
            {/* This is early access: ship a feature dark, grant it to
                five accounts, watch, then move it into a plan. Same
                mechanism, no deploys. */}
            <p className="m-0 text-meta text-muted">
              Grant or remove a feature, or raise a limit, for this account only. Resolved as plan ∪ grants − revokes.
            </p>
          </div>
        </div>

        <div className="px-[18px] pt-1">
          {account.overrides.length === 0 ? (
            <p className="py-[11px] text-[13px] text-subtle">No overrides.</p>
          ) : (
            account.overrides.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-row py-[11px] text-[13px] last:border-b-0">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {featureLabels[o.key as keyof typeof featureLabels] ?? o.key} — {o.value}
                    {o.expiresAt && new Date(o.expiresAt) <= new Date() && <span className="ml-1 badge-neutral">lapsed</span>}
                  </span>
                  <span className="text-[11.5px] text-subtle">
                    {o.reason}{o.expiresAt ? ` · until ${date(o.expiresAt)}` : " · permanent"}
                  </span>
                </div>
                <Form method="post" className="flex shrink-0 items-center gap-2">
                  <input type="hidden" name="_intent" value="revoke" />
                  <input type="hidden" name="key" value={o.key} />
                  <input name="reason" required minLength={3} placeholder="Reason" className="input w-[180px]" />
                  <button type="submit" disabled={busy} className="btn-link text-danger">Remove</button>
                </Form>
              </div>
            ))
          )}
        </div>

        <Form method="post" className="card-body flex flex-wrap items-end gap-2">
          <input type="hidden" name="_intent" value="grant" />
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Key
            <select name="key" className="input w-[220px]">
              <optgroup label="Features">
                {featureKeys.map((k) => <option key={k} value={k}>{k}</option>)}
              </optgroup>
              <optgroup label="Limits">
                {limitKeys.map((k) => <option key={k} value={`limit.${k}`}>limit.{k}</option>)}
              </optgroup>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Value
            <input name="value" required placeholder="on / off / 25 / unlimited" className="input w-[160px]" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Expires (optional)
            <input type="date" name="expires_at" className="input" />
          </label>
          <input name="reason" required minLength={3} placeholder="Reason" className="input min-w-[200px] flex-1" />
          <button type="submit" disabled={busy} className="btn-pri">Apply</button>
        </Form>
      </div>

      <div className="card">
        <div className="card-header"><h2 className="card-title">Recent admin actions</h2></div>
        <div className="px-[18px] pt-1 pb-[14px]">
          {audit.length === 0 ? (
            <p className="py-[11px] text-[13px] text-subtle">Nothing yet.</p>
          ) : (
            audit.map((row) => (
              <div key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-row py-[9px] text-[13px] last:border-b-0">
                <span><span className="font-medium">{row.action}</span> — {row.reason}</span>
                <span className="text-[11.5px] text-subtle">{row.actorEmail} · {date(row.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
