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
  // The Shopify app is mounted by the combined server whether or not
  // anyone uses it, and shopifyApp() needs these to construct at all.
  { name: "SHOPIFY_API_KEY", requirement: "required", purpose: "Shopify app credentials" },
  { name: "SHOPIFY_API_SECRET", requirement: "required", purpose: "Shopify app credentials" },
  { name: "SHOPIFY_APP_URL", requirement: "required", purpose: "Shopify OAuth callback origin" },
  { name: "SCOPES", requirement: "required", purpose: "Shopify OAuth scopes" },

  // --- Degrade a capability --------------------------------------
  {
    name: "SMTP_HOST",
    requirement: "capability",
    purpose: "Outbound mail relay",
    capability: "email — no confirmations, reminders, invoices, trial nudges or team invites",
  },
  {
    name: "MAIL_FROM_EMAIL",
    requirement: "capability",
    purpose: "The authenticated From address",
    capability: "email deliverability — mail would be sent as the merchant's own domain and fail SPF/DKIM",
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

  if (report.ok) {
    if (report.lostCapabilities.length === 0) log("[getbooqin] environment: fully configured");
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
