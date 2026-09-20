/**
 * What this deployment needs to be configured with, and what it loses
 * when it isn't.
 *
 * Two kinds of missing, and conflating them is why boot checks get
 * ripped out. A missing `DATABASE_URL` means nothing works and the
 * process should refuse to start; a missing `SENTRY_DSN` means errors
 * aren't reported and everything else is fine. A check that treats
 * those the same either blocks a deploy over telemetry or lets an app
 * boot with no session secret — and both teach people to ignore it.
 *
 * So every variable below is declared with the capability it gates.
 * Required ones abort the boot with the whole list at once, because
 * finding out about four missing secrets one restart at a time is the
 * thing this exists to prevent. Everything else prints one line naming
 * exactly what the deployment cannot do, which is also what a launch
 * checklist wants: not "is it configured" but "what doesn't work".
 *
 * The list is the documentation. `.env.example` drifts; this is read at
 * every boot and cannot.
 */

export type EnvRequirement = "required" | "capability";

export interface EnvVar {
  name: string;
  requirement: EnvRequirement;
  /** What it's for, in a merchant-visible sense where possible. */
  purpose: string;
  /** For a capability var: what stops working without it. Grouped, so a rail is reported once. */
  capability?: string;
}

export const ENV_VARS: EnvVar[] = [
  // --- Cannot serve at all without these -------------------------
  { name: "DATABASE_URL", requirement: "required", purpose: "Postgres connection string" },
  { name: "APP_URL", requirement: "required", purpose: "Public origin, used in every emailed link" },
  {
    name: "SESSION_SIGNING_SECRET",
    requirement: "required",
    purpose: "Signs the public booking-management links",
  },
  {
    name: "CONNECTION_ENCRYPTION_KEY",
    requirement: "required",
    purpose: "Encrypts stored platform credentials at rest",
  },
  { name: "CLERK_SECRET_KEY", requirement: "required", purpose: "Server-side authentication" },
  {
    name: "VITE_CLERK_PUBLISHABLE_KEY",
    requirement: "required",
    purpose: "Compiled into the client bundle at build time — see fly.toml's [build.args]",
  },

  // --- Degrade a capability --------------------------------------
  {
    name: "SMTP_HOST",
    requirement: "capability",
    purpose: "Outbound mail relay",
    capability: "email — no confirmations, reminders, invoices, trial nudges or team invites",
  },
  {
    // Read by the mailer's nodemailer transport and, until now, declared
    // nowhere — so a deployment with SMTP_HOST and no credentials
    // reported "email: configured" at boot and then failed
    // authentication on the first confirmation, which is the exact
    // shape of failure this file exists to prevent.
    //
    // SMTP_PORT is deliberately absent: it defaults to 587, which is
    // right for every relay we would plausibly use.
    name: "SMTP_USER",
    requirement: "capability",
    purpose: "SMTP authentication",
    capability: "email — the relay will refuse to send without credentials",
  },
  {
    name: "SMTP_PASS",
    requirement: "capability",
    purpose: "SMTP authentication",
    capability: "email — the relay will refuse to send without credentials",
  },
  {
    name: "MAIL_FROM_EMAIL",
    requirement: "capability",
    purpose: "The authenticated From address",
    capability: "email deliverability — mail would be sent as the merchant's own domain and fail SPF/DKIM",
  },
  {
    // Optional since Shopify was shipped dark. They were required only
    // because shopifyApp() throws on a missing apiKey when the combined
    // server imports it at boot — which made an integration no plan
    // grants a hard dependency for every deployment. shopify.server.ts
    // now constructs with obvious placeholders instead, so the absence
    // of these is a switched-off integration rather than a dead app.
    name: "SHOPIFY_API_KEY",
    requirement: "capability",
    purpose: "Shopify app credentials",
    capability: "Shopify — the app cannot be installed on a store",
  },
  {
    name: "SHOPIFY_API_SECRET",
    requirement: "capability",
    purpose: "Shopify app credentials",
    capability: "Shopify — the app cannot be installed on a store",
  },
  {
    name: "SCOPES",
    requirement: "capability",
    purpose: "Shopify OAuth scopes",
    capability: "Shopify — the app cannot be installed on a store",
  },
  {
    name: "SHOPIFY_APP_URL",
    requirement: "capability",
    purpose: "Shopify OAuth callback origin, which must match the Partner dashboard",
    capability: "Shopify OAuth — an install would be redirected back to the wrong host",
  },
  {
    name: "RAZORPAY_KEY_ID",
    requirement: "capability",
    purpose: "Razorpay API credentials",
    capability: "the Razorpay rail — Indian merchants cannot subscribe",
  },
  {
    name: "RAZORPAY_KEY_SECRET",
    requirement: "capability",
    purpose: "Razorpay API credentials",
    capability: "the Razorpay rail — Indian merchants cannot subscribe",
  },
  {
    name: "RAZORPAY_WEBHOOK_SECRET",
    requirement: "capability",
    purpose: "Verifies Razorpay webhook deliveries",
    capability: "Razorpay renewals and failures — money could be taken with nothing to record it",
  },
  {
    name: "PAYPAL_CLIENT_ID",
    requirement: "capability",
    purpose: "PayPal API credentials",
    capability: "the PayPal rail — merchants outside India cannot subscribe",
  },
  {
    name: "PAYPAL_CLIENT_SECRET",
    requirement: "capability",
    purpose: "PayPal API credentials",
    capability: "the PayPal rail — merchants outside India cannot subscribe",
  },
  {
    name: "PAYPAL_WEBHOOK_ID",
    requirement: "capability",
    purpose: "Verifies PayPal webhook deliveries",
    capability: "PayPal renewals and failures — money could be taken with nothing to record it",
  },
  {
    name: "INVOICE_LEGAL_NAME",
    requirement: "capability",
    purpose: "The entity issuing invoices",
    capability: "invoicing — payments are taken and no invoice is issued",
  },
  {
    name: "INVOICE_ADDRESS",
    requirement: "capability",
    purpose: "The registered address printed on invoices",
    capability: "invoicing — payments are taken and no invoice is issued",
  },
  {
    name: "META_APP_ID",
    requirement: "capability",
    purpose: "Meta app credentials, for WhatsApp Embedded Signup",
    capability: "WhatsApp — merchants cannot connect a WhatsApp Business account",
  },
  {
    name: "META_APP_SECRET",
    requirement: "capability",
    purpose: "Meta app credentials, and verifies every WhatsApp webhook",
    capability: "WhatsApp — merchants cannot connect a WhatsApp Business account",
  },
  {
    name: "META_WHATSAPP_CONFIG_ID",
    requirement: "capability",
    purpose: "The Embedded Signup configuration the merchant's popup opens",
    capability: "WhatsApp — merchants cannot connect a WhatsApp Business account",
  },
  {
    name: "META_WEBHOOK_VERIFY_TOKEN",
    requirement: "capability",
    purpose: "Answers Meta's one-time webhook verification handshake",
    capability: "WhatsApp deliveries — message status, replies and template approvals never arrive",
  },
  {
    // Read by @clerk/react-router's verifyWebhook() from the
    // environment rather than passed to it, so nothing in this codebase
    // names it and it was invisible here. Without it every Clerk
    // delivery fails verification: no User row is ever created, which
    // takes account deletion and the duplicate-mailbox check down with
    // it.
    name: "CLERK_WEBHOOK_SIGNING_SECRET",
    requirement: "capability",
    purpose: "Verifies Clerk webhook deliveries",
    capability: "user sync — signups never reach our own User table",
  },
  {
    // Absent means the tax number is optional everywhere, which is how
    // a GSTIN has always worked. Set to "true" to sell B2B-only in the
    // EU by demanding a VAT number — a commercial choice, and the one
    // that avoids a non-Union OSS registration, since a non-EU supplier
    // selling to a non-taxable EU person owes VAT at that person's
    // local rate from the first sale. See billing/tax.ts.
    name: "BILLING_EU_REQUIRE_VAT",
    requirement: "capability",
    purpose: "'true' demands a VAT number from EU customers — see billing/tax.ts",
    capability: "nothing — absent leaves the tax number optional everywhere",
  },
  {
    name: "PLATFORM_ADMIN_EMAILS",
    requirement: "capability",
    purpose: "Allowlist for the platform admin console",
    capability: "the admin console — nobody can reach /admin, including you",
  },
  {
    name: "CRON_SECRET",
    requirement: "capability",
    purpose: "Bearer token for the external cron endpoints",
    capability: "external cron triggers — /cron/* refuses every call (the in-process sweep still runs)",
  },
  {
    name: "SENTRY_DSN",
    requirement: "capability",
    purpose: "Error reporting",
    capability: "error reporting — failures are only visible in logs",
  },
  {
    name: "SUPPORT_EMAIL",
    requirement: "capability",
    purpose: "Shown to merchants as the contact address",
    capability: "the support address shown in the Shopify app footer",
  },
];

