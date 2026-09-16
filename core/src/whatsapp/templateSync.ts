/**
 * Getting our five templates approved inside each merchant's WABA, and
 * keeping track of what Meta thinks of them.
 *
 * ## Approval is per merchant, not per app
 *
 * This is the part that surprises everyone building on WhatsApp. Our
 * templates are not approved once and reused: each merchant's WhatsApp
 * Business Account needs its own copy, submitted and reviewed
 * separately. So connecting a merchant means submitting five templates
 * and then *waiting* — minutes usually, up to 24 hours sometimes, and
 * occasionally a rejection that a human has to read.
 *
 * Which means a freshly connected merchant is in a real and ordinary
 * state: WhatsApp connected, nothing sendable yet. The Settings screen
 * has to say so, the send path has to check, and neither can treat it
 * as an error.
 *
 * ## Submission is idempotent by name
 *
 * Re-submitting an existing name gets a 100/2388023 back rather than a
 * duplicate, which is treated as success — a merchant clicking
 * "Resubmit" on four approved templates and one rejected one should not
 * be punished for the four.
 *
 * ## The cache is the thing the send path reads
 *
 * `WhatsAppTemplate` rows are a copy of Meta's verdict, refreshed by
 * the `message_template_status_update` webhook and by `syncAll()`.
 * Sending against a template Meta has since paused fails *and* costs
 * quality rating, so the check belongs before the call, against
 * something we already know.
 */
import prisma from "../db.js";
import type { WhatsAppAccount } from "@prisma/client";
import { graph, GraphError } from "./graph.js";
import { withToken } from "./accounts.js";
import {
  WHATSAPP_TEMPLATES,
  keyFromMetaName,
  metaName,
  templateFor,
  type WhatsAppTemplateDef,
  type WhatsAppTemplateKey,
} from "./templates.js";

/** Meta's own status vocabulary, kept verbatim. */
export type MetaTemplateStatus = "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED" | string;

export interface TemplateState {
  key: WhatsAppTemplateKey;
  name: string;
  language: string;
  status: MetaTemplateStatus;
  category: string;
  rejectedReason: string | null;
}

/**
 * Meta's payload for one template.
 *
 * The body's `{{n}}` placeholders and the button's URL are what get
 * reviewed, so both are built from the catalogue rather than typed
 * here — a template whose submitted body differs from the one the send
 * path fills is a 132000 at send time and nowhere earlier.
 */
function submissionFor(def: WhatsAppTemplateDef, appUrl: string, language: string): unknown {
  const components: unknown[] = [
    {
      type: "BODY",
      text: def.body,
      // Meta requires an example for every variable, and rejects the
      // template outright without one. These are what a reviewer reads.
      example: { body_text: [def.variables.map((name) => EXAMPLES[name])] },
    },
  ];

  if (def.button) {
    // A dynamic URL button is registered with a fixed base and a single
    // `{{1}}` suffix — that fixed base is exactly why Meta allows a
    // variable link at all, and it is why send.ts passes a suffix
    // rather than a whole URL.
    const base = `${appUrl.replace(/\/$/, "")}/`;
    components.push({
      type: "BUTTONS",
      buttons: [
        {
          type: "URL",
          text: def.button.text,
          url: `${base}{{1}}`,
          example: [`${base}b/abc123`],
        },
      ],
    });
  }

  return {
    name: metaName(def.key),
    language,
    category: def.category,
    components,
  };
}

/** What a reviewer at Meta sees in place of each variable. */
const EXAMPLES: Record<string, string> = {
  customer_name: "Priya",
  business_name: "Sunrise Dental",
  service: "Dental cleaning",
  date: "Monday, 3 March",
  time: "10:30 AM",
  resource: "Dr Rao",
  manage_url: "b/abc123",
  claim_url: "w/abc123",
  expires_at: "6:00 PM today",
};

/**
 * Submit every template to this merchant's WABA.
 *
 * Returns what happened per template rather than throwing on the first
 * failure: four approved and one rejected is a normal outcome, and a
 * merchant should see which one rather than an error about "templates".
 */
