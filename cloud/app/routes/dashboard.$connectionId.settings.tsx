import { useEffect, useRef, useState } from "react";
import { Form, redirect, useFetcher, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.settings";
import { Settings, Data, Mailer, Team, Entitlements, Billing, Checkout, BillingReconcile, Invoices, Plans, Qr, Subscriptions, Tax, WhatsAppAccounts, WhatsAppTemplates, listUserConnections, disconnectConnection, isGetBooqinError } from "getbooqin-core";
// Client-safe subpath for the two rule-checks the component below calls at
// render time — importing these off the main `Settings` namespace instead
// would pull core's *entire* barrel (nodemailer, the Razorpay/Shopify HMAC
// signing code, ...) into the browser bundle, which crashes on load the
// moment any of that code's own `node:crypto` imports get evaluated
// client-side (Vite externalizes Node builtins for the browser and throws
// on any property access — see settingsShared.ts's own header comment on
// why these pure helpers live apart from the DB-touching settings module).
import { type BookingRuleField, bookingWindowIsClosed, cancelCutoffExceedsNotice } from "getbooqin-core/booking/settingsShared";
import { requireTenant } from "~/tenant.server";
import { getClerkClient } from "~/session.server";
import { AlertError, Badge, TimezoneSelect, Toggle, useToast } from "~/components/ui";
import { IntegrationRow, LogoMark, WeeklyHoursEditor } from "~/components/onboarding";
import { UpgradePrompt } from "~/components/upgrade";
import type { PlanId } from "getbooqin-core/billing/plans";
import * as PaymentLinks from "getbooqin-core/booking/paymentLinks";
import { embedSnippet } from "getbooqin-core/booking/embed";
import { WhatsAppCard } from "~/components/whatsapp";
import { DashboardLayoutCard, VocabularyFields, overviewCards, type OverviewCardKey } from "~/components/account";
import {
  SettingsShell, Row, RowInput, RowSelect, RowTextarea, ToggleRow, Segmented, ValueRow, SettingsCard, isSettingsPage,
  MemberRow, PendingInviteRow, InviteMemberCard, TeamReadOnlyNotice, TeamEmptyHint,
} from "~/components/settings";
import { INTEGRATIONS, vocabFor, useVocabulary, withDefaultTerms, type Terms } from "~/lib/presets";
import { BillingPage } from "~/components/billing";
import { PHONE_PATTERN } from "~/lib/validation";
import { CURRENCIES } from "~/lib/currency";

export const meta: Route.MetaFunction = () => [{ title: "Settings · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Settings moved off tab-nav onto the ?page= rail; a bookmarked or
  // linked ?tab=... URL from before that migration used to silently land
  // on General instead of the section it named (UX audit's #7 finding,
  // second half — the dashboard._index.tsx empty-state hrefs already
  // worked around this same gap by never emitting a ?tab= link in the
  // first place, but an old external link still can). Only rewrites when
  // ?page= isn't already present, so a modern link that happens to also
  // carry a stray ?tab= isn't clobbered.
  if (url.searchParams.has("tab") && !url.searchParams.has("page")) {
    url.searchParams.set("page", url.searchParams.get("tab")!);
    url.searchParams.delete("tab");
    throw redirect(url.pathname + url.search);
  }

  // Every page under Settings — General, Business template, Booking
  // rules, Notifications, Integrations, Team — is business configuration
  // or sensitive data (integration credentials, the full team roster with
  // emails), so this gates the
  // *loader* at "admin" too, not just the action below. A write/read
  // teammate shouldn't see any of it, not just be blocked from editing it
  // — unlike the operational dashboard routes (bookings/services/etc.),
  // whose loaders intentionally stay at the default "read".
  const { userId, connection, shop, platform, role: viewerRole } = await requireTenant(request, params.connectionId, "admin");
  const settings = await Settings.getSettings(shop, platform);
  const connections = await listUserConnections(userId);
  const isManual = platform === "manual";

  // getSettings() always seeds business_email/admin_email blank (core's
  // defaultSettings() has no way to know the account's real address at
  // read time) even though the account holding this connection already
  // has one — a fresh account showed two empty email fields it had no
  // reason to (UX audit's D3 finding). Presentation-layer prefill only,
  // same as businessNameValue below — doesn't touch stored settings, so a
  // merchant who deliberately wants a different notification address
  // still just types over it and saves.
  const clerkUser = await getClerkClient().users.getUser(userId);
  const accountEmail =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";

  // Every notification the system actually sends, with a per-message on/off
  // switch and editable subject/body — the page previously exposed four
  // blanket switches and nothing about what was actually going out (Defect
  // Dossier's BQ-34 finding). Resolved and preview-rendered here, server-
  // side, rather than shipping the raw TEMPLATE_DEFS registry + a token
  // renderer to the client — there are only ~16 of these, cheap to
  // precompute all at once.
  // Every message in TEMPLATE_DEFS is now unconditionally real: the four
  // that used to be capability-gated (awaiting payment, payment received,
  // chat lead, visit summary) belonged to the dark surfaces Phase 1
  // removed, so there is nothing left to filter and no way for the page
  // to advertise a notification the product can't send (Defect Dossier's
  // R2-09/R3-02 findings, resolved by deletion rather than by a filter).
  const previewTokens = Mailer.previewTokens(settings);
  const notificationMessages = Mailer.TEMPLATE_DEFS.map((def) => {
    const subject = Settings.template(settings, `${def.key}_subject`, def.subject);
    const body = Settings.template(settings, `${def.key}_body`, def.body);
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      description: def.description,
      enabled: settings.template_enabled?.[def.key] !== false,
      subject,
      body,
      isCustomized: !!settings.templates?.[`${def.key}_subject`] || !!settings.templates?.[`${def.key}_body`],
      previewSubject: Mailer.renderTemplate(subject, previewTokens),
      previewBody: Mailer.renderTemplate(body, previewTokens),
    };
  });

  // canManage is the one flag every control on the Team page gates on
  // (docs/team-ui-spec.md §0/§1.1) — hide, never disable, for a viewer who
  // can't act on it. In practice this loader's own "admin" minRole already
  // means viewerRole is always "admin" or "owner" by the time we get here,
  // but the Team page's own rendering still branches on it explicitly
  // rather than assuming that, so it stays correct if that routing
  // decision is ever revisited independently of this page.
  const canManageTeam = viewerRole === "owner" || viewerRole === "admin";
  const rawMembers = await Team.listMembers(connection.id);
  const rawPendingInvites = canManageTeam ? await Team.listPendingInvites(connection.id) : [];

  // core's User model has no name field — Clerk owns that. One bulk lookup
  // (not one getUser() call per member) for the whole roster.
  const memberClerkUsers = rawMembers.length
    ? (await getClerkClient().users.getUserList({ userId: rawMembers.map((m) => m.userId) })).data
    : [];
  const clerkByUserId = new Map(memberClerkUsers.map((u) => [u.id, u]));
  function memberDisplay(userId: string, email: string): { name: string; initials: string } {
    const cu = clerkByUserId.get(userId);
    const name = ([cu?.firstName, cu?.lastName].filter(Boolean).join(" ") || email.split("@")[0] || "Member").trim();
    const initials =
      name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]!.toUpperCase())
        .join("") || "U";
    return { name, initials };
  }

  const inviteDateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  const members = rawMembers.map((m) => ({ userId: m.userId, ...memberDisplay(m.userId, m.email), email: m.email, role: m.role }));
  const pendingInvites = rawPendingInvites.map((i) => ({
    inviteId: i.id,
    email: i.email,
    role: i.role,
    invitedAt: inviteDateFormatter.format(i.createdAt),
  }));

  // Billing snapshot for the page below. Read-only in 2a — there is no
  // upgrade path until the payment rails go in (2c), and a button that
  // 404s is worse than a plan you can see but not yet change.
  // Before reading entitlements, not after: if the merchant has just
  // paid and the webhook never arrived, everything below would render
  // the stale plan — still badged "Current", still offering the upgrade
  // they already bought. Asks the provider only when there is an
  // unactivated mandate to ask about, so an account that is already
  // active costs no round trip.
  //
  // Errors are swallowed on purpose. Reconciling is an improvement on
  // the page, not a precondition for it; Razorpay being slow must not
  // stop someone reading their own billing settings.
  const preRow = await Subscriptions.get(connection.id);
  if (preRow && BillingReconcile.worthReconciling(preRow)) {
    await BillingReconcile.reconcileSubscription(connection.id).catch(() => undefined);
  }

  const entitlements = await Entitlements.entitlementsFor(connection.id);
  const subscriptionRow = await Subscriptions.get(connection.id);
  // What the merchant would actually be billed in, not what the row
  // happens to say — a subscription that has never paid has a currency
  // nobody has decided yet, and showing USD prices to a shop that will
  // be charged in ₹ is a lie the checkout then refuses to honour.
  const billingCurrency = await Checkout.resolveBillingCurrency(connection.id, entitlements.currency);
  const usage = await Billing.usageSnapshot(shop, platform, connection.id, userId);

  // Small enough to inline, so the card shows the real code rather than
  // a placeholder the merchant has to download to check.
  const bookingQr = await Qr.qrDataUrl(settings.booking_page_url, { width: 240 });

  // The widest span any resource is open on each day — the read side of
  // setBusinessHours. Paired with the count, because the card needs to
  // warn before overwriting more than one person's schedule.
  const [businessHours, resourceCount] = await Promise.all([
    Data.businessHours(shop, platform),
    Data.activeResourceCount(shop, platform),
  ]);

  // The account and Meta's verdict on our templates, read from our own
  // cache rather than from Meta — the webhook keeps it fresh, and a
  // settings page load is the wrong place to spend a Graph call. The
  // "Refresh status" button is there for when the webhook was missed.
  const whatsappAccount = await WhatsAppAccounts.forConnection(connection.id);
  const whatsapp = {
    entitled: entitlements.features.has("whatsapp"),
    // The publishable half of Meta's config, same class of value as a
    // Clerk publishable key: designed to ship in a client bundle. The
    // app *secret* never leaves the server.
    appId: process.env.META_APP_ID ?? "",
    configId: process.env.META_WHATSAPP_CONFIG_ID ?? "",
    account: whatsappAccount
      ? {
          id: whatsappAccount.id,
          displayPhoneNumber: whatsappAccount.displayPhoneNumber,
          verifiedName: whatsappAccount.verifiedName,
          status: whatsappAccount.status,
          onboardingMode: whatsappAccount.onboardingMode,
          qualityRating: whatsappAccount.qualityRating,
          lastError: whatsappAccount.lastError,
        }
      : null,
    templates: whatsappAccount
      ? (await WhatsAppTemplates.statesFor(whatsappAccount.id)).map((t) => ({
          key: t.key,
          name: t.name,
          status: t.status,
          rejectedReason: t.rejectedReason,
        }))
      : [],
  };

  return {
    bookingQr,
    businessHours,
    resourceCount,
    whatsapp,
    settings,
    billing: {
      plan: entitlements.plan,
      status: entitlements.status,
      trialEndsAt: entitlements.trialEndsAt ? entitlements.trialEndsAt.toISOString() : null,
      trialDaysLeft: entitlements.trialDaysLeft,
      currentPeriodEnd: entitlements.currentPeriodEnd ? entitlements.currentPeriodEnd.toISOString() : null,
      cancelAtPeriodEnd: entitlements.cancelAtPeriodEnd,
      // Cached on the row by the charge webhook, so this costs no
      // provider round trip. Null until the first payment clears.
      paymentMethod: subscriptionRow?.paymentMethodLabel
        ? { kind: subscriptionRow.paymentMethodKind, label: subscriptionRow.paymentMethodLabel }
        : null,
      currency: billingCurrency,
      sellable: Checkout.sellablePrices(billingCurrency),
      // Pre-filled from whatever the account already told us, so a
      // returning merchant isn't asked twice.
      tax: {
        // In order of how much each actually knows.
        //
        // What they already saved wins outright. Then the timezone they
        // picked during onboarding, which is the one thing on file that
        // says where the business *is* — a merchant in Amsterdam is not
        // asked to tell us they are in the Netherlands.
        //
        // Currency comes last and only for INR, because it is a claim
        // about a price list rather than about a country: a business
        // pricing in EUR could be in any of twenty of them, and
        // guessing wrong here puts the wrong tax treatment on a real
        // invoice. Anything unrecognised stays blank and they choose.
        country:
          subscriptionRow?.taxCountry ||
          Tax.countryFromTimezone(settings.timezone) ||
          (billingCurrency === "INR" ? "IN" : ""),
        taxId: subscriptionRow?.taxId ?? "",
        note: Tax.taxNote(subscriptionRow?.taxStatus ?? "", subscriptionRow?.taxCountry ?? ""),
        billingName: subscriptionRow?.billingName ?? "",
        billingAddress: subscriptionRow?.billingAddress ?? "",
      },
      // The screen needs it because the VAT field's label and whether
      // it is required are the same decision.
      requireEuVatId: Tax.requireEuVatIdFromEnv(),
      billingCycle: entitlements.billingCycle,
      inGrace: entitlements.inGrace,
      providerName: billingCurrency === "INR" ? "Razorpay" : "PayPal",
      returnedFromCheckout: url.searchParams.get("checkout") === "return",
      // A mandate exists at the provider but nothing has been paid on
      // it yet — an authorisation that has not been charged, or a
      // payment still settling.
      awaitingActivation: !!preRow?.providerSubscriptionId && entitlements.status !== "active",
      invoices: (await Invoices.listInvoices(connection.id)).map((inv) => ({
        id: inv.id,
        number: inv.number,
        issuedAt: inviteDateFormatter.format(inv.issuedAt),
        amount: Invoices.invoiceAmount(inv.amountMinor, inv.currency),
        planName: Plans.PLANS[inv.planId as keyof typeof Plans.PLANS]?.name ?? inv.planId,
      })),
      features: [...entitlements.features],
      limits: Object.fromEntries(
        Object.entries(entitlements.limits).map(([k, v]) => [k, Number.isFinite(v) ? v : null])
      ) as Record<string, number | null>,
      usage,
      overrides: entitlements.overrides.map((o) => ({
        key: o.key,
        value: o.value,
        reason: o.reason,
        expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null,
      })),
    },
    viewerRole,
    canManageTeam,
    members,
    pendingInvites,
    notificationMessages,
    connections,
    currentConnectionId: connection.id,
    isManual,
    shop,
    accountEmail,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  // "admin" here is redundant with the loader's own bump above (a
  // write/read viewer never even reaches this far), but kept explicit per
  // the orchestrator's decision — this is the security-sensitive one, and
  // every team-management branch below depends on it being enforced right
  // here regardless of what the loader already checked.
  const { userId, shop, platform } = await requireTenant(request, params.connectionId, "admin");
  const form = await request.formData();
  const section = String(form.get("_section") ?? "");

  if (section === "invite_member") {
    const email = String(form.get("email") ?? "");
    const role = String(form.get("role") ?? "write");
    try {
      const { invite, emailSent, alreadyPending } = await Team.inviteMember({ connectionId: params.connectionId, email, role, invitedByUserId: userId });
      return {
        saved: true,
        inviteSent: true,
        invitedEmail: invite.email,
        emailSent,
        alreadyPending,
      };
    } catch (err) {
      if (isGetBooqinError(err)) return { inviteError: err.message };
      throw err;
    }
  } else if (section === "update_member_role") {
    const targetUserId = String(form.get("target_user_id") ?? "");
    const role = String(form.get("role") ?? "");
    try {
      await Team.updateMemberRole({ connectionId: params.connectionId, targetUserId, role, actingUserId: userId });
      return { saved: true };
    } catch (err) {
      // No UI control ever submits this against the owner row (see
      // Team.updateMemberRole's own comment) — but the reject there is
      // enforced by throwing, and this action used to let that exception
      // reach the caller unhandled, turning a deliberate authorization
      // boundary into an unhandled-exception 500 for anyone who posted
      // this directly (QA found the same shape of bug in requireTenant's
      // cross-tenant 404 — this is the same class, one layer in).
      if (isGetBooqinError(err)) return { error: err.message };
      throw err;
    }
  } else if (section === "remove_member") {
    const targetUserId = String(form.get("target_user_id") ?? "");
    try {
      await Team.removeMember({ connectionId: params.connectionId, targetUserId, actingUserId: userId });
      return { saved: true };
    } catch (err) {
      if (isGetBooqinError(err)) return { error: err.message };
      throw err;
    }
  } else if (section === "resend_invite") {
    const inviteId = String(form.get("invite_id") ?? "");
    try {
      const { invite, emailSent } = await Team.resendInvite({ connectionId: params.connectionId, inviteId, actingUserId: userId });
      return { saved: true, inviteSent: true, invitedEmail: invite.email, emailSent };
    } catch (err) {
      if (isGetBooqinError(err)) return { error: err.message };
      throw err;
    }
  } else if (section === "revoke_invite") {
    const inviteId = String(form.get("invite_id") ?? "");
    try {
      await Team.revokeInvite({ connectionId: params.connectionId, inviteId, actingUserId: userId });
      return { saved: true };
    } catch (err) {
      if (isGetBooqinError(err)) return { error: err.message };
      throw err;
    }
  } else if (section === "payments") {
    // Nothing here reaches a payment provider. These two strings are
    // rendered into a link the customer pays through directly, so the
    // only validation that matters is "will this produce a working
    // link" — and a merchant sending themselves one rupee is the only
    // check that catches a valid-but-wrong address.
    const upi = String(form.get("upi_id") ?? "").trim();
    const payPal = String(form.get("paypal_me") ?? "").trim();

    if (upi && !PaymentLinks.isUpiId(upi)) {
      return { error: "That doesn't look like a UPI ID. It should look like name@bank." };
    }
    if (payPal && !PaymentLinks.payPalMeHandle(payPal)) {
      return { error: "That doesn't look like a PayPal.me link. Try paypal.me/yourname." };
    }

    await Settings.setSettings(shop, platform, {
      upi_id: upi,
      paypal_me: PaymentLinks.payPalMeHandle(payPal),
    });
    return { saved: true };
  } else if (section === "branding") {
    await Settings.setSettings(shop, platform, {
      brand_logo: String(form.get("brand_logo") ?? ""),
      brand_accent: String(form.get("brand_accent") ?? "").trim(),
    });
    return { saved: true };
  } else if (section === "general") {
    await Settings.setSettings(shop, platform, {
      business_name: String(form.get("business_name") ?? ""),
      business_email: String(form.get("business_email") ?? ""),
      business_phone: String(form.get("business_phone") ?? ""),
      default_country_code: String(form.get("default_country_code") ?? "").trim(),
      business_description: String(form.get("business_description") ?? ""),
      business_address: String(form.get("business_address") ?? ""),
      privacy_notice_url: String(form.get("privacy_notice_url") ?? "").trim(),
      currency: String(form.get("currency") ?? "USD"),
      currency_symbol: String(form.get("currency_symbol") ?? "$"),
      timezone: String(form.get("timezone") ?? "UTC"),
    });
  } else if (section === "rules") {
    const ruleValues = {
      slot_interval: Number(form.get("slot_interval") ?? 30),
      min_notice_hours: Number(form.get("min_notice_hours") ?? 2),
      max_advance_days: Number(form.get("max_advance_days") ?? 60),
      cancel_cutoff_hours: Number(form.get("cancel_cutoff_hours") ?? 24),
      waitlist_offer_window_hours: Number(form.get("waitlist_offer_window_hours") ?? 4),
    };
    // Server-side range + collision validation — the four number fields'
    // only guard used to be their <input>'s own HTML `min` attribute,
    // which a stale tab, a browser that ignores it, or a direct POST all
    // bypass equally easily. Posting slot_interval=-5, min_notice_hours=
    // -100, max_advance_days=0 previously returned 200 OK and saved every
    // value verbatim — the negative interval then fed straight into the
    // slot engine as its own absolute value (GetBooqin clinic audit's
    // BR-01 finding), and a minimum notice past the maximum advance window
    // silently closed online booking entirely with no warning anywhere
    // (BR-02 finding).
    const ruleErrors = Settings.validateBookingRules(ruleValues);
    if (Object.keys(ruleErrors).length > 0) {
      return { ruleErrors };
    }
    await Settings.setSettings(shop, platform, {
      ...ruleValues,
      auto_confirm: form.get("auto_confirm") === "on",
      allow_cancel: form.get("allow_cancel") === "on",
      require_phone: form.get("require_phone") === "on",
      require_email: form.get("require_email") === "on",
      waitlist_enabled: form.get("waitlist_enabled") === "on",
    });
    return { saved: true };
  } else if (section === "billing_upgrade") {
    // Creates the mandate at Razorpay and bounces the merchant to their
    // hosted authorisation page. Nothing is granted here — the plan is
    // written by the webhook, and only once money has actually moved
    // (see core/src/billing/checkout.ts).
    try {
      const { plan, cycle } = Checkout.parsePlanSelection(form.get("plan"), form.get("cycle"));
      const started = await Checkout.startCheckout({
        connectionId: params.connectionId!,
        plan,
        cycle,
        country: String(form.get("country") ?? ""),
        taxId: String(form.get("tax_id") ?? ""),
        billingName: String(form.get("billing_name") ?? ""),
        billingAddress: String(form.get("billing_address") ?? ""),
        // Honoured by PayPal, ignored by Razorpay — see the provider
        // interface. Landing back in the product is the difference
        // between a successful payment reading as successful and
        // reading as a dead end.
        returnUrl: `${new URL(request.url).origin}/dashboard/${params.connectionId}/settings?page=billing&checkout=return`,
        cancelUrl: `${new URL(request.url).origin}/dashboard/${params.connectionId}/settings?page=billing`,
      });
      // A 303 so the browser re-issues as GET — a POST redirected to
      // Razorpay's page would be re-submitted on back-navigation.
      throw redirect(started.approvalUrl, 303);
    } catch (err) {
      if (isGetBooqinError(err)) return { error: err.message };
      throw err;
    }
  } else if (section === "billing_details") {
    // The tax identity and the invoice recipient, saved on their own
    // rather than only riding along with an upgrade. Validated with the
    // same function checkout uses, so a merchant finds out here that
    // their tax number is unusable rather than at the moment they try
    // to pay.
    const country = String(form.get("country") ?? "").trim();
    const taxId = String(form.get("tax_id") ?? "").trim();
    const tax = Tax.validateTaxIdentity(
      { country, taxId },
      { requireEuVatId: Tax.requireEuVatIdFromEnv() }
    );
    if (!tax.identity) return { error: tax.problems[0]!.message };

    await Subscriptions.saveBillingDetails(params.connectionId!, {
      country: tax.identity.country,
      taxId: tax.identity.taxId,
      taxStatus: tax.identity.status,
      billingName: String(form.get("billing_name") ?? "").trim(),
      billingAddress: String(form.get("billing_address") ?? "").trim(),
    });
    return { saved: true, detailsSaved: true };
  } else if (section === "billing_cancel") {
    try {
      await Checkout.cancelAtPeriodEnd(params.connectionId!);
      return { saved: true, billingCancelled: true };
    } catch (err) {
      if (isGetBooqinError(err)) return { error: err.message };
      throw err;
    }
  } else if (section === "vocabulary") {
    // Free text, straight through. There is no "apply a template to this
    // shop" path any more, so nothing here can overwrite a booking rule,
    // a consent notice or an email body as a side effect of picking a
    // word — which is the entire reason presets, PRESET_CONTROLLED_KEYS
    // and the "Preset default / Customized" badges are gone (see core's
    // presets.ts). withDefaultTerms() fills any field the merchant
    // cleared, so a blank input can never render an empty noun in a
    // heading.
    const current = await Settings.getSettings(shop, platform);
    const terms = withDefaultTerms({
      booking_single: String(form.get("term_booking_single") ?? ""),
      booking_plural: String(form.get("term_booking_plural") ?? ""),
      service_single: String(form.get("term_service_single") ?? ""),
      service_plural: String(form.get("term_service_plural") ?? ""),
      resource_single: String(form.get("term_resource_single") ?? ""),
      resource_plural: String(form.get("term_resource_plural") ?? ""),
      customer_single: String(form.get("term_customer_single") ?? ""),
      customer_plural: String(form.get("term_customer_plural") ?? ""),
    });

    // Checked "cards" are the visible ones; anything in the full card
    // list that didn't come through in this submit was switched off.
    const visible = new Set(form.getAll("cards").map(String));
    const hidden = overviewCards({
      booking: terms.booking_single,
      service: terms.service_single,
      services: terms.service_plural,
      resource: terms.resource_single,
    })
      .map((c) => c.key)
      .filter((key) => !visible.has(key));

    await Settings.setSettings(shop, platform, { terms, hidden_overview_cards: hidden });
    void current;
    return { saved: true };
  } else if (section === "business_hours") {
    // Parsed server-side and clamped, because the card posts JSON from a
    // controlled component and a hand-rolled POST is the only other way
    // in. Times that do not parse are dropped rather than rejected —
    // Data.setBusinessHours already refuses a day whose end is not after
    // its start, and the rest of the week should still save.
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(String(form.get("hours") ?? "[]"));
    } catch {
      return { error: "Those hours didn't save — please try again." };
    }

    const days = (Array.isArray(parsed) ? parsed : [])
      .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : {}))
      .map((row) => ({
        day: Number(row.dayOfWeek),
        open: row.open === true,
        start: String(row.start ?? "").slice(0, 5),
        end: String(row.end ?? "").slice(0, 5),
      }))
      .filter((row) => Number.isInteger(row.day) && row.day >= 0 && row.day <= 6);

    const { resourcesUpdated } = await Data.setBusinessHours(shop, platform, days);
    // Nothing to write the hours onto is a real state — an account that
    // has somehow lost its resource — and silently reporting success
    // would leave a merchant with a booking page that offers nothing.
    if (resourcesUpdated === 0) {
      return { error: "We couldn't find anything bookable to apply these hours to. Please get in touch." };
    }
    return { saved: true };
  } else if (section === "disconnect_store") {
    const targetId = String(form.get("connection_id") ?? "");
    await disconnectConnection(userId, targetId);
    // Disconnecting the store currently being viewed leaves this dashboard
    // unreachable (tenant.server.ts's requireTenant 404s non-active
    // connections) — bounce through /dashboard, which redirects to whatever
    // active store is left, or onboarding if none is.
    if (targetId === params.connectionId) {
      throw redirect("/dashboard");
    }
    return { saved: true };
  } else if (section === "notifications") {
    await Settings.setSettings(shop, platform, {
      notify_customer: form.get("notify_customer") === "on",
      notify_admin: form.get("notify_admin") === "on",
      admin_email: String(form.get("admin_email") ?? ""),
      reminder_enabled: form.get("reminder_enabled") === "on",
      reminder_hours: Number(form.get("reminder_hours") ?? 24),
    });
  } else if (section === "notification_template") {
    // Each message row is its own tiny form (on/off toggle, or the
    // subject/body editor), independent of the blanket switches above —
    // the "reuse that mechanism" piece of BQ-34: TEMPLATE_DEFS/
    // Settings.template() already carry a shipped default per key plus a
    // per-shop override, this just adds the save path that was missing.
    const key = String(form.get("key") ?? "");
    const intent = String(form.get("_action") ?? "");
    const current = await Settings.getSettings(shop, platform);
    if (intent === "toggle") {
      await Settings.setSettings(shop, platform, {
        template_enabled: { ...current.template_enabled, [key]: form.get("enabled") === "on" },
      });
    } else if (intent === "reset") {
      const templates = { ...current.templates };
      delete templates[`${key}_subject`];
      delete templates[`${key}_body`];
      await Settings.setSettings(shop, platform, { templates });
    } else {
      await Settings.setSettings(shop, platform, {
        templates: {
          ...current.templates,
          [`${key}_subject`]: String(form.get("subject") ?? ""),
          [`${key}_body`]: String(form.get("body") ?? ""),
        },
      });
    }
    return { saved: true, savedKey: key };
  }

  return { saved: true };
}

