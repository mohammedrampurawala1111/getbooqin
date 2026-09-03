/**
 * Regression test for the Defect Dossier's R3-02 finding: Settings >
 * Notifications listed two messages for capabilities the product doesn't
 * have ("Awaiting payment" with no payment provider connected, and an
 * entire "Chat widget" section with no chat widget anywhere in the
 * product) because the old filter checked template keys and group names by
 * hand and missed one. visibleTemplateDefs() now derives visibility
 * exclusively from each TEMPLATE_DEFS entry's own `requires` field, so a
 * message needing a capability can't ship listed by mistake.
 */
import { describe, expect, it } from "vitest";
import { TEMPLATE_DEFS, visibleTemplateDefs } from "../mailer.js";

describe("visibleTemplateDefs()", () => {
  it("hides every capability-gated message when no capability is available", () => {
    const visible = visibleTemplateDefs({ chat: false, payments: false, visitSummary: false });
    for (const def of visible) expect(def.requires).toBeUndefined();
  });

  it("shows the chat-lead message only when chat is enabled", () => {
    expect(visibleTemplateDefs({ chat: false, payments: true, visitSummary: true }).some((d) => d.key === "admin_chat_lead")).toBe(false);
    expect(visibleTemplateDefs({ chat: true, payments: true, visitSummary: true }).some((d) => d.key === "admin_chat_lead")).toBe(true);
  });

  it("shows both payment-dependent messages only when payments are available", () => {
    const withoutPayments = visibleTemplateDefs({ chat: true, payments: false, visitSummary: true });
    expect(withoutPayments.some((d) => d.key === "customer_created_awaiting_payment")).toBe(false);
    expect(withoutPayments.some((d) => d.key === "customer_paid")).toBe(false);

    const withPayments = visibleTemplateDefs({ chat: true, payments: true, visitSummary: true });
    expect(withPayments.some((d) => d.key === "customer_created_awaiting_payment")).toBe(true);
    expect(withPayments.some((d) => d.key === "customer_paid")).toBe(true);
  });

  it("shows the visit-summary message only when visit summaries are visible", () => {
    expect(visibleTemplateDefs({ chat: true, payments: true, visitSummary: false }).some((d) => d.key === "customer_visit_summary")).toBe(false);
    expect(visibleTemplateDefs({ chat: true, payments: true, visitSummary: true }).some((d) => d.key === "customer_visit_summary")).toBe(true);
  });

  it("every message whose copy promises a payment or a chat widget declares the matching capability", () => {
    for (const def of TEMPLATE_DEFS) {
      const text = `${def.label} ${def.description}`.toLowerCase();
      if (/\bpayment\b|\bpaid\b/.test(text)) expect(def.requires, `"${def.key}" mentions payment but has no requires tag`).toBe("payments");
      if (/\bchat\b/.test(text)) expect(def.requires, `"${def.key}" mentions chat but has no requires tag`).toBe("chat");
    }
  });
});