export interface EnvReport {
  ok: boolean;
  missingRequired: EnvVar[];
  /** One entry per lost capability, deduplicated — a rail missing both keys is one problem, not two. */
  lostCapabilities: { capability: string; vars: string[] }[];
}

function isSet(name: string): boolean {
  return (process.env[name] ?? "").trim() !== "";
}

export function checkEnvironment(): EnvReport {
  const missingRequired = ENV_VARS.filter((v) => v.requirement === "required" && !isSet(v.name));

  const byCapability = new Map<string, string[]>();
  for (const v of ENV_VARS) {
    if (v.requirement !== "capability" || isSet(v.name) || !v.capability) continue;
    byCapability.set(v.capability, [...(byCapability.get(v.capability) ?? []), v.name]);
  }

  return {
    ok: missingRequired.length === 0,
    missingRequired,
    lostCapabilities: [...byCapability].map(([capability, vars]) => ({ capability, vars })),
  };
}

/**
 * Prints what this deployment can and cannot do, and throws if it
 * cannot serve at all.
 *
 * Called once at boot. The throw lists **every** missing required
 * variable rather than the first — a deploy that fails four times in a
 * row, each time naming one more secret, is the experience this
 * replaces.
 */
export function assertEnvironment(log: (line: string) => void = console.log): void {
  const report = checkEnvironment();

  for (const lost of report.lostCapabilities) {
    log(`[getbooqin] disabled: ${lost.capability}  (set ${lost.vars.join(", ")})`);
  }

  // Printed after the missing-capability lines and before the throw,
  // because a deployment can be fully configured and still be a
  // rehearsal — see productionWarnings(). Never fatal: staging is
  // supposed to look like this.
  const warnings = productionWarnings();
  for (const w of warnings) {
    log(`[getbooqin] NOT PRODUCTION-READY: ${w.problem}`);
    log(`[getbooqin]              fix: ${w.fix}`);
  }

  if (report.ok) {
    if (report.lostCapabilities.length === 0 && warnings.length === 0) {
      log("[getbooqin] environment: fully configured");
    }
    return;
  }

  const lines = report.missingRequired.map((v) => `  ${v.name} — ${v.purpose}`);
  throw new Error(
    `Refusing to start: ${report.missingRequired.length} required environment ` +
      `variable${report.missingRequired.length === 1 ? " is" : "s are"} not set.\n${lines.join("\n")}\n\n` +
      `Set them with \`fly secrets set\` (or in .env locally) and deploy again. ` +
      `See core/src/env.ts for the full list, including the optional ones and what each turns off.`
  );
}

