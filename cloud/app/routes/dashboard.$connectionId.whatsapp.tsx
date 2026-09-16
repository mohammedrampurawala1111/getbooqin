import { data } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.whatsapp";
import { Entitlements, WhatsAppAccounts, WhatsAppTemplates } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { getAppUrl } from "~/lib/env.server";

/**
 * The server half of "connect WhatsApp".
 *
 * A resource route rather than a page: Meta's Embedded Signup happens
 * in a popup owned by Facebook's own JS SDK, so the browser ends up
 * holding a `code` and two ids with nowhere to put them. This is where
 * it puts them.
 *
 * Every action here is idempotent and safe to retry, which matters
 * because the one step that is *not* — exchanging the single-use code —
 * happens first and is written down immediately. See
 * whatsapp/accounts.ts's completeSignup for why that ordering is the
 * whole design.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const connectionId = params.connectionId!;

  // The plan gate, stated once here so a merchant on Free gets a clear
  // 402 rather than a Meta popup that leads nowhere. The send path
  // gates independently — this is the courtesy, that one is the rule.
  const entitlements = await Entitlements.entitlementsFor(connectionId);
  if (!entitlements.features.has("whatsapp")) {
    return data({ error: "WhatsApp isn't included in your plan." }, { status: 402 });
  }

  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  try {
    if (intent === "connect") {
      const code = String(form.get("code") ?? "").trim();
      const wabaId = String(form.get("waba_id") ?? "").trim();
      const phoneNumberId = String(form.get("phone_number_id") ?? "").trim();

      // All three or nothing. The ids arrive by postMessage and the code
      // by the SDK callback, and a browser that caught one but not the
      // other would otherwise store half an integration.
      if (!code || !wabaId || !phoneNumberId) {
        return data({ error: "WhatsApp didn't finish connecting. Please try again." }, { status: 400 });
      }

      const account = await WhatsAppAccounts.completeSignup({ connectionId, code, wabaId, phoneNumberId });
      // Submitted straight away, because approval is per-merchant and
      // takes minutes to days. A merchant who connects and then waits a
      // day before we even ask Meta would think the integration is
      // broken.
      const templates = await submitTemplates(connectionId);
      return { account, templates };
    }

    if (intent === "finish") {
      const existing = await WhatsAppAccounts.forConnection(connectionId);
      if (!existing) return data({ error: "No WhatsApp account is connected." }, { status: 400 });

      const account = await WhatsAppAccounts.finishSetup(existing.id);
      const templates = await submitTemplates(connectionId);
      return { account, templates };
    }

    if (intent === "refresh") {
      const templates = await submitTemplates(connectionId, { submit: false });
      return { templates };
    }

    if (intent === "disconnect") {
      // Ours to forget, not ours to switch off — see accounts.ts.
      await WhatsAppAccounts.disconnect(connectionId);
      return { disconnected: true };
    }

    return data({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    // Meta's own words, not a generic message. Almost everything that
    // fails here is something only the merchant can fix — a number
    // still signed in to the WhatsApp Business app, a business not yet
    // verified — and paraphrasing it would take away the one clue they
    // have.
    const message = error instanceof Error ? error.message : "Something went wrong connecting WhatsApp.";
    console.error(`[getbooqin whatsapp] ${intent} failed for ${shop}/${platform}:`, error);
    return data({ error: message }, { status: 400 });
  }
}

async function submitTemplates(connectionId: string, opts: { submit?: boolean } = {}) {
  const row = await WhatsAppAccounts.rowForConnection(connectionId);
  if (!row) return [];
  return opts.submit === false
    ? WhatsAppTemplates.syncAll(row)
    : WhatsAppTemplates.submitAll(row, getAppUrl());
}
