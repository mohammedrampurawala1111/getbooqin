/**
 * Regression test for the Defect Dossier's BQ-34 finding: Settings >
 * Notifications had four blanket switches and no way to see, edit, or
 * preview any of the ~16 messages the app actually sends. previewTokens()
 * fabricates sample data (no real booking exists to preview against) and
 * must cover every token any TEMPLATE_DEFS subject/body actually uses, or
 * a preview would silently render a leftover "{{token}}" — renderTemplate()
 * already strips unresolved tokens, which would hide exactly that bug.
 */
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../settings.js";
import { TEMPLATE_DEFS, previewTokens, renderTemplate } from "../mailer.js";

const settings = defaultSettings("preview-test.myshopify.com", "owner@example.com");

describe("notification preview", () => {
  it("previewTokens supplies a value for every token used across TEMPLATE_DEFS", () => {
    const allText = TEMPLATE_DEFS.map((d) => `${d.subject}\n${d.body}`).join("\n");
    const usedTokens = new Set(allText.match(/\{\{[a-z_]+\}\}/g));
    const sample = previewTokens(settings);
    for (const token of usedTokens) {
      expect(sample, `missing sample value for ${token}`).toHaveProperty(token);
    }
  });

  it("renders every template's subject and body with no leftover {{token}} placeholders", () => {
    const sample = previewTokens(settings);
    for (const def of TEMPLATE_DEFS) {
      const subject = renderTemplate(def.subject, sample);
      const body = renderTemplate(def.body, sample);
      expect(subject, `${def.key} subject`).not.toMatch(/\{\{[a-z_]+\}\}/);
      expect(body, `${def.key} body`).not.toMatch(/\{\{[a-z_]+\}\}/);
    }
  });

  it("renders real sample values into the confirmation email, not placeholders", () => {
    const def = TEMPLATE_DEFS.find((d) => d.key === "customer_created")!;
    const sample = previewTokens(settings);
    const subject = renderTemplate(def.subject, sample);
    expect(subject).toContain(sample["{{date}}"]);
    expect(subject).toContain(sample["{{time}}"]);
  });
});