/* ------------------------------------------------------------------ */
/* Set, but set to something that isn't production                     */
/* ------------------------------------------------------------------ */

/**
 * The checks above answer "is it configured". This one answers a
 * different and, at launch, more dangerous question: **is what it is
 * configured with the real thing?**
 *
 * Every item here passes `checkEnvironment()` completely. A Clerk
 * development key is set. A Razorpay test key is set. `PAYPAL_ENV` is
 * set, to `sandbox`. `APP_URL` is set, to a fly.dev host. Nothing is
 * missing, nothing warns, and the app serves — it just serves a
 * rehearsal to a real customer.
 *
 * That is the failure this exists to catch, because it is the one with
 * no symptom. A missing secret breaks something visibly on the first
 * request; a sandbox credential works perfectly, takes no money, and
 * looks like a successful upgrade to everyone involved.
 *
 * These print as warnings and never block a boot. A staging deployment
 * is *supposed* to hold test keys, and a check that refused to start
 * over one would be ripped out within a week. The line in the log is
 * the whole mechanism: it is read at every boot, it cannot drift from
 * the code the way a launch checklist does, and it says what to do.
 */
export interface ProductionWarning {
  /** What is true right now, in terms of consequence rather than config. */
  problem: string;
  /** The specific thing that resolves it. */
  fix: string;
}

