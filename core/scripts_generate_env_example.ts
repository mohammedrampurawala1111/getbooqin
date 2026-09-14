/**
 * Regenerates the repo's .env.example from core/src/env.ts.
 *
 * The env file is documentation, and documentation drifts. This makes
 * the drift impossible: the boot check and the example are generated
 * from one list, so a variable added to the check cannot be missing
 * from the file anyone reads when setting the project up.
 *
 *   npx tsx core/scripts_generate_env_example.ts
 */
import { writeFileSync } from "node:fs";
import { ENV_VARS } from "./src/env.js";

const required = ENV_VARS.filter((v) => v.requirement === "required");
const capability = ENV_VARS.filter((v) => v.requirement === "capability");

const lines: string[] = [
  "# Generated from core/src/env.ts, which is the single source of truth and",
  "# is checked at every boot. If you add a variable there, regenerate this.",
  "#",
  "# Required: the server refuses to start without these.",
  "# Optional: the server starts and the named capability is switched off.",
  "",
  "# ---------------------------------------------------------------- Required",
  "",
];

for (const v of required) lines.push(`# ${v.purpose}`, `${v.name}=`, "");

lines.push("# ------------------------------------- Optional (each turns something off)", "");
const seen = new Set<string>();
for (const v of capability) {
  if (v.capability && !seen.has(v.capability)) {
    seen.add(v.capability);
    lines.push(`# Without this: ${v.capability}`);
  }
  lines.push(`# ${v.purpose}`, `${v.name}=`, "");
}

// Invoice extras that have sensible defaults and so aren't in the boot check.
lines.push(
  "# ------------------------------------------------- Invoicing, optional bits",
  "",
  "# GSTIN printed on invoices. Blank is legitimate below the registration threshold.",
  "INVOICE_GSTIN=",
  "",
  "# 'true' once a Letter of Undertaking is on file — decides whether export",
  "# invoices go out under LUT without IGST, or with IGST payable.",
  "INVOICE_LUT_ON_FILE=false",
  "",
  "# Invoice series prefix: GB -> GB/2026-27/0001",
  "INVOICE_SERIES_PREFIX=GB",
  "",
  "# GST rate for domestic Indian sales, as a percentage.",
  "INVOICE_GST_RATE=18",
  "",
  "# sandbox | live. PayPal credentials look identical in both, so this is explicit.",
  "PAYPAL_ENV=sandbox",
  ""
);

writeFileSync(new URL("../.env.example", import.meta.url), lines.join("\n"));
console.log(`wrote .env.example — ${required.length} required, ${capability.length} optional`);