export async function submitAll(
  account: WhatsAppAccount,
  appUrl: string,
  language = "en",
  fetchImpl: typeof fetch = fetch
): Promise<TemplateState[]> {
  const results: TemplateState[] = [];

  for (const def of WHATSAPP_TEMPLATES) {
    try {
      await withToken(account, (token) =>
        graph({
          path: `${account.wabaId}/message_templates`,
          accessToken: token,
          method: "POST",
          body: submissionFor(def, appUrl, language),
          fetchImpl,
        })
      );
      results.push(await upsertState(account.id, def.key, language, "PENDING", def.category, null));
    } catch (error) {
      if (error instanceof GraphError && isAlreadyExists(error)) {
        // Already submitted — its real status comes back from syncAll
        // below, so this is not a failure and must not overwrite an
        // APPROVED row with PENDING.
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      results.push(await upsertState(account.id, def.key, language, "REJECTED", def.category, reason));
    }
  }

  // Whatever the submissions did, Meta's own list is the truth — and it
  // is the only way the already-existing ones get their real status.
  try {
    return await syncAll(account, fetchImpl);
  } catch {
    return results;
  }
}

function isAlreadyExists(error: GraphError): boolean {
  return error.subcode === 2388023 || /already exists/i.test(error.message);
}

interface MetaTemplateRow {
  name: string;
  language: string;
  status: string;
  category?: string;
  rejected_reason?: string;
}

/**
 * Read Meta's list back and make our cache match it.
 *
 * Also the repair path for a webhook that never arrived — the status
 * update is the one delivery whose loss is silent, because a template
 * stuck at PENDING looks exactly like one Meta has not got to yet.
 */
export async function syncAll(
  account: WhatsAppAccount,
  fetchImpl: typeof fetch = fetch
): Promise<TemplateState[]> {
  const response = await withToken(account, (token) =>
    graph<{ data?: MetaTemplateRow[] }>({
      path: `${account.wabaId}/message_templates`,
      accessToken: token,
      query: { fields: "name,language,status,category,rejected_reason", limit: "100" },
      fetchImpl,
    })
  );

  const states: TemplateState[] = [];
  for (const row of response.data ?? []) {
    const key = keyFromMetaName(row.name);
    // A merchant's own templates live in the same WABA. They are not
    // ours to track, and writing them into this table would make the
    // Settings screen list templates we cannot send.
    if (!key) continue;

    states.push(
      await upsertState(
        account.id,
        key,
        row.language,
        row.status,
        row.category ?? templateFor(key).category,
        row.rejected_reason && row.rejected_reason !== "NONE" ? row.rejected_reason : null
      )
    );
  }
  return states;
}

async function upsertState(
  accountId: string,
  key: WhatsAppTemplateKey,
  language: string,
  status: string,
  category: string,
  rejectedReason: string | null
): Promise<TemplateState> {
  const name = metaName(key);
  const row = await prisma.whatsAppTemplate.upsert({
    where: { accountId_name_language: { accountId, name, language } },
    create: { accountId, key, name, language, status, category, rejectedReason },
    update: { key, status, category, rejectedReason },
  });
  return {
    key: row.key as WhatsAppTemplateKey,
    name: row.name,
    language: row.language,
    status: row.status,
    category: row.category,
    rejectedReason: row.rejectedReason,
  };
}

/**
 * Apply a `message_template_status_update` webhook.
 *
 * Narrower than syncAll on purpose: a webhook names one template, and
 * refetching all of them on every update would turn Meta's own
 * notification into a rate-limit problem.
 */
export async function applyStatusUpdate(
  accountId: string,
  name: string,
  language: string,
  status: string,
  reason: string | null
): Promise<void> {
  const key = keyFromMetaName(name);
  if (!key) return;
  await upsertState(accountId, key, language, status, templateFor(key).category, reason);
}

export async function statesFor(accountId: string): Promise<TemplateState[]> {
  const rows = await prisma.whatsAppTemplate.findMany({
    where: { accountId },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => ({
    key: row.key as WhatsAppTemplateKey,
    name: row.name,
    language: row.language,
    status: row.status,
    category: row.category,
    rejectedReason: row.rejectedReason,
  }));
}