interface ProductionCheck {
  /** Truthy when the deployment is NOT production-ready in this respect. */
  failing: (env: NodeJS.ProcessEnv) => boolean;
  problem: string;
  fix: string;
}

const PRODUCTION_CHECKS: ProductionCheck[] = [
  {
    // Anything that is not a live key, rather than specifically a
    // pk_test_ one. Clerk development instances carry a capped user
    // count, relaxed security, unbranded shared OAuth consent screens
    // and email delivery that does not match production — none of which
    // shows up as an error, only as a ceiling you hit later.
    //
    // Stated as "not pk_live_" so it also catches the placeholder in
    // fly.prod.toml's build args. That value has to be replaced before a
    // real deploy, and a check that only knew about pk_test_ would have
    // let it through silently into a build whose login is broken.
    failing: (env) => !(env.VITE_CLERK_PUBLISHABLE_KEY ?? "").startsWith("pk_live_"),
    problem:
      "Clerk is not a production instance — capped users, shared unbranded OAuth consent screens, non-production email",
    fix: "Create a Clerk production instance and rebuild with its pk_live_ key (fly.toml [build.args]) plus its sk_live_ CLERK_SECRET_KEY",
  },
  {
    failing: (env) => (env.CLERK_SECRET_KEY ?? "").startsWith("sk_test_"),
    problem: "CLERK_SECRET_KEY is a development key, so sessions are issued by Clerk's dev instance",
    fix: "fly secrets set CLERK_SECRET_KEY=sk_live_… from the Clerk production instance",
  },
  {
    // Every emailed link — confirmations, reminders, invoices, manage
    // and cancel — is built from APP_URL. On a fly.dev host the link a
    // customer receives is on a different domain from the address it
    // arrives from, which is both a trust problem and a DMARC-alignment
    // signal.
    failing: (env) => /\.fly\.dev/i.test(env.APP_URL ?? ""),
    problem:
      "APP_URL is a fly.dev host, so every booking link and emailed link a customer sees is on a domain that isn't yours",
    fix: "Point your own domain at the app (fly certs add …) and fly secrets set APP_URL=https://your-domain",
  },
  {
    failing: (env) => (env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_test_"),
    problem: "Razorpay is in test mode — upgrades appear to succeed and no money moves",
    fix: "fly secrets set RAZORPAY_KEY_ID=rzp_live_… RAZORPAY_KEY_SECRET=… and confirm the live plan ids in billing/plans.ts",
  },
  {
    failing: (env) => !!(env.PAYPAL_CLIENT_ID ?? "").trim() && env.PAYPAL_ENV !== "live",
    problem: "PayPal is in sandbox — upgrades appear to succeed and no money moves",
    fix: "fly secrets set PAYPAL_ENV=live with live PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID",
  },
  {
    // The mailer refuses to send without MAIL_FROM_EMAIL, so this is
    // about alignment rather than delivery: a relay's own login address
    // is a domain you cannot publish SPF, DKIM or DMARC records for, so
    // there is nothing for a receiver to verify you against.
    failing: (env) => /@(smtp-)?(brevo|sendinblue|sendgrid|mailgun)\b/i.test(env.MAIL_FROM_EMAIL ?? ""),
    problem:
      "MAIL_FROM_EMAIL is the relay's own address, not a domain you can authenticate — confirmations and reminders send unaligned",
    fix: "Publish DKIM + SPF for a domain you own, then fly secrets set MAIL_FROM_EMAIL=notify@your-domain",
  },
];

/**
 * Production-readiness problems, in the order they should be fixed.
 *
 * Returns nothing outside production: a developer running against test
 * keys is not misconfigured, they are developing.
 */
export function productionWarnings(env: NodeJS.ProcessEnv = process.env): ProductionWarning[] {
  if (env.NODE_ENV !== "production") return [];
  return PRODUCTION_CHECKS.filter((c) => c.failing(env)).map(({ problem, fix }) => ({ problem, fix }));
}