export default function SettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const {
    settings, billing, notificationMessages, connections, currentConnectionId, isManual, shop, accountEmail, canManageTeam, members, pendingInvites, bookingQr, whatsapp, businessHours, resourceCount,
  } = loaderData;
  const v = useVocabulary();
  // defaultSettings() seeds business_name to the connection's own opaque
  // shop id, so a manual connection that never completed onboarding step 1
  // shows that raw manual-<uuid> string as its "business name" instead of
  // an empty field prompting the owner to set a real one (UX audit's D2
  // finding, same root cause as the sidebar label fix in
  // dashboard.$connectionId.tsx).
  const businessNameValue = isManual && settings.business_name === shop ? "" : settings.business_name;
  const businessEmailValue = settings.business_email || accountEmail;
  const adminEmailValue = settings.admin_email || accountEmail;
  const [searchParams] = useSearchParams();
  const rawPage = searchParams.get("page");
  // An unknown ?page= value falls back to General. The three slugs that
  // used to need their own carve-outs here — payments, whatsapp,
  // visit_summaries, each a real slug that rendered a heading and nav
  // highlight with zero form fields while its flag was off (UX audit's C4
  // finding) — are simply not settings pages any more, so isSettingsPage()
  // rejects them on its own.
  const page = isSettingsPage(rawPage) ? rawPage : "general";
  // Shopify is shipped dark: no plan grants it, so the row is hidden
  // outright rather than shown disabled. A "coming soon" tile for
  // something already built, that an admin can switch on per account,
  // would invite questions nobody wants to answer yet — and an account
  // that *has* been granted it sees the real thing.
  const canUseShopify = billing.features.includes("shopify") || !isManual;
  const savedAt = actionData?.saved ? "just now" : undefined;
  const base = `/dashboard/${currentConnectionId}`;

  // Field-level errors from a blocked "rules" save (BR-01/BR-02) — see the
  // action's validateBookingRules call above.
  const ruleErrors: Partial<Record<BookingRuleField, string>> =
    (actionData && "ruleErrors" in actionData ? actionData.ruleErrors : undefined) ?? {};
  const ruleErrorSummary = Object.keys(ruleErrors).length > 0 ? "Fix the highlighted fields below before saving." : undefined;
  const bookingWindowClosed = bookingWindowIsClosed(settings);
  const cutoffExceedsNotice = cancelCutoffExceedsNotice(settings);

  return (
    <SettingsShell active={page} base={base}>
      {page === "general" && (
        <SettingsCard saveLabel="Save changes" savedAt={savedAt}>
          <input type="hidden" name="_section" value="general" />
          <Row label="Business name">
            <RowInput name="business_name" defaultValue={businessNameValue} placeholder={isManual ? "e.g. Kapsalon Vondel" : undefined} cap={9999} />
          </Row>
          <Row label="Business email">
            <RowInput name="business_email" type="email" defaultValue={businessEmailValue} />
          </Row>
          <Row label="Business phone">
            <RowInput type="tel" name="business_phone" defaultValue={settings.business_phone} pattern={PHONE_PATTERN} />
          </Row>
          {/* A phone number saved with no country code leaves the
              business unable to reliably dial it back (GetBooqin clinic
              audit's PB-03 finding). This is prepended automatically to
              any phone number typed without one, business-wide (booking
              form, staff-entered bookings, client records) — see
              bookingsShared.ts's normalizePhone(). */}
          <Row label="Default country code" hint="Added automatically to phone numbers entered without one, e.g. +91">
            <RowInput name="default_country_code" defaultValue={settings.default_country_code} placeholder="+91" cap={100} />
          </Row>
          {/* Shown on the public booking page's business header — it used
              to give a prospective client only a name and a bare list of
              service durations, with none of this already-collected
              context reaching the page (Defect Dossier's BQ-33 finding). */}
          <Row label="Description" hint="One line, shown on your booking page">
            <RowInput name="business_description" defaultValue={settings.business_description} cap={160} />
          </Row>
          <Row label="Address" hint="Shown on your booking page">
            <RowInput name="business_address" defaultValue={settings.business_address} cap={9999} />
          </Row>
          {/* The booking form's required consent checkbox links here — see
              the "rules" page's own note — falling back to GetBooqin's own
              privacy page when this is blank. Every business collecting
              real contact details (and for a clinic, health-adjacent
              notes) should point this at their own notice once they have
              one (GetBooqin clinic audit's TS-01 finding). */}
          <Row label="Privacy notice URL" hint="Linked from the consent checkbox on your booking form. Leave blank to use GetBooqin's own privacy page.">
            <RowInput type="url" name="privacy_notice_url" defaultValue={settings.privacy_notice_url} placeholder="https://your-clinic.example/privacy" cap={9999} />
          </Row>
          {/* One dropdown driving both stored values, replacing two free-text
              fields that could independently disagree — nothing stopped
              "INR" sitting beside "$", which would render every price
              wrongly on the public booking page with no warning (GetBooqin
              clinic audit's CR-03 finding). */}
          <Row label="Currency">
            <CurrencyRowSelect defaultCode={settings.currency} defaultSymbol={settings.currency_symbol} />
          </Row>
          <Row label="Timezone" hint="All times shown in this zone">
            <TimezoneSelect defaultValue={settings.timezone} />
          </Row>
        </SettingsCard>
      )}

      {page === "general" && (
        <BusinessHoursCard
          hours={businessHours}
          resourceCount={resourceCount}
          canManageStaff={billing.features.includes("staff")}
          connectionId={currentConnectionId}
          savedAt={savedAt}
        />
      )}

      {page === "general" && (
        <BrandingCard
          connectionId={currentConnectionId}
          canBrand={billing.features.includes("branding")}
          currentPlan={billing.plan}
          logo={settings.brand_logo}
          accent={settings.brand_accent}
          savedAt={savedAt}
        />
      )}

      {page === "general" && <VocabularySection settings={settings} saved={!!actionData?.saved} savedAt={savedAt} />}

      {page === "rules" && (
        <SettingsCard saveLabel="Save booking rules" savedAt={savedAt} error={ruleErrorSummary}>
          <input type="hidden" name="_section" value="rules" />
          {/* Every save producing zero bookable slots for the next 30+ days
              used to go through silently, green tick and all — a minimum
              notice of 3000 hours against a 90-day advance window closed
              online booking entirely with nothing anywhere saying so
              (GetBooqin clinic audit's BR-02 finding). Blocked at save time
              now (see the action's validateBookingRules call); this repeats
              as a standing banner too, since a value written before this
              fix shipped is still live until someone opens this page. */}
          {bookingWindowClosed && (
            <p className="m-0 mx-[18px] mt-[14px] rounded-[8px] bg-danger-bg px-3 py-2 text-[12.5px] font-medium text-danger">
              Online booking is currently closed: minimum notice ({settings.min_notice_hours}h) leaves no bookable
              moment before your {settings.max_advance_days}-day maximum advance window. Fix one of the two fields
              below to reopen it.
            </p>
          )}
          <Row label="Slot interval (minutes)" hint="The spacing between bookable start times.">
            <RowInput type="number" name="slot_interval" min={5} max={480} defaultValue={settings.slot_interval} cap={140} />
            {ruleErrors.slot_interval && <p className="m-0 mt-1 text-[12px] text-danger">{ruleErrors.slot_interval}</p>}
          </Row>
          <Row label="Minimum notice (hours)" hint="How soon before a slot someone can still book it.">
            <RowInput type="number" name="min_notice_hours" min={0} max={720} defaultValue={settings.min_notice_hours} cap={140} />
            {ruleErrors.min_notice_hours && <p className="m-0 mt-1 text-[12px] text-danger">{ruleErrors.min_notice_hours}</p>}
          </Row>
          <Row label="Max advance booking (days)" hint="How far ahead your calendar opens up.">
            <RowInput type="number" name="max_advance_days" min={1} max={730} defaultValue={settings.max_advance_days} cap={140} />
            {ruleErrors.max_advance_days && <p className="m-0 mt-1 text-[12px] text-danger">{ruleErrors.max_advance_days}</p>}
          </Row>
          <Row label="Cancellation cutoff (hours before start)" hint={`How late a ${v.customerOne} can still cancel.`}>
            <RowInput type="number" name="cancel_cutoff_hours" min={0} max={720} defaultValue={settings.cancel_cutoff_hours} cap={140} />
            {ruleErrors.cancel_cutoff_hours && <p className="m-0 mt-1 text-[12px] text-danger">{ruleErrors.cancel_cutoff_hours}</p>}
          </Row>
          {/* A cutoff longer than the notice window means a booking made at
              the earliest allowed moment is un-cancellable from the instant
              it's created — legitimate for e.g. deliberately-final
              same-day slots, so this only warns, it never blocks a save
              (GetBooqin clinic audit's PB-01 finding; see the un-cancellable
              patient's own fix on the manage-booking page). */}
          {cutoffExceedsNotice && (
            <p className="m-0 mx-[18px] mt-[14px] rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
              Cancellation cutoff ({settings.cancel_cutoff_hours}h) is longer than minimum notice ({settings.min_notice_hours}h)
              — anyone who books inside that gap won't be able to cancel online at all.
            </p>
          )}
          <ToggleRow name="auto_confirm" label="Auto-confirm new bookings" hint="Skip manual approval for new bookings" defaultChecked={settings.auto_confirm} />
          <ToggleRow name="require_phone" label="Require a phone number" hint="Ask for a phone number when booking" defaultChecked={settings.require_phone} />
          {/* Email was hard-required with no matching setting at all — a
              walk-in patient with no email address couldn't book online,
              full stop (GetBooqin clinic audit's PB-03 finding). Defaults
              on, so no shop's booking form changes until this is explicitly
              turned off. */}
          <ToggleRow name="require_email" label="Require an email address" hint="Ask for an email address when booking" defaultChecked={settings.require_email} />
          <ToggleRow name="waitlist_enabled" label="Offer freed slots to the waitlist" hint="Cancelled, declined or no-show bookings get offered to the next matching waitlist entry" defaultChecked={settings.waitlist_enabled} />
          <Row label="Waitlist offer window (hours)" hint={settings.waitlist_enabled ? "How long someone has to claim an offered slot before it moves to the next person." : "Inactive — turn on \"Offer freed slots to the waitlist\" above for this to take effect."}>
            {/* Stayed editable and looked identically live whether or not
                the toggle above was on, with nothing indicating it was
                inert (GetBooqin clinic audit's finding under BR-02's rule
                table, "waitlist_offer_window"). The hint above is the fix,
                not a disabled input — a `disabled` field is dropped from
                FormData entirely on submit, which would silently reset
                this to the action's fallback default instead of preserving
                whatever a merchant had it set to before switching the
                toggle off. */}
            <RowInput type="number" name="waitlist_offer_window_hours" min={0.25} max={168} step={0.25} defaultValue={settings.waitlist_offer_window_hours} cap={140} />
            {ruleErrors.waitlist_offer_window_hours && <p className="m-0 mt-1 text-[12px] text-danger">{ruleErrors.waitlist_offer_window_hours}</p>}
          </Row>
          <ToggleRow name="allow_cancel" label={`Allow ${v.customers.toLowerCase()} to cancel`} hint={`Let ${v.customers.toLowerCase()} cancel their own ${v.bookingMany}`} defaultChecked={settings.allow_cancel} />
        </SettingsCard>
      )}

      {page === "notifications" && (
        <div className="flex flex-col gap-[14px]">
          <SettingsCard saveLabel="Save notification settings" savedAt={savedAt}>
            <input type="hidden" name="_section" value="notifications" />
            <ToggleRow
              name="notify_customer"
              label={`Email the ${v.customerOne}`}
              hint={`Sent on ${v.bookingOne} events`}
              defaultChecked={settings.notify_customer}
            />
            <ToggleRow name="notify_admin" label="Email the business" hint={`Sent on ${v.bookingOne} events`} defaultChecked={settings.notify_admin} />
            <Row label="Admin notification email">
              <RowInput name="admin_email" type="email" defaultValue={adminEmailValue} />
            </Row>
            {/* "Cuts no-shows by around a third" was an unsourced claim with
                nothing behind it (Defect Dossier's BQ-34 finding, item 5) —
                the hint now just says what the setting does. New copy
                added alongside that fix bypassed the vocabulary helper
                entirely (Defect Dossier's R2-05 finding). */}
            <ToggleRow
              name="reminder_enabled"
              label="Send reminder emails"
              hint={`Sent automatically before the ${v.bookingOne}`}
              defaultChecked={settings.reminder_enabled}
            />
            <Row label="Reminder lead time (hours)">
              <RowInput type="number" name="reminder_hours" min={1} defaultValue={settings.reminder_hours} cap={140} />
            </Row>
            {/* A reminder can only be "ahead of" a booking that itself had
                to be made with at least this much notice — set the lead
                time at or past the minimum notice and every booking made at
                the earliest permitted moment has its reminder due on
                arrival (Defect Dossier's BQ-34 finding, item 4; the sweep
                below now sends it right away rather than dropping it, but
                the setting combination itself is still worth a merchant's
                attention). */}
            {settings.reminder_enabled && settings.reminder_hours >= settings.min_notice_hours && (
              <p className="m-0 rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
                Reminder lead time ({settings.reminder_hours}h) is at or past your minimum {v.bookingOne} notice (
                {settings.min_notice_hours}h) — the earliest allowed {v.bookingOne} will have its reminder sent
                right away instead of ahead of time.
              </p>
            )}
          </SettingsCard>

          <NotificationMessagesCard messages={notificationMessages} vocab={v} />
        </div>
      )}

      {page === "billing" && <BillingPage billing={billing} connectionId={currentConnectionId} saved={!!actionData && "detailsSaved" in actionData && !!actionData.detailsSaved} error={actionData && "error" in actionData ? actionData.error : undefined} />}

      {page === "payments" && (
        <PaymentsPage
          connectionId={currentConnectionId}
          currency={settings.currency}
          businessName={settings.business_name}
          upiId={settings.upi_id}
          payPalMe={settings.paypal_me}
          savedAt={savedAt}
          error={actionData && "error" in actionData ? actionData.error : undefined}
        />
      )}

      {page === "integrations" && (
        <>
          {/* Only for an account an admin has granted it to. No plan
              includes WhatsApp — Meta will not let us onboard anyone
              until Tech Provider is approved — so an UpgradePrompt here
              would name a plan that does not grant it either. Hidden is
              honest; "upgrade for this" would not be. */}
          {whatsapp.entitled && (
            <WhatsAppCard
              connectionId={currentConnectionId}
              plan={billing.plan}
              entitled
              account={whatsapp.account}
              templates={whatsapp.templates}
              appId={whatsapp.appId}
              configId={whatsapp.configId}
            />
          )}
          <BookingQrCard connectionId={currentConnectionId} bookingUrl={settings.booking_page_url} vocab={v} qr={bookingQr} />
          <EmbedSnippetCard bookingUrl={settings.booking_page_url} vocab={v} />
          <div className="card">
            {INTEGRATIONS.filter(
              // Shopify is dark unless granted; WhatsApp has its own
              // card above and would otherwise appear twice, once as a
              // working integration and once as "coming soon".
              (integ) => (integ.id !== "shopify" || canUseShopify) && integ.id !== "whatsapp"
            ).map((integ) => {
              if (integ.id === "shopify") {
                return (
                  <IntegrationRow
                    key={integ.id}
                    id={integ.id}
                    name={integ.name}
                    initial={integ.initial}
                    tint={integ.tint}
                    tag={integ.tag}
                    blurb={integ.blurb}
                    detail={isManual ? undefined : settings.business_name || undefined}
                    connected={!isManual}
                    variant="settings"
                    action={
                      isManual ? (
                        <a href="/connect/shopify" className="btn-sec no-underline hover:no-underline">Connect</a>
                      ) : (
                        <span className="btn-sec pointer-events-none opacity-60">Connected</span>
                      )
                    }
                  />
                );
              }
              return (
                <IntegrationRow
                  key={integ.id}
                  id={integ.id}
                  name={integ.name}
                  initial={integ.initial}
                  tint={integ.tint}
                  tag="Coming soon"
                  blurb={integ.blurb}
                  connected={false}
                  variant="settings"
                  disabled
                />
              );
            })}
          </div>

          {/* The "Sales channels" list is gone. It existed to manage
              multiple Shopify connections, and with Shopify shipped dark
              it rendered exactly one row on every account saying "No
              store connected" above a Connect button that 402s. A card
              whose only content is the absence of the thing it manages
              is noise on the one page a merchant reads when something
              is wrong. Reconnecting the multi-store list is a revert of
              this hunk if Shopify is ever released generally. */}
        </>
      )}

      {page === "team" && (
        <TeamSection
          members={members}
          pendingInvites={pendingInvites}
          canManageTeam={canManageTeam}
          canChooseRole={billing.features.includes("team_roles")}
          connectionId={currentConnectionId}
          actionData={actionData}
        />
      )}
    </SettingsShell>
  );
}

type NotificationMessage = {
  key: string;
  group: string;
  label: string;
  description: string;
  enabled: boolean;
  subject: string;
  body: string;
  isCustomized: boolean;
  previewSubject: string;
  previewBody: string;
};

// Every notification the app actually sends, listed with a per-message
// on/off switch, an editable subject/body, and a live preview rendered
// against sample data — Settings > Notifications used to be four blanket
// switches with no visibility into what was actually going out (Defect
// Dossier's BQ-34 finding). Grouped by TEMPLATE_DEFS' own `group` field
// (Booking received, Confirmed, Cancelled, Reminder, Waitlist, ...).
function NotificationMessagesCard({ messages, vocab }: { messages: NotificationMessage[]; vocab: ReturnType<typeof useVocabulary> }) {
  const groups: { group: string; messages: NotificationMessage[] }[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && last.group === m.group) last.messages.push(m);
    else groups.push({ group: m.group, messages: [m] });
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Email templates</h2>
      </div>
      <div className="card-body flex flex-col gap-[18px]">
        {groups.map((g) => (
          <div key={g.group} className="flex flex-col gap-[8px]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">{vocabizeLabel(g.group, vocab)}</span>
            <div className="flex flex-col gap-[8px]">
              {g.messages.map((m) => (
                <MessageRow key={m.key} message={m} vocab={vocab} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// TEMPLATE_DEFS' labels ("Booking confirmed", "Upcoming booking reminder",
// "Notify the customer") are plain, preset-agnostic English written in
// core, which has no concept of a shop's vocabulary — bypassing the
// vocabulary helper the same way the rest of the new copy in this pass did
// (Defect Dossier's R2-05 finding). Word-boundary substitution here instead
// of hand-maintaining a per-message-key override list, so any future
// TEMPLATE_DEFS entry that reuses one of these words is covered for free.
function vocabizeLabel(text: string, vocab: ReturnType<typeof useVocabulary>): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return text
    .replace(/\bBookings\b/g, cap(vocab.bookingMany))
    .replace(/\bbookings\b/g, vocab.bookingMany)
    .replace(/\bBooking\b/g, cap(vocab.bookingOne))
    .replace(/\bbooking\b/g, vocab.bookingOne)
    .replace(/\bCustomers\b/g, cap(vocab.customers))
    .replace(/\bcustomers\b/g, vocab.customers.toLowerCase())
    .replace(/\bCustomer\b/g, cap(vocab.customerOne))
    .replace(/\bcustomer\b/g, vocab.customerOne);
}

// "Sent to {the customer|the business}" derived from the key's own prefix
// rather than baking it into every one of TEMPLATE_DEFS' description
// strings by hand — the recipient-facing word still comes from the shop's
// real vocabulary either way (Defect Dossier's BQ-34 finding, item 1).
function recipientLabel(key: string, vocab: ReturnType<typeof useVocabulary>): string {
  if (key.startsWith("customer_") || key.startsWith("waitlist_")) return `Sent to the ${vocab.customerOne}`;
  if (key.startsWith("admin_")) return "Sent to your team";
  return "";
}

function MessageRow({ message, vocab }: { message: NotificationMessage; vocab: ReturnType<typeof useVocabulary> }) {
  const [expanded, setExpanded] = useState<"none" | "preview" | "edit">("none");
  const toggleFetcher = useFetcher();
  const editFetcher = useFetcher();
  const resetFetcher = useFetcher();

  // toggleFetcher.formData reflects the in-flight submission optimistically
  // — a merchant flipping the switch sees it move immediately rather than
  // waiting on the round trip.
  const enabled =
    toggleFetcher.formData ? toggleFetcher.formData.get("enabled") === "on" : message.enabled;
  const label = vocabizeLabel(message.label, vocab);

  return (
    <div className="rounded-[9px] border border-line">
      <div className="flex items-center gap-3 px-3 py-[10px]">
        <toggleFetcher.Form method="post" onChange={(e) => toggleFetcher.submit(e.currentTarget)}>
          <input type="hidden" name="_section" value="notification_template" />
          <input type="hidden" name="_action" value="toggle" />
          <input type="hidden" name="key" value={message.key} />
          <Toggle name="enabled" defaultChecked={message.enabled} ariaLabel={`Send "${label}"`} />
        </toggleFetcher.Form>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-[2px]">
            <span className="text-body font-medium">{label}</span>
            {message.isCustomized && <span className="badge-neutral">Customized</span>}
          </div>
          <span className="text-[12px] text-muted">
            {recipientLabel(message.key, vocab) || message.description}
          </span>
        </div>
        <button type="button" className="btn-link shrink-0" onClick={() => setExpanded(expanded === "preview" ? "none" : "preview")}>
          {expanded === "preview" ? "Hide preview" : "Preview"}
        </button>
        <button type="button" className="btn-link shrink-0" onClick={() => setExpanded(expanded === "edit" ? "none" : "edit")}>
          {expanded === "edit" ? "Cancel" : "Edit"}
        </button>
      </div>

      {!enabled && (
        <p className="m-0 border-t border-line bg-canvas px-3 py-2 text-[12px] text-subtle">
          Turned off — this message won't be sent.
        </p>
      )}

      {expanded === "preview" && (
        <div className="flex flex-col gap-[6px] border-t border-line bg-canvas px-3 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Preview with sample data</span>
          <span className="text-body font-medium">{message.previewSubject}</span>
          <p className="m-0 whitespace-pre-wrap text-[13px] text-muted">{message.previewBody}</p>
        </div>
      )}

      {expanded === "edit" && (
        // Two sibling forms, not one nested inside the other — nesting
        // <form> is invalid HTML, and the browser silently mis-parses it on
        // hydration (the outer form closes early at the inner form's start
        // tag), which is what made "Reset to default" post correctly but
        // never actually take effect.
        <div className="flex flex-col gap-[10px] border-t border-line px-3 py-3">
          <editFetcher.Form method="post" className="flex flex-col gap-[10px]" onSubmit={() => setExpanded("none")}>
            <input type="hidden" name="_section" value="notification_template" />
            <input type="hidden" name="key" value={message.key} />
            <Row label="Subject">
              <RowInput name="subject" defaultValue={message.subject} cap={9999} />
            </Row>
            <Row label="Body">
              <RowTextarea name="body" defaultValue={message.body} rows={7} cap={9999} />
            </Row>
            <p className="m-0 text-[12px] text-subtle">
              Tokens like {"{{customer_name}}"}, {"{{date}}"}, {"{{time}}"} and {"{{manage_url}}"} are filled in when it's sent.
            </p>
            <div className="flex justify-end">
              <button type="submit" className="btn-pri" disabled={editFetcher.state !== "idle"}>
                {editFetcher.state !== "idle" ? "Saving…" : "Save message"}
              </button>
            </div>
          </editFetcher.Form>
          {message.isCustomized && (
            <resetFetcher.Form method="post" className="flex justify-end">
              <input type="hidden" name="_section" value="notification_template" />
              <input type="hidden" name="_action" value="reset" />
              <input type="hidden" name="key" value={message.key} />
              <button type="submit" className="btn-sec" disabled={resetFetcher.state !== "idle"}>
                Reset to default
              </button>
            </resetFetcher.Form>
          )}
        </div>
      )}
    </div>
  );
}

// Lets a merchant confirm their credentials/template actually work before
// relying on them for real bookings — its own fetcher (not the page's
// actionData) so sending a test doesn't get tangled up with whichever other
// section's form last submitted on this page.
function CurrencyRowSelect({ defaultCode, defaultSymbol }: { defaultCode: string; defaultSymbol: string }) {
  const [code, setCode] = useState(defaultCode);
  const known = CURRENCIES.some((c) => c.code === code);
  // A shop whose stored code was hand-typed before this dropdown existed
  // and isn't in the curated list keeps its original symbol until the
  // merchant actually picks something from the list — better than
  // guessing blank for a real value we don't otherwise recognize.
  const symbol = known ? CURRENCIES.find((c) => c.code === code)!.symbol : defaultSymbol;
  return (
    <>
      <RowSelect name="currency" value={code} onChange={(e) => setCode(e.target.value)}>
        {!known && <option value={code}>{code}</option>}
        {CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>{c.label}</option>
        ))}
      </RowSelect>
      <input type="hidden" name="currency_symbol" value={symbol} />
    </>
  );
}

/**
 * Settings → General's second card: the words this business uses, and
 * which Overview cards it shows. Both used to live on a separate
 * "Business template" page built around an industry-preset picker; the
 * presets are gone (see core's presets.ts) and what's left is small
 * enough to sit under General, which is where W5 wants it anyway.
 *
 * Local state exists only so the live preview line under the heading
 * tracks what's typed — the inputs are real named fields, so the save
 * works identically with or without it.
 */
function VocabularySection({
  settings, saved, savedAt,
}: { settings: { terms: Terms; hidden_overview_cards: string[] }; saved: boolean; savedAt?: string }) {
  // Raw, not run through withDefaultTerms on every keystroke: that fills
  // a blank with the default, which would fight someone clearing a field
  // to retype it. The fallback is applied where it is actually needed —
  // the preview below — and again on the server at save.
  const [terms, setTerms] = useState<Terms>(() => withDefaultTerms(settings.terms));
  const [hidden, setHidden] = useState<Record<string, boolean>>(
    () => Object.fromEntries(settings.hidden_overview_cards.map((key) => [key, true]))
  );
  const toast = useToast();
  const navigation = useNavigation();
  const v = vocabFor(withDefaultTerms(terms));

  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (navigation.state === "submitting") {
      wasSubmitting.current = true;
      return;
    }
    if (navigation.state !== "idle" || !wasSubmitting.current) return;
    wasSubmitting.current = false;
    if (saved) toast("Saved.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation.state]);

  return (
    <Form method="post" className="flex flex-col gap-[14px]">
      <input type="hidden" name="_section" value="vocabulary" />

      <div className="card" id="vocabulary">
        <div className="card-header">
          <div className="flex flex-col gap-[3px]">
            <h2 className="card-title">What do you call things?</h2>
            <p className="m-0 text-meta text-muted">
              Whatever you type here is what the dashboard, your booking page and every email say —
              {" "}{v.bookingTitle.toLowerCase()}, {v.services.toLowerCase()}, {v.resources.toLowerCase()},{" "}
              {v.customers.toLowerCase()}.
            </p>
          </div>
        </div>
        <div className="px-[18px] py-[14px]">
          <VocabularyFields terms={terms} onChange={(patch) => setTerms((prev) => ({ ...prev, ...patch }))} />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="flex flex-col gap-[3px]">
            <h2 className="card-title">Dashboard layout</h2>
            {/* Don't promise reordering unless drag handles exist. */}
            <p className="m-0 text-meta text-muted">Switch off any Overview card you don't need.</p>
          </div>
        </div>
        <div className="px-[18px] py-[14px]">
          <DashboardLayoutCard
            vocab={{
              booking: terms.booking_single,
              service: terms.service_single,
              services: terms.service_plural,
              resource: terms.resource_single,
            }}
            hidden={hidden}
            onToggle={(key: OverviewCardKey) => setHidden((prev) => ({ ...prev, [key]: !prev[key] }))}
          />
        </div>
        <div className="card-footer">
          {saved && savedAt && <span className="alert-success">Saved {savedAt}.</span>}
          <button type="submit" className="btn-pri ml-auto">Save</button>
        </div>
      </div>
    </Form>
  );
}

type TeamMember = { userId: string; name: string; initials: string; email: string; role: "owner" | "admin" | "write" | "read" };
type TeamPendingInvite = { inviteId: string; email: string; role: "admin" | "write" | "read"; invitedAt: string };

// Team settings page (docs/team-management-spec.md, docs/team-ui-spec.md).
// Card order top to bottom: Team members -> Pending invites -> Invite a
// teammate, the last two omitted entirely for a write/read viewer (§0 of
// the UI spec) — in practice this route's own loader already requires
// "admin" to be reached at all (see the loader's own comment), so
// canManageTeam is always true here today; this still branches on it
// explicitly rather than assuming that, the same defensive choice the
// loader itself makes.
function TeamSection({
  members, pendingInvites, canManageTeam, canChooseRole, connectionId, actionData,
}: {
  members: TeamMember[];
  pendingInvites: TeamPendingInvite[];
  canManageTeam: boolean;
  /** The `team_roles` entitlement — decides whether a role can be picked at all. */
  canChooseRole: boolean;
  connectionId: string;
  actionData: Route.ComponentProps["actionData"];
}) {
  const navigation = useNavigation();
  const toast = useToast();
  const inviting = navigation.state !== "idle" && navigation.formData?.get("_section") === "invite_member";
  const inviteError = actionData && "inviteError" in actionData ? actionData.inviteError : undefined;

  // Bumped on every successful send and used as InviteMemberCard's `key`
  // below — the card's email/role inputs are uncontrolled (a plain <Form>,
  // not react state), so remounting is what actually clears them. Without
  // this the fields kept whatever was last typed/selected after "Invite
  // sent to …", making it easy to double-invite the same address.
  const [formKey, setFormKey] = useState(0);

  // The invite form is a real <Form> (client-side transition, not a full
  // reload) precisely so this effect can catch its completion the same way
  // TemplateTab already does for its own <Form> above.
  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (navigation.state !== "idle") {
      wasSubmitting.current = true;
      return;
    }
    if (!wasSubmitting.current) return;
    wasSubmitting.current = false;
    if (actionData && "inviteSent" in actionData && actionData.inviteSent) {
      const email = actionData.invitedEmail;
      if (actionData.emailSent === false) {
        toast(`Invite saved for ${email}, but the email couldn't be sent — use Resend.`);
      } else if (actionData.alreadyPending) {
        toast(`Invite re-sent to ${email}.`);
      } else {
        toast(`Invite sent to ${email}.`);
      }
      setFormKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation.state]);

  return (
    <>
      {!canManageTeam && <TeamReadOnlyNotice />}

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Team members</h2>
        </div>
        {members.map((m) => (
          <MemberRow key={m.userId} userId={m.userId} name={m.name} email={m.email} initials={m.initials} role={m.role} canManage={canManageTeam} />
        ))}
        {members.length === 1 && pendingInvites.length === 0 && <TeamEmptyHint />}
      </div>

      {canManageTeam && pendingInvites.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Pending invites</h2>
          </div>
          {pendingInvites.map((i) => (
            <PendingInviteRow key={i.inviteId} inviteId={i.inviteId} email={i.email} role={i.role} invitedAt={i.invitedAt} />
          ))}
        </div>
      )}

      {canManageTeam && <InviteMemberCard
          key={formKey}
          pending={inviting}
          error={inviteError}
          canChooseRole={canChooseRole}
          connectionId={connectionId}
        />}
    </>
  );
}

/**
 * The embed snippet.
 *
 * Plain HTML the merchant pastes into their own site — no script tag
 * loaded from us, no build step, nothing to keep in sync. An iframe of
 * the booking page they already have, which means it cannot drift from
 * it: whatever their booking page does, the embed does.
 *
 * Ungated, deliberately. There is no `embed` entitlement because there
 * is nothing to enforce — the booking page is public, and anyone who
 * wanted to could write these eight lines themselves. What a plan
 * actually buys here is `no_badge`, which the embedded page honours
 * exactly like the hosted one.
 */
function EmbedSnippetCard({ bookingUrl, vocab }: { bookingUrl: string; vocab: ReturnType<typeof useVocabulary> }) {
  const [copied, setCopied] = useState(false);

  // Built by core rather than assembled here. This is a wire format —
  // text handed to a merchant to paste into a site we will never see —
  // and its other end is the `?embed=1` listener on the booking page.
  // Two hand-written copies of one protocol is how they drift; one
  // generator that also owns the message type is how they cannot.
  //
  // It is stricter than the inline version it replaces in three ways
  // that matter on somebody else's page: it checks the message's origin
  // (the old comment claimed this and the code never did it), it bounds
  // the height it will honour, and it derives the frame id from the URL
  // instead of hardcoding one — so a merchant with a page per location
  // can paste two of these without one driving the other's height.
  const snippet = embedSnippet({ bookingUrl, title: `Book online` });

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Denied or unavailable — the snippet is on screen to copy by hand.
    }
  }

  return (
    <div className="card p-[18px]">
      <div className="mb-1 flex items-start justify-between gap-3">
        <h2 className="card-title">Put booking on your website</h2>
        <button type="button" className="btn-sec shrink-0" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="m-0 mb-3 text-meta text-muted">
        Paste this wherever you want the {vocab.bookingOne.toLowerCase()} form to appear — a page, a sidebar, a
        pop-up. It resizes itself as customers move through the steps, and it stays in step with your settings
        automatically.
      </p>
      <pre className="m-0 max-h-[240px] overflow-auto rounded-[9px] border border-line bg-canvas-alt p-3 text-[12px] leading-[1.5]">
        <code>{snippet}</code>
      </pre>
      <p className="m-0 mt-2 text-[12px] text-subtle">
        No website? Your{" "}
        <a href={bookingUrl} target="_blank" rel="noreferrer" className="text-brand-600 underline">
          booking link
        </a>{" "}
        works on its own.
      </p>
    </div>
  );
}

/**
 * Booking-page branding — a logo and an accent colour.
 *
 * Its own card and its own form, separate from the rest of General,
 * because the logo has to be read and downscaled in the browser before
 * it can be submitted at all, and mixing that into the main settings
 * save would make an ordinary field change depend on image handling.
 *
 * The image never reaches the server at full size. A phone photo is
 * four megabytes; what gets stored is a data URL of a 512px-max render
 * of it, which is a few tens of kilobytes and small enough to inline
 * into the booking page. The server re-checks the size and format
 * regardless — everything that happens in a browser is a suggestion.
 */
function BusinessHoursCard({
  hours, resourceCount, canManageStaff, connectionId, savedAt,
}: {
  hours: { dayOfWeek: number; open: boolean; start: string; end: string }[];
  resourceCount: number;
  canManageStaff: boolean;
  connectionId: string;
  savedAt?: string;
}) {
  const [days, setDays] = useState(() =>
    hours.map((day) => ({
      ...day,
      // A day with no schedule has no times to show. Seed the inputs
      // with a plausible working day so ticking "open" does not then
      // require typing both ends from scratch.
      start: day.start || "09:00",
      end: day.end || "17:00",
    }))
  );

  return (
    <SettingsCard
      title="Business hours"
      subtitle="When customers can book. Individual staff can differ."
      saveLabel="Save hours"
      savedAt={savedAt}
    >
      <input type="hidden" name="_section" value="business_hours" />
      <input type="hidden" name="hours" value={JSON.stringify(days)} />

      {resourceCount > 1 && (
        <p className="m-[14px_18px_4px] rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
          This account has {resourceCount} bookable {resourceCount === 1 ? "person or room" : "people or rooms"}, and
          saving here gives all of them these hours.{" "}
          {canManageStaff ? (
            <a href={`/dashboard/${connectionId}/resources`} className="underline">
              Set them individually instead
            </a>
          ) : (
            "Ask us to turn on staff management if they need different hours."
          )}
        </p>
      )}

      <WeeklyHoursEditor days={days} onChange={setDays} inset />
    </SettingsCard>
  );
}

function BrandingCard({
  connectionId, canBrand, currentPlan, logo, accent, savedAt,
}: {
  connectionId: string;
  canBrand: boolean;
  currentPlan: PlanId;
  logo: string;
  accent: string;
  savedAt?: string;
}) {
  const [logoValue, setLogoValue] = useState(logo);
  const [accentValue, setAccentValue] = useState(accent || "#8f3aa9");
  const [problem, setProblem] = useState("");

  async function onPick(file: File | undefined) {
    setProblem("");
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      // SVG is refused here and again on the server: it is an image
      // format that can contain script, and this value gets inlined
      // into a page on our own origin.
      setProblem("Use a PNG, JPEG or WebP image.");
      return;
    }
    try {
      setLogoValue(await downscaleToDataUrl(file, 512));
    } catch {
      setProblem("That image couldn't be read. Try another file.");
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <div className="flex flex-col gap-[3px]">
          <h2 className="card-title">Your booking page</h2>
          <p className="m-0 text-meta text-muted">Your logo and colour, instead of ours.</p>
        </div>
      </div>

      {!canBrand ? (
        <div className="px-[18px] py-[14px]">
          <UpgradePrompt connectionId={connectionId} feature="branding" currentPlan={currentPlan} />
        </div>
      ) : (
        <Form method="post" className="contents">
          {/* Its own section. Posting "general" from a form that holds
              only two of its twelve fields made the action read the
              other ten as empty strings and write them — one click on
              Save here blanked the business name, address and phone and
              reset the currency to USD and the timezone to UTC, which
              silently re-bases every availability calculation and every
              displayed booking time. */}
          <input type="hidden" name="_section" value="branding" />
          <input type="hidden" name="brand_logo" value={logoValue} />

          <div className="flex flex-col gap-[14px] px-[18px] py-[14px]">
            {problem && <AlertError>{problem}</AlertError>}

            <div className="flex items-center gap-4">
              <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-[9px] border border-line bg-canvas-alt">
                {logoValue ? (
                  <img src={logoValue} alt="Your logo" className="max-h-full max-w-full object-contain" />
                ) : (
                  <LogoMark size={24} />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label className="btn-sec cursor-pointer">
                  {logoValue ? "Replace logo" : "Upload a logo"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={(e) => onPick(e.currentTarget.files?.[0])}
                  />
                </label>
                {logoValue && (
                  <button type="button" className="btn-link text-danger" onClick={() => setLogoValue("")}>
                    Remove
                  </button>
                )}
              </div>
            </div>

            <label className="flex items-center gap-3 text-[12px] text-muted">
              Accent colour
              <input
                type="color"
                name="brand_accent"
                value={accentValue}
                onChange={(e) => setAccentValue(e.currentTarget.value)}
                className="h-8 w-12 cursor-pointer rounded-[6px] border border-line bg-surface p-[2px]"
                aria-label="Accent colour"
              />
              <span className="num text-subtle">{accentValue}</span>
            </label>
          </div>

          <div className="card-footer">
            {savedAt && <span className="alert-success">Saved {savedAt}.</span>}
            <button type="submit" className="btn-pri ml-auto">Save</button>
          </div>
        </Form>
      )}
    </div>
  );
}

/**
 * Reads an image file and returns a data URL no larger than `max` on
 * its longest side.
 *
 * Done here rather than server-side because the alternative is
 * uploading a four-megabyte phone photo to store a favicon-sized mark.
 * The canvas render also strips EXIF, which is worth having: a logo
 * photographed on a phone otherwise carries the GPS coordinates of
 * wherever it was taken.
 */
async function downscaleToDataUrl(file: File, max: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas context");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // PNG keeps transparency, which most logos need. Falls back to JPEG
  // only if the PNG comes out too big for the stored cap.
  const png = canvas.toDataURL("image/png");
  if (png.length <= 48 * 1024) return png;
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * Settings → Payments.
 *
 * One field, and a lot of honesty around it.
 *
 * GetBooqin is not in this transaction: the merchant's UPI ID or
 * PayPal.me handle goes into a link the customer pays through directly,
 * and the money never touches us. That is what makes this possible
 * without becoming a payment aggregator — and it is also why the page
 * has to say, plainly, that nothing here confirms a payment. A merchant
 * who believes this is automatic will stop checking their bank, and
 * that is the one outcome worse than having no feature at all.
 */
function PaymentsPage({
  connectionId, currency, businessName, upiId, payPalMe, savedAt, error,
}: {
  connectionId: string;
  currency: string;
  businessName: string;
  upiId: string;
  payPalMe: string;
  savedAt?: string;
  error?: string;
}) {
  const [upi, setUpi] = useState(upiId);
  const [pp, setPp] = useState(payPalMe);
  const indian = currency.toUpperCase() === "INR";

  // Exactly what a customer would be sent, built with the same function
  // the server uses. Seeing the real link before saving is what catches
  // a typo that is still a valid address.
  const preview = PaymentLinks.paymentLink(indian ? "upi" : "paypal", {
    payee: { upiId: upi, payPalMe: pp, payeeName: businessName || "Booking" },
    amount: 1,
    currency,
    reference: "BK-TEST01",
    note: "Test payment",
  });

  return (
    <div className="flex flex-col gap-[14px]">
      <Form method="post" className="contents">
        <input type="hidden" name="_section" value="payments" />

        <div className="card">
          <div className="card-header">
            <div className="flex flex-col gap-[3px]">
              <h2 className="card-title">Where your customers pay you</h2>
              <p className="m-0 text-meta text-muted">
                Money goes straight to you. GetBooqin never holds it, and never takes a cut.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-[14px] px-[18px] py-[14px]">
            {error && <AlertError>{error}</AlertError>}

            {/* Said where the field is, not after a failed request.
                A merchant who fills in a UPI ID on a dollar-priced shop
                has done nothing wrong and needs to know it won't be
                used — "(India only)" in a label is not enough. */}
            {!indian && upi && (
              <p className="m-0 rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
                <strong>This UPI ID won't be used.</strong> Your prices are in {currency}, and UPI only settles in
                rupees — a payment link for a {currency} amount would ask for the wrong money. Add a PayPal.me link
                below instead, or change your currency under Settings → General.
              </p>
            )}
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              UPI ID{!indian && " (not used — you price in " + currency + ")"}
              <input
                className="input w-full min-w-0"
                name="upi_id"
                value={upi}
                onChange={(e) => setUpi(e.currentTarget.value)}
                placeholder="yourbusiness@okhdfcbank"
                aria-label="UPI ID"
                maxLength={120}
              />
              {/* A personal UPI ID taking business payments is P2P, which
                  carries daily limits and can get flagged if used
                  commercially at volume. Said here rather than after it
                  happens. */}
              <span className="text-[11.5px] text-subtle">
                Use the UPI ID you receive business payments on, not a personal one.
              </span>
            </label>

            <label className="flex flex-col gap-1 text-[12px] text-muted">
              PayPal.me link{indian && " (for customers outside India)"}
              <input
                className="input w-full min-w-0"
                name="paypal_me"
                value={pp}
                onChange={(e) => setPp(e.currentTarget.value)}
                placeholder="paypal.me/yourbusiness"
                aria-label="PayPal.me link"
                maxLength={120}
              />
            </label>
          </div>

          <div className="card-footer">
            {savedAt && <span className="alert-success">Saved {savedAt}.</span>}
            <button type="submit" className="btn-pri ml-auto">Save</button>
          </div>
        </div>
      </Form>

      {preview && (
        <div className="card p-[18px]">
          <h2 className="card-title mb-1">Check it works</h2>
          <p className="m-0 mb-3 text-meta text-muted">
            Pay yourself {indian ? "₹1" : "1.00"} with this. Nothing here can tell whether an address is
            <em> yours</em> — only that it's the right shape — so this is the check that matters.
          </p>
          {/* Named apps, not just the generic link. A bare upi:// goes
              to whichever app holds Android's default — WhatsApp
              registers as one — so "it opened WhatsApp" is the first
              thing a merchant hits when testing. */}
          <div className="flex flex-wrap gap-2">
            {indian
              ? PaymentLinks.upiAppLinks({
                  payee: { upiId: upi, payPalMe: pp, payeeName: businessName || "Booking" },
                  amount: 1,
                  currency,
                  reference: "BKTEST01",
                  note: "Test payment",
                }).map((app) => (
                  <a
                    key={app.id}
                    href={app.url}
                    className="btn-sec no-underline hover:no-underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {app.label}
                  </a>
                ))
              : (
                <a href={preview} className="btn-sec no-underline hover:no-underline" target="_blank" rel="noreferrer">
                  Send a test payment
                </a>
              )}
          </div>
          <pre className="mt-3 overflow-x-auto rounded-[9px] border border-line bg-canvas-alt p-3 text-[11.5px]">
            <code>{preview}</code>
          </pre>
        </div>
      )}

      <div className="card p-[18px]">
        <h2 className="card-title mb-1">What this does and doesn't do</h2>
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-meta text-muted">
          <li>
            <strong className="text-ink-2">Customers get a link and a QR</strong> with the amount and your
            booking reference already filled in — on their phone it opens their payment app directly.
          </li>
          <li>
            {/* The single most important sentence on this page. */}
            <strong className="text-warn">Nothing tells us when they've paid.</strong> The money arrives in your
            account, you see it in your own app, and you mark it paid on the Orders page. Keep checking your bank.
          </li>
          <li>
            <strong className="text-ink-2">Amounts can be edited</strong> in some payment apps, so check how much
            actually arrived — not just that something did.
          </li>
        </ul>
        <p className="m-0 mt-3 text-[12px] text-subtle">
          Set how much each service asks for under{" "}
          <a href={`/dashboard/${connectionId}/services`} className="text-brand-600 underline">
            Services
          </a>
          .
        </p>
      </div>
    </div>
  );
}

/**
 * The booking link as something you can put on a wall.
 *
 * The cheapest distribution a small business has: print it, tape it to
 * the window, put it on the back of a receipt or a business card.
 * Someone scans it with their phone camera — no app, no account,
 * nothing to install — and lands on the booking page.
 *
 * Deliberately shown, not just offered as a download. A merchant will
 * not print something they have not seen, and scanning the preview off
 * their own screen is the fastest way to confirm it points where they
 * expect.
 */
function BookingQrCard({
  connectionId, bookingUrl, vocab, qr,
}: {
  connectionId: string;
  bookingUrl: string;
  vocab: ReturnType<typeof useVocabulary>;
  /** Small inline preview. The download route renders a print-resolution one. */
  qr: string;
}) {
  return (
    <div className="card p-[18px]">
      <h2 className="card-title mb-1">Your booking QR code</h2>
      <p className="m-0 mb-3 text-meta text-muted">
        Print it for your window or counter, or send it in a message. Anyone can scan it with their phone camera
        to book a {vocab.bookingOne.toLowerCase()} — there's nothing for them to install.
      </p>

      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <img
          src={qr}
          alt={`QR code linking to ${bookingUrl}`}
          className="h-[140px] w-[140px] shrink-0 rounded-[9px] border border-line bg-white p-2"
        />
        <div className="flex min-w-0 flex-col gap-2">
          <a
            href={`/dashboard/${connectionId}/booking-qr.png`}
            className="btn-pri self-start no-underline hover:no-underline"
          >
            Download for printing
          </a>
          <span className="text-[12px] text-subtle">
            A high-resolution PNG, about 9cm square at print quality.
          </span>
          <span className="min-w-0 break-all text-[12px] text-subtle">Points to {bookingUrl}</span>
        </div>
      </div>
    </div>
  );
}
